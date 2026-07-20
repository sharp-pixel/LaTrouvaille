import { Client } from "@opensearch-project/opensearch";
import http from "node:http";
import { products } from "../src/data/catalog.js";
import { getPersonaById, getPersonaSearchContext } from "../src/data/personas.js";
import {
  AGENTIC_FILTER_FIELDS,
  buildAgenticQuery,
  buildPersonaQueryClause,
  buildPersonalizedRewrite,
  buildRecommendedRankFeatureClauses,
  buildServiceTextRecipe,
  buildTrustedPersonaContext,
  deriveAgenticServiceConstraints,
  deriveEffectiveSort,
  validateAgenticDsl,
} from "../src/lib/agentic-search.js";
import { createQueryUnderstanding, localSearchProducts, normalizeText, stripQueryControls } from "../src/lib/search.js";

const port = Number(process.env.SEARCH_API_PORT || 8790);
const index = process.env.OPENSEARCH_ALIAS || process.env.OPENSEARCH_INDEX || "secondhand_items_current";
const trackTotalHits = parseTrackTotalHits(process.env.OPENSEARCH_TRACK_TOTAL_HITS);
const queryRewriteEndpoint = process.env.QUERY_REWRITE_ENDPOINT || "http://127.0.0.1:8791/rewrite";
const queryRewriteTimeoutMs = Number(process.env.QUERY_REWRITE_TIMEOUT_MS || 20);
const agenticMode = process.env.OPENSEARCH_AGENTIC_SEARCH_MODE || "active";
const agenticPipeline = process.env.OPENSEARCH_AGENTIC_SEARCH_PIPELINE || "secondhand-agentic-search";
const configuredAgenticTimeoutMs = Number(process.env.OPENSEARCH_AGENTIC_SEARCH_TIMEOUT_MS);
const agenticTimeoutMs =
  Number.isFinite(configuredAgenticTimeoutMs) && configuredAgenticTimeoutMs > 0
    ? Math.trunc(configuredAgenticTimeoutMs)
    : 15000;

const client = new Client({
  node: process.env.OPENSEARCH_URL || "http://127.0.0.1:9200",
  auth:
    process.env.OPENSEARCH_USERNAME && process.env.OPENSEARCH_PASSWORD
      ? { username: process.env.OPENSEARCH_USERNAME, password: process.env.OPENSEARCH_PASSWORD }
      : undefined,
  ssl: { rejectUnauthorized: process.env.OPENSEARCH_REJECT_UNAUTHORIZED !== "false" },
});

function parseTrackTotalHits(value) {
  if (value === "true") return 10000;
  if (value === "false") return 0;
  const parsed = Number(value || 10000);
  return Number.isInteger(parsed) && parsed >= 0 ? Math.min(parsed, 10000) : 10000;
}

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

