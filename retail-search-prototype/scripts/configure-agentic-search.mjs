import { Client } from "@opensearch-project/opensearch";
import { readFileSync } from "node:fs";
import { AGENTIC_FALLBACK_QUERY, selectAvailableModel } from "../src/lib/agentic-search.js";
import {
  buildAgenticModelConnector,
  buildTrustedConnectorClusterSettings,
  loadPersistentSageMakerConnectorCredentials,
  normalizeAgenticModelProvider,
  redactConnectorCredential,
  rollbackAgenticRegistration,
  selectConfiguredSageMakerModel,
} from "../src/lib/agentic-model-provider.js";

const node = process.env.OPENSEARCH_URL || "http://127.0.0.1:9200";
const pipelineId = process.env.OPENSEARCH_AGENTIC_SEARCH_PIPELINE || "secondhand-agentic-search";
const providedModelId = process.env.OPENSEARCH_AGENTIC_MODEL_ID || "";
const fineTunedModel = process.env.AGENTIC_FINE_TUNED_MODEL || "psg-agentic-query-planner-v3";
const baseModel = process.env.AGENTIC_BASE_MODEL || process.env.MISTRAL_MODEL || "ministral-3-8b-instruct-2512";
const provider = normalizeAgenticModelProvider(process.env.AGENTIC_MODEL_PROVIDER || "openai");
const discoveryBaseUrl = (process.env.AGENTIC_MODEL_DISCOVERY_BASE_URL || "http://127.0.0.1:8000/v1").replace(/\/$/, "");
const connectorBaseUrl = (process.env.AGENTIC_MODEL_BASE_URL || "http://host.docker.internal:8000/v1").replace(/\/$/, "");
const modelApiKey = process.env.AGENTIC_MODEL_API_KEY || process.env.MISTRAL_API_KEY || "local";
const sagemakerRegion =
  process.env.SAGEMAKER_REGION || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "eu-west-1";
const sagemakerEndpoint = process.env.SAGEMAKER_MINISTRAL_ENDPOINT || "la-trouvaille-ministral";
const sagemakerModel = process.env.SAGEMAKER_MINISTRAL_MODEL || baseModel;
const structuredOutput = process.env.AGENTIC_STRUCTURED_OUTPUT !== "false";
const dryRun = process.argv.includes("--dry-run");
const queryPlannerSystemPrompt = readFileSync(
  new URL(
    "../../query-understanding-training/src/query_understanding/prompts/opensearch-agentic-query-planner-v3.txt",
    import.meta.url,
  ),
  "utf8",
).trim();
const queryPlannerUserPrompt = readFileSync(
  new URL(
    "../../query-understanding-training/src/query_understanding/prompts/opensearch-agentic-query-planner-user-v3.txt",
    import.meta.url,
  ),
  "utf8",
).trim();

const client = new Client({
  node,
  auth:
    process.env.OPENSEARCH_USERNAME && process.env.OPENSEARCH_PASSWORD
      ? { username: process.env.OPENSEARCH_USERNAME, password: process.env.OPENSEARCH_PASSWORD }
      : undefined,
  ssl: { rejectUnauthorized: process.env.OPENSEARCH_REJECT_UNAUTHORIZED !== "false" },
});

function unwrap(response) {
  return response?.body ?? response;
}

