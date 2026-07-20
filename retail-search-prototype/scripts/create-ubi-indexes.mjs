import { Client } from "@opensearch-project/opensearch";

const node = process.env.OPENSEARCH_URL || "http://127.0.0.1:9200";
const eventsIndex = process.env.UBI_EVENTS_INDEX || "ubi_events";
const queriesIndex = process.env.UBI_QUERIES_INDEX || "ubi_queries";
const dryRun = process.argv.includes("--dry-run");
const reset = process.argv.includes("--reset");

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

const commonSettings = {
  number_of_shards: Number(process.env.OPENSEARCH_SHARDS || 1),
  number_of_replicas: Number(process.env.OPENSEARCH_REPLICAS || 0),
};

const eventsBody = {
  settings: commonSettings,
  mappings: {
    dynamic: true,
    properties: {
      application: { type: "keyword", ignore_above: 100 },
      action_name: { type: "keyword", ignore_above: 100 },
      query_id: { type: "keyword", ignore_above: 100 },
      client_id: { type: "keyword", ignore_above: 256 },
      persona_id: { type: "keyword", ignore_above: 100 },
      persona_version: { type: "integer" },
      timestamp: { type: "date" },
      message_type: { type: "keyword", ignore_above: 100 },
      message: { type: "text", fields: { keyword: { type: "keyword", ignore_above: 1024 } } },
      event_attributes: { type: "object", dynamic: true },
    },
  },
};

const queriesBody = {
  settings: commonSettings,
  mappings: {
    dynamic: true,
    properties: {
      application: { type: "keyword", ignore_above: 100 },
      query_id: { type: "keyword", ignore_above: 100 },
      client_id: { type: "keyword", ignore_above: 256 },
      persona_id: { type: "keyword", ignore_above: 100 },
      persona_version: { type: "integer" },
      timestamp: { type: "date" },
      user_query: { type: "keyword", ignore_above: 1024 },
      query_response_object_ids: { type: "keyword", ignore_above: 256 },
      query_attributes: { type: "object", dynamic: true },
    },
  },
};

async function ensureIndex(index, body) {
  const exists = unwrap(await client.indices.exists({ index }));
  if (exists && reset) {
    await client.indices.delete({ index });
  }
  if (!exists || reset) {
    await client.indices.create({ index, body });
    return "created";
  }
  await client.indices.putMapping({
    index,
    body: {
      properties: {
        persona_id: body.mappings.properties.persona_id,
        persona_version: body.mappings.properties.persona_version,
      },
    },
  });
  return "updated";
}

async function main() {
  if (dryRun) {
    console.log(
      JSON.stringify(
        {
          node,
          eventsIndex,
          queriesIndex,
          eventsFields: Object.keys(eventsBody.mappings.properties),
          queriesFields: Object.keys(queriesBody.mappings.properties),
        },
        null,
        2,
      ),
    );
    return;
  }

  const events = await ensureIndex(eventsIndex, eventsBody);
  const queries = await ensureIndex(queriesIndex, queriesBody);
  console.log(`UBI indexes ready: ${eventsIndex} (${events}), ${queriesIndex} (${queries}).`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
