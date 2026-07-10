import { Client } from "@opensearch-project/opensearch";
import http from "node:http";
import { products } from "../src/data/catalog.js";
import { createQueryUnderstanding, localSearchProducts, normalizeText } from "../src/lib/search.js";

const port = Number(process.env.SEARCH_API_PORT || 8790);
const index = process.env.OPENSEARCH_ALIAS || process.env.OPENSEARCH_INDEX || "secondhand_items_current";
const trackTotalHits =
  process.env.OPENSEARCH_TRACK_TOTAL_HITS === "true" ? true : Number(process.env.OPENSEARCH_TRACK_TOTAL_HITS || 10000);
const queryRewriteEndpoint = process.env.QUERY_REWRITE_ENDPOINT || "http://127.0.0.1:8791/rewrite";
const queryRewriteTimeoutMs = Number(process.env.QUERY_REWRITE_TIMEOUT_MS || 20);
const mistralMode = process.env.MISTRAL_QUERY_UNDERSTANDING_MODE || "off";
const mistralEndpoint = process.env.MISTRAL_QUERY_UNDERSTANDING_ENDPOINT || "http://127.0.0.1:8792/understand";
const mistralTimeoutMs = Number(process.env.MISTRAL_QUERY_UNDERSTANDING_TIMEOUT_MS || 900);

const client = new Client({
  node: process.env.OPENSEARCH_URL || "http://127.0.0.1:9200",
  auth:
    process.env.OPENSEARCH_USERNAME && process.env.OPENSEARCH_PASSWORD
      ? { username: process.env.OPENSEARCH_USERNAME, password: process.env.OPENSEARCH_PASSWORD }
      : undefined,
  ssl: { rejectUnauthorized: process.env.OPENSEARCH_REJECT_UNAUTHORIZED !== "false" },
});

function unwrap(response) {
  return response?.body ?? response;
}

function send(response, status, payload) {
  response.writeHead(status, {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
    "content-type": "application/json",
  });
  response.end(JSON.stringify(payload));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        request.destroy();
        reject(new Error("Request body too large"));
      }
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    request.on("error", reject);
  });
}

function keywordValues(values = []) {
  return values.map((value) => normalizeText(value)).filter(Boolean);
}

function applyTier2Filters(filter, filters, tier2Rewrite) {
  if (tier2Rewrite?.status !== "applied") return;
  (tier2Rewrite.filters || []).forEach((rewriteFilter) => {
    if (!rewriteFilter.field || filters?.[rewriteFilter.field]?.length) return;
    filter.push({ terms: { [rewriteFilter.field]: keywordValues(rewriteFilter.values || []) } });
  });
}

function addTier2Boosts(should, tier2Rewrite) {
  if (tier2Rewrite?.status !== "applied") return;

  (tier2Rewrite.synonyms || []).forEach((synonym) => {
    should.push({
      multi_match: {
        query: synonym,
        fields: ["brand^5", "title^4", "category^2", "material^2", "canonical_text"],
        operator: "or",
        boost: 1.8,
      },
    });
  });

  (tier2Rewrite.boosts || []).forEach((boost) => {
    if (!boost.field || !boost.phrase) return;
    should.push({
      match_phrase: {
        [boost.field]: {
          query: boost.phrase,
          boost: Number(boost.weight) || 3,
        },
      },
    });
  });
}

function addTier2Burials(should, tier2Rewrite) {
  if (tier2Rewrite?.status !== "applied") return;

  (tier2Rewrite.bury || []).forEach((bury) => {
    if (!bury.field || !bury.value) return;
    should.push({
      boosting: {
        positive: { match_all: {} },
        negative: { term: { [bury.field]: normalizeText(bury.value) } },
        negative_boost: Number(bury.weight) || 0.5,
      },
    });
  });
}

function applyMistralFilters(filter, filters, mistralUnderstanding) {
  if (mistralMode !== "active" || mistralUnderstanding?.status !== "applied") return;
  for (const constraint of mistralUnderstanding.compiler?.constraints?.filters || []) {
    if (filters?.[constraint.field]?.length) continue;
    if (constraint.field === "price" && ["gte", "lte"].includes(constraint.op)) {
      filter.push({ range: { price: { [constraint.op]: Number(constraint.value) } } });
      continue;
    }
    if (["brand", "category", "condition", "country", "material"].includes(constraint.field)) {
      const values = Array.isArray(constraint.value) ? constraint.value : [constraint.value];
      if (values.length) filter.push({ terms: { [constraint.field]: keywordValues(values) } });
    }
  }
}

