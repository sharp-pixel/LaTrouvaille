import { deriveEffectiveSort, stripQueryControls } from "./search.js";
import { getPersonaQueryExpansion } from "../data/personas.js";

export { deriveEffectiveSort } from "./search.js";

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
const CANONICAL_MULTI_MATCH_FIELDS = ["title^5", "brand^3", "canonical_text^3", "description"];
const RECOMMENDED_RANK_FEATURES = new Map([
  ["quality_score", 0.2],
  ["freshness_score", 0.05],
  ["seller_score", 0.02],
]);
export const PERSONA_EXPANSION_BOOST = 0.35;
export const MAX_PERSONA_CONTEXT_LENGTH = 512;
const MAX_PERSONA_ID_LENGTH = 64;
const MAX_PERSONA_ARCHETYPE_LENGTH = 64;
const MAX_PERSONA_BACKGROUND_LENGTH = 160;
const MAX_PERSONA_MENTAL_MODEL_LENGTH = 160;
const MAX_PERSONA_QUERY_EXPANSION_LENGTH = 120;
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
const MAX_AGENTIC_QUERY_TEXT_LENGTH = 1000;
const MAX_SERVICE_TEXT_QUERY_LENGTH = 300;
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
  Recommended: "recommended",
  "Lowest price": "price_asc",
  Newest: "listed_at_desc",
  "Price drop": "old_price_desc",
};

export function buildAgenticQueryText({
  query,
  filters = {},
  maxPrice = 20000,
  sort = "Recommended",
  size = 48,
  trackTotalHits = 10000,
  understanding = {},
  persona,
}) {
  const priceCeiling = Number(maxPrice) || 20000;
  const resultSize = Math.min(Math.max(Math.trunc(Number(size) || 48), 1), 96);
  const totalHits =
    trackTotalHits === true
      ? 10000
      : trackTotalHits === false
        ? 0
        : Math.max(0, Math.trunc(Number(trackTotalHits) || 0));
  const mandatoryFilters = buildMandatoryFilters(filters, priceCeiling);
  const { textQuery, textOperator } = buildServiceTextRecipe({ query, filters, sort, understanding });
  if (!textQuery) {
    throw new Error("Agentic query requires descriptive text; use the deterministic browse path");
  }

  const contract = JSON.stringify({
    filter: mandatoryFilters,
    size: resultSize,
    track_total_hits: totalHits,
    sort_mode: SORT_INSTRUCTIONS[sort] || SORT_INSTRUCTIONS.Recommended,
    ...(sort === "Recommended" ? {} : { rank_features: false }),
    text_operator: textOperator,
    base_text_query: textQuery,
    persona: buildTrustedPersonaContext(persona),
  });
  const prefix = "Normalized shopper request: ";
  const suffix = [
    `Immutable service contract: ${contract}`,
    "Copy the core contract exactly. Apply persona only through the system persona-should recipe. Follow sort_mode.",
  ].join("\n");
  const shopperBudget = MAX_AGENTIC_QUERY_TEXT_LENGTH - prefix.length - suffix.length - 1;
  if (shopperBudget < 1) {
    throw new Error("Agentic service contract exceeds the native 1000-character query_text limit");
  }
  const shopperRequest = buildNormalizedShopperRequest(textQuery, sort, priceCeiling);
  if (shopperRequest.length > shopperBudget) {
    throw new Error(
      "Agentic normalized shopper request and service contract exceed the native 1000-character query_text limit",
    );
  }
  return `${prefix}${shopperRequest}\n${suffix}`;
}

function buildNormalizedShopperRequest(textQuery, sort, priceCeiling) {
  const base = String(textQuery).replace(/\s+/g, " ").trim();
  const boundedPrice = Math.max(1, Math.trunc(Number(priceCeiling) || 20000));
  if (sort === "Lowest price") return `cheapest ${base} under ${boundedPrice}`;
  if (sort === "Newest") return `newest ${base} under ${boundedPrice}`;
  if (sort === "Price drop") return `${base} with biggest price drops under ${boundedPrice}`;
  return `${base} under ${boundedPrice}`;
}

function boundedPersonaText(value, field, maxLength) {
  if (typeof value !== "string") throw new Error(`Trusted persona ${field} must be a string`);
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length > maxLength || /[\r\n]/.test(value)) {
    throw new Error(`Trusted persona ${field} must contain 1-${maxLength} single-line characters`);
  }
  return normalized;
}

