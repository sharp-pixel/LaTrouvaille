// Legacy standalone compiler adapter. Native Agentic Search does not call this service.
import http from "node:http";

const port = Number(process.env.MISTRAL_QUERY_UNDERSTANDING_PORT || 8792);
const baseUrl = (process.env.MISTRAL_BASE_URL || "http://127.0.0.1:8000/v1").replace(/\/$/, "");
const apiKey = process.env.MISTRAL_API_KEY || "";
const model = process.env.MISTRAL_MODEL || "ministral-3-8b-instruct-2512";
const timeoutMs = Number(process.env.MISTRAL_MODEL_TIMEOUT_MS || 1500);

const responseSchema = {
  name: "psg_query_understanding_subset",
  strict: false,
  schema: {
    type: "object",
    properties: {
      raw_query: { type: "string" },
      category: { type: "string" },
      confidence: { type: "number" },
      clarification_needed: { type: "boolean" },
      clarification_question: { type: ["string", "null"] },
      rewrites: {
        type: "object",
        properties: {
          keyword_query: { type: "string" },
          embedding_query: { type: "string" },
          negative_query: { type: "string" },
        },
        required: ["keyword_query", "embedding_query", "negative_query"],
      },
      constraints: {
        type: "object",
        properties: {
          filters: {
            type: "array",
            items: {
              type: "object",
              properties: {
                field: { type: "string" },
                op: { type: "string" },
                value: {},
              },
              required: ["field", "op", "value"],
            },
          },
        },
        required: ["filters"],
      },
    },
    required: ["rewrites", "constraints"],
  },
};

const allowedCategories = ["watches", "jewellery", "bags", "dresses", "shoes", "accessories", "clothing", "unknown"];
const allowedFields = ["brand", "category", "condition", "country", "material", "price"];
const systemPrompt = [
  "You are PSG Query Compiler v1 for a second-hand luxury catalog.",
  "Return one JSON object and nothing else.",
  "Interpret the shopper query into concise keyword and embedding rewrites plus conservative catalog constraints.",
  "Never emit OpenSearch DSL. Constraints may use only brand, category, condition, country, material, or price.",
  "For price use gte or lte with a numeric euro value. For the other fields use term or terms.",
  `Categories use these exact index values: ${allowedCategories.join(", ")}.`,
].join(" ");

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

function parseJson(content) {
  if (typeof content !== "string") throw new Error("Model response did not contain text");
  const unfenced = content.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  return JSON.parse(unfenced);
}

function validateCompiler(output, rawQuery) {
  if (!output || typeof output !== "object" || Array.isArray(output)) throw new Error("Model output must be an object");
  const rewrites = output.rewrites;
  if (!rewrites || typeof rewrites.keyword_query !== "string" || !rewrites.keyword_query.trim()) {
    throw new Error("Model output is missing rewrites.keyword_query");
  }
  if (rewrites.keyword_query.length > 1000) throw new Error("Model keyword rewrite is too long");
  if (output.raw_query && output.raw_query !== rawQuery) throw new Error("Model output raw_query does not match request");
  const rawFilters = Array.isArray(output.constraints?.filters) ? output.constraints.filters.slice(0, 8) : [];
  const filters = rawFilters.filter((constraint) => {
    if (!constraint || !allowedFields.includes(constraint.field)) return false;
    if (constraint.field === "price") {
      return ["gte", "lte"].includes(constraint.op) && Number.isFinite(Number(constraint.value));
    }
    return (
      ["term", "terms"].includes(constraint.op) &&
      (typeof constraint.value === "string" ||
        (Array.isArray(constraint.value) && constraint.value.every((value) => typeof value === "string")))
    );
  });
  return {
    schema_version: "psg_query_compiler_v1",
    raw_query: rawQuery,
    category: allowedCategories.includes(output.category) ? output.category : "unknown",
    confidence: Number.isFinite(Number(output.confidence)) ? Math.max(0, Math.min(1, Number(output.confidence))) : 0,
    clarification_needed: Boolean(output.clarification_needed),
    clarification_question: typeof output.clarification_question === "string" ? output.clarification_question : null,
    rewrites: {
      keyword_query: rewrites.keyword_query.trim(),
      embedding_query: typeof rewrites.embedding_query === "string" ? rewrites.embedding_query.trim() : rewrites.keyword_query.trim(),
      negative_query: typeof rewrites.negative_query === "string" ? rewrites.negative_query.trim() : "",
    },
    constraints: { filters },
  };
}

async function understand(rawQuery, context = {}) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 700,
        response_format: { type: "json_schema", json_schema: responseSchema },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: JSON.stringify({ raw_query: rawQuery, current_filters: context.filters || {} }) },
        ],
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`model endpoint returned ${response.status}`);
    const body = await response.json();
    const compiler = validateCompiler(parseJson(body.choices?.[0]?.message?.content), rawQuery);
    return { status: "applied", model, tookMs: Date.now() - startedAt, compiler };
  } catch (error) {
    return {
      status: error.name === "AbortError" ? "timeout" : "invalid",
      model,
      tookMs: Date.now() - startedAt,
      error: error.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

const server = http.createServer(async (request, response) => {
  if (request.method === "OPTIONS") return send(response, 204, {});
  if (request.method === "GET" && request.url === "/health") {
    return send(response, 200, { ok: true, model, baseUrl, timeoutMs });
  }
  if (request.method === "POST" && request.url === "/understand") {
    const payload = await readJson(request);
    if (!String(payload.query || "").trim()) return send(response, 400, { error: "query is required" });
    return send(response, 200, await understand(String(payload.query), payload));
  }
  return send(response, 404, { error: "not_found" });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Mistral query-understanding adapter listening on http://127.0.0.1:${port}`);
  console.log(`Model: ${model} via ${baseUrl}`);
});