function addMistralRewrite(should, mistralUnderstanding) {
  if (mistralMode !== "active" || mistralUnderstanding?.status !== "applied") return;
  const keywordQuery = mistralUnderstanding.compiler?.rewrites?.keyword_query;
  if (!keywordQuery) return;
  should.push({
    multi_match: {
      query: keywordQuery,
      fields: ["brand^6", "title^5", "category^3", "material^2", "color", "description", "canonical_text"],
      operator: "or",
      boost: 1.5,
    },
  });
}

function addPhraseIntentBoosts(should, phraseIntents = []) {
  phraseIntents.forEach((intent) => {
    const phrases = [...new Set([intent.label, intent.matchedPhrase, ...(intent.phrases || [])].filter(Boolean))];
    phrases.forEach((phrase) => {
      should.push(
        { match_phrase: { title: { query: phrase, boost: 6 } } },
        { match_phrase: { canonical_text: { query: phrase, boost: 4 } } },
      );
    });
    if (intent.label) {
      should.push({ match_phrase: { reasons: { query: intent.label, boost: 8 } } });
    }
  });
}

function buildQuery({ query, filters, maxPrice, tier2Rewrite, mistralUnderstanding }) {
  const understanding = createQueryUnderstanding(query, products);
  const mistralKeywordQuery =
    mistralMode === "active" && mistralUnderstanding?.status === "applied"
      ? mistralUnderstanding.compiler?.rewrites?.keyword_query
      : "";
  const filter = [
    { term: { availability: "active" } },
    { range: { price: { lte: Number(maxPrice) || 20000 } } },
  ];
  const must = [];
  const should = [
    { rank_feature: { field: "quality_score", boost: 0.12 } },
    { rank_feature: { field: "freshness_score", boost: 0.03 } },
    { rank_feature: { field: "seller_score", boost: 0.02 } },
  ];

  Object.entries(filters || {}).forEach(([key, values]) => {
    if (values?.length) filter.push({ terms: { [key]: keywordValues(values) } });
  });

  if (understanding.brand) {
    must.push({ match_phrase: { brand: { query: understanding.brand, boost: 8 } } });
  }

  if (understanding.categories.length && !filters?.category?.length) {
    filter.push({ terms: { category: keywordValues(understanding.categories) } });
  }

  if (understanding.materials?.length && !filters?.material?.length) {
    filter.push({ terms: { material: keywordValues(understanding.materials) } });
  }
  applyTier2Filters(filter, filters, tier2Rewrite);
  applyMistralFilters(filter, filters, mistralUnderstanding);
  addPhraseIntentBoosts(should, understanding.phraseIntents);

  if (mistralKeywordQuery || understanding.tokens.length) {
    must.push({
      multi_match: {
        query: mistralKeywordQuery || understanding.tokens.join(" "),
        fields: ["title^4", "canonical_text^3", "description^2", "material", "color", "reasons"],
        operator: mistralKeywordQuery ? "or" : "and",
      },
    });
  }

  if (query?.trim()) {
    should.push(
      { match_phrase: { brand: { query, boost: 12 } } },
      { match_phrase: { title: { query, boost: 7 } } },
      {
        multi_match: {
          query,
          fields: ["brand^6", "title^5", "category^3", "material^2", "color", "description", "canonical_text"],
          operator: "or",
        },
      },
    );
  }
  addTier2Boosts(should, tier2Rewrite);
  addTier2Burials(should, tier2Rewrite);
  addMistralRewrite(should, mistralUnderstanding);

  return {
    bool: {
      filter,
      must,
      should,
      minimum_should_match: must.length || !query?.trim() ? 0 : 1,
    },
  };
}

