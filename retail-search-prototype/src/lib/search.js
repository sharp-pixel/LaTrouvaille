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
  "pre",
  "preloved",
  "resale",
  "second",
  "than",
  "the",
  "under",
  "up",
  "used",
]);

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
  const normalized = value.replace(/\s/g, "").replace(",", ".");
  const amount = Number(normalized);
  if (!Number.isFinite(amount)) return null;
  return Math.round(amount * (suffix.toLowerCase() === "k" ? 1000 : 1));
}

export function parseMaxPrice(query) {
  const q = String(query ?? "").toLowerCase();
  const phraseMatch = q.match(
    /\b(?:under|below|max|less than|up to)\s*(?:eur|euro|euros|€)?\s*([0-9]+(?:[.,][0-9]+)?)(\s*k)?\b/,
  );
  const symbolMatch = q.match(/(?:<|<=)\s*(?:eur|euro|euros|€)?\s*([0-9]+(?:[.,][0-9]+)?)(\s*k)?\b/);
  const match = phraseMatch || symbolMatch;
  if (!match) return null;
  return parseMoney(match[1], match[2]?.trim());
}

export function createQueryUnderstanding(query, catalog) {
  const normalizedQuery = normalizeText(query);
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
  const materials = MATERIAL_TERMS.filter(({ terms }) =>
    terms.some((term) => new RegExp(`\\b${escapeRegExp(normalizeText(term))}\\b`).test(normalizedQuery)),
  ).map(({ material }) => material);

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
    tokens,
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
  return understanding.tokens.every((token) => text.includes(token));
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

export function localSearchProducts(items, { query, filters, maxPrice, sort }) {
  const understanding = createQueryUnderstanding(query, items);
  const priceLimit = Number(maxPrice) || 20000;
  const filtered = items
    .filter((item) => matchesFacetFilters(item, filters))
    .filter((item) => item.price <= priceLimit)
    .filter((item) => matchesQuery(item, understanding))
    .map((product) => ({
      ...product,
      computedScore: scoreProduct(product, understanding, filters),
    }));

  if (sort === "Lowest price") return filtered.sort((a, b) => a.price - b.price);
  if (sort === "Newest") return filtered.sort((a, b) => new Date(b.listed_at) - new Date(a.listed_at));
  if (sort === "Price drop") {
    return filtered.sort((a, b) => Number(Boolean(b.oldPrice)) - Number(Boolean(a.oldPrice)) || b.computedScore - a.computedScore);
  }
  return filtered.sort((a, b) => b.computedScore - a.computedScore);
}