function buildQuery({ query, filters, maxPrice, sort, tier2Rewrite, personaContext }) {
  const understanding = createQueryUnderstanding(query, products);
  const relevanceQuery = stripQueryControls(query);
  const filter = [
    { term: { availability: "active" } },
    { range: { price: { lte: Number(maxPrice) || 20000 } } },
  ];
  const must = [];
  const personaClause = buildPersonaQueryClause(personaContext);
  const should = [...(personaClause ? [personaClause] : []), ...buildRecommendedRankFeatureClauses(sort)];

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
  addPhraseIntentBoosts(should, understanding.phraseIntents);

  if (understanding.tokens.length) {
    must.push({
      multi_match: {
        query: understanding.tokens.join(" "),
        fields: ["title^4", "canonical_text^3", "description^2", "material", "color", "reasons"],
        operator: "and",
      },
    });
  }

  if (relevanceQuery) {
    should.push(
      { match_phrase: { brand: { query: relevanceQuery, boost: 12 } } },
      { match_phrase: { title: { query: relevanceQuery, boost: 7 } } },
      {
        multi_match: {
          query: relevanceQuery,
          fields: ["brand^6", "title^5", "category^3", "material^2", "color", "description", "canonical_text"],
          operator: "or",
        },
      },
    );
  }
  addTier2Boosts(should, tier2Rewrite);
  addTier2Burials(should, tier2Rewrite);

  return {
    bool: {
      filter,
      must,
      should,
      minimum_should_match: must.length || !understanding.requiresTextMatch || !relevanceQuery ? 0 : 1,
    },
  };
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
  const query = String(payload.query || "").trim().slice(0, 1000);
  const rawFilters = payload.filters && typeof payload.filters === "object" ? payload.filters : {};
  const filters = Object.fromEntries(
    AGENTIC_FILTER_FIELDS.map((field) => [
      field,
      Array.isArray(rawFilters[field])
        ? rawFilters[field]
            .filter((value) => typeof value === "string" && value.trim())
            .slice(0, 20)
            .map((value) => value.trim().slice(0, 100))
        : [],
    ]),
  );
  const requestedMaxPrice = Number(payload.maxPrice);
  const maxPrice = Number.isFinite(requestedMaxPrice)
    ? Math.min(Math.max(Math.trunc(requestedMaxPrice), 1), 20000)
    : 20000;
  const requestedSort = String(payload.sort || "Recommended");
  const selectedSort = ["Recommended", "Lowest price", "Newest", "Price drop"].includes(requestedSort)
    ? requestedSort
    : "Recommended";
  const sort = deriveEffectiveSort(query, selectedSort);
  const requestedSize = Number(payload.size);
  const size = Number.isFinite(requestedSize) ? Math.min(Math.max(Math.trunc(requestedSize), 1), 96) : 48;
  // The browser sends only an allowlisted identifier. Ignore any client-provided
  // persona fields and resolve the authoritative profile on the server.
  const personaId = typeof payload.personaId === "string" ? payload.personaId.slice(0, 64) : "anonymous";
  const persona = getPersonaById(personaId);
  const personaSearchContext = getPersonaSearchContext(persona.id);
  const personaContext = buildTrustedPersonaContext(personaSearchContext);
  const understanding = createQueryUnderstanding(query, products);
  const { filters: effectiveFilters, maxPrice: effectiveMaxPrice } = deriveAgenticServiceConstraints({
    filters,
    maxPrice,
    understanding,
  });
  const serviceTextRecipe = buildServiceTextRecipe({ query, filters: effectiveFilters, sort, understanding });
  const agenticEligible = Boolean(serviceTextRecipe.textQuery);
  const personalization = (status) => {
    const effectiveStatus = personaContext.mode === "unprofiled" ? "unprofiled" : status;
    const personalizedRewrite = buildPersonalizedRewrite(
      serviceTextRecipe.textQuery || understanding.rewritten,
      personaSearchContext,
    );
    return {
      personalizedRewrite,
      personalization: {
        personaId: personaContext.id,
        personaVersion: personaContext.version,
        status: effectiveStatus,
        query: personalizedRewrite,
      },
    };
  };
  const sourceFields = [
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
  ];
  let agenticError = null;
  let agenticDslQuery = null;

  if (agenticMode === "active" && query.trim() && agenticEligible) {
    try {
      const body = {
        query: buildAgenticQuery({
          query,
          filters: effectiveFilters,
          maxPrice: effectiveMaxPrice,
          sort,
          size,
          trackTotalHits,
          understanding,
          persona: personaSearchContext,
        }),
        _source: sourceFields,
      };

      const result = unwrap(
        await client.search({ index, search_pipeline: agenticPipeline, body }, { requestTimeout: agenticTimeoutMs }),
      );
      agenticDslQuery = result.ext?.dsl_query || null;
      validateAgenticDsl({
        dslQuery: agenticDslQuery,
        filters: effectiveFilters,
        maxPrice: effectiveMaxPrice,
        shopperQuery: query,
        sort,
        size,
        trackTotalHits,
        understanding,
        persona: personaSearchContext,
      });
      return {
        index,
        source: "opensearch",
        tookMs: Date.now() - startedAt,
        opensearchTookMs: result.took,
        total: typeof result.hits.total === "number" ? result.hits.total : result.hits.total?.value,
        totalRelation: typeof result.hits.total === "number" ? "eq" : result.hits.total?.relation,
        queryPlan: {
          ...understanding,
          ...personalization("applied"),
          dslQuery: agenticDslQuery,
          agentic: {
            status: "applied",
            pipeline: agenticPipeline,
          },
        },
        enhancements: {
          agentic: "applied",
          agenticMode,
          agenticPipeline,
          dslQuery: agenticDslQuery,
          querqy: "not_called",
          rules: [],
        },
        products: result.hits.hits.map(toProduct),
      };
    } catch (error) {
      agenticError = error;
    }
  }

  const tier2Rewrite = await fetchTier2Rewrite(query, understanding);
  let lexicalDslQuery;

  try {
    lexicalDslQuery = {
      size,
      track_total_hits: trackTotalHits,
      query: buildQuery({
        query,
        filters,
        maxPrice: effectiveMaxPrice,
        sort,
        tier2Rewrite,
        personaContext: personaSearchContext,
      }),
      _source: sourceFields,
    };
    const sortClause = buildSort(sort);
    if (sortClause) lexicalDslQuery.sort = sortClause;

    const result = unwrap(await client.search({ index, body: lexicalDslQuery }));
    return {
      index,
      source: "opensearch",
      tookMs: Date.now() - startedAt,
      opensearchTookMs: result.took,
      total: typeof result.hits.total === "number" ? result.hits.total : result.hits.total?.value,
      totalRelation: typeof result.hits.total === "number" ? "eq" : result.hits.total?.relation,
      queryPlan: {
        ...understanding,
        ...personalization(agenticError ? "fallback" : "applied"),
        dslQuery: lexicalDslQuery,
        tier2: tier2Rewrite,
        agentic: {
          status: agenticError ? "fallback" : agenticMode === "active" ? "skipped" : "disabled",
          pipeline: agenticPipeline,
          error: agenticError?.message || null,
        },
      },
      enhancements: {
        querqy: tier2Rewrite.status,
        rules: tier2Rewrite.rules || [],
        tookMs: tier2Rewrite.tookMs,
        agentic: agenticError ? "fallback" : agenticMode === "active" ? "skipped" : "disabled",
        agenticMode,
        agenticPipeline,
        agenticError: agenticError?.message || null,
        dslQuery: agenticDslQuery,
      },
      products: result.hits.hits.map(toProduct),
      warning: agenticError ? `Agentic Search failed; used lexical OpenSearch fallback: ${agenticError.message}` : undefined,
    };
  } catch (error) {
    const productsFallback = localSearchProducts(products, {
      query,
      filters,
      maxPrice: effectiveMaxPrice,
      sort,
      persona,
    }).slice(0, size);
    return {
      index,
      source: "local-fallback",
      tookMs: Date.now() - startedAt,
      total: productsFallback.length,
      totalRelation: "eq",
      queryPlan: {
        ...understanding,
        ...personalization("fallback"),
        dslQuery: lexicalDslQuery,
        tier2: tier2Rewrite,
        agentic: {
          status: agenticError ? "failed" : agenticMode === "active" ? "skipped" : "disabled",
          pipeline: agenticPipeline,
          error: agenticError?.message || null,
        },
      },
      enhancements: {
        querqy: tier2Rewrite.status,
        rules: tier2Rewrite.rules || [],
        tookMs: tier2Rewrite.tookMs,
        agentic: agenticError ? "failed" : agenticMode === "active" ? "skipped" : "disabled",
        agenticMode,
        agenticPipeline,
        agenticError: agenticError?.message || null,
        dslQuery: agenticDslQuery,
      },
      products: productsFallback,
      warning: [agenticError?.message, error.message].filter(Boolean).join("; "),
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
  console.log(`Native Agentic Search: ${agenticMode} (${agenticPipeline})`);
});
