import test from "node:test";
import assert from "node:assert/strict";
import {
  buildBasicLexicalQuery,
  createLiteralQueryPlan,
  createQueryUnderstanding,
  deriveEffectiveSort,
  localSearchProducts,
  parseMaxPrice,
  stripQueryControls,
} from "../src/lib/search.js";
import { getPersonaById } from "../src/data/personas.js";

test("basic lexical query applies no query understanding or scoring recipe", () => {
  assert.deepEqual(buildBasicLexicalQuery("dress watch under 1000 newest"), {
    multi_match: {
      query: "dress watch under 1000 newest",
      fields: ["title", "brand", "canonical_text", "description"],
      operator: "or",
    },
  });
  assert.deepEqual(buildBasicLexicalQuery("  "), { match_all: {} });
});

test("literal query plans do not infer shopper intent or controls", () => {
  const plan = createLiteralQueryPlan("dress watch under 1000 newest");

  assert.deepEqual(plan.categories, []);
  assert.deepEqual(plan.materials, []);
  assert.deepEqual(plan.phraseIntents, []);
  assert.deepEqual(plan.chips, []);
  assert.equal(plan.brand, "");
  assert.equal(plan.intent, "");
  assert.equal(plan.priceMax, null);
  assert.equal(plan.rewritten, "dress watch under 1000 newest");
  assert.equal(plan.tokenOperator, "or");
  assert.deepEqual(plan.tokens, ["dress", "watch", "under", "1000", "newest"]);
});

const items = [
  {
    id: "older-drop",
    brand: "ALPHA",
    title: "Archive bag",
    category: "Bags",
    material: "Leather",
    color: "Black",
    condition: "Good",
    country: "France",
    size: "M",
    canonical_text: "ALPHA Archive bag Bags Leather Black Good France",
    reasons: [],
    price: 300,
    oldPrice: 900,
    listed_at: "2024-01-01T00:00:00Z",
    score: 10,
  },
  {
    id: "newest-cheapest",
    brand: "BETA",
    title: "Modern bag",
    category: "Bags",
    material: "Canvas",
    color: "Blue",
    condition: "Excellent",
    country: "Italy",
    size: "M",
    canonical_text: "BETA Modern bag Bags Canvas Blue Excellent Italy",
    reasons: [],
    price: 100,
    oldPrice: 400,
    listed_at: "2026-01-01T00:00:00Z",
    score: 20,
  },
  {
    id: "middle",
    brand: "GAMMA",
    title: "Classic bag",
    category: "Bags",
    material: "Silk",
    color: "Red",
    condition: "Very good",
    country: "Spain",
    size: "M",
    canonical_text: "GAMMA Classic bag Bags Silk Red Very good Spain",
    reasons: [],
    price: 200,
    oldPrice: null,
    listed_at: "2025-01-01T00:00:00Z",
    score: 30,
  },
];

test("literal local search matches any query token", () => {
  const results = localSearchProducts(items, {
    query: "bag nonexistent",
    filters: {},
    maxPrice: 20000,
    sort: "Recommended",
    persona: null,
    queryUnderstanding: false,
  });

  assert.equal(results.length, items.length);
});

test("shared control cleanup keeps lexical and local fallback browse-only queries nonrestrictive", () => {
  for (const query of ["newest", "cheapest", "price drops"]) {
    const understanding = createQueryUnderstanding(query, items);
    assert.equal(stripQueryControls(query), "");
    assert.deepEqual(understanding.tokens, []);
    assert.equal(understanding.requiresTextMatch, false);
  }

  const budget = createQueryUnderstanding("under 150", items);
  assert.equal(stripQueryControls("under 150"), "");
  assert.equal(budget.priceMax, 150);
  assert.deepEqual(
    localSearchProducts(items, { query: "under 150", filters: {}, maxPrice: 20000, sort: "Recommended" }).map(
      ({ id }) => id,
    ),
    ["middle", "newest-cheapest", "older-drop"],
  );

  const newest = localSearchProducts(items, {
    query: "newest",
    filters: {},
    maxPrice: 20000,
    sort: "Recommended",
  });
  assert.deepEqual(newest.map(({ id }) => id), ["newest-cheapest", "middle", "older-drop"]);

  const cheapest = localSearchProducts(items, {
    query: "cheapest",
    filters: {},
    maxPrice: 20000,
    sort: "Recommended",
  });
  assert.deepEqual(cheapest.map(({ id }) => id), ["newest-cheapest", "middle", "older-drop"]);

  const priceDrop = localSearchProducts(items, {
    query: "price drops",
    filters: {},
    maxPrice: 20000,
    sort: "Recommended",
  });
  assert.deepEqual(priceDrop.map(({ id }) => id), ["older-drop", "newest-cheapest", "middle"]);
});

