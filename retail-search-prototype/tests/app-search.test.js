import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { transformWithEsbuild } from "vite";

const appUrl = new URL("../src/App.jsx", import.meta.url);
const transformed = await transformWithEsbuild(
  readFileSync(appUrl, "utf8").replaceAll("import.meta.env", "({})"),
  appUrl.pathname,
  { jsx: "automatic" },
);
const code = transformed.code.replace(/from (["'])([^"']+)\1/g, (_, quote, specifier) => {
  const url = specifier.startsWith(".") ? new URL(specifier, appUrl).href : import.meta.resolve(specifier);
  return `from ${JSON.stringify(url)}`;
});
const { App } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);

async function mountApp(t) {
  const storage = new Map();
  const requests = [];
  const original = {
    fetch: globalThis.fetch,
    localStorage: globalThis.localStorage,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
  };
  globalThis.fetch = (url, options) => {
    if (url.endsWith("/agentic-pipelines")) return Promise.resolve({ json: async () => ({ models: [] }) });
    if (!url.endsWith("/search")) return Promise.resolve({ ok: true });
    return new Promise((resolve) => requests.push({ payload: JSON.parse(options.body), resolve }));
  };
  let renderer;
  t.after(async () => {
    try {
      if (renderer) await act(async () => renderer.unmount());
    } finally {
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete globalThis[key];
        else globalThis[key] = value;
      }
    }
  });
  await act(async () => { renderer = create(createElement(App)); });
  return {
    props: (name) => renderer.root.find((node) => node.type?.name === name).props,
    records: () => JSON.parse(storage.get("maison-reuse-ubi-events") || "[]").filter((r) => r.type === "query"),
    requests,
    async answer(request, id) {
      await act(async () => request.resolve({
        ok: true,
        json: async () => ({
          source: "opensearch",
          products: [{ id, item_id: id, brand: "TEST HOUSE", title: id, reasons: [], price: 100 }],
          queryPlan: { rewritten: request.payload.query, dslQuery: { query: { match_all: {} } } },
          total: 1,
        }),
      }));
    },
  };
}

test("new query and sort telemetry wait for their own response", async (t) => {
  const app = await mountApp(t);
  await act(async () => app.props("Header").runSearch("bags"));
  await app.answer(app.requests[0], "bag-result");
  await act(async () => app.props("Header").runSearch("watches"));
  assert.equal(app.records().length, 1, "pending watches must not be recorded with bags results");
  await app.answer(app.requests[1], "watch-result");
  assert.equal(app.records()[0].user_query, "watches");
  assert.deepEqual(app.records()[0].query_response_object_ids, ["watch-result"]);
  await act(async () => app.props("ResultsPage").setSort("Lowest price"));
  assert.equal(app.records().length, 2);
  await app.answer(app.requests[2], "cheapest-watch");
  assert.deepEqual(app.records()[0].query_response_object_ids, ["cheapest-watch"]);
});

test("model switches create a new query record and aborted results are ignored", async (t) => {
  const app = await mountApp(t);
  await act(async () => app.props("Header").runSearch("bags"));
  await app.answer(app.requests[0], "base-result");
  await act(async () => app.props("Header").onSelectPipeline("agentic-lt-qwen3-v1"));
  await app.answer(app.requests[1], "qwen-result");
  assert.equal(app.records().length, 2);
  assert.deepEqual(app.records()[0].query_response_object_ids, ["qwen-result"]);
  await act(async () => app.props("Header").runSearch("watches"));
  await act(async () => app.props("Header").runSearch("shoes"));
  await app.answer(app.requests[2], "stale-watch");
  assert.equal(app.records().length, 2);
  await app.answer(app.requests[3], "shoe-result");
  assert.equal(app.records().length, 3);
  assert.deepEqual(app.records()[0].query_response_object_ids, ["shoe-result"]);
});

test("returning to results records the refreshed response even for identical controls", async (t) => {
  const app = await mountApp(t);
  await act(async () => app.props("Header").runSearch("bags"));
  await app.answer(app.requests[0], "first-result");
  await act(async () => app.props("Header").setMode("home"));
  await act(async () => app.props("Header").runSearch("bags"));
  assert.equal(app.records().length, 1);
  await app.answer(app.requests[1], "fresh-result");
  assert.equal(app.records().length, 2);
  assert.deepEqual(app.records()[0].query_response_object_ids, ["fresh-result"]);
});

test("the active query remains inspectable beyond the bounded interaction history", async (t) => {
  const app = await mountApp(t);
  await act(async () => app.props("Header").runSearch("bags"));
  await app.answer(app.requests[0], "bag-result");
  const product = app.props("ResultsPage").products[0];
  for (let index = 0; index < 45; index += 1) {
    await act(async () => app.props("ResultsPage").toggleFavorite(product.id, product, 1));
  }
  const panel = app.props("UbiTelemetryPanel");
  assert.equal(panel.events.length, 40);
  assert.ok(panel.events.some((event) => event.type === "query" && event.query_id === panel.queryId));
});

test("retry preserves search mode and controls without recording failed responses", async (t) => {
  const app = await mountApp(t);
  await act(async () => app.props("Header").runSearch("gold watch"));
  const firstRequest = app.requests[0];
  await act(async () => firstRequest.resolve({
    ok: false,
    status: 503,
    json: async () => ({ error: "Search service unavailable" }),
  }));
  assert.equal(app.props("ResultsPage").searchMeta.status, "error");
  assert.deepEqual(app.props("ResultsPage").products, []);
  assert.equal(app.records().length, 0);
  await act(async () => app.props("ResultsPage").onRetry());
  assert.equal(app.requests.length, 2);
  assert.deepEqual(app.requests[1].payload, firstRequest.payload);
  assert.equal(app.requests[1].payload.queryUnderstanding, true);
  assert.equal(app.props("ResultsPage").searchMeta.status, "loading");
  await app.answer(app.requests[1], "retry-watch");
  assert.equal(app.records().length, 1);
  assert.equal(app.props("ResultsPage").searchMeta.status, "ready");
  assert.deepEqual(app.records()[0].query_response_object_ids, ["retry-watch"]);
});
