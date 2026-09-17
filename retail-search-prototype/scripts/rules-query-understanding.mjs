import { products } from "../src/data/catalog.js";
import { createLiteralQueryPlan, deriveEffectiveSort, normalizeText } from "../src/lib/search.js";

// This compiler is server-only. Vocabulary comes from the catalogue, never from
// shopper-supplied field names or DSL. No model, rewrite service, or persona data.
const TEXT_FIELDS = ["title^4", "brand^3", "canonical_text^2", "description"];
const CATEGORY_ALIASES = {
  Watches: ["watch", "watches", "timepiece", "timepieces"],
  Jewellery: ["jewellery", "jewelry", "jewels"],
  Bags: ["bag", "bags", "handbag", "handbags"],
  Dresses: ["dress", "dresses"],
  Shoes: ["shoe", "shoes", "footwear"],
  Clothing: ["clothing", "clothes"],
  Accessories: ["accessory", "accessories"],
};
// Subtypes establish a category but stay in the text query: boots must not
// silently expand to every shoe, nor rings to every piece of jewellery.
const SUBTYPES = {
  Watches: ["dress watch", "dress watches", "formal watch", "formal watches", "suit watch", "suit watches", "bracelet watch", "bracelet watches"],
  Jewellery: ["ring", "rings", "bracelet", "bracelets", "earring", "earrings", "necklace", "necklaces"],
  Bags: ["tote", "totes", "crossbody", "shoulder bag"],
  Shoes: ["boot", "boots", "sandal", "sandals", "trainer", "trainers", "heel", "heels", "sneaker", "sneakers"],
  Clothing: ["coat", "coats", "blazer", "blazers", "jacket", "jackets", "trench", "top", "tops", "camisole", "trousers", "knitwear", "corset"],
  Accessories: ["wallet", "wallets", "scarf", "scarves", "bag charm", "charm", "charms"],
};
const COUNTRY_ALIASES = {
  France: ["french"], Italy: ["italian"], Spain: ["spanish"], Germany: ["german"],
  Austria: ["austrian"], Belgium: ["belgian"], Netherlands: ["dutch", "holland"],
  Switzerland: ["swiss"], "United Kingdom": ["british", "uk", "britain"],
  "United States": ["american", "usa"], Japan: ["japanese"],
  Portugal: ["portuguese"], Greece: ["greek"], Sweden: ["swedish"],
  Bulgaria: ["bulgarian"], Monaco: ["monegasque"],
};
const MATERIAL_ALIASES = { Leather: ["calfskin", "taurillon"], Wool: ["tweed"], Steel: ["stainless steel"], Gold: ["yellow gold", "rose gold"] };
const COLOR_ALIASES = { Grey: ["gray"], Multicolour: ["multicolor", "multicolored", "multicoloured"], Ecru: ["cream"] };
const fold = (value) => String(value).normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
// Match the index's lowercase/asciifolding normalizer, preserving '&' and '-'.
const keyword = (value) => fold(value).trim();
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const values = (field) => [...new Set(products.map((product) => product[field]).filter(Boolean))];
const dictionary = [];
function addEntries(field, entries, aliases = {}, retain = false) {
  for (const value of entries) {
    for (const alias of [value, ...(aliases[value] || [])]) {
      dictionary.push({ field, value, alias: normalizeText(alias), retain });
    }
  }
}
addEntries("brand.keyword", values("brand"));
addEntries("category", values("category"), CATEGORY_ALIASES);
for (const [category, aliases] of Object.entries(SUBTYPES)) {
  for (const alias of aliases) dictionary.push({ field: "category", value: category, alias, retain: true });
}
addEntries("material", values("material"), MATERIAL_ALIASES);
addEntries("color", values("color"), COLOR_ALIASES);
addEntries("country", values("country"), COUNTRY_ALIASES);
addEntries("condition", values("condition"));
dictionary.sort((a, b) => b.alias.length - a.alias.length);

