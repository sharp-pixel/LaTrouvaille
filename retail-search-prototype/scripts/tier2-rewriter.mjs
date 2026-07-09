import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeText } from "../src/lib/search.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const port = Number(process.env.QUERY_REWRITER_PORT || 8791);
const rulesPath = process.env.QUERY_REWRITER_RULES || path.join(root, "config", "querqy-tier2-rules.json");
const artificialDelayMs = Number(process.env.QUERY_REWRITER_DELAY_MS || 0);

let rules = [];

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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function matchesRule(rule, normalizedQuery) {
  const allMatches = (rule.all || []).every((term) => normalizedQuery.includes(normalizeText(term)));
  const anyMatches = !(rule.any || []).length || rule.any.some((term) => normalizedQuery.includes(normalizeText(term)));
  return allMatches && anyMatches;
}

function mergeUnique(values) {
  return [...new Set(values.filter(Boolean))];
}

function rewrite(query) {
  const startedAt = Date.now();
  const normalizedQuery = normalizeText(query);
  const matches = rules.filter((rule) => matchesRule(rule, normalizedQuery));

  if (!matches.length) {
    return {
      status: "no_match",
      tookMs: Date.now() - startedAt,
      rules: [],
      rewrittenQuery: query,
      synonyms: [],
      filters: [],
      boosts: [],
      bury: [],
    };
  }

  const rewrittenQuery = matches.find((rule) => rule.rewrite)?.rewrite || query;
  return {
    status: "applied",
    tookMs: Date.now() - startedAt,
    rules: matches.map((rule) => rule.id),
    rewrittenQuery,
    synonyms: mergeUnique(matches.flatMap((rule) => rule.synonyms || [])),
    filters: matches.flatMap((rule) => rule.filters || []),
    boosts: matches.flatMap((rule) => rule.boosts || []),
    bury: matches.flatMap((rule) => rule.bury || []),
  };
}

async function loadRules() {
  rules = JSON.parse(await readFile(rulesPath, "utf8"));
}

const server = http.createServer(async (request, response) => {
  if (request.method === "OPTIONS") {
    send(response, 204, {});
    return;
  }

  try {
    if (request.method === "GET" && request.url === "/health") {
      send(response, 200, { ok: true, rules: rules.length, rulesPath });
      return;
    }

    if (request.method === "POST" && request.url === "/rewrite") {
      const payload = await readJson(request);
      if (artificialDelayMs) await delay(artificialDelayMs);
      send(response, 200, rewrite(payload.query || ""));
      return;
    }

    send(response, 404, { error: "not_found" });
  } catch (error) {
    send(response, 500, { error: error.message });
  }
});

await loadRules();

server.listen(port, "127.0.0.1", () => {
  console.log(`Tier-2 query rewriter listening on http://127.0.0.1:${port}`);
  console.log(`Rules loaded: ${rules.length}`);
});
