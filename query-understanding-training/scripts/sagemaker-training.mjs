import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REGION = process.env.SAGEMAKER_REGION || process.env.AWS_REGION || "eu-west-1";
const INSTANCE_TYPE = process.env.SAGEMAKER_TRAINING_INSTANCE_TYPE || "ml.g5.2xlarge";
const ROLE_NAME = "LaTrouvailleSageMakerTrainingRole";
const POLICY_NAME = "LaTrouvailleSageMakerTrainingPolicy";
const TRAINING_IMAGE_TAG =
  "2.9.0-gpu-py312-cu130-ubuntu22.04-sagemaker-v1.18-2026-07-17-17-26-13-soci";
const TRAINING_IMAGE = `763104351884.dkr.ecr.${REGION}.amazonaws.com/pytorch-training:${TRAINING_IMAGE_TAG}`;
const STATE_PATH = path.join(PROJECT_ROOT, "artifacts", "sagemaker-training-state.json");

function awsJson(args) {
  const output = execFileSync("aws", [...args, "--output", "json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return output.trim() ? JSON.parse(output) : {};
}

function aws(args) {
  execFileSync("aws", args, { stdio: "inherit" });
}

function exists(args) {
  try {
    execFileSync("aws", args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function accountId() {
  return awsJson(["sts", "get-caller-identity"]).Account;
}

function resourceNames(account) {
  return {
    bucket: `la-trouvaille-sagemaker-training-${account}-${REGION}`,
    roleArn: `arn:aws:iam::${account}:role/${ROLE_NAME}`,
  };
}

function trustPolicy() {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Service: "sagemaker.amazonaws.com" },
        Action: "sts:AssumeRole",
      },
    ],
  };
}

function rolePolicy(account, bucket) {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        // SageMaker's input-channel validation issues an unconditioned
        // ListBucket against this bucket, so the s3:prefix condition that
        // previously scoped this statement caused CreateTrainingJob to fail
        // with AccessDenied. ListBucket stays scoped to this single private,
        // encrypted, public-access-blocked training bucket; object reads below
        // remain restricted to the source/ prefix.
        Sid: "ReadTrainingSourceAndBucketMetadata",
        Effect: "Allow",
        Action: ["s3:GetBucketLocation", "s3:ListBucket"],
        Resource: `arn:aws:s3:::${bucket}`,
      },
      {
        Sid: "ReadTrainingSource",
        Effect: "Allow",
        Action: ["s3:GetObject"],
        Resource: `arn:aws:s3:::${bucket}/source/*`,
      },
      {
        Sid: "WriteTrainingArtifacts",
        Effect: "Allow",
        Action: ["s3:AbortMultipartUpload", "s3:GetObject", "s3:PutObject"],
        Resource: [
          `arn:aws:s3:::${bucket}/output/*`,
          `arn:aws:s3:::${bucket}/checkpoints/*`,
        ],
      },
      {
        Sid: "AuthenticateToAwsDeepLearningContainers",
        Effect: "Allow",
        Action: ["ecr:GetAuthorizationToken"],
        Resource: "*",
      },
      {
        Sid: "PullPinnedAwsPytorchTrainingImage",
        Effect: "Allow",
        Action: ["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"],
        Resource: `arn:aws:ecr:${REGION}:763104351884:repository/pytorch-training`,
      },
      {
        Sid: "WriteTrainingLogs",
        Effect: "Allow",
        Action: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:DescribeLogStreams", "logs:PutLogEvents"],
        Resource: `arn:aws:logs:${REGION}:${account}:log-group:/aws/sagemaker/TrainingJobs*`,
      },
      {
        Sid: "WriteTrainingMetrics",
        Effect: "Allow",
        Action: "cloudwatch:PutMetricData",
        Resource: "*",
        Condition: {
          StringEquals: {
            "cloudwatch:namespace": "/aws/sagemaker/TrainingJobs",
          },
        },
      },
    ],
  };
}

function ensureBucket(bucket) {
  if (!exists(["s3api", "head-bucket", "--bucket", bucket])) {
    // us-east-1 is the S3 default region and rejects a LocationConstraint; all
    // other regions require one.
    const createArgs = ["s3api", "create-bucket", "--region", REGION, "--bucket", bucket];
    if (REGION !== "us-east-1") {
      createArgs.push("--create-bucket-configuration", `LocationConstraint=${REGION}`);
    }
    aws(createArgs);
  }
  aws([
    "s3api",
    "put-public-access-block",
    "--bucket",
    bucket,
    "--public-access-block-configuration",
    "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true",
  ]);
  aws([
    "s3api",
    "put-bucket-encryption",
    "--bucket",
    bucket,
    "--server-side-encryption-configuration",
    JSON.stringify({
      Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" }, BucketKeyEnabled: true }],
    }),
  ]);
}

function ensureRole(account, bucket) {
  if (!exists(["iam", "get-role", "--role-name", ROLE_NAME])) {
    aws([
      "iam",
      "create-role",
      "--role-name",
      ROLE_NAME,
      "--assume-role-policy-document",
      JSON.stringify(trustPolicy()),
      "--description",
      "Least-privilege SageMaker role for La Trouvaille Ministral QLoRA training",
    ]);
  }
  aws([
    "iam",
    "put-role-policy",
    "--role-name",
    ROLE_NAME,
    "--policy-name",
    POLICY_NAME,
    "--policy-document",
    JSON.stringify(rolePolicy(account, bucket)),
  ]);
}

