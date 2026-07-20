export const AGENTIC_QUERY_FIELDS = [
  "brand",
  "title",
  "description",
  "canonical_text",
  "category",
  "price",
  "old_price",
  "country",
  "condition",
  "material",
  "color",
  "availability",
  "shipping",
  "seller_tier",
  "listed_at",
  "quality_score",
  "freshness_score",
  "seller_score",
];

export const AGENTIC_FILTER_FIELDS = ["category", "condition", "material", "country"];
const AGENTIC_TEXT_FIELDS = new Set(["brand", "canonical_text", "description", "title"]);
const AGENTIC_KEYWORD_FIELDS = new Set([
  "availability",
  "category",
  "color",
  "condition",
  "country",
  "material",
  "seller_tier",
  "shipping",
]);
const AGENTIC_NORMALIZED_KEYWORD_FIELDS = new Set([
  "category",
  "color",
  "condition",
  "country",
  "material",
  "seller_tier",
  "shipping",
]);
const AGENTIC_INTEGER_FIELDS = new Set(["old_price", "price"]);
const AGENTIC_NUMERIC_FIELDS = new Set(AGENTIC_INTEGER_FIELDS);
const AGENTIC_DATE_FIELDS = new Set(["listed_at"]);
const AGENTIC_EXACT_FIELDS = new Set([
  ...AGENTIC_KEYWORD_FIELDS,
  ...AGENTIC_NUMERIC_FIELDS,
  ...AGENTIC_DATE_FIELDS,
]);
const AGENTIC_RANGE_FIELDS = new Set([...AGENTIC_NUMERIC_FIELDS, ...AGENTIC_DATE_FIELDS]);
const OPENSEARCH_INTEGER_MIN = -2_147_483_648;
const OPENSEARCH_INTEGER_MAX = 2_147_483_647;
const AGENTIC_RANK_FEATURE_FIELDS = new Set(["freshness_score", "quality_score", "seller_score"]);
const AGENTIC_PREFIX_FIELDS = new Set([
  "availability",
  "category",
  "color",
  "condition",
  "country",
  "material",
  "seller_tier",
  "shipping",
]);
export const AGENTIC_FALLBACK_MARKER = "__agentic_planner_fallback__";
export const AGENTIC_FALLBACK_QUERY = JSON.stringify({
  size: 0,
  track_total_hits: false,
  query: { bool: { filter: [{ term: { availability: AGENTIC_FALLBACK_MARKER } }] } },
});

const AGENTIC_QUERY_TYPES = new Set([
  "bool",
  "match",
  "match_all",
  "match_phrase",
  "multi_match",
  "prefix",
  "range",
  "rank_feature",
  "term",
  "terms",
]);
const AGENTIC_TOP_LEVEL_KEYS = new Set(["query", "size", "sort", "track_total_hits"]);
const MAX_AGENTIC_QUERY_CLAUSES = 100;
const FORBIDDEN_DSL_KEYS = new Set([
  "agentic",
  "painless",
  "query_string",
  "regexp",
  "script",
  "script_score",
  "wildcard",
]);

const SORT_INSTRUCTIONS = {
  Recommended: "Rank by textual relevance, then favor quality_score, freshness_score, and seller_score.",
  "Lowest price": "Sort by price ascending, then by relevance descending.",
  Newest: "Sort by listed_at descending, then by relevance descending.",
  "Price drop": "Sort by old_price descending with missing values last, then by relevance descending.",
};

export function buildAgenticQueryText({
  query,
  filters = {},
  maxPrice = 20000,
  sort = "Recommended",
  size = 48,
  trackTotalHits = 10000,
}) {
  const constraints = ["availability must equal active", `price must be at most ${Number(maxPrice) || 20000} EUR`];

  for (const field of AGENTIC_FILTER_FIELDS) {
    const values = sanitizeFilterValues(filters[field]);
    if (values.length === 0) continue;
    constraints.push(`${field} must be one of the exact values ${JSON.stringify(values)}`);
  }

  return [
    `Shopper request: ${String(query || "Show all available items").trim().slice(0, 1000)}.`,
    `Required filters: ${constraints.join("; ")}.`,
    trackTotalHits === true
      ? "Track exact total hits."
      : trackTotalHits === false
        ? "Do not track total hits."
        : `Track total hits up to ${Math.max(0, Number(trackTotalHits) || 0)}.`,
    `Return exactly ${Math.min(Math.max(Number(size) || 48, 1), 96)} product hits.`,
    SORT_INSTRUCTIONS[sort] || SORT_INSTRUCTIONS.Recommended,
    "Use full-text queries for relevance and exact/range clauses in bool.filter. Use only mapped fields.",
  ].join("\n");
}

