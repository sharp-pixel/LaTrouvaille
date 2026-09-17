import assert from "node:assert/strict";
import test from "node:test";
import { compileAnonymousQuery } from "../scripts/rules-query-understanding.mjs";

const compile = (query, options = {}) => compileAnonymousQuery({ query, ...options });
const terms = (plan, field, mode = "filter") => plan.dslQuery.query.bool[mode]?.filter((clause) => clause.terms?.[field]).map((clause) => clause.terms[field]) || [];
const price = (plan) => plan.dslQuery.query.bool.filter.find((clause) => clause.range?.price).range.price;

test("explicit catalogue attributes become hard filters and leave only model text", () => {
  const plan = compile("Show me black leather Maison Bellune Page bags from France under 1,500 EUR");
  assert.deepEqual(terms(plan, "brand.keyword"), [["maison bellune"]]);
  assert.deepEqual(terms(plan, "category"), [["bags"]]);
  assert.deepEqual(terms(plan, "material"), [["leather"]]);
  assert.deepEqual(terms(plan, "color"), [["black"]]);
  assert.deepEqual(terms(plan, "country"), [["france"]]);
  assert.equal(price(plan).lt, 1500);
  assert.equal(plan.queryPlan.residualQuery, "page");
  assert.equal(plan.dslQuery.query.bool.must[0].multi_match.query, "page");
});

test("filter-only and empty searches do not require a text match", () => {
  for (const query of ["black leather bags", "", "show me all designer resale items"]) {
    const plan = compile(query);
    assert.equal(plan.dslQuery.query.bool.must, undefined);
    assert.equal(plan.queryPlan.personalization.status, "unprofiled");
    assert.equal(plan.queryPlan.agentic.status, "not_called");
  }
});

test("preferences stay optional, and but restores hard constraint scope", () => {
  const plan = compile("bags preferably black leather under 500 but from France");
  assert.deepEqual(terms(plan, "category"), [["bags"]]);
  assert.deepEqual(terms(plan, "country"), [["france"]]);
  assert.deepEqual(terms(plan, "color"), []);
  assert.deepEqual(terms(plan, "color", "should"), [["black"]]);
  assert.deepEqual(terms(plan, "material", "should"), [["leather"]]);
  assert.equal(plan.dslQuery.query.bool.minimum_should_match, 0);
  assert.equal(price(plan).lt, undefined);
  assert.ok(plan.dslQuery.query.bool.should.some((clause) => clause.range?.price?.lt === 500));
});

test("alternatives use OR within a facet and exclusions never become positive filters", () => {
  const plan = compile("black or brown bags without canvas");
  assert.deepEqual(terms(plan, "color")[0].sort(), ["black", "brown"]);
  assert.deepEqual(terms(plan, "material"), []);
  assert.deepEqual(terms(plan, "material", "must_not"), [["canvas"]]);
  assert.equal(plan.queryPlan.residualQuery, "");
  const subtype = compile("shoes except boots");
  assert.deepEqual(terms(subtype, "category", "must_not"), []);
  assert.equal(subtype.dslQuery.query.bool.must_not[0].multi_match.query, "boots");
});

test("price bounds preserve currency separators, strictness, and the independent UI cap", () => {
  for (const amount of ["1,500", "1.500", "1 500", "1.5k", "1,5k"]) {
    assert.equal(price(compile(`watches under ${amount}`)).lt, 1500, amount);
  }
  assert.deepEqual(price(compile("between EUR 250 and EUR 1,250", { maxPrice: 900 })), { gte: 250, lte: 900 });
  assert.deepEqual(price(compile("from 100 to 500")), { gte: 100, lte: 500 });
  assert.deepEqual(price(compile("over 100 and at most 499.50")), { gt: 100, lte: 499.5 });
  assert.deepEqual(price(compile("at least 500 under 1000 under 800", { maxPrice: 700 })), { gte: 500, lte: 700 });
  assert.deepEqual(price(compile("under 500", { maxPrice: 500 })), { lt: 500 });
  assert.deepEqual(price(compile("over 100 at least 100")), { gt: 100, lte: 20000 });
  assert.deepEqual(price(compile("<= 500 >= 100")), { gte: 100, lte: 500 });
  assert.equal(price(compile("no more than 500")).lte, 500);
});

