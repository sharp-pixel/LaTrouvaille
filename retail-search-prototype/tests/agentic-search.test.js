import test from "node:test";
import assert from "node:assert/strict";
import {
  AGENTIC_FALLBACK_QUERY,
  buildAgenticQuery,
  buildAgenticQueryText,
  selectAvailableModel,
  validateAgenticDsl,
} from "../src/lib/agentic-search.js";

test("agentic query carries shopper intent and mandatory filters", () => {
  const query = buildAgenticQuery({
    query: "formal watch",
    filters: { category: ["Watches"], material: [] },
    maxPrice: 5000,
    sort: "Lowest price",
    size: 24,
  });

  assert.equal(query.agentic.query_fields.includes("canonical_text"), true);
  assert.match(query.agentic.query_text, /Shopper request: formal watch/);
  assert.match(query.agentic.query_text, /availability must equal active/);
  assert.match(query.agentic.query_text, /category must be one of the exact values \["Watches"\]/);
  assert.match(query.agentic.query_text, /Return exactly 24 product hits/);
  assert.match(query.agentic.query_text, /Track total hits up to 10000/);
  assert.match(query.agentic.query_text, /Sort by price ascending/);
});

test("empty searches still produce a bounded catalog request", () => {
  const text = buildAgenticQueryText({ query: "", maxPrice: 20000 });
  assert.match(text, /Show all available items/);
  assert.match(text, /price must be at most 20000 EUR/);
});

test("model selection prefers the fine-tune and falls back to the base", () => {
  const configured = {
    fineTunedModel: "psg-agentic-query-planner-v1",
    baseModel: "ministral-3-8b-instruct-2512",
  };

  assert.deepEqual(
    selectAvailableModel({ availableModelIds: [configured.baseModel, configured.fineTunedModel], ...configured }),
    { model: configured.fineTunedModel, source: "fine-tuned" },
  );
  assert.deepEqual(selectAvailableModel({ availableModelIds: [configured.baseModel], ...configured }), {
    model: configured.baseModel,
    source: "base",
  });
});

test("model selection fails when neither configured model is served", () => {
  assert.throws(
    () => selectAvailableModel({ availableModelIds: ["unrelated"], fineTunedModel: "fine", baseModel: "base" }),
    /neither fine or base/,
  );
});

test("runtime validator accepts a complete policy-aligned request body", () => {
  const dslQuery = {
    size: 24,
    track_total_hits: 10000,
    query: {
      bool: {
        filter: [
          { term: { availability: "active" } },
          { range: { price: { lte: 5000 } } },
          { terms: { category: ["watches"] } },
        ],
        must: [{ multi_match: { query: "formal watch", fields: ["title^5", "canonical_text^3"] } }],
      },
    },
    sort: [{ price: { order: "asc" } }, { _score: { order: "desc" } }],
  };
  assert.deepEqual(
    validateAgenticDsl({
      dslQuery: JSON.stringify(dslQuery),
      filters: { category: ["Watches"] },
      maxPrice: 5000,
      sort: "Lowest price",
      size: 24,
      trackTotalHits: 10000,
    }),
    dslQuery,
  );
});

test("runtime validator rejects the silent QueryPlanningTool fallback", () => {
  assert.throws(
    () =>
      validateAgenticDsl({
        dslQuery: AGENTIC_FALLBACK_QUERY,
        maxPrice: 20000,
        sort: "Recommended",
        size: 96,
        trackTotalHits: 10000,
      }),
    /internal fallback query/,
  );
});

test("runtime validator rejects missing hard filters", () => {
  assert.throws(
    () =>
      validateAgenticDsl({
        dslQuery: { size: 24, track_total_hits: 10000, query: { match_all: {} } },
        maxPrice: 20000,
        sort: "Recommended",
        size: 24,
        trackTotalHits: 10000,
      }),
    /availability filter/,
  );
});

function validAgenticBody(overrides = {}) {
  return {
    size: 24,
    track_total_hits: 10000,
    query: {
      bool: {
        filter: [
          { term: { availability: "active" } },
          { range: { price: { lte: 5000 } } },
          { terms: { category: ["bags"] } },
        ],
        must: [{ multi_match: { query: "canvas bag", fields: ["title^5", "canonical_text^3"] } }],
      },
    },
    ...overrides,
  };
}

function validateCanvasBag(dslQuery) {
  return validateAgenticDsl({
    dslQuery,
    filters: { category: ["Bags"] },
    maxPrice: 5000,
    sort: "Recommended",
    size: 24,
    trackTotalHits: 10000,
  });
}

test("runtime validator requires exact size and mandatory shopper intent", () => {
  assert.throws(() => validateCanvasBag(validAgenticBody({ size: 1 })), /must equal/);

  const filterOnly = validAgenticBody();
  delete filterOnly.query.bool.must;
  assert.throws(() => validateCanvasBag(filterOnly), /shopper-intent text query/);
});