function packageSource(mode) {
  const directory = mkdtempSync(path.join(tmpdir(), "la-trouvaille-sagemaker-"));
  const archive = path.join(directory, `source-${mode}.tar.gz`);
  execFileSync(
    "tar",
    [
      "-czf",
      archive,
      "--exclude=.venv",
      "--exclude=.pytest_cache",
      "--exclude=.mypy_cache",
      "--exclude=.ruff_cache",
      "--exclude=artifacts",
      "--exclude=__pycache__",
      ".",
    ],
    { cwd: PROJECT_ROOT, stdio: "inherit" },
  );
  return archive;
}

function containerCommand() {
  return [
    "set -euo pipefail;",
    "mkdir -p /opt/ml/code;",
    "tar -xzf /opt/ml/input/data/source/* -C /opt/ml/code;",
    "exec bash /opt/ml/code/scripts/sagemaker-entrypoint.sh",
  ].join(" ");
}

function trainingJob({ bucket, roleArn, mode, sourceKey }) {
  const timestamp = new Date().toISOString().replaceAll(/[-:.TZ]/g, "").slice(0, 14);
  const modelTag = process.env.TRAINING_MODEL_TAG || "ministral";
  const jobName = `la-trouvaille-${modelTag}-qlora-${mode}-${timestamp}`;
  const smoke = mode === "smoke";
  return {
    TrainingJobName: jobName,
    RoleArn: roleArn,
    AlgorithmSpecification: {
      TrainingImage: TRAINING_IMAGE,
      TrainingInputMode: "File",
      ContainerEntrypoint: ["bash", "-lc"],
      ContainerArguments: [containerCommand()],
    },
    InputDataConfig: [
      {
        ChannelName: "source",
        DataSource: {
          S3DataSource: {
            S3DataType: "S3Prefix",
            S3Uri: `s3://${bucket}/${sourceKey}`,
            S3DataDistributionType: "FullyReplicated",
          },
        },
        InputMode: "File",
      },
    ],
    OutputDataConfig: {
      S3OutputPath: `s3://${bucket}/output/${jobName}`,
    },
    ResourceConfig: {
      InstanceType: INSTANCE_TYPE,
      InstanceCount: 1,
      VolumeSizeInGB: 200,
    },
    StoppingCondition: {
      MaxRuntimeInSeconds: smoke ? 7_200 : 43_200,
    },
    Environment: {
      HF_HOME: "/opt/ml/hf-cache",
      HF_HUB_DISABLE_TELEMETRY: "1",
      TOKENIZERS_PARALLELISM: "false",
      PYTHONUNBUFFERED: "1",
      PIP_DISABLE_PIP_VERSION_CHECK: "1",
      TRAINING_CONFIG:
        process.env.TRAINING_CONFIG ||
        (smoke ? "configs/qlora-sagemaker-smoke.yaml" : "configs/qlora-sagemaker.yaml"),
    },
    RetryStrategy: { MaximumRetryAttempts: 1 },
    Tags: [
      { Key: "Project", Value: "LaTrouvaille" },
      { Key: "Workload", Value: "MinistralQLoRA" },
      { Key: "Mode", Value: mode },
    ],
    EnableNetworkIsolation: false,
  };
}

function plan(mode) {
  const account = accountId();
  const { bucket, roleArn } = resourceNames(account);
  console.log(
    JSON.stringify(
      {
        mode,
        region: REGION,
        instanceType: INSTANCE_TYPE,
        instanceNote: "SageMaker Training does not expose ml.g6.2xlarge; ml.g5.2xlarge has the same 24 GiB VRAM.",
        image: TRAINING_IMAGE,
        roleArn,
        bucket,
        endpointUnaffected: "la-trouvaille-ministral remains InService and billable",
      },
      null,
      2,
    ),
  );
}

function launch(mode) {
  if (!["smoke", "full"].includes(mode)) {
    throw new Error(`Unsupported training mode: ${mode}`);
  }
  const account = accountId();
  const { bucket, roleArn } = resourceNames(account);
  ensureBucket(bucket);
  ensureRole(account, bucket);
  const sourceArchive = packageSource(mode);
  const sourceKey = `source/${Date.now()}-${path.basename(sourceArchive)}`;
  aws(["s3", "cp", sourceArchive, `s3://${bucket}/${sourceKey}`, "--only-show-errors"]);
  const job = trainingJob({ bucket, roleArn, mode, sourceKey });
  console.log(JSON.stringify(job, null, 2));
  aws([
    "sagemaker",
    "create-training-job",
    "--region",
    REGION,
    "--cli-input-json",
    JSON.stringify(job),
  ]);
  mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  writeFileSync(
    STATE_PATH,
    `${JSON.stringify(
      {
        mode,
        region: REGION,
        instanceType: INSTANCE_TYPE,
        trainingJobName: job.TrainingJobName,
        bucket,
        sourceKey,
        roleArn,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`Started billable SageMaker training job ${job.TrainingJobName}.`);
}

function status(jobName) {
  console.log(
    JSON.stringify(
      awsJson([
        "sagemaker",
        "describe-training-job",
        "--region",
        REGION,
        "--training-job-name",
        jobName,
      ]),
      null,
      2,
    ),
  );
}

const [command = "plan", argument = "smoke"] = process.argv.slice(2);
if (command === "plan") {
  plan(argument);
} else if (command === "launch") {
  launch(argument);
} else if (command === "status") {
  if (!argument) throw new Error("Pass a training job name");
  status(argument);
} else {
  throw new Error("Usage: node scripts/sagemaker-training.mjs plan|launch|status [smoke|full|job-name]");
}
