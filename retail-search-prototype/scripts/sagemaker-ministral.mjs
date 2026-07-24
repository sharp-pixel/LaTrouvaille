import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const DEFAULT_ENDPOINT_NAME = "la-trouvaille-ministral";
export const DEFAULT_INSTANCE_TYPE = "ml.g5.2xlarge";
export const DEFAULT_MODEL_ID = "mistralai/Ministral-3-8B-Instruct-2512-BF16";
export const DEFAULT_MODEL_REVISION = "06cc81bfd6e45321d8fc8f816576c5b6ac67ec22";
export const DEFAULT_SERVED_MODEL_NAME = "ministral-3-8b-instruct-2512";
export const DEFAULT_ADAPTER_NAME = "psg-agentic-query-planner-v3";
export const DEFAULT_ADAPTER_PATH = "/opt/ml/model/qlora-agentic-v3/adapter";
export const DEFAULT_IMAGE_TAG =
  "0.25.1-gpu-py312-cu130-ubuntu22.04-sagemaker-v1.3-2026-07-22-22-50-11";
export const DEFAULT_INFERENCE_AMI = "al2-ami-sagemaker-inference-gpu-3-1";
const AWS_REGION_PATTERN = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/;
const DOCKER_TAG_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

function requiredName(value, label) {
  if (!/^[A-Za-z0-9](?:-*[A-Za-z0-9])*$/.test(value) || value.length > 63) {
    throw new Error(`${label} must be a valid SageMaker name with at most 63 characters`);
  }
  return value;
}