test("explicit UI filters remain hard even against conflicting text or preferences", () => {
  const plan = compile("black bags preferably from Italy", { filters: { color: ["Brown"], country: ["France"] }, maxPrice: 500 });
  assert.deepEqual(terms(plan, "color"), [["brown"], ["black"]]);
  assert.deepEqual(terms(plan, "country"), [["france"]]);
  assert.deepEqual(terms(plan, "country", "should"), [["italy"]]);
  assert.equal(price(plan).lte, 500);
});

test("longest entity matches preserve house punctuation and material distinctions", () => {
  assert.deepEqual(terms(compile("Porter and Rowe coat"), "brand.keyword"), [["porter & rowe"]]);
  assert.deepEqual(terms(compile("white gold ring"), "material"), [["white gold"]]);
  assert.deepEqual(terms(compile("white gold ring"), "color"), []);
  assert.deepEqual(terms(compile("gold bags"), "color"), [["gold"]]);
  assert.deepEqual(terms(compile("bags preferably gold"), "color", "should"), [["gold"]]);
  assert.deepEqual(terms(compile("gold watch"), "category"), [["watches"]]);
  assert.deepEqual(terms(compile("gold watch"), "material"), [["gold"]]);
});

test("subtypes, model numbers, and unrecognized terms survive entity extraction", () => {
  assert.equal(compile("Ardenne Berenice 30 leather bags").queryPlan.residualQuery, "berenice 30");
  assert.equal(compile("white gold rings").queryPlan.residualQuery, "ring");
  assert.equal(compile("leather boots").queryPlan.residualQuery, "boots");
  assert.equal(compile("unrecognized obsidian motif").queryPlan.residualQuery, "unrecognized obsidian motif");
  assert.deepEqual(terms(compile("leather strap watch"), "material"), []);
  assert.equal(compile("leather strap watch").queryPlan.residualQuery, "leather strap");
  assert.deepEqual(terms(compile("bag charm"), "category"), [["accessories"]]);
});

test("watch styles shadow dress categories and explicit gender includes unisex", () => {
  for (const query of ["dress watch", "formal watch", "suit watch"]) {
    const plan = compile(query);
    assert.deepEqual(terms(plan, "category"), [["watches"]]);
    assert.deepEqual(terms(plan, "gender_affinity"), []);
    assert.equal(plan.dslQuery.query.bool.minimum_should_match, 0);
    assert.equal(plan.dslQuery.query.bool.must, undefined);
  }
  assert.deepEqual(terms(compile("women's watches"), "gender_affinity"), [["women", "unisex"]]);
  assert.deepEqual(terms(compile("men's watches"), "gender_affinity"), [["men", "unisex"]]);
});

test("country recognition identifies seller location without inventing manufacturing origin", () => {
  assert.deepEqual(terms(compile("bags from Italy"), "country"), [["italy"]]);
  const plan = compile("bags made in Italy");
  assert.deepEqual(terms(plan, "country"), []);
  assert.equal(plan.queryPlan.residualQuery, "made italy");
});

test("result size, total-hit tracking and selected sort are preserved", () => {
  const plan = compile("newest watches", { size: 24, trackTotalHits: 123, sort: "Lowest price" });
  assert.equal(plan.dslQuery.size, 24);
  assert.equal(plan.dslQuery.track_total_hits, 123);
  assert.deepEqual(plan.dslQuery.sort, [{ price: { order: "asc" } }, { _score: { order: "desc" } }]);
  assert.equal(compile("watches").dslQuery.sort, undefined);
});
