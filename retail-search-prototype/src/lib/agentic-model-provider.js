const SAGEMAKER_ENDPOINT_PATTERN = /^[A-Za-z0-9](?:-*[A-Za-z0-9])*$/;
const AWS_REGION_PATTERN = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/;
const TRUSTED_CONNECTOR_SETTING = "plugins.ml_commons.trusted_connector_endpoints_regex";
const PRIVATE_CONNECTOR_SETTING = "plugins.ml_commons.connector.private_ip_enabled";

export function normalizeAgenticModelProvider(value = "openai") {
  const provider = String(value).trim().toLowerCase();
  if (!["openai", "sagemaker"].includes(provider)) {
    throw new Error(`Unsupported AGENTIC_MODEL_PROVIDER "${value}"; expected openai or sagemaker`);
  }
  return provider;
}

export function selectConfiguredSageMakerModel({ configuredModel, fineTunedModel, baseModel }) {
  const model = String(configuredModel || baseModel || "").trim();
  if (!model) throw new Error("SAGEMAKER_MINISTRAL_MODEL or AGENTIC_BASE_MODEL is required");
  return {
    model,
    source: model === fineTunedModel ? "fine-tuned" : model === baseModel ? "base" : "configured",
  };
}

export function loadPersistentSageMakerConnectorCredentials(environment = process.env) {
  const accessKeyId = String(environment.SAGEMAKER_CONNECTOR_ACCESS_KEY_ID || "").trim();
  const secretAccessKey = String(environment.SAGEMAKER_CONNECTOR_SECRET_ACCESS_KEY || "").trim();
  const sessionToken = String(environment.SAGEMAKER_CONNECTOR_SESSION_TOKEN || "").trim();
  const allowTemporarySession =
    environment.SAGEMAKER_CONNECTOR_ALLOW_SESSION_CREDENTIALS === "true";
  if (sessionToken && !allowTemporarySession) {
    throw new Error(
      "SAGEMAKER_CONNECTOR_SESSION_TOKEN is temporary and would expire inside the persisted OpenSearch connector",
    );
  }
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      "Set SAGEMAKER_CONNECTOR_ACCESS_KEY_ID and SAGEMAKER_CONNECTOR_SECRET_ACCESS_KEY to a dedicated principal that can invoke only the configured endpoint",
    );
  }
  return { accessKeyId, secretAccessKey, sessionToken };
}

function validateSageMakerTarget({ region, endpointName, credentials }) {
  if (!AWS_REGION_PATTERN.test(region)) {
    throw new Error(`Invalid SAGEMAKER_REGION "${region}"`);
  }
  if (
    !SAGEMAKER_ENDPOINT_PATTERN.test(endpointName) ||
    endpointName.length > 63
  ) {
    throw new Error(`Invalid SAGEMAKER_MINISTRAL_ENDPOINT "${endpointName}"`);
  }
  if (!credentials?.accessKeyId || !credentials?.secretAccessKey) {
    throw new Error("SageMaker connector requires AWS access key credentials");
  }
}

function omitUnsupportedVllmSchemaKeywords(value) {
  if (Array.isArray(value)) return value.map(omitUnsupportedVllmSchemaKeywords);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "uniqueItems")
      .map(([key, item]) => [key, omitUnsupportedVllmSchemaKeywords(item)]),
  );
}

export function prepareAgenticRequestBody({ provider, requestBody }) {
  const normalizedProvider = normalizeAgenticModelProvider(provider);
  const schema = requestBody?.response_format?.json_schema?.schema;
  if (normalizedProvider !== "sagemaker" || !schema) return requestBody;
  return {
    ...requestBody,
    response_format: {
      ...requestBody.response_format,
      json_schema: {
        ...requestBody.response_format.json_schema,
        schema: omitUnsupportedVllmSchemaKeywords(schema),
      },
    },
  };
}

function normalizeSettingList(value) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [value];
  } catch {
    return [value];
  }
}