async function request(method, path, body) {
  return unwrap(await client.transport.request({ method, path, body }));
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForModel(taskId) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const task = await request("GET", `/_plugins/_ml/tasks/${encodeURIComponent(taskId)}`);
    if (task.state === "COMPLETED" && task.model_id) return task.model_id;
    if (["FAILED", "COMPLETED_WITH_ERROR"].includes(task.state)) {
      throw new Error(`Model registration failed: ${task.error || JSON.stringify(task)}`);
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for model registration task ${taskId}`);
}

async function discoverModel() {
  const headers = modelApiKey && modelApiKey !== "local" ? { Authorization: `Bearer ${modelApiKey}` } : {};
  const response = await fetch(`${discoveryBaseUrl}/models`, { headers });
  if (!response.ok) throw new Error(`Model discovery returned HTTP ${response.status}`);
  const payload = await response.json();
  const availableModelIds = (payload.data || []).map((model) => model.id).filter(Boolean);
  return selectAvailableModel({ availableModelIds, fineTunedModel, baseModel });
}

function loadSageMakerCredentials() {
  return loadPersistentSageMakerConnectorCredentials();
}

function modelRegistration(selectedModel, sagemakerCredentials) {
  const requestBody = {
    model: "${parameters.model}",
    messages: [
      { role: "system", content: "${parameters.system_prompt}" },
      { role: "user", content: "${parameters.user_prompt}" },
    ],
    temperature: 0,
    max_tokens: 1200,
  };
  if (structuredOutput) {
    const facetFilterFields = ["category", "condition", "country", "material"];
    const facetValueSchema = { type: "string", minLength: 1, maxLength: 100 };
    const singleKeywordProperties = {
      availability: { type: "string", enum: ["active"] },
      ...Object.fromEntries(facetFilterFields.map((field) => [field, facetValueSchema])),
    };
    const multipleKeywordProperties = Object.fromEntries(
      facetFilterFields.map((field) => [
        field,
        { type: "array", items: facetValueSchema, minItems: 2, maxItems: 20, uniqueItems: true },
      ]),
    );
    const scoreSortOptions = {
      type: "object",
      properties: { order: { type: "string", enum: ["desc"] } },
      required: ["order"],
      additionalProperties: false,
    };
    const filterClause = {
      type: "object",
      properties: {
        term: {
          type: "object",
          properties: singleKeywordProperties,
          minProperties: 1,
          maxProperties: 1,
          additionalProperties: false,
        },
        terms: {
          type: "object",
          properties: multipleKeywordProperties,
          minProperties: 1,
          maxProperties: 1,
          additionalProperties: false,
        },
        range: {
          type: "object",
          properties: {
            price: {
              type: "object",
              properties: { lte: { type: "integer", minimum: 1, maximum: 20000 } },
              required: ["lte"],
              additionalProperties: false,
            },
          },
          required: ["price"],
          additionalProperties: false,
        },
      },
      minProperties: 1,
      maxProperties: 1,
      additionalProperties: false,
    };
    const multiMatchClause = {
      type: "object",
      properties: {
        multi_match: {
          type: "object",
          properties: {
            query: { type: "string", minLength: 1, maxLength: 300 },
            fields: {
              type: "array",
              items: {
                type: "string",
                enum: ["title^5", "brand^3", "canonical_text^3", "description"],
              },
              minItems: 4,
              maxItems: 4,
              uniqueItems: true,
            },
            operator: { type: "string", enum: ["and", "or"] },
          },
          required: ["query", "fields", "operator"],
          additionalProperties: false,
        },
      },
      required: ["multi_match"],
      additionalProperties: false,
    };
    const rankFeatureClause = {
      type: "object",
      properties: {
        rank_feature: {
          type: "object",
          properties: {
            field: { type: "string", enum: ["quality_score", "freshness_score", "seller_score"] },
            boost: { type: "number", enum: [0.2, 0.05, 0.02] },
          },
          required: ["field", "boost"],
          additionalProperties: false,
        },
      },
      required: ["rank_feature"],
      additionalProperties: false,
    };
    const personaExpansionClause = {
      type: "object",
      properties: {
        multi_match: {
          type: "object",
          properties: {
            query: { type: "string", minLength: 1, maxLength: 120 },
            fields: {
              type: "array",
              items: {
                type: "string",
                enum: ["title^5", "brand^3", "canonical_text^3", "description"],
              },
              minItems: 4,
              maxItems: 4,
              uniqueItems: true,
            },
            operator: { type: "string", enum: ["or"] },
            boost: { type: "number", enum: [0.35] },
          },
          required: ["query", "fields", "operator", "boost"],
          additionalProperties: false,
        },
      },
      required: ["multi_match"],
      additionalProperties: false,
    };
    const sortClause = {
      type: "object",
      properties: {
        _score: scoreSortOptions,
        price: {
          type: "object",
          properties: { order: { type: "string", enum: ["asc"] } },
          required: ["order"],
          additionalProperties: false,
        },
        listed_at: scoreSortOptions,
        old_price: {
          type: "object",
          properties: {
            order: { type: "string", enum: ["desc"] },
            missing: { type: "string", enum: ["_last"] },
          },
          required: ["order", "missing"],
          additionalProperties: false,
        },
      },
      minProperties: 1,
      maxProperties: 1,
      additionalProperties: false,
    };
    requestBody.response_format = {
      type: "json_schema",
      json_schema: {
        name: "opensearch_request",
        strict: true,
        schema: {
          type: "object",
          properties: {
            size: { type: "integer", minimum: 1, maximum: 96 },
            track_total_hits: { type: "integer", minimum: 0, maximum: 10000 },
            query: {
              type: "object",
              properties: {
                bool: {
                  type: "object",
                  properties: {
                    filter: { type: "array", items: filterClause, minItems: 2, maxItems: 6 },
                    must: { type: "array", items: multiMatchClause, minItems: 1, maxItems: 1 },
                    should: {
                      type: "array",
                      items: { anyOf: [personaExpansionClause, rankFeatureClause] },
                      minItems: 1,
                      maxItems: 4,
                    },
                  },
                  required: ["filter", "must"],
                  additionalProperties: false,
                },
              },
              required: ["bool"],
              additionalProperties: false,
            },
            sort: { type: "array", items: sortClause, minItems: 1, maxItems: 2 },
          },
          required: ["size", "track_total_hits", "query"],
          additionalProperties: false,
        },
      },
    };
  }

  return {
    name: `La Trouvaille agentic planner: ${selectedModel.model}`,
    function_name: "remote",
    description: `Native agentic-search planner using the ${selectedModel.source} retail query model`,
    connector: buildAgenticModelConnector({
      provider,
      selectedModel,
      requestBody,
      connectorBaseUrl,
      modelApiKey,
      sagemaker: {
        region: sagemakerRegion,
        endpointName: sagemakerEndpoint,
        credentials: sagemakerCredentials,
      },
    }),
  };
}

function agentRegistration(modelId) {
  return {
    name: "La Trouvaille native agentic search planner",
    type: "flow",
    description: "Retail query planning with the native OpenSearch QueryPlanningTool",
    tools: [
      {
        type: "QueryPlanningTool",
        parameters: {
          model_id: modelId,
          response_filter: "$.choices[0].message.content",
          query_planner_system_prompt: queryPlannerSystemPrompt,
          query_planner_user_prompt: queryPlannerUserPrompt,
          fallback_query: AGENTIC_FALLBACK_QUERY,
        },
      },
    ],
  };
}

function pipelineRegistration(agentId) {
  return {
    request_processors: [{ agentic_query_translator: { agent_id: agentId } }],
    response_processors: [{ agentic_context: { dsl_query: true } }],
  };
}

async function main() {
  const selectedModel = providedModelId
    ? { model: "pre-registered", source: "provided" }
    : provider === "sagemaker"
      ? selectConfiguredSageMakerModel({
          configuredModel: sagemakerModel,
          fineTunedModel,
          baseModel,
        })
      : await discoverModel();
  if (dryRun) {
    const previewCredentials = {
      accessKeyId: "<redacted>",
      secretAccessKey: "<redacted>",
      sessionToken: "",
    };
    const registrationPreview = providedModelId
      ? null
      : modelRegistration(selectedModel, previewCredentials);
    if (registrationPreview) {
      registrationPreview.connector = redactConnectorCredential(registrationPreview.connector);
    }
    console.log(
      JSON.stringify(
        {
          node,
          pipelineId,
          provider,
          selectedModel,
          providedModelId: providedModelId || null,
          connectorBaseUrl: provider === "openai" ? connectorBaseUrl : null,
          sagemaker:
            provider === "sagemaker"
              ? { region: sagemakerRegion, endpointName: sagemakerEndpoint }
              : null,
          structuredOutput,
          modelRegistration: registrationPreview,
          agentRegistration: agentRegistration(providedModelId || "<registered-model-id>"),
          pipelineRegistration: pipelineRegistration("<registered-agent-id>"),
        },
        null,
        2,
      ),
    );
    return;
  }

  let modelId = providedModelId;
  let registeredModelId = null;
  let registeredAgentId = null;
  try {
    if (!modelId) {
      const sagemakerCredentials =
        provider === "sagemaker" ? loadSageMakerCredentials() : undefined;
      const connectorOrigin =
        provider === "sagemaker"
          ? `https://runtime.sagemaker.${sagemakerRegion}.amazonaws.com`
          : new URL(connectorBaseUrl).origin;
      const currentClusterSettings = await request(
        "GET",
        "/_cluster/settings?flat_settings=true&include_defaults=false",
      );
      await request("PUT", "/_cluster/settings", {
        persistent: buildTrustedConnectorClusterSettings({
          provider,
          connectorOrigin,
          currentPersistent: currentClusterSettings.persistent,
        }),
      });
      const registration = await request(
        "POST",
        "/_plugins/_ml/models/_register",
        modelRegistration(selectedModel, sagemakerCredentials),
      );
      modelId =
        registration.model_id ||
        (registration.task_id && (await waitForModel(registration.task_id)));
      if (!modelId) {
        throw new Error(
          `Model registration did not return a model ID: ${JSON.stringify(registration)}`,
        );
      }
      registeredModelId = modelId;
    }
    const agent = await request(
      "POST",
      "/_plugins/_ml/agents/_register",
      agentRegistration(modelId),
    );
    if (!agent.agent_id) {
      throw new Error(`Agent registration did not return an agent ID: ${JSON.stringify(agent)}`);
    }
    registeredAgentId = agent.agent_id;
    await request(
      "PUT",
      `/_search/pipeline/${encodeURIComponent(pipelineId)}`,
      pipelineRegistration(agent.agent_id),
    );
    console.log(`Configured native Agentic Search pipeline ${pipelineId}.`);
    console.log(
      `Planner model: ${selectedModel.model} (${selectedModel.source}); OpenSearch model ID: ${modelId}`,
    );
    console.log(`Flow agent ID: ${agent.agent_id}`);
  } catch (error) {
    const rollbackErrors = await rollbackAgenticRegistration({
      request,
      registeredModelId,
      registeredAgentId,
    });
    const suffix = rollbackErrors.length
      ? ` Registration rollback also failed: ${rollbackErrors.join("; ")}`
      : "";
    throw new Error(`${error.message || String(error)}${suffix}`, { cause: error });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