export function buildAgenticQuery(options) {
  return {
    agentic: {
      query_text: buildAgenticQueryText(options),
      query_fields: AGENTIC_QUERY_FIELDS,
    },
  };
}

export function selectAvailableModel({ availableModelIds, fineTunedModel, baseModel }) {
  const available = new Set((availableModelIds || []).map(String));
  if (fineTunedModel && available.has(fineTunedModel)) {
    return { model: fineTunedModel, source: "fine-tuned" };
  }
  if (baseModel && available.has(baseModel)) {
    return { model: baseModel, source: "base" };
  }

  const expected = [fineTunedModel, baseModel].filter(Boolean).join(" or ");
  throw new Error(`The model server exposes neither ${expected || "a configured model"}`);
}

export function validateAgenticDsl({ dslQuery, filters = {}, maxPrice, sort, size, trackTotalHits }) {
  const body = decodeDsl(dslQuery);
  if (JSON.stringify(body).includes(AGENTIC_FALLBACK_MARKER)) {
    throw new Error("QueryPlanningTool used its internal fallback query");
  }
  for (const key of Object.keys(body)) {
    if (!AGENTIC_TOP_LEVEL_KEYS.has(key)) throw new Error(`Unsupported agentic search key: ${key}`);
  }
  if (!Number.isInteger(body.size) || body.size !== size) {
    throw new Error(`Agentic result size must equal the service requirement (${size})`);
  }
  if (body.track_total_hits !== trackTotalHits) {
    throw new Error("Agentic track_total_hits does not match the service requirement");
  }
  const clauseCount = validateQueryNode(body.query, "query");
  if (clauseCount > MAX_AGENTIC_QUERY_CLAUSES) {
    throw new Error(`Agentic query has ${clauseCount} clauses; limit is ${MAX_AGENTIC_QUERY_CLAUSES}`);
  }
  rejectForbiddenKeys(body);

  const filterClauses = body.query.bool?.filter;
  const positiveFilters = Array.isArray(filterClauses) ? filterClauses : filterClauses ? [filterClauses] : [];
  const requiredConstraintFields = new Set(["availability", "price"]);
  for (const field of AGENTIC_FILTER_FIELDS) {
    if (sanitizeFilterValues(filters[field]).length) requiredConstraintFields.add(field);
  }
  if (!containsExactFilter(positiveFilters, "availability", "active", { normalize: false })) {
    throw new Error("Agentic query omitted the availability filter");
  }
  if (!containsRangeFilter(positiveFilters, "price", "lte", Number(maxPrice))) {
    throw new Error("Agentic query omitted the price ceiling");
  }
  for (const field of AGENTIC_FILTER_FIELDS) {
    const values = sanitizeFilterValues(filters[field]);
    if (values.length && !containsTermsFilter(positiveFilters, field, values)) {
      throw new Error(`Agentic query omitted the ${field} facet filter`);
    }
  }
  validateConstraintPlacement(body.query, requiredConstraintFields);
  if (!containsMandatoryTextQuery(body.query)) {
    throw new Error("Agentic query omitted the mandatory shopper-intent text query");
  }
  validateSort(body.sort, sort);
  return body;
}

function decodeDsl(value) {
  let decoded = value;
  if (typeof decoded === "string") {
    try {
      decoded = JSON.parse(decoded);
    } catch {
      throw new Error("Agentic context did not contain valid JSON DSL");
    }
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new Error("Agentic context did not contain an OpenSearch request body");
  }
  return decoded;
}