function requiredEnvironmentValue(value, label, maxLength = 1024) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > maxLength ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${label} must be a non-empty value with at most ${maxLength} characters`);
  }
  return value;
}

export function isMissingEndpointError(stderr) {
  return /Could not find endpoint/i.test(String(stderr));
}

function awsJson(args, { allowMissing = false } = {}) {
  try {
    const output = execFileSync("aws", [...args, "--output", "json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return output.trim() ? JSON.parse(output) : {};
  } catch (error) {
    const stderr = String(error.stderr || "").trim();
    if (allowMissing && isMissingEndpointError(stderr)) {
      return null;
    }
    throw new Error(stderr || error.message);
  }
}

function aws(args) {
  execFileSync("aws", args, { stdio: "inherit" });
}

function configuredRegion() {
  if (process.env.SAGEMAKER_REGION || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION) {
    return process.env.SAGEMAKER_REGION || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
  }
  return execFileSync("aws", ["configure", "get", "region"], { encoding: "utf8" }).trim();
}

export function buildSageMakerDeployment({
  region,
  executionRoleArn,
  endpointName = DEFAULT_ENDPOINT_NAME,
  instanceType = DEFAULT_INSTANCE_TYPE,
  modelId = DEFAULT_MODEL_ID,
  modelRevision = DEFAULT_MODEL_REVISION,
  servedModelName = DEFAULT_SERVED_MODEL_NAME,
  adapterModelDataUrl = "",
  adapterName = DEFAULT_ADAPTER_NAME,
  adapterPath = DEFAULT_ADAPTER_PATH,
  imageTag = DEFAULT_IMAGE_TAG,
  timestamp = Date.now(),
}) {
  if (!AWS_REGION_PATTERN.test(region)) {
    throw new Error(`Invalid SageMaker region "${region}"`);
  }
  requiredName(endpointName, "Endpoint name");
  if (!/^ml\.[a-z0-9.]+$/.test(instanceType)) {
    throw new Error(`Invalid SageMaker instance type "${instanceType}"`);
  }
  requiredEnvironmentValue(modelId, "Model ID");
  requiredEnvironmentValue(modelRevision, "Model revision");
  requiredEnvironmentValue(servedModelName, "Served model name", 256);
  if (adapterModelDataUrl && !/^s3:\/\/[^/]+\/.+/.test(adapterModelDataUrl)) {
    throw new Error("Adapter ModelDataUrl must be a non-empty S3 object URI");
  }
  if (adapterModelDataUrl) {
    requiredEnvironmentValue(adapterName, "Adapter name", 256);
    requiredEnvironmentValue(adapterPath, "Adapter path");
  }
  if (!DOCKER_TAG_PATTERN.test(imageTag)) {
    throw new Error(`Invalid SageMaker vLLM image tag "${imageTag}"`);
  }
  const suffix = String(timestamp);
  const modelName = requiredName(`${endpointName}-model-${suffix}`, "Model name");
  const endpointConfigName = requiredName(`${endpointName}-config-${suffix}`, "Endpoint config name");
  const image = `763104351884.dkr.ecr.${region}.amazonaws.com/vllm:${imageTag}`;
  const environment = {
    SM_VLLM_REVISION: modelRevision,
    SM_VLLM_SERVED_MODEL_NAME: servedModelName,
    SM_VLLM_TENSOR_PARALLEL_SIZE: "1",
    SM_VLLM_MAX_MODEL_LEN: "4096",
    SM_VLLM_MAX_NUM_SEQS: "4",
    SM_VLLM_MAX_NUM_BATCHED_TOKENS: "4096",
    SM_VLLM_GPU_MEMORY_UTILIZATION: "0.90",
    SM_VLLM_DTYPE: "bfloat16",
    SM_VLLM_LANGUAGE_MODEL_ONLY: "true",
    PROCESS_AUTO_RECOVERY: "true",
  };
  if (adapterModelDataUrl) {
    environment.SM_VLLM_MODEL = modelId;
    environment.SM_VLLM_ENABLE_LORA = "true";
    environment.SM_VLLM_MAX_LORA_RANK = "16";
    environment.SM_VLLM_LORA_MODULES = JSON.stringify({
      name: adapterName,
      path: adapterPath,
      base_model_name: modelId,
    });
  } else {
    environment.HF_MODEL_ID = modelId;
  }

  return {
    endpointName,
    modelName,
    endpointConfigName,
    model: {
      ModelName: modelName,
      ExecutionRoleArn: executionRoleArn,
      PrimaryContainer: {
        Image: image,
        ...(adapterModelDataUrl ? { ModelDataUrl: adapterModelDataUrl } : {}),
        Environment: environment,
      },
    },
    endpointConfig: {
      EndpointConfigName: endpointConfigName,
      ProductionVariants: [
        {
          VariantName: "primary",
          ModelName: modelName,
          InstanceType: instanceType,
          InitialInstanceCount: 1,
          InitialVariantWeight: 1,
          InferenceAmiVersion: DEFAULT_INFERENCE_AMI,
          ContainerStartupHealthCheckTimeoutInSeconds: 1800,
        },
      ],
    },
    endpoint: {
      EndpointName: endpointName,
      EndpointConfigName: endpointConfigName,
    },
  };
}

function deploymentFromEnvironment({ requireRole = false } = {}) {
  const executionRoleArn = process.env.SAGEMAKER_EXECUTION_ROLE_ARN || "";
  if (requireRole && !/^arn:aws[a-z-]*:iam::\d{12}:role\/.+/.test(executionRoleArn)) {
    throw new Error("Set SAGEMAKER_EXECUTION_ROLE_ARN to the SageMaker model execution role ARN");
  }
  return buildSageMakerDeployment({
    region: configuredRegion(),
    executionRoleArn: executionRoleArn || "<required:SAGEMAKER_EXECUTION_ROLE_ARN>",
    endpointName: process.env.SAGEMAKER_MINISTRAL_ENDPOINT || DEFAULT_ENDPOINT_NAME,
    instanceType: process.env.SAGEMAKER_MINISTRAL_INSTANCE_TYPE || DEFAULT_INSTANCE_TYPE,
    modelId: process.env.SAGEMAKER_MINISTRAL_MODEL_ID || DEFAULT_MODEL_ID,
    modelRevision: process.env.SAGEMAKER_MINISTRAL_MODEL_REVISION || DEFAULT_MODEL_REVISION,
    servedModelName: process.env.SAGEMAKER_MINISTRAL_MODEL || DEFAULT_SERVED_MODEL_NAME,
    adapterModelDataUrl: process.env.SAGEMAKER_MINISTRAL_ADAPTER_MODEL_DATA_URL || "",
    adapterName: process.env.SAGEMAKER_MINISTRAL_ADAPTER_NAME || DEFAULT_ADAPTER_NAME,
    adapterPath: process.env.SAGEMAKER_MINISTRAL_ADAPTER_PATH || DEFAULT_ADAPTER_PATH,
    imageTag: process.env.SAGEMAKER_VLLM_IMAGE_TAG || DEFAULT_IMAGE_TAG,
  });
}

function printPlan(deployment) {
  console.log(
    JSON.stringify(
      {
        region: configuredRegion(),
        billableResource: `${deployment.endpointConfig.ProductionVariants[0].InstanceType} real-time endpoint`,
        ...deployment,
      },
      null,
      2,
    ),
  );
}

function assertEndpointDoesNotExist(region, endpointName) {
  const existing = awsJson(
    ["sagemaker", "describe-endpoint", "--region", region, "--endpoint-name", endpointName],
    { allowMissing: true },
  );
  if (existing) {
    throw new Error(
      `Endpoint ${endpointName} already exists with status ${existing.EndpointStatus}; delete it explicitly before redeploying`,
    );
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export function createSageMakerDeploymentResources({ region, deployment, runAws = aws }) {
  const created = { model: false, endpointConfig: false, endpoint: false };
  try {
    runAws([
      "sagemaker",
      "create-model",
      "--region",
      region,
      "--cli-input-json",
      JSON.stringify(deployment.model),
    ]);
    created.model = true;
    runAws([
      "sagemaker",
      "create-endpoint-config",
      "--region",
      region,
      "--cli-input-json",
      JSON.stringify(deployment.endpointConfig),
    ]);
    created.endpointConfig = true;
    runAws([
      "sagemaker",
      "create-endpoint",
      "--region",
      region,
      "--cli-input-json",
      JSON.stringify(deployment.endpoint),
    ]);
    created.endpoint = true;
    runAws([
      "sagemaker",
      "wait",
      "endpoint-in-service",
      "--region",
      region,
      "--endpoint-name",
      deployment.endpointName,
    ]);
  } catch (error) {
    const rollbackErrors = [];
    const rollback = (args, label) => {
      try {
        runAws(args);
        return true;
      } catch (rollbackError) {
        rollbackErrors.push(`${label}: ${errorMessage(rollbackError)}`);
        return false;
      }
    };
    if (created.endpoint) {
      const endpointDeleteRequested = rollback(
        ["sagemaker", "delete-endpoint", "--region", region, "--endpoint-name", deployment.endpointName],
        "delete endpoint",
      );
      if (endpointDeleteRequested) {
        rollback(
          ["sagemaker", "wait", "endpoint-deleted", "--region", region, "--endpoint-name", deployment.endpointName],
          "wait for endpoint deletion",
        );
      }
    }
    if (created.endpointConfig) {
      rollback(
        [
          "sagemaker",
          "delete-endpoint-config",
          "--region",
          region,
          "--endpoint-config-name",
          deployment.endpointConfigName,
        ],
        "delete endpoint config",
      );
    }
    if (created.model) {
      rollback(
        ["sagemaker", "delete-model", "--region", region, "--model-name", deployment.modelName],
        "delete model",
      );
    }
    const rollbackSummary = rollbackErrors.length
      ? ` Partial-resource rollback also failed: ${rollbackErrors.join("; ")}`
      : created.model
        ? " Partial SageMaker resources were rolled back."
        : "";
    throw new Error(`${errorMessage(error)}${rollbackSummary}`, { cause: error });
  }
}

export function replaceSageMakerEndpoint({
  region,
  deployment,
  previousEndpointConfigName,
  runAws = aws,
}) {
  let modelCreated = false;
  let configCreated = false;
  let previousEndpointDeleted = false;
  let replacementEndpointCreated = false;
  try {
    runAws([
      "sagemaker",
      "create-model",
      "--region",
      region,
      "--cli-input-json",
      JSON.stringify(deployment.model),
    ]);
    modelCreated = true;
    runAws([
      "sagemaker",
      "create-endpoint-config",
      "--region",
      region,
      "--cli-input-json",
      JSON.stringify(deployment.endpointConfig),
    ]);
    configCreated = true;
    runAws([
      "sagemaker",
      "delete-endpoint",
      "--region",
      region,
      "--endpoint-name",
      deployment.endpointName,
    ]);
    runAws([
      "sagemaker",
      "wait",
      "endpoint-deleted",
      "--region",
      region,
      "--endpoint-name",
      deployment.endpointName,
    ]);
    previousEndpointDeleted = true;
    runAws([
      "sagemaker",
      "create-endpoint",
      "--region",
      region,
      "--cli-input-json",
      JSON.stringify(deployment.endpoint),
    ]);
    replacementEndpointCreated = true;
    runAws([
      "sagemaker",
      "wait",
      "endpoint-in-service",
      "--region",
      region,
      "--endpoint-name",
      deployment.endpointName,
    ]);
  } catch (error) {
    const rollbackErrors = [];
    const rollback = (args, label) => {
      try {
        runAws(args);
      } catch (rollbackError) {
        rollbackErrors.push(`${label}: ${errorMessage(rollbackError)}`);
      }
    };
    if (replacementEndpointCreated) {
      rollback(
        ["sagemaker", "delete-endpoint", "--region", region, "--endpoint-name", deployment.endpointName],
        "delete failed replacement endpoint",
      );
      rollback(
        ["sagemaker", "wait", "endpoint-deleted", "--region", region, "--endpoint-name", deployment.endpointName],
        "wait for failed replacement deletion",
      );
    }
    if (previousEndpointDeleted) {
      rollback(
        [
          "sagemaker",
          "create-endpoint",
          "--region",
          region,
          "--endpoint-name",
          deployment.endpointName,
          "--endpoint-config-name",
          previousEndpointConfigName,
        ],
        "restore previous endpoint",
      );
      rollback(
        ["sagemaker", "wait", "endpoint-in-service", "--region", region, "--endpoint-name", deployment.endpointName],
        "wait for previous endpoint restoration",
      );
    }
    if (configCreated) {
      rollback(
        [
          "sagemaker",
          "delete-endpoint-config",
          "--region",
          region,
          "--endpoint-config-name",
          deployment.endpointConfigName,
        ],
        "delete replacement endpoint config",
      );
    }
    if (modelCreated) {
      rollback(
        ["sagemaker", "delete-model", "--region", region, "--model-name", deployment.modelName],
        "delete replacement model",
      );
    }
    const rollbackSummary = rollbackErrors.length
      ? ` Rollback errors: ${rollbackErrors.join("; ")}`
      : previousEndpointDeleted
        ? " The previous endpoint configuration was restored."
        : " The existing endpoint was not changed.";
    throw new Error(`${errorMessage(error)}${rollbackSummary}`, { cause: error });
  }
}

export function assertManagedSageMakerResources({
  endpointName,
  endpointConfigName,
  modelNames,
}) {
  const expectedConfigPrefix = `${endpointName}-config-`;
  const expectedModelPrefix = `${endpointName}-model-`;
  const configPattern = new RegExp(`^${expectedConfigPrefix}\\d{13}$`);
  const modelPattern = new RegExp(`^${expectedModelPrefix}\\d{13}$`);
  if (!configPattern.test(endpointConfigName)) {
    throw new Error(
      `Refusing to delete endpoint config ${endpointConfigName}; expected a script-managed name matching ${expectedConfigPrefix}<timestamp>`,
    );
  }
  if (!modelNames.length || modelNames.some((name) => !modelPattern.test(name))) {
    throw new Error(
      `Refusing to delete model resources; expected script-managed names matching ${expectedModelPrefix}<timestamp>`,
    );
  }
}

function deploy() {
  const region = configuredRegion();
  const deployment = deploymentFromEnvironment({ requireRole: true });
  assertEndpointDoesNotExist(region, deployment.endpointName);
  printPlan(deployment);
  console.log(`Creating billable SageMaker endpoint ${deployment.endpointName} in ${region}...`);
  createSageMakerDeploymentResources({ region, deployment });
  console.log(`SageMaker endpoint ${deployment.endpointName} is InService.`);
}

function status() {
  const region = configuredRegion();
  const endpointName = process.env.SAGEMAKER_MINISTRAL_ENDPOINT || DEFAULT_ENDPOINT_NAME;
  const endpoint = awsJson([
    "sagemaker",
    "describe-endpoint",
    "--region",
    region,
    "--endpoint-name",
    endpointName,
  ]);
  console.log(JSON.stringify(endpoint, null, 2));
}

function update() {
  const region = configuredRegion();
  const deployment = deploymentFromEnvironment({ requireRole: true });
  if (!deployment.model.PrimaryContainer.ModelDataUrl) {
    throw new Error(
      "Set SAGEMAKER_MINISTRAL_ADAPTER_MODEL_DATA_URL to the validated SageMaker model.tar.gz artifact",
    );
  }
  const current = awsJson([
    "sagemaker",
    "describe-endpoint",
    "--region",
    region,
    "--endpoint-name",
    deployment.endpointName,
  ]);
  printPlan(deployment);
  console.log(
    `Replacing ${deployment.endpointName} during a maintenance window; rollback config is ${current.EndpointConfigName}...`,
  );
  replaceSageMakerEndpoint({
    region,
    deployment,
    previousEndpointConfigName: current.EndpointConfigName,
  });
  console.log(
    `SageMaker endpoint ${deployment.endpointName} is InService with adapter ${process.env.SAGEMAKER_MINISTRAL_ADAPTER_NAME || DEFAULT_ADAPTER_NAME}.`,
  );
}

function remove() {
  const region = configuredRegion();
  const endpointName = process.env.SAGEMAKER_MINISTRAL_ENDPOINT || DEFAULT_ENDPOINT_NAME;
  const endpoint = awsJson([
    "sagemaker",
    "describe-endpoint",
    "--region",
    region,
    "--endpoint-name",
    endpointName,
  ]);
  const endpointConfigName = endpoint.EndpointConfigName;
  const endpointConfig = awsJson([
    "sagemaker",
    "describe-endpoint-config",
    "--region",
    region,
    "--endpoint-config-name",
    endpointConfigName,
  ]);
  const modelNames = [
    ...new Set((endpointConfig.ProductionVariants || []).map((variant) => variant.ModelName).filter(Boolean)),
  ];
  assertManagedSageMakerResources({ endpointName, endpointConfigName, modelNames });

  aws(["sagemaker", "delete-endpoint", "--region", region, "--endpoint-name", endpointName]);
  aws(["sagemaker", "wait", "endpoint-deleted", "--region", region, "--endpoint-name", endpointName]);
  aws([
    "sagemaker",
    "delete-endpoint-config",
    "--region",
    region,
    "--endpoint-config-name",
    endpointConfigName,
  ]);
  for (const modelName of modelNames) {
    aws(["sagemaker", "delete-model", "--region", region, "--model-name", modelName]);
  }
  console.log(`Deleted endpoint ${endpointName}, its endpoint config, and ${modelNames.length} model resource(s).`);
}

function main() {
  const command = process.argv[2] || "plan";
  if (command === "plan") printPlan(deploymentFromEnvironment());
  else if (command === "deploy") deploy();
  else if (command === "update") update();
  else if (command === "status") status();
  else if (command === "delete") remove();
  else throw new Error("Usage: node scripts/sagemaker-ministral.mjs [plan|deploy|update|status|delete]");
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