test("price parsing and cleanup share the same supported control grammar", () => {
  for (const query of ["maximum 150", "maximum of 150", "max of EUR 150", "<= €150"]) {
    assert.equal(parseMaxPrice(query), 150);
    assert.equal(stripQueryControls(query), "");
  }

  for (const query of ["bags under 5,000", "bags under €5,000", "bags under 5.000", "bags under 5 000"]) {
    assert.equal(parseMaxPrice(query), 5000);
    assert.equal(stripQueryControls(query), "bags");
  }
  assert.equal(parseMaxPrice("bags under 5.5k"), 5500);
  assert.equal(parseMaxPrice("bags under 5,5k"), 5500);
  for (const query of ["bags under 1.500,50 EUR", "bags under 1,500.50 EUR", "bags under 1 500,50 EUR"]) {
    assert.equal(parseMaxPrice(query), 1500);
    assert.equal(stripQueryControls(query), "bags");
  }

  for (const query of [
    "bags with the largest discounts",
    "bags with highest reductions",
    "bags with drops",
    "bags discounted most",
  ]) {
    assert.equal(deriveEffectiveSort(query), "Price drop");
    assert.equal(stripQueryControls(query), "bags");
  }
  assert.equal(deriveEffectiveSort("drop earrings"), "Recommended");
  assert.equal(stripQueryControls("drop earrings"), "drop earrings");

  assert.equal(parseMaxPrice("bags under 0"), 1);
  assert.deepEqual(
    localSearchProducts(items, {
      query: "bags under 0",
      filters: {},
      maxPrice: 20000,
      sort: "Recommended",
    }).map(({ id }) => id),
    ["middle", "newest-cheapest", "older-drop"],
  );
});

test("shared control cleanup removes conversational scaffolding before fallback tokenization", () => {
  const blackCanvas = createQueryUnderstanding("show me black canvas bags", items);
  assert.deepEqual(blackCanvas.categories, ["Bags"]);
  assert.deepEqual(blackCanvas.materials, ["Canvas"]);
  assert.deepEqual(blackCanvas.tokens, ["black"]);

  for (const query of ["I am looking for a silk dress", "I'm looking for a silk dress", "I’m looking for a silk dress"]) {
    const silkDress = createQueryUnderstanding(query, items);
    assert.deepEqual(silkDress.categories, ["Dresses"]);
    assert.deepEqual(silkDress.materials, ["Silk"]);
    assert.deepEqual(silkDress.tokens, []);
  }

  for (const query of [
    "show all bags",
    "bags please",
    "can I see bags",
    "designer bags",
    "bags for sale",
    "second hand bags",
  ]) {
    const bags = createQueryUnderstanding(query, items);
    assert.deepEqual(bags.categories, ["Bags"]);
    assert.deepEqual(bags.tokens, []);
    assert.equal(
      localSearchProducts(items, { query, filters: {}, maxPrice: 20000, sort: "Recommended" }).length,
      items.length,
    );
  }
});

test("specific multi-word materials shadow only overlapping generic material matches", () => {
  assert.deepEqual(createQueryUnderstanding("white gold ring", items).materials, ["White gold"]);
  assert.deepEqual(createQueryUnderstanding("gold and white gold ring", items).materials, ["Gold", "White gold"]);
});

test("deterministic understanding does not translate gender into a backend filter", () => {
  for (const query of ["women's bags", "men's watches", "bags for him", "shoes for her"]) {
    const plan = createQueryUnderstanding(query, items);
    assert.equal("genderAffinities" in plan, false);
    assert.equal(plan.chips.some((chip) => chip.startsWith("Gender affinity:")), false);
  }
});

