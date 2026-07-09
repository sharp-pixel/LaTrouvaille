import { Client } from "@opensearch-project/opensearch";
import { appendFile, mkdir } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const dataDir = path.join(root, "data");
const port = Number(process.env.UBI_COLLECTOR_PORT || 8787);
const forwardToOpenSearch = process.env.UBI_FORWARD_OPENSEARCH === "1";
const eventsIndex = process.env.UBI_EVENTS_INDEX || "ubi_events";
const queriesIndex = process.env.UBI_QUERIES_INDEX || "ubi_queries";

const client = forwardToOpenSearch
  ? new Client({
      node: process.env.OPENSEARCH_URL || "http://127.0.0.1:9200",
      auth:
        process.env.OPENSEARCH_USERNAME && process.env.OPENSEARCH_PASSWORD
          ? { username: process.env.OPENSEARCH_USERNAME, password: process.env.OPENSEARCH_PASSWORD }
          : undefined,
      ssl: { rejectUnauthorized: process.env.OPENSEARCH_REJECT_UNAUTHORIZED !== "false" },
    })
  : null;

const recent = [];

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

async function persist(kind, payload) {
  await mkdir(dataDir, { recursive: true });
  const file = kind === "query" ? "ubi-queries.ndjson" : "ubi-events.ndjson";
  const record = { received_at: new Date().toISOString(), ...payload };
  await appendFile(path.join(dataDir, file), `${JSON.stringify(record)}\n`);
  recent.unshift({ kind, ...record });
  recent.splice(20);

  if (client) {
    await client.index({
      index: kind === "query" ? queriesIndex : eventsIndex,
      body: record,
      refresh: false,
    });
  }

  return record;
}

const server = http.createServer(async (request, response) => {
  if (request.method === "OPTIONS") {
    send(response, 204, {});
    return;
  }

  try {
    if (request.method === "GET" && request.url === "/health") {
      send(response, 200, { ok: true, forwardToOpenSearch, recent: recent.length });
      return;
    }

    if (request.method === "GET" && request.url === "/ubi/recent") {
      send(response, 200, { recent });
      return;
    }

    if (request.method === "POST" && request.url === "/ubi/query") {
      const record = await persist("query", await readJson(request));
      send(response, 202, { ok: true, query_id: record.query_id });
      return;
    }

    if (request.method === "POST" && request.url === "/ubi/event") {
      const record = await persist("event", await readJson(request));
      send(response, 202, { ok: true, action_name: record.action_name });
      return;
    }

    send(response, 404, { error: "not_found" });
  } catch (error) {
    send(response, 400, { error: error.message });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`UBI collector listening on http://127.0.0.1:${port}`);
  console.log(`Forwarding to OpenSearch: ${forwardToOpenSearch ? "enabled" : "disabled"}`);
});
