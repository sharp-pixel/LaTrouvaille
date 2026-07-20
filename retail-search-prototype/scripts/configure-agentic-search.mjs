import { Client } from "@opensearch-project/opensearch";
import { readFileSync } from "node:fs";
import { AGENTIC_FALLBACK_QUERY, selectAvailableModel } from "../src/lib/agentic-search.js";

const node = process.env.OPENSEARCH_URL || "http://127.0.0.1:9200";
const pipelineId = process.env.OPENSEARCH_AGENTIC_SEARCH_PIPELINE || "secondhand-agentic-search";
const providedModelId = process.env.OPENSEARCH_AGENTIC_MODEL_ID || "";
const fineTunedModel = process.env.AGENTIC_FINE_TUNED_MODEL || "psg-agentic-query-planner-v1";
const baseModel = process.env.AGENTIC_BASE_MODEL || process.env.MISTRAL_MODEL || "ministral-3-8b-instruct-2512";
const discoveryBaseUrl = (process.env.AGENTIC_MODEL_DISCOVERY_BASE_URL || "http://127.0.0.1:8000/v1").replace(/\/$/, "");
const connectorBaseUrl = (process.env.AGENTIC_MODEL_BASE_URL || "http://host.docker.internal:8000/v1").replace(/\/$/, "");
const modelApiKey = process.env.AGENTIC_MODEL_API_KEY || process.env.MISTRAL_API_KEY || "local";
const dryRun = process.argv.includes("--dry-run");
const queryPlannerSystemPrompt = readFileSync(
  new URL(
    "../../query-understanding-training/src/query_understanding/prompts/opensearch-agentic-query-planner-v1.txt",
    import.meta.url,
  ),
  "utf8",
).trim();
const queryPlannerUserPrompt = readFileSync(
  new URL(
    "../../query-understanding-training/src/query_understanding/prompts/opensearch-agentic-query-planner-user-v1.txt",
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

function modelRegistration(selectedModel) {
  return {
    name: `La Trouvaille agentic planner: ${selectedModel.model}`,
    function_name: "remote",
    description: `Native agentic-search planner using the ${selectedModel.source} retail query model`,
    connector: {
      name: `OpenAI-compatible connector: ${selectedModel.model}`,
      description: "Connector to the locally served fine-tuned or base Ministral model",
      version: 1,
      protocol: "http",
      parameters: { model: selectedModel.model },
      credential: { api_key: modelApiKey },
      actions: [
        {
          action_type: "predict",
          method: "POST",
          url: `${connectorBaseUrl}/chat/completions`,
          headers: {
            Authorization: "Bearer ${credential.api_key}",
            "content-type": "application/json",
          },
          request_body:
            '{ "model": "${parameters.model}", "messages": [{"role":"system","content":"${parameters.system_prompt}"},{"role":"user","content":"${parameters.user_prompt}"}], "temperature": 0, "max_tokens": 1200 }',
        },
      ],
    },
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
  const selectedModel = providedModelId ? { model: "pre-registered", source: "provided" } : await discoverModel();
  if (dryRun) {
    const registrationPreview = providedModelId ? null : modelRegistration(selectedModel);
    if (registrationPreview) registrationPreview.connector.credential.api_key = "<redacted>";
    console.log(
      JSON.stringify(
        {
          node,
          pipelineId,
          selectedModel,
          providedModelId: providedModelId || null,
          connectorBaseUrl,
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
  if (!modelId) {
    const connectorUrl = new URL(connectorBaseUrl);
    const escapedOrigin = connectorUrl.origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    await request("PUT", "/_cluster/settings", {
      persistent: {
        "plugins.ml_commons.trusted_connector_endpoints_regex": [`^${escapedOrigin}/.*$`],
        "plugins.ml_commons.connector.private_ip_enabled": connectorUrl.protocol === "http:",
      },
    });

    const registration = await request("POST", "/_plugins/_ml/models/_register", modelRegistration(selectedModel));
    modelId = registration.model_id || (registration.task_id && (await waitForModel(registration.task_id)));
    if (!modelId) throw new Error(`Model registration did not return a model ID: ${JSON.stringify(registration)}`);
  }

  const agent = await request("POST", "/_plugins/_ml/agents/_register", agentRegistration(modelId));
  if (!agent.agent_id) throw new Error(`Agent registration did not return an agent ID: ${JSON.stringify(agent)}`);
  await request("PUT", `/_search/pipeline/${encodeURIComponent(pipelineId)}`, pipelineRegistration(agent.agent_id));

  console.log(`Configured native Agentic Search pipeline ${pipelineId}.`);
  console.log(`Planner model: ${selectedModel.model} (${selectedModel.source}); OpenSearch model ID: ${modelId}`);
  console.log(`Flow agent ID: ${agent.agent_id}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
