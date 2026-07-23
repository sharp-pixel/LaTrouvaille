import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAgenticModelConnector,
  buildTrustedConnectorClusterSettings,
  loadPersistentSageMakerConnectorCredentials,
  normalizeAgenticModelProvider,
  prepareAgenticRequestBody,
  redactConnectorCredential,
  rollbackAgenticRegistration,
  selectConfiguredSageMakerModel,
} from "../src/lib/agentic-model-provider.js";
import {
  DEFAULT_INSTANCE_TYPE,
  DEFAULT_MODEL_ID,
  DEFAULT_MODEL_REVISION,
  assertManagedSageMakerResources,
  buildSageMakerDeployment,
  createSageMakerDeploymentResources,
  isMissingEndpointError,
} from "../scripts/sagemaker-ministral.mjs";

test("SageMaker deployment pins Ministral to one ml.g6.2xlarge text-only worker", () => {
  const deployment = buildSageMakerDeployment({
    region: "eu-west-1",
    executionRoleArn: "arn:aws:iam::123456789012:role/SageMakerExecutionRole",
    timestamp: 1720000000000,
  });

  assert.equal(deployment.endpointName, "la-trouvaille-ministral");
  assert.equal(deployment.endpointConfig.ProductionVariants.length, 1);
  assert.equal(deployment.endpointConfig.ProductionVariants[0].InstanceType, DEFAULT_INSTANCE_TYPE);
  assert.equal(
    deployment.endpointConfig.ProductionVariants[0].InferenceAmiVersion,
    "al2-ami-sagemaker-inference-gpu-3-1",
  );
  assert.equal(
    deployment.model.PrimaryContainer.Image,
    "763104351884.dkr.ecr.eu-west-1.amazonaws.com/vllm:0.25.1-gpu-py312-cu130-ubuntu22.04-sagemaker-v1.3-2026-07-22-22-50-11",
  );
  assert.deepEqual(
    {
      model: deployment.model.PrimaryContainer.Environment.HF_MODEL_ID,
      revision: deployment.model.PrimaryContainer.Environment.SM_VLLM_REVISION,
      maxModelLength: deployment.model.PrimaryContainer.Environment.SM_VLLM_MAX_MODEL_LEN,
      languageModelOnly: deployment.model.PrimaryContainer.Environment.SM_VLLM_LANGUAGE_MODEL_ONLY,
      dtype: deployment.model.PrimaryContainer.Environment.SM_VLLM_DTYPE,
    },
    {
      model: DEFAULT_MODEL_ID,
      revision: DEFAULT_MODEL_REVISION,
      maxModelLength: "4096",
      languageModelOnly: "true",
      dtype: "bfloat16",
    },
  );
  assert.equal(
    "SM_VLLM_DISABLE_LOG_REQUESTS" in deployment.model.PrimaryContainer.Environment,
    false,
  );
});

test("SageMaker connector signs the standard invocation endpoint with SigV4", () => {
  const requestBody = {
    model: "${parameters.model}",
    messages: [],
    response_format: {
      type: "json_schema",
      json_schema: {
        schema: {
          type: "array",
          items: { type: "string" },
          uniqueItems: true,
        },
      },
    },
  };
  const connector = buildAgenticModelConnector({
    provider: "sagemaker",
    selectedModel: { model: "ministral-3-8b-instruct-2512", source: "base" },
    requestBody,
    sagemaker: {
      region: "eu-west-1",
      endpointName: "la-trouvaille-ministral",
      credentials: {
        accessKeyId: "access-key",
        secretAccessKey: "secret-key",
        sessionToken: "session-token",
      },
    },
  });

  assert.equal(connector.protocol, "aws_sigv4");
  assert.deepEqual(connector.parameters, {
    model: "ministral-3-8b-instruct-2512",
    region: "eu-west-1",
    service_name: "sagemaker",
  });
  assert.deepEqual(connector.credential, {
    access_key: "access-key",
    secret_key: "secret-key",
    session_token: "session-token",
  });
  assert.equal(
    connector.actions[0].url,
    "https://runtime.sagemaker.eu-west-1.amazonaws.com/endpoints/la-trouvaille-ministral/invocations",
  );
  assert.equal("Authorization" in connector.actions[0].headers, false);
  assert.equal(
    "uniqueItems" in
      JSON.parse(connector.actions[0].request_body).response_format.json_schema.schema,
    false,
  );
  assert.equal(requestBody.response_format.json_schema.schema.uniqueItems, true);
});