function validateQueryNode(node, path) {
  if (!node || typeof node !== "object" || Array.isArray(node) || Object.keys(node).length !== 1) {
    throw new Error(`${path} must contain exactly one query type`);
  }
  const [queryType, payload] = Object.entries(node)[0];
  if (!AGENTIC_QUERY_TYPES.has(queryType)) throw new Error(`Unsupported agentic query type: ${queryType}`);
  let clauseCount = 1;
  if (queryType === "bool") {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error(`${path}.bool must be an object`);
    const allowedKeys = new Set(["adjust_pure_negative", "boost", "filter", "minimum_should_match", "must", "should"]);
    for (const key of Object.keys(payload)) {
      if (!allowedKeys.has(key)) throw new Error(`Unsupported bool key: ${key}`);
    }
    validateBoolConsistency(payload, path);
    validateConjunctiveConstraints(payload, path);
    for (const clauseName of ["filter", "must", "should"]) {
      const rawClauses = payload[clauseName];
      if (rawClauses === undefined) continue;
      const clauses = Array.isArray(rawClauses) ? rawClauses : [rawClauses];
      for (const [index, clause] of clauses.entries()) {
        clauseCount += validateQueryNode(clause, `${path}.bool.${clauseName}[${index}]`);
      }
    }
  }
  validateQueryFields(queryType, payload);
  return clauseCount;
}

function validateQueryFields(queryType, payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`Agentic ${queryType} payload must be an object`);
  }
  if (["match", "match_phrase"].includes(queryType)) {
    const [field, value] = singleFieldEntry(payload, queryType);
    assertAllowedField(field);
    if (!AGENTIC_TEXT_FIELDS.has(field)) {
      throw new Error(`Agentic ${queryType} requires a mapped full-text field: ${field}`);
    }
    if (typeof value !== "string" || !value.trim() || value.length > 1000) {
      throw new Error(`Agentic ${queryType} value must be a non-empty string of at most 1000 characters`);
    }
  } else if (queryType === "prefix") {
    const [field, value] = singleFieldEntry(payload, queryType);
    assertAllowedField(field);
    if (!AGENTIC_PREFIX_FIELDS.has(field)) throw new Error(`Agentic prefix is not supported for field: ${field}`);
    if (typeof value !== "string" || !value.trim() || value.length > 1000) {
      throw new Error("Agentic prefix value must be a non-empty string of at most 1000 characters");
    }
  } else if (queryType === "term") {
    const [field, value] = singleFieldEntry(payload, queryType);
    assertAllowedField(field);
    validateExactValue(field, value, queryType);
  } else if (queryType === "terms") {
    const [field, values] = singleFieldEntry(payload, queryType);
    assertAllowedField(field);
    if (!Array.isArray(values) || values.length === 0 || values.length > 100 || !values.every(isPrimitive)) {
      throw new Error("Agentic terms value must be a non-empty primitive list of at most 100 values");
    }
    for (const value of values) validateExactValue(field, value, queryType);
  } else if (queryType === "range") {
    const [field, bounds] = singleFieldEntry(payload, queryType);
    assertAllowedField(field);
    if (!AGENTIC_RANGE_FIELDS.has(field)) throw new Error(`Agentic range is not supported for field: ${field}`);
    if (!bounds || typeof bounds !== "object" || Array.isArray(bounds)) {
      throw new Error("Agentic range bounds must be an object");
    }
    const allowedBounds = new Set(["gt", "gte", "lt", "lte"]);
    const entries = Object.entries(bounds);
    if (entries.length === 0 || entries.some(([key, value]) => !allowedBounds.has(key) || !isPrimitive(value))) {
      throw new Error("Agentic range supports only primitive gt/gte/lt/lte bounds");
    }
    validateRangeConsistency(field, bounds);
  } else if (queryType === "multi_match") {
    const allowedKeys = new Set(["boost", "fields", "minimum_should_match", "operator", "query", "tie_breaker", "type"]);
    for (const key of Object.keys(payload)) {
      if (!allowedKeys.has(key)) throw new Error(`Unsupported multi_match key: ${key}`);
    }
    if (typeof payload.query !== "string" || !payload.query.trim() || payload.query.length > 1000) {
      throw new Error("Agentic multi_match.query must be a non-empty string of at most 1000 characters");
    }
    if (!Array.isArray(payload.fields) || payload.fields.length === 0 || payload.fields.length > 8) {
      throw new Error("Agentic multi_match.fields must contain between 1 and 8 fields");
    }
    const baseFields = payload.fields.map((field) => (typeof field === "string" ? field.split("^", 1)[0] : field));
    if (new Set(baseFields).size !== payload.fields.length) {
      throw new Error("Agentic multi_match.fields must not contain duplicate base fields");
    }
    for (const field of payload.fields) {
      if (typeof field !== "string") throw new Error("Agentic multi_match.fields must contain strings");
      const baseField = field.split("^", 1)[0];
      assertAllowedField(baseField);
      if (!AGENTIC_TEXT_FIELDS.has(baseField)) {
        throw new Error(`Agentic multi_match requires mapped full-text fields: ${baseField}`);
      }
    }
  } else if (queryType === "rank_feature") {
    const allowedKeys = new Set(["boost", "field"]);
    for (const key of Object.keys(payload)) {
      if (!allowedKeys.has(key)) throw new Error(`Unsupported rank_feature key: ${key}`);
    }
    assertAllowedField(payload.field);
    if (!AGENTIC_RANK_FEATURE_FIELDS.has(payload.field)) {
      throw new Error(`Agentic rank_feature requires a mapped rank_feature field: ${String(payload.field)}`);
    }
  } else if (queryType === "match_all") {
    for (const key of Object.keys(payload)) {
      if (key !== "boost") throw new Error(`Unsupported match_all key: ${key}`);
    }
  }
}