export function buildTrustedPersonaContext(persona = {}, categories = []) {
  const rawId = persona?.id ?? persona?.personaId ?? "anonymous";
  const id = boundedPersonaText(rawId, "id", MAX_PERSONA_ID_LENGTH);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
    throw new Error("Trusted persona id must be a lowercase kebab-case identifier");
  }
  const rawVersion = persona?.version ?? persona?.personaVersion ?? 1;
  const version = rawVersion;
  if (!Number.isInteger(version) || version < 1 || version > 1000) {
    throw new Error("Trusted persona version must be an integer between 1 and 1000");
  }
  const rawExpansion = getPersonaQueryExpansion(persona, categories);
  if (id === "anonymous" || rawExpansion === "") {
    return Object.freeze({ id: "anonymous", version: 1, mode: "unprofiled" });
  }

  const context = {
    id,
    version,
    archetype: boundedPersonaText(persona?.archetype, "archetype", MAX_PERSONA_ARCHETYPE_LENGTH),
    background: boundedPersonaText(persona?.background, "background", MAX_PERSONA_BACKGROUND_LENGTH),
    mental_model: boundedPersonaText(
      persona?.mentalModel ?? persona?.mental_model,
      "mental_model",
      MAX_PERSONA_MENTAL_MODEL_LENGTH,
    ),
    query_expansion: boundedPersonaText(
      rawExpansion,
      "query_expansion",
      MAX_PERSONA_QUERY_EXPANSION_LENGTH,
    ),
  };
  if (JSON.stringify(context).length > MAX_PERSONA_CONTEXT_LENGTH) {
    throw new Error(`Trusted persona context exceeds ${MAX_PERSONA_CONTEXT_LENGTH} characters`);
  }
  return Object.freeze(context);
}

export function buildPersonaQueryClause(persona) {
  const context = buildTrustedPersonaContext(persona);
  if (context.mode === "unprofiled") return null;
  return {
    multi_match: {
      query: context.query_expansion,
      fields: [...CANONICAL_MULTI_MATCH_FIELDS],
      operator: "or",
      boost: PERSONA_EXPANSION_BOOST,
    },
  };
}

export function buildPersonalizedRewrite(baseTextQuery, persona) {
  const base = String(baseTextQuery || "").replace(/\s+/g, " ").trim();
  const context = buildTrustedPersonaContext(persona);
  return context.mode === "unprofiled" ? base : `${base} ${context.query_expansion}`.trim();
}

export function buildLocalPersonalizationPlan(queryPlan = {}, persona, selectedCategories = []) {
  const basePlan = queryPlan && typeof queryPlan === "object" && !Array.isArray(queryPlan) ? queryPlan : {};
  const personaCategories = [
    ...(Array.isArray(basePlan.categories) ? basePlan.categories : []),
    ...(Array.isArray(selectedCategories) ? selectedCategories : []),
  ];
  const context = buildTrustedPersonaContext(persona, personaCategories);
  const baseRewrite = String(basePlan.rewritten || "").replace(/\s+/g, " ").trim();
  const personalizedRewrite =
    context.mode === "unprofiled" ? baseRewrite : `${baseRewrite} ${context.query_expansion}`.trim();
  return {
    ...basePlan,
    ...(personalizedRewrite !== baseRewrite ? { baseRewrite } : {}),
    rewritten: personalizedRewrite,
    personalizedRewrite,
    personalization: {
      personaId: context.id,
      personaVersion: context.version,
      status: context.mode === "unprofiled" ? "unprofiled" : "fallback",
      query: personalizedRewrite,
    },
  };
}

function cleanServiceTextQuery(query) {
  return stripQueryControls(query || "Show all available items").slice(0, MAX_SERVICE_TEXT_QUERY_LENGTH).trim();
}