test("SageMaker setup uses a configured static model instead of remote discovery", () => {
  assert.deepEqual(
    selectConfiguredSageMakerModel({
      configuredModel: "",
      fineTunedModel: "psg-agentic-query-planner-v3",
      baseModel: "ministral-3-8b-instruct-2512",
    }),
    { model: "ministral-3-8b-instruct-2512", source: "base" },
  );
  assert.deepEqual(
    selectConfiguredSageMakerModel({
      configuredModel: "psg-agentic-query-planner-v3",
      fineTunedModel: "psg-agentic-query-planner-v3",
      baseModel: "ministral-3-8b-instruct-2512",
    }),
    { model: "psg-agentic-query-planner-v3", source: "fine-tuned" },
  );
});

test("SageMaker request schemas omit vLLM-unsupported uniqueItems without mutating the source", () => {
  const requestBody = {
    response_format: {
      type: "json_schema",
      json_schema: {
        schema: {
          type: "object",
          properties: {
            values: {
              type: "array",
              items: { type: "string" },
              uniqueItems: true,
            },
          },
        },
      },
    },
  };

  const prepared = prepareAgenticRequestBody({ provider: "sagemaker", requestBody });
  assert.equal(
    "uniqueItems" in prepared.response_format.json_schema.schema.properties.values,
    false,
  );
  assert.equal(
    requestBody.response_format.json_schema.schema.properties.values.uniqueItems,
    true,
  );
  assert.equal(
    prepareAgenticRequestBody({ provider: "openai", requestBody }),
    requestBody,
  );
});

test("persisted SageMaker connectors require explicitly dedicated non-expiring credentials", () => {
  assert.deepEqual(
    loadPersistentSageMakerConnectorCredentials({
      SAGEMAKER_CONNECTOR_ACCESS_KEY_ID: "dedicated-access",
      SAGEMAKER_CONNECTOR_SECRET_ACCESS_KEY: "dedicated-secret",
    }),
    {
      accessKeyId: "dedicated-access",
      secretAccessKey: "dedicated-secret",
      sessionToken: "",
    },
  );
  assert.throws(
    () =>
      loadPersistentSageMakerConnectorCredentials({
        AWS_ACCESS_KEY_ID: "generic-access",
        AWS_SECRET_ACCESS_KEY: "generic-secret",
      }),
    /dedicated principal/,
  );
  assert.throws(
    () =>
      loadPersistentSageMakerConnectorCredentials({
        SAGEMAKER_CONNECTOR_ACCESS_KEY_ID: "temporary-access",
        SAGEMAKER_CONNECTOR_SECRET_ACCESS_KEY: "temporary-secret",
        SAGEMAKER_CONNECTOR_SESSION_TOKEN: "temporary-token",
      }),
    /temporary/,
  );
});

test("connector cluster settings preserve existing trusted endpoints and private-IP access", () => {
  const existingEndpoint = "^http://host\\.docker\\.internal:8000/.*$";
  const sagemakerSettings = buildTrustedConnectorClusterSettings({
    provider: "sagemaker",
    connectorOrigin: "https://runtime.sagemaker.eu-west-1.amazonaws.com",
    currentPersistent: {
      "plugins.ml_commons.trusted_connector_endpoints_regex": JSON.stringify([
        existingEndpoint,
      ]),
      "plugins.ml_commons.connector.private_ip_enabled": "true",
    },
  });
  assert.deepEqual(
    sagemakerSettings["plugins.ml_commons.trusted_connector_endpoints_regex"],
    [
      existingEndpoint,
      "^https://runtime\\.sagemaker\\.eu-west-1\\.amazonaws\\.com/.*$",
    ],
  );
  assert.equal(
    "plugins.ml_commons.connector.private_ip_enabled" in sagemakerSettings,
    false,
  );

  const localSettings = buildTrustedConnectorClusterSettings({
    provider: "openai",
    connectorOrigin: "http://host.docker.internal:8000",
    currentPersistent: sagemakerSettings,
  });
  assert.equal(localSettings["plugins.ml_commons.connector.private_ip_enabled"], true);
  assert.equal(
    localSettings["plugins.ml_commons.trusted_connector_endpoints_regex"].length,
    2,
  );
});

test("agentic registration rollback removes the agent before its newly registered model", async () => {
  const calls = [];
  const errors = await rollbackAgenticRegistration({
    request: async (method, path) => {
      calls.push([method, path]);
      if (path.includes("/agents/")) throw new Error("agent cleanup failed");
    },
    registeredAgentId: "agent/id",
    registeredModelId: "model/id",
  });
  assert.deepEqual(calls, [
    ["DELETE", "/_plugins/_ml/agents/agent%2Fid"],
    ["DELETE", "/_plugins/_ml/models/model%2Fid"],
  ]);
  assert.deepEqual(errors, ["delete agent: agent cleanup failed"]);
});