test("runtime validator rejects broadened or conjunctive facet sets", () => {
  const broadened = validAgenticBody();
  broadened.query.bool.filter[2] = { terms: { category: ["bags", "watches"] } };
  assert.throws(() => validateCanvasBag(broadened), /category facet filter/);

  const conjunctive = validAgenticBody();
  conjunctive.query.bool.filter.splice(2, 1, { term: { category: "bags" } }, { term: { category: "watches" } });
  assert.throws(
    () =>
      validateAgenticDsl({
        dslQuery: conjunctive,
        filters: { category: ["Bags", "Watches"] },
        maxPrice: 5000,
        sort: "Recommended",
        size: 24,
        trackTotalHits: 10000,
      }),
    /conjunctive category exact constraints|category facet filter/,
  );
});

test("runtime validator treats non-normalized availability as a mismatch", () => {
  const body = validAgenticBody();
  body.query.bool.filter[0] = { term: { availability: "ACTIVE" } };
  assert.throws(() => validateCanvasBag(body), /availability filter/);
});

test("runtime validator rejects contradictory hard constraints", () => {
  const duplicate = validAgenticBody();
  duplicate.query.bool.filter.push({ term: { availability: "inactive" } });
  assert.throws(() => validateCanvasBag(duplicate), /conjunctive availability exact constraints|availability.*exactly one direct/);

  const negated = validAgenticBody();
  negated.query.bool.must_not = [{ term: { category: "bags" } }];
  assert.throws(() => validateCanvasBag(negated), /Unsupported bool key: must_not/);
});

test("runtime validator requires a non-empty full-text shopper query", () => {
  const empty = validAgenticBody();
  empty.query.bool.must = [{ multi_match: { query: "", fields: ["title"] } }];
  assert.throws(() => validateCanvasBag(empty), /non-empty string/);

  const constraintAsIntent = validAgenticBody();
  constraintAsIntent.query.bool.must = [{ match: { availability: "active" } }];
  assert.throws(() => validateCanvasBag(constraintAsIntent), /requires a mapped full-text field: availability/);

  const numericIntent = validAgenticBody();
  numericIntent.query.bool.must = [{ match: { old_price: "500" } }];
  assert.throws(() => validateCanvasBag(numericIntent), /requires a mapped full-text field/);

  const hiddenNumericConstraint = validAgenticBody();
  hiddenNumericConstraint.query.bool.must.push({ match: { old_price: "500" } });
  assert.throws(() => validateCanvasBag(hiddenNumericConstraint), /requires a mapped full-text field/);
});

test("runtime validator rejects unsatisfiable ranges and bool clauses", () => {
  const impossiblePrice = validAgenticBody();
  impossiblePrice.query.bool.filter[1] = { range: { price: { gte: 6000, lte: 5000 } } };
  assert.throws(() => validateCanvasBag(impossiblePrice), /price range is unsatisfiable/);

  const negateEverything = validAgenticBody();
  negateEverything.query.bool.must_not = [{ match_all: {} }];
  assert.throws(() => validateCanvasBag(negateEverything), /Unsupported bool key: must_not/);

  const negateIntent = validAgenticBody();
  negateIntent.query.bool.must_not = [structuredClone(negateIntent.query.bool.must[0])];
  assert.throws(() => validateCanvasBag(negateIntent), /Unsupported bool key: must_not/);

  const impossibleDate = validAgenticBody();
  impossibleDate.query.bool.should = [{ range: { listed_at: { gte: "2026-01-01", lte: "2025-01-01" } } }];
  assert.throws(() => validateCanvasBag(impossibleDate), /listed_at range is unsatisfiable/);

  const impossibleShouldCount = validAgenticBody();
  impossibleShouldCount.query.bool.should = [{ match_all: {} }];
  impossibleShouldCount.query.bool.minimum_should_match = 2;
  assert.throws(() => validateCanvasBag(impossibleShouldCount), /minimum_should_match must be an integer between 0/);

  const impossibleAcrossFilters = validAgenticBody();
  impossibleAcrossFilters.query.bool.filter.push(
    { range: { old_price: { gte: 600 } } },
    { range: { old_price: { lte: 500 } } },
  );
  assert.throws(() => validateCanvasBag(impossibleAcrossFilters), /conjunctive old_price ranges are unsatisfiable/);

  const impossibleExactFilters = validAgenticBody();
  impossibleExactFilters.query.bool.filter.push({ term: { shipping: "free" } });
  impossibleExactFilters.query.bool.must.push({ terms: { shipping: ["paid", "pickup"] } });
  assert.throws(
    () => validateCanvasBag(impossibleExactFilters),
    /conjunctive shipping exact constraints are unsatisfiable/,
  );

  const impossibleExactRange = validAgenticBody();
  impossibleExactRange.query.bool.filter.push({ term: { old_price: 600 } });
  impossibleExactRange.query.bool.must.push({ range: { old_price: { lt: 600 } } });
  assert.throws(
    () => validateCanvasBag(impossibleExactRange),
    /conjunctive old_price exact\/range constraints are unsatisfiable/,
  );

  const impossibleMixedDate = validAgenticBody();
  impossibleMixedDate.query.bool.filter.push({ range: { listed_at: { gte: 1_735_689_600_000 } } });
  impossibleMixedDate.query.bool.must.push({ range: { listed_at: { lt: "2025-01-01" } } });
  assert.throws(() => validateCanvasBag(impossibleMixedDate), /conjunctive listed_at ranges are unsatisfiable/);

  const emptyIntegerInterval = validAgenticBody();
  emptyIntegerInterval.query.bool.should = [{ range: { old_price: { gt: 1, lt: 2 } } }];
  assert.throws(() => validateCanvasBag(emptyIntegerInterval), /old_price range is unsatisfiable/);

  const singletonIntegerInterval = validAgenticBody();
  singletonIntegerInterval.query.bool.should = [{ range: { old_price: { gte: 2, lte: 2 } } }];
  assert.doesNotThrow(() => validateCanvasBag(singletonIntegerInterval));

  for (const bounds of [{ gt: 2_147_483_647 }, { lt: -2_147_483_648 }]) {
    const outsideIntegerMapping = validAgenticBody();
    outsideIntegerMapping.query.bool.should = [{ range: { old_price: bounds } }];
    assert.throws(() => validateCanvasBag(outsideIntegerMapping), /old_price range is unsatisfiable/);
  }

  for (const bounds of [{ gte: -2_147_483_648 }, { lte: 2_147_483_647 }]) {
    const integerMappingEdge = validAgenticBody();
    integerMappingEdge.query.bool.should = [{ range: { old_price: bounds } }];
    assert.doesNotThrow(() => validateCanvasBag(integerMappingEdge));
  }
});

