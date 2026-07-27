import { getPersonaQueryExpansion } from "../data/personas.js";

const GENERIC_TERMS = new Set([
  "a",
  "an",
  "and",
  "article",
  "articles",
  "by",
  "designer",
  "designers",
  "eur",
  "euro",
  "euros",
  "for",
  "fresh",
  "in",
  "item",
  "items",
  "less",
  "luxury",
  "max",
  "new",
  "of",
  "or",
  "pre",
  "preloved",
  "resale",
  "second",
  "than",
  "the",
  "under",
  "up",
  "used",
  "with",
]);

const PRICE_LIMIT_PREFIX_SOURCE = String.raw`(?:under|below|less\s+than|up\s+to|max(?:imum)?(?:\s+of)?)`;
const MONEY_AMOUNT_SOURCE = String.raw`(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d{1,3}(?:\s+\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?)`;
const LOWEST_PRICE_CONTROL_SOURCE = String.raw`\b(?:lowest\s+prices?|cheapest|price\s+low\s+to\s+high)\b`;
const NEWEST_CONTROL_SOURCE = String.raw`\b(?:newest|latest|most\s+recent|recently\s+listed|new)\b`;
const PRICE_DROP_CONTROL_SOURCE = String.raw`\b(?:price\s+(?:drops?|reductions?|discounts?)|(?:biggest|largest|highest)\s+(?:price\s+)?(?:drops?|reductions?|discounts?)|with\s+(?:the\s+)?(?:(?:biggest|largest|highest)\s+)?(?:price\s+)?(?:drops?|reductions?|discounts?)|discounted\s+most)\b`;
const BROWSE_GENERIC_SOURCE = String.raw`\b(?:all|any|anything|everything|available|designer|luxury|pre[-\s]?(?:loved|owned)|used|fresh|resale|second[-\s]?hand|for\s+sale|sale|items?|products?|listings?|catalog(?:ue)?)\b`;

const CATEGORY_TERMS = [
  { category: "Watches", terms: ["watch", "watches", "cadre", "feline", "pivot", "evermark"] },
  { category: "Jewellery", terms: ["jewellery", "jewelry", "bracelet", "bracelets", "earring", "earrings", "ring", "rings", "diamond", "gold"] },
  { category: "Bags", terms: ["bag", "bags", "flap", "tote", "crossbody", "handbag", "shoulder"] },
  { category: "Dresses", terms: ["dress", "dresses", "maxi", "mini", "slip"] },
  { category: "Shoes", terms: ["shoe", "shoes", "boot", "boots", "sandal", "sandals", "trainer", "trainers", "heel", "heels"] },
  { category: "Accessories", terms: ["accessory", "accessories", "wallet", "scarf", "charm"] },
  { category: "Clothing", terms: ["clothing", "coat", "blazer", "trench", "top", "camisole", "trousers", "knitwear", "corset"] },
];

const PHRASE_INTENTS = [
  {
    id: "dress-watch",
    label: "Dress watch",
    category: "Watches",
    phrases: ["dress watch", "dress watches", "formal watch", "formal watches", "suit watch", "tuxedo watch"],
    shadowTerms: ["dress", "dresses", "watch", "watches"],
  },
];

const CATEGORY_TOKEN_SET = new Set(CATEGORY_TERMS.flatMap(({ terms }) => terms));

const MATERIAL_TERMS = [
  { material: "Leather", terms: ["leather", "calfskin", "taurillon", "grained"] },
  { material: "Silk", terms: ["silk"] },
  { material: "Wool", terms: ["wool", "tweed"] },
  { material: "Steel", terms: ["steel"] },
  { material: "Gold", terms: ["gold", "yellow gold", "rose gold"] },
  { material: "White gold", terms: ["white gold"] },
  { material: "Metal", terms: ["metal"] },
  { material: "Linen", terms: ["linen"] },
  { material: "Cotton", terms: ["cotton"] },
  { material: "Cashmere", terms: ["cashmere"] },
  { material: "Satin", terms: ["satin"] },
  { material: "Canvas", terms: ["canvas"] },
  { material: "Cloth", terms: ["cloth"] },
  { material: "Viscose", terms: ["viscose"] },
  { material: "Lace", terms: ["lace"] },
  { material: "Glitter", terms: ["glitter"] },
];

