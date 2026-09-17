import test from "node:test";
import assert from "node:assert/strict";
import { getPersonaById } from "../src/data/personas.js";
import { buildLocalPersonalizationPlan } from "../src/lib/agentic-search.js";
import { compactQueryPlan, recordUbiQuery } from "../src/lib/ubi.js";

test("UBI stores the effective rewrite once and keeps only compact personalization metadata", () => {
  const compact = compactQueryPlan(
    {
      rewritten: "Bags",
      personalizedRewrite: "Bags rare archive",
      personalization: {
        personaId: "fashion-insider",
        personaVersion: 1,
        status: "applied",
        query: "Bags rare archive",
        archetype: "Fashion insider",
      },
      agentic: { status: "applied" },
    },
    "Bags rare archive",
  );

  assert.deepEqual(compact, {
    rewritten: "Bags",
    personalization: {
      personaId: "fashion-insider",
      personaVersion: 1,
      status: "applied",
    },
    agentic: { status: "applied" },
  });
  assert.equal("personalizedRewrite" in compact, false);
  assert.equal("query" in compact.personalization, false);

  assert.deepEqual(compactQueryPlan({ rewritten: "Bags" }, "Bags"), {});
});

test("query recording applies compact personalization to the persisted UBI record", () => {
  const originalFetch = globalThis.fetch;
  const originalLocalStorage = globalThis.localStorage;
  const storage = new Map();
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
  };
  globalThis.fetch = async () => ({ ok: true });

  try {
    const record = recordUbiQuery({
      userQuery: "bags",
      rewrittenQuery: "Bags rare archive",
      results: [{ item_id: "MR-1" }],
      queryPlan: {
        rewritten: "Bags",
        personalizedRewrite: "Bags rare archive",
        personalization: {
          personaId: "fashion-insider",
          personaVersion: 1,
          status: "applied",
          query: "Bags rare archive",
        },
      },
      filters: {},
      sort: "Recommended",
      persona: { id: "fashion-insider", version: 1 },
    });

    assert.equal(record.query_attributes.rewritten_query, "Bags rare archive");
    assert.deepEqual(record.query_attributes.query_plan, {
      rewritten: "Bags",
      personalization: {
        personaId: "fashion-insider",
        personaVersion: 1,
        status: "applied",
      },
    });
    assert.equal(JSON.parse(storage.get("maison-reuse-ubi-events"))[0].query_attributes.rewritten_query, "Bags rare archive");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = originalLocalStorage;
  }
});

test("UBI canonicalizes a client-local fallback plan without persisting baseRewrite", () => {
  const localPlan = buildLocalPersonalizationPlan(
    { rewritten: "Bags" },
    getPersonaById("fashion-insider"),
  );
  const compact = compactQueryPlan(localPlan, localPlan.personalizedRewrite);

  assert.deepEqual(compact, {
    rewritten: "Bags",
      personalization: {
        personaId: "fashion-insider",
        personaVersion: 2,
        status: "fallback",
      },
  });
  assert.equal("baseRewrite" in compact, false);
  assert.equal("personalizedRewrite" in compact, false);
});

test("UBI keeps the executed OpenSearch DSL for query inspection", () => {
  const dslQuery = {
    size: 24,
    track_total_hits: 10000,
    query: { term: { availability: "active" } },
  };

  const compact = compactQueryPlan({ rewritten: "Bags", dslQuery }, "Bags");

  assert.equal(compact.dsl_query_json, JSON.stringify(dslQuery));
  assert.equal("dslQuery" in compact, false);
});

test("agentic strings and lexical objects persist DSL as the same field type", () => {
  const dsl = { size: 24, query: { multi_match: { query: "bags" } } };
  for (const value of [dsl, JSON.stringify(dsl)]) {
    const compact = compactQueryPlan({ dslQuery: value }, "bags");
    assert.equal(typeof compact.dsl_query_json, "string");
    assert.deepEqual(JSON.parse(compact.dsl_query_json), dsl);
    assert.equal("dslQuery" in compact, false, "do not reuse a legacy object mapping");
  }
});

test("telemetry survives unavailable, full, and malformed browser storage", async (t) => {
  const originalStorage = globalThis.localStorage;
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = originalStorage;
  });
  const posts = [];
  globalThis.fetch = async (url, options) => { posts.push(JSON.parse(options.body)); return { ok: true }; };
  const storageCases = [
    { getItem() { throw new Error("storage disabled"); }, setItem() { throw new Error("storage disabled"); } },
    { getItem: () => null, setItem() { throw new Error("quota exceeded"); } },
    ...["invalid json", "null", "{}", '[null,1,"invalid"]'].map((raw) => {
      const storage = new Map([["maison-reuse-ubi-events", raw]]);
      return {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, String(value)),
      };
    }),
  ];
  for (const [index, storage] of storageCases.entries()) {
    const telemetry = await import(`../src/lib/ubi.js?storage-case=${index}`);
    globalThis.localStorage = storage;
    assert.deepEqual(telemetry.getRecentUbiEvents(), []);
    const query = telemetry.recordUbiQuery({ userQuery: "bags", results: [], queryPlan: {}, filters: {}, sort: "Recommended" });
    const event = telemetry.recordUbiEvent({ queryId: query.query_id, actionName: "click" });
    assert.equal(event.client_id, query.client_id);
    assert.equal(telemetry.getRecentUbiEvents()[0].query_id, query.query_id);
  }
  assert.equal(posts.length, 12);
});
