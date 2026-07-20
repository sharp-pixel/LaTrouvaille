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
      personaVersion: 1,
      status: "fallback",
    },
  });
  assert.equal("baseRewrite" in compact, false);
  assert.equal("personalizedRewrite" in compact, false);
});