test("local fallback does not reproduce planner-owned shopper or persona budgets", () => {
  const persona = getPersonaById("first-luxury-purchase");
  const pricedItems = [
    { ...items[0], id: "within-persona-budget", price: 1400 },
    { ...items[1], id: "over-persona-budget", price: 1600 },
  ];

  assert.deepEqual(
    localSearchProducts(pricedItems, {
      query: "bags",
      filters: {},
      maxPrice: 20000,
      sort: "Recommended",
      persona,
    }).map(({ id }) => id).sort(),
    ["over-persona-budget", "within-persona-budget"],
  );
  assert.deepEqual(
    localSearchProducts(pricedItems, {
      query: "bags under 1200",
      filters: {},
      maxPrice: 20000,
      sort: "Recommended",
      persona,
    }).map(({ id }) => id).sort(),
    ["over-persona-budget", "within-persona-budget"],
  );
});

test("persona profile terms softly boost local relevance without becoming filters", () => {
  const generic = {
    ...items[0],
    id: "generic",
    title: "Everyday bag",
    canonical_text: "ALPHA Everyday bag Bags Leather Black Good France",
    score: 50,
  };
  const editorial = {
    ...items[0],
    id: "editorial",
    title: "Rare archive runway bag",
    canonical_text: "ALPHA Rare archive runway bag Bags Leather Black Good France",
    score: 50,
  };
  const options = { query: "bags", filters: {}, maxPrice: 20000, sort: "Recommended" };

  assert.deepEqual(
    localSearchProducts([generic, editorial], options).map(({ id }) => id),
    ["generic", "editorial"],
  );
  assert.deepEqual(
    localSearchProducts([generic, editorial], {
      ...options,
      persona: {
        searchProfile: {
          queryExpansion: "rare archive vintage runway editorial limited edition distinctive",
        },
      },
    }).map(({ id }) => id),
    ["editorial", "generic"],
  );
  assert.equal(localSearchProducts([generic, editorial], { ...options, persona: null }).length, 2);
});

test("watch-specific persona preferences reorder generic watch results", () => {
  const braceletWatch = {
    ...items[0],
    id: "bracelet-watch",
    title: "Feline bracelet watch",
    category: "Watches",
    canonical_text: "MAISON AURELLE Feline bracelet watch Watches Steel Gold",
    reasons: ["Luxury jewellery", "Sculptural bracelet"],
    score: 50,
  };
  const traditionalWatch = {
    ...items[0],
    id: "traditional-watch",
    title: "Tradition leather strap watch",
    category: "Watches",
    canonical_text: "BREGONNE Tradition leather strap watch Watches Gold Silver",
    reasons: ["Dress watch", "Mechanical style"],
    score: 50,
  };
  const options = { query: "watch", filters: {}, maxPrice: 20000, sort: "Recommended" };

  assert.deepEqual(
    localSearchProducts([braceletWatch, traditionalWatch], {
      ...options,
      persona: getPersonaById("first-luxury-purchase"),
    }).map(({ id }) => id),
    ["bracelet-watch", "traditional-watch"],
  );
  assert.deepEqual(
    localSearchProducts([braceletWatch, traditionalWatch], {
      ...options,
      persona: getPersonaById("watch-collector"),
    }).map(({ id }) => id),
    ["traditional-watch", "bracelet-watch"],
  );
});

test("local explicit sorts break equal primary values by computed relevance", () => {
  const lowerScore = {
    ...items[0],
    id: "lower-score",
    price: 100,
    listed_at: "2026-01-01T00:00:00Z",
    score: 10,
  };
  const higherScore = {
    ...items[1],
    id: "higher-score",
    price: 100,
    listed_at: "2026-01-01T00:00:00Z",
    score: 50,
  };
  const options = { query: "bags", filters: {}, maxPrice: 20000 };

  for (const sort of ["Lowest price", "Newest"]) {
    assert.deepEqual(
      localSearchProducts([lowerScore, higherScore], { ...options, sort }).map(({ id }) => id),
      ["higher-score", "lower-score"],
    );
  }
});