test("runtime validator honors keyword normalizers in exact conjunctions", () => {
  const normalizedKeyword = validAgenticBody();
  normalizedKeyword.query.bool.filter.push({ term: { shipping: "Free" } });
  normalizedKeyword.query.bool.must.push({ term: { shipping: "free" } });
  assert.doesNotThrow(() => validateCanvasBag(normalizedKeyword));
});

test("runtime validator enforces exact-query field types and shape", () => {
  const textExact = validAgenticBody();
  textExact.query.bool.filter.push({ term: { title: "canvas" } });
  assert.throws(() => validateCanvasBag(textExact), /term requires a mapped exact-value field: title/);

  const rankFeatureExact = validAgenticBody();
  rankFeatureExact.query.bool.filter.push({ term: { quality_score: 10 } });
  assert.throws(() => validateCanvasBag(rankFeatureExact), /term requires a mapped exact-value field: quality_score/);

  const multifield = validAgenticBody();
  multifield.query.bool.filter.push({ term: { color: "red", shipping: "free" } });
  assert.throws(() => validateCanvasBag(multifield), /term must name exactly one field/);

  const excessiveTerms = validAgenticBody();
  excessiveTerms.query.bool.filter.push({ terms: { color: Array.from({ length: 101 }, (_, index) => `color-${index}`) } });
  assert.throws(() => validateCanvasBag(excessiveTerms), /at most 100 values/);

  const fractionalInteger = validAgenticBody();
  fractionalInteger.query.bool.filter.push({ term: { old_price: 1.5 } });
  assert.throws(() => validateCanvasBag(fractionalInteger), /term.old_price contains a value incompatible/);
});

test("runtime validator enforces prefix and rank-feature mapping types", () => {
  const numericPrefix = validAgenticBody();
  numericPrefix.query.bool.should = [{ prefix: { price: "50" } }];
  assert.throws(() => validateCanvasBag(numericPrefix), /prefix is not supported for field: price/);

  const numericRankFeature = validAgenticBody();
  numericRankFeature.query.bool.should = [{ rank_feature: { field: "price" } }];
  assert.throws(() => validateCanvasBag(numericRankFeature), /requires a mapped rank_feature field: price/);
});

test("runtime validator rejects terms lookup and excessive clauses", () => {
  const lookup = validAgenticBody();
  lookup.query.bool.filter[2] = { terms: { category: { index: "private", id: "1", path: "values" } } };
  assert.throws(() => validateCanvasBag(lookup), /primitive list/);

  const excessive = validAgenticBody();
  excessive.query.bool.should = Array.from({ length: 100 }, () => ({ match_all: {} }));
  assert.throws(() => validateCanvasBag(excessive), /clauses; limit is 100/);
});

test("runtime validator rejects sort suffixes", () => {
  const body = validAgenticBody({
    sort: [{ price: { order: "asc" } }, { _score: { order: "desc" } }, { listed_at: { order: "desc" } }],
  });
  assert.throws(
    () =>
      validateAgenticDsl({
        dslQuery: body,
        filters: { category: ["Bags"] },
        maxPrice: 5000,
        sort: "Lowest price",
        size: 24,
        trackTotalHits: 10000,
      }),
    /does not match Lowest price/,
  );
});