// Price extraction runs before punctuation normalization so decimal/thousands
// separators survive. Amounts are EUR, matching the catalogue's price field.
const AMOUNT = String.raw`(?:\d{1,3}(?:[, .]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)(?:\s*k)?`;
const MONEY = String.raw`(?:eur\s*|euros?\s*|\u20ac\s*)?(${AMOUNT})(?:\s*(?:euros?|eur|\u20ac))?`;
function money(value) {
  let compact = value.replace(/\s/g, "");
  const multiplier = /k$/i.test(compact) ? 1000 : 1;
  compact = compact.replace(/k$/i, "");
  if (/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(compact)) compact = compact.replace(/,/g, "");
  else if (/^\d{1,3}(?:\.\d{3})+(?:,\d+)?$/.test(compact)) compact = compact.replace(/\./g, "").replace(",", ".");
  else compact = compact.replace(",", ".");
  return Number(compact) * multiplier;
}
function extractPrices(text, mode, constraints) {
  const patterns = [
    [new RegExp(`\\bbetween\\s+${MONEY}\\s+and\\s+${MONEY}(?![\\w.,]\\d)`, "gi"), (a, b) => ({ gte: money(a), lte: money(b) })],
    [new RegExp(`\\bfrom\\s+${MONEY}\\s+to\\s+${MONEY}(?![\\w.,]\\d)`, "gi"), (a, b) => ({ gte: money(a), lte: money(b) })],
    [new RegExp(`(?:\\b(?:under|below|less\\s+than)|(?<![<>])<(?!=))\\s*${MONEY}(?![\\w.,]\\d)`, "gi"), (a) => ({ lt: money(a) })],
    [new RegExp(`(?:\\b(?:up\\s+to|at\\s+most|no\\s+more\\s+than|max(?:imum)?(?:\\s+(?:price|budget|of))?|budget(?:\\s+of)?)|<=)\\s*${MONEY}(?![\\w.,]\\d)`, "gi"), (a) => ({ lte: money(a) })],
    [new RegExp(`(?:\\b(?:over|above|more\\s+than)|(?<![<>])>(?!=))\\s*${MONEY}(?![\\w.,]\\d)`, "gi"), (a) => ({ gt: money(a) })],
    [new RegExp(`(?:\\b(?:at\\s+least|min(?:imum)?(?:\\s+(?:price|of))?)|>=)\\s*${MONEY}(?![\\w.,]\\d)`, "gi"), (a) => ({ gte: money(a) })],
  ];
  for (const [pattern, toRange] of patterns) {
    text = text.replace(pattern, (...args) => {
      const range = toRange(args[1], args[2]);
      constraints.push({ field: "price", range, mode, matched: args[0] });
      return " ";
    });
  }
  return text;
}

function clauses(query) {
  // Preference/exclusion scope ends at punctuation or an explicit hard marker.
  const markers = /\b(preferably|ideally|prefer|preferred|if possible|must(?:\s+be)?|only|but|not|without|excluding|except|no(?!\s+more\s+than))\b|[,;](?!\d)/gi;
  const result = [];
  let mode = "hard";
  let start = 0;
  for (const match of query.matchAll(markers)) {
    result.push({ text: query.slice(start, match.index), mode });
    mode = /^(prefer|ideal|if possible)/i.test(match[0]) ? "soft"
      : /^(not|without|excluding|except|no)$/i.test(match[0]) ? "exclude" : "hard";
    start = match.index + match[0].length;
  }
  result.push({ text: query.slice(start), mode });
  return result;
}

function cleanResidual(text) {
  return text
    .replace(/\b(?:please|kindly|show me|show|find me|find|search for|looking for|i want|i need|i would like|can you|could you|i|me)\b/g, " ")
    .replace(/\b(?:lowest prices?|cheapest|price low to high|newest|latest|most recent|recently listed|price drops?)\b/g, " ")
    .replace(/\b(?:all|any|available|designer|luxury|pre loved|pre owned|second hand|resale|items?|products?|listings?|catalogue|catalog|a|an|the|and|or|in|of|from|with|for|by|is|be|that|are|seller|sellers|ships|shipping|colour|color|coloured|colored|material)\b/g, " ")
    .replace(/\s+/g, " ").trim();
}

