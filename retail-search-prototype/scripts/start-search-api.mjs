import { Client } from "@opensearch-project/opensearch";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_CATALOG_ALIAS = "secondhand_items_current";
const DEFAULT_UBI_EVENTS_INDEX = "ubi_events";
const DEFAULT_UBI_QUERIES_INDEX = "ubi_queries";
const DEFAULT_RETRIES = 60;
const DEFAULT_RETRY_DELAY_MS = 1000;

function unwrap(response) {
  return response?.body ?? response;
}

function createClient(env = process.env) {
  return new Client({
    node: env.OPENSEARCH_URL || "http://127.0.0.1:9200",
    auth:
      env.OPENSEARCH_USERNAME && env.OPENSEARCH_PASSWORD
        ? { username: env.OPENSEARCH_USERNAME, password: env.OPENSEARCH_PASSWORD }
        : undefined,
    ssl: { rejectUnauthorized: env.OPENSEARCH_REJECT_UNAUTHORIZED !== "false" },
  });
}

function sleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function waitForOpenSearch({
  client,
  retries = DEFAULT_RETRIES,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  sleepFn = sleep,
  logger = console,
}) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      await client.info();
      return;
    } catch (error) {
      lastError = error;
      if (attempt === 1) {
        logger.warn(`Waiting for OpenSearch: ${error.message}`);
      }
      if (attempt < retries) await sleepFn(retryDelayMs);
    }
  }
  throw new Error(`OpenSearch did not become ready: ${lastError?.message || "unknown error"}`);
}

async function findMissingResources(client, resources) {
  const entries = await Promise.all(
    Object.entries(resources).map(async ([name, index]) => [
      name,
      unwrap(await client.indices.exists({ index })) !== true,
    ]),
  );
  return entries.filter(([, missing]) => missing).map(([name]) => name);
}

function runBootstrapScript(scriptName, env = process.env) {
  const scriptPath = fileURLToPath(new URL(scriptName, import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${scriptName} failed ${signal ? `with signal ${signal}` : `with exit code ${code}`}`,
        ),
      );
    });
  });
}

export async function ensureOpenSearchBootstrap({
  client = createClient(),
  env = process.env,
  runScript = (scriptName) => runBootstrapScript(scriptName, env),
  retries = Number(env.OPENSEARCH_BOOTSTRAP_RETRIES || DEFAULT_RETRIES),
  retryDelayMs = Number(env.OPENSEARCH_BOOTSTRAP_RETRY_DELAY_MS || DEFAULT_RETRY_DELAY_MS),
  sleepFn = sleep,
  logger = console,
} = {}) {
  const resources = {
    catalog: env.OPENSEARCH_ALIAS || env.OPENSEARCH_INDEX || DEFAULT_CATALOG_ALIAS,
    ubiEvents: env.UBI_EVENTS_INDEX || DEFAULT_UBI_EVENTS_INDEX,
    ubiQueries: env.UBI_QUERIES_INDEX || DEFAULT_UBI_QUERIES_INDEX,
  };

  await waitForOpenSearch({ client, retries, retryDelayMs, sleepFn, logger });
  const missing = await findMissingResources(client, resources);
  if (!missing.length) {
    logger.log("OpenSearch bootstrap resources already exist.");
    return { bootstrapped: false, resources };
  }

  logger.warn(`OpenSearch bootstrap required; missing: ${missing.join(", ")}.`);
  if (missing.includes("ubiEvents") || missing.includes("ubiQueries")) {
    await runScript("create-ubi-indexes.mjs");
  }
  if (missing.includes("catalog")) {
    await runScript("index-opensearch.mjs");
  }

  const stillMissing = await findMissingResources(client, resources);
  if (stillMissing.length) {
    throw new Error(`OpenSearch bootstrap incomplete; missing: ${stillMissing.join(", ")}`);
  }

  logger.log("OpenSearch bootstrap completed.");
  return { bootstrapped: true, resources };
}

export async function startSearchApi(options) {
  await ensureOpenSearchBootstrap(options);
  await import("./search-api.mjs");
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  startSearchApi().catch((error) => {
    console.error(`Search API startup failed: ${error.message}`);
    process.exitCode = 1;
  });
}