export function buildServiceTextRecipe({ query, filters = {}, understanding = {} }) {
  const cleaned = cleanServiceTextQuery(query);
  const phraseIntents = Array.isArray(understanding.phraseIntents) ? understanding.phraseIntents : [];
  const phraseLabels = phraseIntents
    .map((intent) => (typeof intent?.label === "string" ? intent.label.trim() : ""))
    .filter(Boolean);

  const facetValues = AGENTIC_FILTER_FIELDS.flatMap((field) => normalizedFilterValues(filters[field]));
  const facetTokenKeys = new Set(
    facetValues.flatMap((value) => intentTokens(value).map(({ key }) => key)),
  );
  const phraseTokenKeys = new Set(
    phraseIntents.flatMap((intent) =>
      [intent?.label, intent?.matchedPhrase, ...(Array.isArray(intent?.phrases) ? intent.phrases : [])].flatMap(
        (value) => intentTokens(value).map(({ key }) => key),
      ),
    ),
  );
  const connectorKeys = new Set([
    "a",
    "an",
    "and",
    "condition",
    "conditions",
    "for",
    "from",
    "in",
    "made",
    "of",
    "or",
    "the",
    "with",
  ]);
  const residual = intentTokens(cleaned).filter(
    ({ key }) => !facetTokenKeys.has(key) && !phraseTokenKeys.has(key) && !connectorKeys.has(key),
  );
  if (phraseLabels.length) {
    const descriptorValues = [...new Map(residual.map(({ key, value }) => [key, value])).values()];
    return {
      textQuery: (descriptorValues.length ? descriptorValues : [...new Set(phraseLabels)])
        .join(" ")
        .slice(0, MAX_SERVICE_TEXT_QUERY_LENGTH),
      textOperator: descriptorValues.length ? "and" : "or",
    };
  }
  if (facetTokenKeys.size && residual.length) {
    return {
      textQuery: residual
        .map(({ value }) => value)
        .join(" ")
        .slice(0, MAX_SERVICE_TEXT_QUERY_LENGTH),
      textOperator: "and",
    };
  }
  if (facetValues.length) {
    return {
      textQuery: [...new Set(facetValues)].join(" ").slice(0, MAX_SERVICE_TEXT_QUERY_LENGTH),
      textOperator: defaultServiceTextOperator(filters),
    };
  }
  return {
    textQuery: residual.length ? cleaned : "",
    textOperator: understanding.brand ? "and" : defaultServiceTextOperator(filters),
  };
}

export function buildServiceTextQuery(query, sort = "Recommended", filters = {}, understanding = {}) {
  return buildServiceTextRecipe({ query, filters, sort, understanding }).textQuery;
}

export function buildServiceTextOperator(filters = {}, query, sort = "Recommended", understanding = {}) {
  if (typeof query === "string" && query.trim()) {
    return buildServiceTextRecipe({ query, filters, sort, understanding }).textOperator;
  }
  return defaultServiceTextOperator(filters);
}

export function buildRecommendedRankFeatureClauses(sort = "Recommended") {
  if (sort !== "Recommended") return [];
  return [...RECOMMENDED_RANK_FEATURES].map(([field, boost]) => ({ rank_feature: { field, boost } }));
}

function defaultServiceTextOperator(filters) {
  const facetValueCounts = AGENTIC_FILTER_FIELDS.map((field) => normalizedFilterValues(filters[field]).length);
  return facetValueCounts.every((count) => count === 0) || facetValueCounts.some((count) => count > 1) ? "or" : "and";
}

function intentTokens(value) {
  const matches = String(value).match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) || [];
  return matches.map((token) => ({ value: token, key: intentTokenKey(token) }));
}