function extractEntities(text, mode, constraints, context) {
  const normalized = normalizeText(text);
  const occupied = new Set();
  const removals = new Set();
  // A watch phrase shadows dress/bracelet as categories. Gold is a material in
  // watch/jewellery intent, a color in bags/clothing, never both by accident.
  const watchIntent = /\b(?:watch|watches|timepiece)\b/.test(context);
  const wearableIntent = /\b(?:bag|bags|dress|dresses|shoe|shoes|clothing|coat|wallet)\b/.test(context) && !watchIntent;
  const entries = [...dictionary].sort((a, b) => {
    if (a.field === "brand.keyword" && b.field !== a.field) return -1;
    if (b.field === "brand.keyword" && a.field !== b.field) return 1;
    if (a.alias.length !== b.alias.length) return b.alias.length - a.alias.length;
    return 0;
  });
  for (const entry of entries) {
    for (const match of normalized.matchAll(new RegExp(`\\b${escapeRegex(entry.alias)}\\b`, "g"))) {
      const positions = Array.from({ length: match[0].length }, (_, index) => match.index + index);
      if (positions.some((position) => occupied.has(position))) continue;
      if (entry.alias === "gold") {
        const explicitColor = /\bcolou?r\s*$/.test(normalized.slice(0, match.index))
          || /^\s+colou?red?\b/.test(normalized.slice(match.index + match[0].length));
        if (entry.field !== (wearableIntent || explicitColor ? "color" : "material")) continue;
      }
      // Manufacturing origin is not seller location. Leave unsupported origin
      // language as text rather than assert a provenance the catalogue lacks.
      if (entry.field === "country" && /\b(?:made in|manufactured in|origin(?:ating)?(?: from| in)?)\s*$/.test(normalized.slice(0, match.index))) continue;
      // Material on a strap/lining is not necessarily the listing's material.
      if (entry.field === "material" && /^\s+(?:strap|band|lining|trim)\b/.test(normalized.slice(match.index + match[0].length))) continue;
      if (watchIntent && entry.field === "category" && entry.value === "Jewellery") continue;
      if (!(entry.retain && mode === "exclude")) {
        constraints.push({ field: entry.field, values: [keyword(entry.value)], label: entry.value, mode, matched: match[0] });
      }
      positions.forEach((position) => occupied.add(position));
      if (!entry.retain) positions.forEach((position) => removals.add(position));
      // Dress/formal/suit watch is a style preference, keeping the broad watch
      // candidate set. Other subtypes remain required residual text.
      if (entry.field === "category" && entry.value === "Watches" && entry.retain && mode !== "exclude") {
        constraints.push({ field: "text", text: match[0], mode: mode === "exclude" ? "exclude" : "soft", matched: match[0] });
        positions.forEach((position) => removals.add(position));
      }
    }
  }
  let residual = [...normalized].map((char, index) => removals.has(index) ? " " : char).join("");
  residual = residual.replace(/\b(women s|womens|women|female|men s|mens|men|male|unisex)\b/g, (match) => {
    const affinity = match.startsWith("women") || match === "female" ? "women" : match === "unisex" ? "unisex" : "men";
    constraints.push({ field: "gender_affinity", values: affinity === "unisex" || mode === "exclude" ? [affinity] : [affinity, "unisex"], label: affinity, mode, matched: match });
    return " ";
  });
  // The catalogue uses the standard analyzer, so resolve common subtype number
  // variants to the actual product vocabulary rather than assuming stemming.
  return cleanResidual(residual).replace(/\b(rings|bracelets|necklaces|wallets|coats|blazers|jackets|scarves|boot|sandal|trainer|heel|earring)\b/g, (word) => ({
    rings: "ring", bracelets: "bracelet", necklaces: "necklace", wallets: "wallet", coats: "coat", blazers: "blazer", jackets: "jacket", scarves: "scarf",
    boot: "boots", sandal: "sandals", trainer: "trainers", heel: "heels", earring: "earrings",
  })[word]);
}

function textClause(text) {
  return { multi_match: { query: text, fields: TEXT_FIELDS, operator: "and" } };
}