const MATERIAL_TOKEN_SET = new Set(MATERIAL_TERMS.flatMap(({ terms }) => terms.flatMap((term) => normalizeText(term).split(" "))));

export function normalizeText(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function stripQueryControls(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\s*(?:(?:please|kindly)\s+)?(?:(?:can|could|would)\s+you\s+)?/i, "")
    .replace(/^\s*(?:can|could|would)\s+i\s+(?:see|find|browse|search(?:\s+for)?)\s+/i, "")
    .replace(
      /^\s*(?:(?:please|kindly)\s+)?(?:show(?:\s+me)?|find(?:\s+me)?|search(?:\s+for)?|look\s+for|browse|give\s+me)\s+/i,
      "",
    )
    .replace(/^\s*i(?:\s+am|['’]m)\s+looking\s+for\s+/i, "")
    .replace(/^\s*i\s+(?:would\s+like|want)(?:\s+to\s+(?:see|find))?\s+/i, "")
    .replace(/^\s*i\s+need\s+/i, "")
    .replace(/\s+(?:please|kindly)\s*$/i, "")
    .replace(new RegExp(BROWSE_GENERIC_SOURCE, "gi"), " ")
    .replace(
      new RegExp(
        `\\b${PRICE_LIMIT_PREFIX_SOURCE}\\s*(?:(?:eur|euro|euros|€)\\s*)?${MONEY_AMOUNT_SOURCE}(?:\\s*k)?(?:\\s*(?:eur|euro|euros|€))?(?=\\s|$|[.,;!?])`,
        "gi",
      ),
      " ",
    )
    .replace(
      new RegExp(
        `(?:<=|<)\\s*(?:(?:eur|euro|euros|€)\\s*)?${MONEY_AMOUNT_SOURCE}(?:\\s*k)?(?:\\s*(?:eur|euro|euros|€))?(?=\\s|$|[.,;!?])`,
        "gi",
      ),
      " ",
    )
    .replace(new RegExp(LOWEST_PRICE_CONTROL_SOURCE, "gi"), " ")
    .replace(new RegExp(NEWEST_CONTROL_SOURCE, "gi"), " ")
    .replace(new RegExp(PRICE_DROP_CONTROL_SOURCE, "gi"), " ")
    .replace(/\s+/g, " ")
    .replace(/^(?:and|or|with|the)\b\s*/i, "")
    .replace(/\s*\b(?:and|or|with|the)$/i, "")
    .replace(/^[,;:\s]+|[,;:\s]+$/g, "")
    .trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function titleCase(value) {
  return value
    .toLowerCase()
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function parseMoney(value, suffix = "") {
  const compact = value.replace(/\s/g, "");
  let normalized = compact;
  if (/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(compact)) {
    normalized = compact.replace(/,/g, "");
  } else if (/^\d{1,3}(?:\.\d{3})+(?:,\d+)?$/.test(compact)) {
    normalized = compact.replace(/\./g, "").replace(",", ".");
  } else {
    normalized = compact.replace(",", ".");
  }
  const amount = Number(normalized);
  if (!Number.isFinite(amount)) return null;
  return Math.floor(amount * (suffix.toLowerCase() === "k" ? 1000 : 1));
}

export function parseMaxPrice(query) {
  const q = String(query ?? "").toLowerCase();
  const phraseMatch = q.match(
    new RegExp(
      `\\b${PRICE_LIMIT_PREFIX_SOURCE}\\s*(?:eur|euro|euros|€)?\\s*(${MONEY_AMOUNT_SOURCE})(\\s*k)?\\b`,
      "i",
    ),
  );
  const symbolMatch = q.match(
    new RegExp(`(?:<=|<)\\s*(?:eur|euro|euros|€)?\\s*(${MONEY_AMOUNT_SOURCE})(\\s*k)?\\b`, "i"),
  );
  const match = phraseMatch || symbolMatch;
  if (!match) return null;
  const parsed = parseMoney(match[1], match[2]?.trim());
  return parsed === null ? null : Math.max(1, parsed);
}

export function deriveEffectiveSort(query, requestedSort = "Recommended") {
  if (["Lowest price", "Newest", "Price drop"].includes(requestedSort)) return requestedSort;
  const text = String(query || "");
  if (new RegExp(PRICE_DROP_CONTROL_SOURCE, "i").test(text)) return "Price drop";
  if (new RegExp(LOWEST_PRICE_CONTROL_SOURCE, "i").test(text)) return "Lowest price";
  if (new RegExp(NEWEST_CONTROL_SOURCE, "i").test(text)) return "Newest";
  return "Recommended";
}

function findMatchedMaterials(normalizedQuery) {
  const matches = MATERIAL_TERMS.flatMap(({ material, terms }) =>
    terms.flatMap((term) => {
      const normalizedTerm = normalizeText(term);
      return [...normalizedQuery.matchAll(new RegExp(`\\b${escapeRegExp(normalizedTerm)}\\b`, "g"))].map(
        (match) => ({ material, start: match.index, end: match.index + match[0].length }),
      );
    }),
  );
  const unshadowed = matches.filter(
    (candidate) =>
      !matches.some(
        (other) =>
          other.material !== candidate.material &&
          other.start <= candidate.start &&
          other.end >= candidate.end &&
          other.end - other.start > candidate.end - candidate.start,
      ),
  );
  const matchedMaterials = new Set(unshadowed.map(({ material }) => material));
  return MATERIAL_TERMS.filter(({ material }) => matchedMaterials.has(material)).map(({ material }) => material);
}

export function createQueryUnderstanding(query, catalog) {
  const normalizedQuery = normalizeText(stripQueryControls(query));
  const phraseIntents = PHRASE_INTENTS.map((intent) => ({
    ...intent,
    matchedPhrase: intent.phrases.find((phrase) => new RegExp(`\\b${escapeRegExp(normalizeText(phrase))}\\b`).test(normalizedQuery)),
  })).filter((intent) => intent.matchedPhrase);
  const shadowedCategoryTerms = new Set(phraseIntents.flatMap((intent) => intent.shadowTerms || []));
  const knownBrands = [...new Set(catalog.map((product) => product.brand))]
    .map((brand) => ({ raw: brand, normalized: normalizeText(brand) }))
    .sort((a, b) => b.normalized.length - a.normalized.length);

  const brand = knownBrands.find(({ normalized }) => {
    if (!normalized) return false;
    return new RegExp(`\\b${escapeRegExp(normalized)}\\b`).test(normalizedQuery);
  });

  const categories = [
    ...new Set([
      ...phraseIntents.map((intent) => intent.category),
      ...CATEGORY_TERMS.filter(({ terms }) =>
        terms.some((term) => {
          const normalizedTerm = normalizeText(term);
          if (shadowedCategoryTerms.has(normalizedTerm)) return false;
          return new RegExp(`\\b${escapeRegExp(normalizedTerm)}\\b`).test(normalizedQuery);
        }),
      ).map(({ category }) => category),
    ]),
  ];
  const materials = findMatchedMaterials(normalizedQuery);

  const priceMax = parseMaxPrice(query);
  const brandWords = new Set((brand?.normalized || "").split(" ").filter(Boolean));
  const categoryWords = new Set(categories.flatMap((category) => normalizeText(category).split(" ")));
  const materialWords = new Set(materials.flatMap((material) => normalizeText(material).split(" ")));
  const phraseIntentWords = new Set(
    phraseIntents.flatMap((intent) =>
      [intent.label, intent.matchedPhrase].flatMap((value) => normalizeText(value).split(" ").filter(Boolean)),
    ),
  );
  const tokens = normalizedQuery
    .split(" ")
    .filter(Boolean)
    .filter((token) => token.length > 1)
    .filter((token) => !/^\d+$/.test(token))
    .filter((token) => !GENERIC_TERMS.has(token))
    .filter((token) => !brandWords.has(token))
    .filter((token) => !categoryWords.has(token))
    .filter((token) => !CATEGORY_TOKEN_SET.has(token))
    .filter((token) => !phraseIntentWords.has(token))
    .filter((token) => !materialWords.has(token))
    .filter((token) => !MATERIAL_TOKEN_SET.has(token));

  const chips = [];
  if (brand) chips.push(`Brand: ${titleCase(brand.raw)}`);
  phraseIntents.forEach((intent) => chips.push(`Intent: ${intent.label}`));
  categories.forEach((category) => chips.push(`Category: ${category}`));
  materials.forEach((material) => chips.push(`Material: ${material}`));
  if (priceMax) chips.push(`Budget: under ${priceMax.toLocaleString("en-US")} EUR`);
  if (!chips.length) chips.push("Designer resale", "Fresh listings", "EU shipping");

  const rewrittenParts = [];
  if (brand) rewrittenParts.push(titleCase(brand.raw));
  phraseIntents.forEach((intent) => rewrittenParts.push(intent.label));
  if (tokens.length) rewrittenParts.push(tokens.join(" "));
  const categoriesForRewrite = categories.filter((category) => !phraseIntents.some((intent) => intent.category === category));
  if (categoriesForRewrite.length) rewrittenParts.push(categoriesForRewrite.join(" or "));
  if (materials.length) rewrittenParts.push(materials.join(" or "));
  if (priceMax) rewrittenParts.push(`under ${priceMax.toLocaleString("en-US")} EUR`);

  return {
    brand: brand?.raw || "",
    categories,
    chips,
    intent: brand || categories.length ? "Exact shopping intent" : "Browse",
    materials,
    phraseIntents: phraseIntents.map(({ id, label, category, matchedPhrase, phrases }) => ({
      id,
      label,
      category,
      matchedPhrase,
      phrases,
    })),
    priceMax,
    requiresTextMatch: Boolean(brand || categories.length || materials.length || tokens.length),
    rewritten: rewrittenParts.join(" ") || query || "pre-loved designer items",
    tokenOperator: "and",
    tokens,
  };
}

export function createLiteralQueryPlan(query) {
  const literalQuery = String(query ?? "").trim();
  const tokens = normalizeText(literalQuery).split(" ").filter(Boolean);
  return {
    brand: "",
    categories: [],
    chips: [],
    intent: "",
    materials: [],
    phraseIntents: [],
    priceMax: null,
    requiresTextMatch: Boolean(tokens.length),
    rewritten: literalQuery || "pre-loved designer items",
    tokenOperator: "or",
    tokens,
  };
}

export function buildBasicLexicalQuery(query) {
  const literalQuery = String(query ?? "").trim();
  if (!literalQuery) return { match_all: {} };
  return {
    multi_match: {
      query: literalQuery,
      fields: ["title", "brand", "canonical_text", "description"],
      operator: "or",
    },
  };
}

function matchesFacetFilters(product, filters) {
  return Object.entries(filters).every(([key, values]) => !values.length || values.includes(product[key]));
}

function productText(product) {
  return normalizeText(
    [
      product.brand,
      product.title,
      product.category,
      product.genderAffinity,
      product.material,
      product.color,
      product.condition,
      product.country,
      product.size,
      product.canonical_text,
      ...(product.reasons || []),
    ].join(" "),
  );
}

function matchesQuery(product, understanding) {
  if (!understanding.requiresTextMatch) return true;
  if (understanding.brand && normalizeText(product.brand) !== normalizeText(understanding.brand)) return false;
  if (understanding.categories.length && !understanding.categories.includes(product.category)) return false;
  if (understanding.materials?.length && !understanding.materials.includes(product.material)) return false;
  if (!understanding.tokens.length) return true;

  const text = productText(product);
  const tokenMatches = understanding.tokens.map((token) => text.includes(token));
  return understanding.tokenOperator === "or" ? tokenMatches.some(Boolean) : tokenMatches.every(Boolean);
}

function scoreProduct(product, understanding, selectedFilters) {
  let score = product.score;
  const text = productText(product);

  if (understanding.brand && normalizeText(product.brand) === normalizeText(understanding.brand)) score += 220;
  if (understanding.categories.includes(product.category)) score += 80;
  if (understanding.materials?.includes(product.material)) score += 45;
  understanding.phraseIntents?.forEach((intent) => {
    if (product.category === intent.category) score += 60;
    if (text.includes(normalizeText(intent.label)) || text.includes(normalizeText(intent.matchedPhrase))) score += 90;
  });
  understanding.tokens.forEach((token) => {
    if (normalizeText(product.title).includes(token)) score += 45;
    else if (text.includes(token)) score += 18;
  });

  Object.entries(selectedFilters).forEach(([key, values]) => {
    if (values.length && values.includes(product[key])) score += 8;
  });

  return score;
}

function scorePersonaAffinity(product, persona, categories) {
  const expansion = getPersonaQueryExpansion(persona, categories);
  if (!expansion) return 0;

  const terms = [
    ...new Set(
      normalizeText(String(expansion).slice(0, 120))
        .split(" ")
        .filter((term) => term.length > 2),
    ),
  ].slice(0, 16);
  const title = normalizeText(product.title);
  const text = productText(product);
  const affinity = terms.reduce((score, term) => {
    if (title.includes(term)) return score + 5;
    if (text.includes(term)) return score + 3;
    return score;
  }, 0);

  // Persona terms are soft signals: they can break close relevance ties but never
  // become filters or overwhelm the shopper's explicit query.
  return Math.min(affinity, 30);
}

export function localSearchProducts(items, { query, filters, maxPrice, sort, persona, queryUnderstanding = true }) {
  const understanding = queryUnderstanding
    ? createQueryUnderstanding(query, items)
    : createLiteralQueryPlan(query);
  const requestedPriceLimit = Number(maxPrice) || 20000;
  const priceLimit = requestedPriceLimit;
  const effectiveSort = queryUnderstanding ? deriveEffectiveSort(query, sort) : sort;
  const personaCategories = [
    ...understanding.categories,
    ...(Array.isArray(filters?.category) ? filters.category : []),
  ];
  const filtered = items
    .filter((item) => matchesFacetFilters(item, filters))
    .filter((item) => item.price <= priceLimit)
    .filter((item) => matchesQuery(item, understanding))
    .map((product) => ({
      ...product,
      computedScore:
        scoreProduct(product, understanding, filters) + scorePersonaAffinity(product, persona, personaCategories),
    }));

  if (effectiveSort === "Lowest price") {
    return filtered.sort((a, b) => a.price - b.price || b.computedScore - a.computedScore);
  }
  if (effectiveSort === "Newest") {
    return filtered.sort(
      (a, b) => new Date(b.listed_at) - new Date(a.listed_at) || b.computedScore - a.computedScore,
    );
  }
  if (effectiveSort === "Price drop") {
    return filtered.sort(
      (a, b) => (Number(b.oldPrice) || Number.NEGATIVE_INFINITY) - (Number(a.oldPrice) || Number.NEGATIVE_INFINITY) || b.computedScore - a.computedScore,
    );
  }
  return filtered.sort((a, b) => b.computedScore - a.computedScore);
}