function intentTokenKey(value) {
  const normalized = normalizeFilterValue(value);
  if (normalized.length > 4 && normalized.endsWith("ies")) return `${normalized.slice(0, -3)}y`;
  if (normalized.length > 4 && /(ches|shes|sses|xes|zes)$/.test(normalized)) return normalized.slice(0, -2);
  if (normalized.length > 3 && normalized.endsWith("s") && !normalized.endsWith("ss")) {
    return normalized.slice(0, -1);
  }
  return normalized;
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

export function deriveAgenticServiceConstraints({ filters = {}, maxPrice = 20000, understanding = {} }) {
  const sanitizedFilters = Object.fromEntries(
    AGENTIC_FILTER_FIELDS.map((field) => [field, sanitizeFilterValues(filters[field])]),
  );
  const effectiveFilters = {
    ...sanitizedFilters,
    category: sanitizedFilters.category.length
      ? sanitizedFilters.category
      : sanitizeFilterValues(understanding.categories),
    material: sanitizedFilters.material.length
      ? sanitizedFilters.material
      : sanitizeFilterValues(understanding.materials),
  };
  const requestedPrice = Number(maxPrice);
  const boundedPrice = Number.isFinite(requestedPrice)
    ? Math.min(Math.max(Math.trunc(requestedPrice), 1), 20000)
    : 20000;
  const rawUnderstoodPrice = understanding.priceMax;
  const hasUnderstoodPrice =
    (typeof rawUnderstoodPrice === "number" ||
      (typeof rawUnderstoodPrice === "string" && rawUnderstoodPrice.trim() !== "")) &&
    Number.isFinite(Number(rawUnderstoodPrice));
  const understoodPrice = hasUnderstoodPrice ? Number(rawUnderstoodPrice) : null;
  const effectiveMaxPrice =
    understoodPrice !== null
      ? Math.min(boundedPrice, Math.min(Math.max(Math.trunc(understoodPrice), 1), 20000))
      : boundedPrice;
  return { filters: effectiveFilters, maxPrice: effectiveMaxPrice };
}

export function validateAgenticDsl({
  dslQuery,
  filters = {},
  maxPrice,
  shopperQuery,
  sort,
  size,
  trackTotalHits,
  understanding = {},
  persona,
}) {
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
  const expectedFilters = buildMandatoryFilters(filters, maxPrice);
  if (!structuralJsonEqual(positiveFilters, expectedFilters)) {
    throw new Error("Agentic query must copy the immutable service-contract filters exactly");
  }
  const requiredConstraintFields = new Set(["availability", "price"]);
  for (const field of AGENTIC_FILTER_FIELDS) {
    if (normalizedFilterValues(filters[field]).length) requiredConstraintFields.add(field);
  }
  if (!containsExactFilter(positiveFilters, "availability", "active", { normalize: false })) {
    throw new Error("Agentic query omitted the availability filter");
  }
  if (!containsRangeFilter(positiveFilters, "price", "lte", Number(maxPrice))) {
    throw new Error("Agentic query omitted the price ceiling");
  }
  for (const field of AGENTIC_FILTER_FIELDS) {
    const values = normalizedFilterValues(filters[field]);
    if (values.length && !containsTermsFilter(positiveFilters, field, values)) {
      throw new Error(`Agentic query omitted the ${field} facet filter`);
    }
  }
  validateConstraintPlacement(body.query, requiredConstraintFields);
  const personaClause = buildPersonaQueryClause(persona);
  const multiMatch = validateCanonicalTextRecipe(body.query, sort, Boolean(personaClause));
  validateServiceTextRecipe(multiMatch, shopperQuery, filters, sort, understanding);
  validateSort(body.sort, sort);
  validateRankingClauses(body.query, sort, personaClause);
  return body;
}

function buildMandatoryFilters(filters = {}, maxPrice = 20000) {
  const mandatoryFilters = [
    { term: { availability: "active" } },
    { range: { price: { lte: Number(maxPrice) || 20000 } } },
  ];
  for (const field of AGENTIC_FILTER_FIELDS) {
    const values = normalizedFilterValues(filters?.[field]);
    if (values.length === 0) continue;
    mandatoryFilters.push(
      values.length === 1 ? { term: { [field]: values[0] } } : { terms: { [field]: values } },
    );
  }
  return mandatoryFilters;
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

function structuralJsonEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => structuralJsonEqual(item, right[index]))
    );
  }
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object"
  ) {
    return false;
  }
  const leftPrototype = Object.getPrototypeOf(left);
  const rightPrototype = Object.getPrototypeOf(right);
  if (
    (leftPrototype !== Object.prototype && leftPrototype !== null) ||
    (rightPrototype !== Object.prototype && rightPrototype !== null)
  ) {
    return false;
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) => Object.hasOwn(right, key) && structuralJsonEqual(left[key], right[key]),
    )
  );
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
    if (payload.boost !== undefined && (typeof payload.boost !== "number" || !Number.isFinite(payload.boost))) {
      throw new Error("Agentic rank_feature.boost must be a finite number");
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

function validateCanonicalTextRecipe(query, mode, hasPersonaClause) {
  const bool = query?.bool;
  if (!bool || typeof bool !== "object" || Array.isArray(bool)) {
    throw new Error("Agentic query must use the canonical root bool recipe");
  }
  const expectedBoolKeys = mode === "Recommended" || hasPersonaClause ? ["filter", "must", "should"] : ["filter", "must"];
  const actualBoolKeys = Object.keys(bool).sort();
  if (!structuralJsonEqual(actualBoolKeys, [...expectedBoolKeys].sort())) {
    throw new Error(`Agentic root bool keys must be exactly ${expectedBoolKeys.join(", ")}`);
  }
  if (!Array.isArray(bool.must) || bool.must.length !== 1 || !bool.must[0]?.multi_match) {
    throw new Error("Agentic query must contain exactly one direct multi_match in bool.must");
  }
  const multiMatch = bool.must[0].multi_match;
  const expectedKeys = ["fields", "operator", "query"];
  if (
    !multiMatch ||
    typeof multiMatch !== "object" ||
    Array.isArray(multiMatch) ||
    !structuralJsonEqual(Object.keys(multiMatch).sort(), expectedKeys) ||
    !structuralJsonEqual(multiMatch.fields, CANONICAL_MULTI_MATCH_FIELDS) ||
    typeof multiMatch.query !== "string" ||
    !multiMatch.query.trim() ||
    !["and", "or"].includes(multiMatch.operator)
  ) {
    throw new Error("Agentic multi_match must use the canonical nonempty field and option recipe");
  }
  return multiMatch;
}

function validateServiceTextRecipe(multiMatch, shopperQuery, filters, mode, understanding) {
  const expected = buildServiceTextRecipe({ query: shopperQuery, filters, sort: mode, understanding });
  if (typeof shopperQuery === "string" && shopperQuery.trim()) {
    if (multiMatch.query !== expected.textQuery) {
      throw new Error("Agentic multi_match must copy the immutable service-contract base_text_query exactly");
    }
  }
  if (multiMatch.operator !== expected.textOperator) {
    throw new Error("Agentic multi_match must copy the immutable service-contract text_operator exactly");
  }
}

function sanitizeFilterValues(value) {
  return Array.isArray(value)
    ? value
        .filter((item) => typeof item === "string" && item.trim())
        .slice(0, 20)
        .map((item) => item.trim().slice(0, 100))
    : [];
}

function normalizedFilterValues(value) {
  return [...new Set(sanitizeFilterValues(value).map(normalizeFilterValue))];
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
    throw new Error("Recommended agentic ranking must omit sort");
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

function validateRankingClauses(query, mode, personaClause) {
  const clauses = [];
  collectRankFeatureClauses(query, "query", clauses);
  const expectedShould = [
    ...(personaClause ? [personaClause] : []),
    ...buildRecommendedRankFeatureClauses(mode),
  ];
  if (expectedShould.length === 0) {
    if (query.bool.should !== undefined || clauses.length) {
      throw new Error(`${mode} agentic ranking must omit bool.should and rank_feature clauses`);
    }
    return;
  }
  if (!Array.isArray(query.bool.should) || !structuralJsonEqual(query.bool.should, expectedShould)) {
    if (personaClause) {
      throw new Error("Agentic personalization and ranking must use the exact canonical bool.should recipe");
    }
    throw new Error("Recommended agentic ranking requires the exact three rank_feature clauses");
  }
  const expectedRankCount = mode === "Recommended" ? RECOMMENDED_RANK_FEATURES.size : 0;
  if (clauses.length !== expectedRankCount) {
    throw new Error(`${mode} agentic ranking contains an unexpected rank_feature clause`);
  }
}

function collectRankFeatureClauses(node, path, clauses) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return;
  const [queryType, payload] = Object.entries(node)[0] || [];
  if (queryType === "rank_feature") {
    clauses.push({ field: payload?.field, boost: payload?.boost, path });
    return;
  }
  if (queryType !== "bool" || !payload || typeof payload !== "object" || Array.isArray(payload)) return;
  for (const clauseName of ["filter", "must", "should"]) {
    const rawClauses = payload[clauseName];
    if (rawClauses === undefined) continue;
    const children = Array.isArray(rawClauses) ? rawClauses : [rawClauses];
    children.forEach((child, index) => collectRankFeatureClauses(child, `${path}.bool.${clauseName}[${index}]`, clauses));
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