test("SageMaker deployment validates region and image tag before creating resources", () => {
  const base = {
    region: "eu-west-1",
    executionRoleArn: "arn:aws:iam::123456789012:role/SageMakerExecutionRole",
    timestamp: 1720000000000,
  };
  assert.throws(
    () => buildSageMakerDeployment({ ...base, region: "" }),
    /Invalid SageMaker region/,
  );
  assert.throws(
    () => buildSageMakerDeployment({ ...base, imageTag: "repository:tag" }),
    /Invalid SageMaker vLLM image tag/,
  );
  assert.throws(
    () => buildSageMakerDeployment({ ...base, modelId: " " }),
    /Model ID must be a non-empty value/,
  );
});

test("SageMaker deletion refuses endpoint configs and models outside its managed namespace", () => {
  assert.doesNotThrow(() =>
    assertManagedSageMakerResources({
      endpointName: "la-trouvaille-ministral",
      endpointConfigName: "la-trouvaille-ministral-config-1720000000000",
      modelNames: ["la-trouvaille-ministral-model-1720000000000"],
    }),
  );
  assert.throws(
    () =>
      assertManagedSageMakerResources({
        endpointName: "la-trouvaille-ministral",
        endpointConfigName: "shared-production-config",
        modelNames: ["shared-production-model"],
      }),
    /Refusing to delete endpoint config/,
  );
  assert.throws(
    () =>
      assertManagedSageMakerResources({
        endpointName: "la-trouvaille-ministral",
        endpointConfigName: "la-trouvaille-ministral-config-1720000000000",
        modelNames: ["shared-production-model"],
      }),
    /Refusing to delete model resources/,
  );
});

test("missing endpoint detection does not suppress unrelated validation failures", () => {
  assert.equal(
    isMissingEndpointError(
      'An error occurred (ValidationException): Could not find endpoint "missing".',
    ),
    true,
  );
  assert.equal(
    isMissingEndpointError(
      "An error occurred (ValidationException): Endpoint name contains invalid characters.",
    ),
    false,
  );
});

test("SageMaker deployment rolls back a model when endpoint-config creation fails", () => {
  const deployment = buildSageMakerDeployment({
    region: "eu-west-1",
    executionRoleArn: "arn:aws:iam::123456789012:role/SageMakerExecutionRole",
    timestamp: 1720000000000,
  });
  const calls = [];
  const runAws = (args) => {
    calls.push(args);
    if (args[1] === "create-endpoint-config") throw new Error("endpoint config failed");
  };

  assert.throws(
    () => createSageMakerDeploymentResources({ region: "eu-west-1", deployment, runAws }),
    /endpoint config failed.*rolled back/,
  );
  assert.deepEqual(
    calls.map((args) => args[1]),
    ["create-model", "create-endpoint-config", "delete-model"],
  );
});

test("SageMaker deployment rolls back all resources when the endpoint waiter fails", () => {
  const deployment = buildSageMakerDeployment({
    region: "eu-west-1",
    executionRoleArn: "arn:aws:iam::123456789012:role/SageMakerExecutionRole",
    timestamp: 1720000000000,
  });
  const calls = [];
  const runAws = (args) => {
    calls.push(args);
    if (args[1] === "wait" && args[2] === "endpoint-in-service") {
      throw new Error("endpoint failed");
    }
  };

  assert.throws(
    () => createSageMakerDeploymentResources({ region: "eu-west-1", deployment, runAws }),
    /endpoint failed.*rolled back/,
  );
  assert.deepEqual(
    calls.map((args) => args.slice(1, 3).join(" ")),
    [
      "create-model --region",
      "create-endpoint-config --region",
      "create-endpoint --region",
      "wait endpoint-in-service",
      "delete-endpoint --region",
      "wait endpoint-deleted",
      "delete-endpoint-config --region",
      "delete-model --region",
    ],
  );
});

test("provider validation and dry-run redaction fail closed", () => {
  assert.equal(normalizeAgenticModelProvider(" SageMaker "), "sagemaker");
  assert.throws(() => normalizeAgenticModelProvider("unknown"), /Unsupported AGENTIC_MODEL_PROVIDER/);
  assert.throws(
    () =>
      buildAgenticModelConnector({
        provider: "sagemaker",
        selectedModel: { model: "model" },
        requestBody: {},
        sagemaker: {
          region: "eu-west-1",
          endpointName: "bad/endpoint",
          credentials: { accessKeyId: "access", secretAccessKey: "secret" },
        },
      }),
    /Invalid SAGEMAKER_MINISTRAL_ENDPOINT/,
  );

  assert.deepEqual(
    redactConnectorCredential({
      protocol: "aws_sigv4",
      credential: { access_key: "access", secret_key: "secret" },
    }).credential,
    { access_key: "<redacted>", secret_key: "<redacted>" },
  );
});