export function compileAnonymousQuery({ query = "", filters = {}, maxPrice = 20000, sort = "Recommended", size = 48, trackTotalHits = 10000 }) {
  const constraints = [];
  const residuals = [];
  for (const { text, mode } of clauses(fold(query))) {
    const residual = extractEntities(extractPrices(text, mode, constraints), mode, constraints, normalizeText(query));
    if (!residual) continue;
    if (mode === "hard") residuals.push(residual);
    else constraints.push({ field: "text", text: residual, mode, matched: residual });
  }
  const filter = [{ term: { availability: "active" } }];
  const should = [];
  const mustNot = [];
  const priceRange = { lte: maxPrice };
  // UI selections remain independent hard constraints. Contradictory explicit
  // requests return no matches; they are never silently loosened.
  for (const [field, selected] of Object.entries(filters)) {
    if (selected.length) filter.push({ terms: { [field]: selected.map(keyword) } });
  }
  const grouped = new Map();
  for (const constraint of constraints) {
    if (constraint.field === "price" && constraint.mode === "hard") {
      for (const [operator, amount] of Object.entries(constraint.range)) {
        priceRange[operator] = priceRange[operator] === undefined ? amount
          : operator.startsWith("l") ? Math.min(priceRange[operator], amount) : Math.max(priceRange[operator], amount);
      }
    } else if (constraint.values) {
      const key = `${constraint.mode}:${constraint.field}`;
      const group = grouped.get(key) || { ...constraint, values: [] };
      group.values = [...new Set([...group.values, ...constraint.values])];
      grouped.set(key, group);
    } else {
      const clause = constraint.range ? { range: { price: constraint.range } } : textClause(constraint.text);
      (constraint.mode === "exclude" ? mustNot : should).push(clause);
    }
  }
  // OpenSearch accepts one upper and one lower bound per range. Collapse the
  // independent limits to the tighter bound, retaining strictness on ties.
  if (priceRange.lt !== undefined && priceRange.lte !== undefined) {
    delete priceRange[priceRange.lt <= priceRange.lte ? "lte" : "lt"];
  }
  if (priceRange.gt !== undefined && priceRange.gte !== undefined) {
    delete priceRange[priceRange.gt >= priceRange.gte ? "gte" : "gt"];
  }
  filter.push({ range: { price: priceRange } });
  for (const { field, values: selected, mode } of grouped.values()) {
    (mode === "soft" ? should : mode === "exclude" ? mustNot : filter).push({ terms: { [field]: selected } });
  }
  const residualQuery = residuals.join(" ");
  const bool = { filter };
  if (residualQuery) bool.must = [textClause(residualQuery)];
  if (should.length) { bool.should = should; bool.minimum_should_match = 0; }
  if (mustNot.length) bool.must_not = mustNot;
  const effectiveSort = deriveEffectiveSort(query, sort);
  const dslQuery = { size, track_total_hits: trackTotalHits, query: { bool } };
  if (effectiveSort === "Lowest price") dslQuery.sort = [{ price: { order: "asc" } }, { _score: { order: "desc" } }];
  if (effectiveSort === "Newest") dslQuery.sort = [{ listed_at: { order: "desc" } }, { _score: { order: "desc" } }];
  if (effectiveSort === "Price drop") dslQuery.sort = [{ old_price: { order: "desc", missing: "_last" } }, { _score: { order: "desc" } }];
  const labels = (field) => [...new Set(constraints.filter((c) => c.field === field && c.mode === "hard").map((c) => c.label))];
  const chips = [...new Set(constraints.map((c) => {
    const prefix = c.mode === "soft" ? "Prefer" : c.mode === "exclude" ? "Exclude" : c.field === "country" ? "Seller country" : c.field.replace(".keyword", "").replace("_", " ");
    return `${prefix}: ${c.label || c.matched}`;
  }))];
  return {
    dslQuery,
    queryPlan: {
      ...createLiteralQueryPlan(query),
      brand: labels("brand.keyword").join(" or "),
      categories: labels("category"), materials: labels("material"), colors: labels("color"), countries: labels("country"),
      chips, intent: constraints.length ? "Shopping intent" : "Text search",
      priceMax: priceRange.lte ?? priceRange.lt,
      rewritten: [residualQuery, ...chips].filter(Boolean).join(" | ") || "All available items",
      residualQuery, tokens: residualQuery.split(" ").filter(Boolean), tokenOperator: "and",
      requiresTextMatch: Boolean(residualQuery), constraints,
      queryUnderstanding: { status: "enabled", engine: "rules", version: 1 },
      personalization: { personaId: "anonymous", personaVersion: 1, status: "unprofiled" },
      agentic: { status: "not_called" },
      tier2: { status: "not_called", rules: [] },
    },
  };
}