async function fetchMistralUnderstanding(query, filters) {
  if (mistralMode === "off") return { status: "disabled", tookMs: 0 };
  if (!query.trim()) return { status: "skipped", tookMs: 0 };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), mistralTimeoutMs);
  const startedAt = Date.now();
  try {
    const response = await fetch(mistralEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, filters }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Mistral adapter returned ${response.status}`);
    return await response.json();
  } catch (error) {
    return {
      status: error.name === "AbortError" ? "timeout" : "skipped",
      tookMs: Date.now() - startedAt,
      error: error.message,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchTier2Rewrite(query, understanding) {
  if (!queryRewriteEndpoint) {
    return { status: "disabled", tookMs: 0 };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), queryRewriteTimeoutMs);
  const startedAt = Date.now();

  try {
    const response = await fetch(queryRewriteEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, queryPlan: understanding }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`rewrite service returned ${response.status}`);
    return await response.json();
  } catch (error) {
    return {
      status: error.name === "AbortError" ? "timeout" : "skipped",
      tookMs: Date.now() - startedAt,
      error: error.message,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function buildSort(sort) {
  if (sort === "Lowest price") return [{ price: { order: "asc" } }, { _score: { order: "desc" } }];
  if (sort === "Newest") return [{ listed_at: { order: "desc" } }, { _score: { order: "desc" } }];
  if (sort === "Price drop") return [{ old_price: { order: "desc", missing: "_last" } }, { _score: { order: "desc" } }];
  return undefined;
}

function toProduct(hit) {
  const source = hit._source;
  return {
    id: source.item_id,
    item_id: source.item_id,
    brand: source.brand,
    title: source.title,
    category: source.category,
    size: source.size,
    price: source.price,
    oldPrice: source.old_price,
    country: source.country,
    condition: source.condition,
    material: source.material,
    color: source.color,
    image: source.image,
    badge: source.badge,
    reasons: source.reasons || [],
    availability: source.availability,
    shipping: source.shipping,
    seller_id: source.seller_id,
    seller_tier: source.seller_tier,
    seller_score: source.seller_score,
    listed_at: source.listed_at,
    canonical_text: source.canonical_text,
    score: Math.round(hit._score || source.quality_score || 1),
  };
}

async function search(payload) {
  const startedAt = Date.now();
  const query = payload.query || "";
  const filters = payload.filters || { category: [], condition: [], material: [], country: [] };
  const maxPrice = Number(payload.maxPrice) || 20000;
  const sort = payload.sort || "Recommended";
  const size = Math.min(Number(payload.size) || 48, 96);
  const understanding = createQueryUnderstanding(query, products);
  const [tier2Rewrite, mistralUnderstanding] = await Promise.all([
    fetchTier2Rewrite(query, understanding),
    fetchMistralUnderstanding(query, filters),
  ]);

  try {
    const body = {
      size,
      track_total_hits: trackTotalHits,
      query: buildQuery({ query, filters, maxPrice, tier2Rewrite, mistralUnderstanding }),
      _source: [
        "item_id",
        "brand",
        "title",
        "category",
        "size",
        "price",
        "old_price",
        "country",
        "condition",
        "material",
        "color",
        "image",
        "badge",
        "reasons",
        "availability",
        "shipping",
        "seller_id",
        "seller_tier",
        "seller_score",
        "listed_at",
        "canonical_text",
        "quality_score",
      ],
    };
    const sortClause = buildSort(sort);
    if (sortClause) body.sort = sortClause;

    const result = unwrap(await client.search({ index, body }));
    return {
      index,
      source: "opensearch",
      tookMs: Date.now() - startedAt,
      opensearchTookMs: result.took,
      total: typeof result.hits.total === "number" ? result.hits.total : result.hits.total?.value,
      totalRelation: typeof result.hits.total === "number" ? "eq" : result.hits.total?.relation,
      queryPlan: { ...understanding, tier2: tier2Rewrite, mistral: mistralUnderstanding },
      enhancements: {
        querqy: tier2Rewrite.status,
        rules: tier2Rewrite.rules || [],
        tookMs: tier2Rewrite.tookMs,
        mistral: mistralUnderstanding.status,
        mistralModel: mistralUnderstanding.model || null,
        mistralTookMs: mistralUnderstanding.tookMs,
        mistralMode,
      },
      products: result.hits.hits.map(toProduct),
    };
  } catch (error) {
    const productsFallback = localSearchProducts(products, { query, filters, maxPrice, sort }).slice(0, size);
    return {
      index,
      source: "local-fallback",
      tookMs: Date.now() - startedAt,
      total: productsFallback.length,
      totalRelation: "eq",
      queryPlan: { ...understanding, tier2: tier2Rewrite, mistral: mistralUnderstanding },
      enhancements: {
        querqy: tier2Rewrite.status,
        rules: tier2Rewrite.rules || [],
        tookMs: tier2Rewrite.tookMs,
        mistral: mistralUnderstanding.status,
        mistralModel: mistralUnderstanding.model || null,
        mistralTookMs: mistralUnderstanding.tookMs,
        mistralMode,
      },
      products: productsFallback,
      warning: error.message,
    };
  }
}

const server = http.createServer(async (request, response) => {
  if (request.method === "OPTIONS") {
    send(response, 204, {});
    return;
  }

  try {
    if (request.method === "GET" && request.url === "/health") {
      await client.info();
      send(response, 200, { ok: true, index });
      return;
    }

    if (request.method === "POST" && request.url === "/search") {
      send(response, 200, await search(await readJson(request)));
      return;
    }

    send(response, 404, { error: "not_found" });
  } catch (error) {
    send(response, 500, { error: error.message });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Search API listening on http://127.0.0.1:${port}`);
  console.log(`OpenSearch index: ${index}`);
});