export function buildTrustedConnectorClusterSettings({
  provider,
  connectorOrigin,
  currentPersistent = {},
}) {
  const normalizedProvider = normalizeAgenticModelProvider(provider);
  const origin = new URL(connectorOrigin).origin;
  const escapedOrigin = origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const trustedEndpoint = `^${escapedOrigin}/.*$`;
  const trustedEndpoints = [
    ...new Set([
      ...normalizeSettingList(currentPersistent[TRUSTED_CONNECTOR_SETTING]),
      trustedEndpoint,
    ]),
  ];
  const settings = { [TRUSTED_CONNECTOR_SETTING]: trustedEndpoints };
  if (normalizedProvider === "openai" && new URL(origin).protocol === "http:") {
    settings[PRIVATE_CONNECTOR_SETTING] = true;
  }
  return settings;
}

export async function rollbackAgenticRegistration({
  request,
  registeredModelId,
  registeredAgentId,
}) {
  const errors = [];
  const remove = async (path, label) => {
    try {
      await request("DELETE", path);
    } catch (error) {
      errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  if (registeredAgentId) {
    await remove(
      `/_plugins/_ml/agents/${encodeURIComponent(registeredAgentId)}`,
      "delete agent",
    );
  }
  if (registeredModelId) {
    await remove(
      `/_plugins/_ml/models/${encodeURIComponent(registeredModelId)}`,
      "delete model",
    );
  }
  return errors;
}

export function buildAgenticModelConnector({
  provider,
  selectedModel,
  requestBody,
  connectorBaseUrl,
  modelApiKey,
  sagemaker,
}) {
  const normalizedProvider = normalizeAgenticModelProvider(provider);
  // ml-commons defaults connection/read timeouts to 30s. The FP8 Ministral planner
  // needs ~15-17s and intermittently crossed 30s, surfacing as
  // "Error communicating with remote model: Read timed out". Raise it here, at
  // registration time: client_config must be set alongside the credential, because
  // GET on a model redacts the credential and a later PUT would wipe it.
  const connectorTimeoutSeconds = Number(process.env.AGENTIC_CONNECTOR_TIMEOUT_SECONDS || 120);
  const common = {
    name: `${normalizedProvider === "sagemaker" ? "SageMaker" : "OpenAI-compatible"} connector: ${selectedModel.model}`,
    description:
      normalizedProvider === "sagemaker"
        ? "SigV4 connector to the SageMaker-hosted Ministral query planner"
        : "Connector to the locally or remotely served Ministral query planner",
    version: 1,
    parameters: { model: selectedModel.model },
    client_config: {
      connection_timeout: connectorTimeoutSeconds,
      read_timeout: connectorTimeoutSeconds,
    },
  };

  if (normalizedProvider === "sagemaker") {
    validateSageMakerTarget(sagemaker);
    const credential = {
      access_key: sagemaker.credentials.accessKeyId,
      secret_key: sagemaker.credentials.secretAccessKey,
    };
    if (sagemaker.credentials.sessionToken) {
      credential.session_token = sagemaker.credentials.sessionToken;
    }
    return {
      ...common,
      protocol: "aws_sigv4",
      parameters: {
        ...common.parameters,
        region: sagemaker.region,
        service_name: "sagemaker",
      },
      credential,
      actions: [
        {
          action_type: "predict",
          method: "POST",
          url: `https://runtime.sagemaker.${sagemaker.region}.amazonaws.com/endpoints/${sagemaker.endpointName}/invocations`,
          headers: { "content-type": "application/json" },
          request_body: JSON.stringify(
            prepareAgenticRequestBody({ provider: normalizedProvider, requestBody }),
          ),
        },
      ],
    };
  }

  return {
    ...common,
    protocol: "http",
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
        request_body: JSON.stringify(requestBody),
      },
    ],
  };
}

export function redactConnectorCredential(connector) {
  return {
    ...connector,
    credential: Object.fromEntries(
      Object.keys(connector.credential || {}).map((key) => [key, "<redacted>"]),
    ),
  };
}
