import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";

async function fixture(t, mode = "active") {
  const requests = [];
  let fail = false;
  const opensearch = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ url: request.url, body: JSON.parse(body || "{}") });
    response.writeHead(fail ? 503 : 200, { "content-type": "application/json" });
    response.end(JSON.stringify(fail ? { error: "unavailable" } : {
      took: 1, hits: { total: { value: 1, relation: "eq" }, hits: [{
        _score: 1, _source: { item_id: "test-listing", title: "Leather bag", brand: "MAISON BELLUNE", price: 100 },
      }] },
    }));
  });
  opensearch.listen(0, "127.0.0.1");
  await once(opensearch, "listening");
  t.after(() => { opensearch.closeAllConnections(); opensearch.close(); });
  const child = spawn(process.execPath, ["scripts/search-api.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env, SEARCH_API_HOST: "127.0.0.1", SEARCH_API_PORT: "0",
      OPENSEARCH_URL: `http://127.0.0.1:${opensearch.address().port}`,
      OPENSEARCH_USERNAME: "", OPENSEARCH_PASSWORD: "",
      OPENSEARCH_AGENTIC_SEARCH_MODE: mode,
      QUERY_REWRITE_ENDPOINT: `http://127.0.0.1:${opensearch.address().port}/rewrite`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
  });
  const endpoint = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Search API did not start")), 10000);
    let output = "";
    child.stdout.on("data", (data) => {
      output += data;
      const match = output.match(/Search API listening on (http:\/\/[^\s]+)/);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`Search API exited: ${code}`)); });
  });
  return {
    requests,
    fail: () => { fail = true; },
    async search(payload) {
      const response = await fetch(`${endpoint}/search`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      return { status: response.status, body: await response.json() };
    },
  };
}

test("Anonymous sends compiled DSL with no pipeline/model/rewrite dependency, even with agentic disabled", async (t) => {
  const api = await fixture(t, "disabled");
  for (const personaId of ["anonymous", "unknown-persona", undefined]) {
    const response = await api.search({ query: "black leather bags under 500", personaId, pipeline: "agentic-lt-qwen3-v1", persona: { strictMaxPrice: 1 } });
    assert.equal(response.status, 200);
    const request = api.requests.at(-1);
    assert.equal(new URL(request.url, "http://test").searchParams.get("search_pipeline"), "_none");
    assert.equal(request.body.query.agentic, undefined);
    assert.equal(request.body.query.bool.must, undefined);
    assert.ok(request.body.query.bool.filter.some((clause) => clause.range?.price?.lt === 500));
    assert.deepEqual(response.body.queryPlan.dslQuery, request.body);
    assert.equal(response.body.queryPlan.queryUnderstanding.engine, "rules");
    assert.equal(response.body.queryPlan.personalization.status, "unprofiled");
  }
  assert.equal(api.requests.length, 3, "exactly one OpenSearch call per request; no rewrite service calls");
});

test("literal toggle bypass retains raw words and puts UI constraints only in post_filter", async (t) => {
  const api = await fixture(t);
  const query = "black leather bags under 500";
  const response = await api.search({ query, personaId: "watch-collector", queryUnderstanding: false, maxPrice: 800, filters: { category: ["Bags"] }, sort: "Newest" });
  assert.equal(response.status, 200);
  assert.deepEqual(api.requests[0].body.query, { multi_match: { query, fields: ["title", "brand", "canonical_text", "description"], operator: "or" } });
  assert.ok(api.requests[0].body.post_filter.bool.filter.some((clause) => clause.range?.price?.lte === 800));
  assert.deepEqual(api.requests[0].body.sort[0], { listed_at: { order: "desc" } });
  assert.equal(response.body.queryPlan.queryUnderstanding.status, "bypassed");
  assert.equal(api.requests.length, 1);
});

test("named personas retain agentic routing and fail closed on missing generated DSL", async (t) => {
  const api = await fixture(t);
  const response = await api.search({ query: "dress watch", personaId: "watch-collector", pipeline: "agentic-lt-qwen3-v1" });
  assert.equal(response.status, 503);
  assert.match(api.requests[0].url, /search_pipeline=agentic-lt-qwen3-v1/);
  assert.ok(api.requests[0].body.query.agentic);
  assert.equal(response.body.products, undefined);
  assert.equal(api.requests.length, 1, "no rules or literal fallback after agentic failure");
});

test("Anonymous returns an error with no catalogue fallback when OpenSearch fails", async (t) => {
  const api = await fixture(t);
  api.fail();
  const response = await api.search({ query: "bags", personaId: "anonymous" });
  assert.equal(response.status, 503);
  assert.match(response.body.error, /OpenSearch search failed/);
  assert.equal(response.body.products, undefined);
  assert.ok(api.requests.every((request) => request.body.query.bool));
});