function singleFieldEntry(payload, queryType) {
  const entries = Object.entries(payload);
  if (entries.length !== 1) throw new Error(`Agentic ${queryType} must name exactly one field`);
  return entries[0];
}

function validateRangeConsistency(field, bounds) {
  const entries = Object.entries(bounds).map(([operator, value]) => ({
    operator,
    value: comparableRangeValue(field, value),
  }));
  if (entries.some(({ value }) => value === null)) {
    throw new Error(
      field === "listed_at"
        ? "Agentic listed_at range bounds must be finite epochs or ISO date strings"
        : `Agentic ${field} range bounds must be finite numbers`,
    );
  }

  const satisfiable = AGENTIC_INTEGER_FIELDS.has(field)
    ? integerRangeEntriesAreSatisfiable(entries)
    : rangeEntriesAreSatisfiable(entries);
  if (!satisfiable) throw new Error(`Agentic ${field} range is unsatisfiable`);
}

function comparableRangeValue(field, value) {
  if (AGENTIC_INTEGER_FIELDS.has(field)) {
    return Number.isInteger(value) && value >= OPENSEARCH_INTEGER_MIN && value <= OPENSEARCH_INTEGER_MAX ? value : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (field === "listed_at" && typeof value === "string") {
    const timestamp = Date.parse(asUtcWhenZoneIsMissing(value));
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return null;
}

function asUtcWhenZoneIsMissing(value) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T00:00:00Z`;
  if (/^\d{4}-\d{2}-\d{2}T/.test(value) && !/(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(value)) return `${value}Z`;
  return value;
}

function rangeEntriesAreSatisfiable(entries) {
  const lowerBounds = entries
    .filter(({ operator }) => ["gt", "gte"].includes(operator))
    .map(({ operator, value }) => ({ value, strict: operator === "gt" }));
  const upperBounds = entries
    .filter(({ operator }) => ["lt", "lte"].includes(operator))
    .map(({ operator, value }) => ({ value, strict: operator === "lt" }));
  if (!lowerBounds.length || !upperBounds.length) return true;

  const lower = lowerBounds.reduce((current, candidate) =>
    candidate.value > current.value || (candidate.value === current.value && candidate.strict) ? candidate : current,
  );
  const upper = upperBounds.reduce((current, candidate) =>
    candidate.value < current.value || (candidate.value === current.value && candidate.strict) ? candidate : current,
  );
  if (lower.value > upper.value || (lower.value === upper.value && (lower.strict || upper.strict))) {
    return false;
  }
  return true;
}

function integerRangeEntriesAreSatisfiable(entries) {
  let lower = OPENSEARCH_INTEGER_MIN;
  let upper = OPENSEARCH_INTEGER_MAX;
  for (const { operator, value } of entries) {
    if (["gt", "gte"].includes(operator)) {
      const candidate = operator === "gt" ? value + 1 : value;
      lower = Math.max(lower, candidate);
    } else if (["lt", "lte"].includes(operator)) {
      const candidate = operator === "lt" ? value - 1 : value;
      upper = Math.min(upper, candidate);
    }
  }
  return lower <= upper;
}

function validateConjunctiveConstraints(payload, path) {
  const byField = new Map();
  for (const clauseName of ["filter", "must"]) {
    const rawClauses = payload[clauseName];
    const clauses = rawClauses === undefined ? [] : Array.isArray(rawClauses) ? rawClauses : [rawClauses];
    for (const clause of clauses) {
      if (!clause || typeof clause !== "object" || Array.isArray(clause) || Object.keys(clause).length !== 1) continue;
      const [queryType, queryPayload] = Object.entries(clause)[0];
      if (!queryPayload || typeof queryPayload !== "object" || Array.isArray(queryPayload)) continue;
      const payloadEntries = Object.entries(queryPayload);
      if (payloadEntries.length !== 1) continue;
      const [field, rawValue] = payloadEntries[0];
      const aggregate = byField.get(field) || { exactDomains: [], rangeClauseCount: 0, rangeEntries: [] };

      if (["term", "terms"].includes(queryType)) {
        const values = queryType === "terms" ? rawValue : [rawValue];
        if (
          !AGENTIC_EXACT_FIELDS.has(field) ||
          !Array.isArray(values) ||
          !values.length ||
          !values.every(isPrimitive)
        ) {
          continue;
        }
        const keyedValues = values.map((value) => [mappedExactValueKey(field, value), value]);
        if (keyedValues.some(([key]) => key === null)) continue;
        aggregate.exactDomains.push(new Map(keyedValues));
        byField.set(field, aggregate);
        continue;
      }

      if (
        queryType !== "range" ||
        !AGENTIC_RANGE_FIELDS.has(field) ||
        !rawValue ||
        typeof rawValue !== "object" ||
        Array.isArray(rawValue)
      ) {
        continue;
      }
      const entries = Object.entries(rawValue).map(([operator, value]) => ({
        operator,
        value: comparableRangeValue(field, value),
      }));
      if (entries.some(({ operator, value }) => !["gt", "gte", "lt", "lte"].includes(operator) || value === null)) {
        continue;
      }
      aggregate.rangeClauseCount += 1;
      aggregate.rangeEntries.push(...entries);
      byField.set(field, aggregate);
    }
  }
  for (const [field, aggregate] of byField) {
    if (aggregate.exactDomains.length) {
      const commonKeys = new Set(aggregate.exactDomains[0].keys());
      for (const domain of aggregate.exactDomains.slice(1)) {
        for (const key of commonKeys) {
          if (!domain.has(key)) commonKeys.delete(key);
        }
      }
      if (!commonKeys.size) {
        throw new Error(`${path}.bool conjunctive ${field} exact constraints are unsatisfiable`);
      }
      if (aggregate.rangeEntries.length) {
        const candidates = [...commonKeys].map((key) =>
          comparableRangeValue(field, aggregate.exactDomains[0].get(key)),
        );
        if (
          candidates.every((candidate) => candidate !== null) &&
          !candidates.some((candidate) => rangeEntriesMatchValue(aggregate.rangeEntries, candidate))
        ) {
          throw new Error(`${path}.bool conjunctive ${field} exact/range constraints are unsatisfiable`);
        }
      }
    }
    const rangesAreSatisfiable = AGENTIC_INTEGER_FIELDS.has(field)
      ? integerRangeEntriesAreSatisfiable(aggregate.rangeEntries)
      : rangeEntriesAreSatisfiable(aggregate.rangeEntries);
    if (aggregate.rangeClauseCount > 1 && !rangesAreSatisfiable) {
      throw new Error(`${path}.bool conjunctive ${field} ranges are unsatisfiable`);
    }
  }
}

function mappedExactValueKey(field, value) {
  if (AGENTIC_INTEGER_FIELDS.has(field)) {
    return Number.isInteger(value) && value >= OPENSEARCH_INTEGER_MIN && value <= OPENSEARCH_INTEGER_MAX
      ? `number:${Object.is(value, -0) ? 0 : value}`
      : null;
  }
  if (AGENTIC_DATE_FIELDS.has(field)) {
    const timestamp = comparableRangeValue(field, value);
    return timestamp === null ? null : `date:${timestamp}`;
  }
  if (!AGENTIC_KEYWORD_FIELDS.has(field) || typeof value !== "string") return null;
  const normalized = AGENTIC_NORMALIZED_KEYWORD_FIELDS.has(field) ? normalizeFilterValue(value) : value;
  return `string:${normalized}`;
}

function rangeEntriesMatchValue(entries, value) {
  return entries.every(({ operator, value: bound }) => {
    if (operator === "gt") return value > bound;
    if (operator === "gte") return value >= bound;
    if (operator === "lt") return value < bound;
    return value <= bound;
  });
}

function validateBoolConsistency(payload, path) {
  if (payload.minimum_should_match !== undefined) {
    const shouldCount = Array.isArray(payload.should) ? payload.should.length : payload.should === undefined ? 0 : 1;
    if (
      !Number.isInteger(payload.minimum_should_match) ||
      payload.minimum_should_match < 0 ||
      payload.minimum_should_match > shouldCount
    ) {
      throw new Error(
        `${path}.bool.minimum_should_match must be an integer between 0 and the ${shouldCount} should clauses`,
      );
    }
  }
}

function isPrimitive(value) {
  return (
    value !== null &&
    ["string", "number", "boolean"].includes(typeof value) &&
    (typeof value !== "number" || Number.isFinite(value))
  );
}

function validateExactValue(field, value, queryType) {
  if (!AGENTIC_EXACT_FIELDS.has(field)) {
    throw new Error(`Agentic ${queryType} requires a mapped exact-value field: ${field}`);
  }
  if (!isPrimitive(value) || mappedExactValueKey(field, value) === null) {
    throw new Error(`Agentic ${queryType}.${field} contains a value incompatible with its mapped type`);
  }
}

function assertAllowedField(field) {
  if (typeof field !== "string" || !AGENTIC_QUERY_FIELDS.includes(field)) {
    throw new Error(`Agentic query used an unsupported field: ${String(field)}`);
  }
}

function rejectForbiddenKeys(value) {
  if (Array.isArray(value)) {
    for (const child of value) rejectForbiddenKeys(child);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_DSL_KEYS.has(key)) throw new Error(`Agentic query used forbidden DSL: ${key}`);
    rejectForbiddenKeys(child);
  }
}

function containsExactFilter(clauses, field, expected, options = {}) {
  return clauses.some((clause) => {
    const values = exactClauseValues(clause, field);
    return values?.length === 1 && filterValuesEqual(values[0], expected, options);
  });
}

function containsRangeFilter(clauses, field, operator, expected) {
  return clauses.some((clause) => clause?.range?.[field]?.[operator] === expected);
}

function containsTermsFilter(clauses, field, expectedValues) {
  const expected = normalizedValueSet(expectedValues);
  return clauses.some((clause) => {
    const values = exactClauseValues(clause, field);
    if (!values || values.length !== expectedValues.length) return false;
    const actual = normalizedValueSet(values);
    return actual.size === values.length && actual.size === expected.size && [...expected].every((value) => actual.has(value));
  });
}

function exactClauseValues(clause, field) {
  if (!clause || typeof clause !== "object" || Array.isArray(clause)) return null;
  if (clause.term && Object.keys(clause).length === 1 && Object.keys(clause.term).length === 1) {
    const value = clause.term[field];
    return isPrimitive(value) ? [value] : null;
  }
  if (clause.terms && Object.keys(clause).length === 1 && Object.keys(clause.terms).length === 1) {
    const values = clause.terms[field];
    return Array.isArray(values) && values.every(isPrimitive) ? values : null;
  }
  return null;
}

function validateConstraintPlacement(query, requiredFields) {
  const directFilterCounts = new Map([...requiredFields].map((field) => [field, 0]));

  function visit(node, directRootFilter = false, root = false) {
    if (!node || typeof node !== "object" || Array.isArray(node)) return;
    const [queryType, payload] = Object.entries(node)[0] || [];
    if (!queryType || !payload || typeof payload !== "object" || Array.isArray(payload)) return;

    if (["match", "match_phrase", "prefix", "range", "term", "terms"].includes(queryType)) {
      for (const field of Object.keys(payload)) {
        if (!requiredFields.has(field)) continue;
        if (!directRootFilter || !["range", "term", "terms"].includes(queryType)) {
          throw new Error(`Agentic constraint field ${field} is only allowed as a direct bool.filter clause`);
        }
        directFilterCounts.set(field, (directFilterCounts.get(field) || 0) + 1);
      }
    } else if (queryType === "multi_match") {
      for (const field of payload.fields || []) {
        const baseField = typeof field === "string" ? field.split("^", 1)[0] : field;
        if (requiredFields.has(baseField)) {
          throw new Error(`Agentic constraint field ${baseField} must not be used for text relevance`);
        }
      }
    } else if (queryType === "rank_feature" && requiredFields.has(payload.field)) {
      throw new Error(`Agentic constraint field ${payload.field} must not be used for rank_feature scoring`);
    }

    if (queryType !== "bool") return;
    for (const clauseName of ["filter", "must", "should"]) {
      const rawClauses = payload[clauseName];
      if (rawClauses === undefined) continue;
      const clauses = Array.isArray(rawClauses) ? rawClauses : [rawClauses];
      for (const clause of clauses) visit(clause, root && clauseName === "filter", false);
    }
  }

  visit(query, false, true);
  for (const [field, count] of directFilterCounts) {
    if (count !== 1) throw new Error(`Agentic constraint field ${field} must appear in exactly one direct bool.filter clause`);
  }
}

function normalizedValueSet(values) {
  return new Set(values.map((value) => normalizeFilterValue(value)));
}

function containsMandatoryTextQuery(query) {
  const must = query?.bool?.must;
  const clauses = Array.isArray(must) ? must : must ? [must] : [];
  return clauses.some((clause) => {
    if (!clause || typeof clause !== "object" || Array.isArray(clause)) return false;
    const [queryType, payload] = Object.entries(clause)[0] || [];
    if (["match", "match_phrase"].includes(queryType)) {
      return payload && typeof payload === "object" && Object.keys(payload).every((field) => AGENTIC_TEXT_FIELDS.has(field));
    }
    if (queryType !== "multi_match" || !payload || typeof payload !== "object") return false;
    return payload.fields.every((field) => AGENTIC_TEXT_FIELDS.has(field.split("^", 1)[0]));
  });
}

function sanitizeFilterValues(value) {
  return Array.isArray(value)
    ? value
        .filter((item) => typeof item === "string" && item.trim())
        .slice(0, 20)
        .map((item) => item.trim().slice(0, 100))
    : [];
}

function filterValuesEqual(left, right, { normalize = true } = {}) {
  if (Object.is(left, right)) return true;
  if (!normalize || typeof left !== "string" || typeof right !== "string") return false;
  return normalizeFilterValue(left) === normalizeFilterValue(right);
}

function normalizeFilterValue(value) {
  if (typeof value !== "string") return `${typeof value}:${String(value)}`;
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function validateSort(value, mode) {
  if (mode === "Recommended") {
    if (value === undefined) return;
    const only = sortClause(value, 0);
    if (Array.isArray(value) && value.length === 1 && only?.field === "_score" && only?.order === "desc") return;
    throw new Error("Recommended agentic ranking must not use a business-field sort");
  }
  const expected = {
    "Lowest price": { field: "price", order: "asc" },
    Newest: { field: "listed_at", order: "desc" },
    "Price drop": { field: "old_price", order: "desc", missing: "_last" },
  }[mode];
  const primary = sortClause(value, 0);
  const secondary = sortClause(value, 1);
  if (
    !expected ||
    !Array.isArray(value) ||
    value.length !== 2 ||
    primary?.field !== expected.field ||
    primary?.order !== expected.order ||
    primary?.missing !== expected.missing ||
    secondary?.field !== "_score" ||
    secondary?.order !== "desc"
  ) {
    throw new Error(`Agentic sort does not match ${mode}`);
  }
}

function sortClause(value, index) {
  if (!Array.isArray(value) || !value[index] || typeof value[index] !== "object") return null;
  const entries = Object.entries(value[index]);
  if (entries.length !== 1) return null;
  const [field, options] = entries[0];
  if (typeof options === "string") return { field, order: options, missing: undefined };
  if (!options || typeof options !== "object" || Array.isArray(options)) return null;
  const allowedKeys = field === "old_price" ? new Set(["missing", "order"]) : new Set(["order"]);
  if (Object.keys(options).some((key) => !allowedKeys.has(key))) return null;
  return { field, order: options.order, missing: options.missing };
}
