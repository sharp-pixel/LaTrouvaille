import { Client } from "@opensearch-project/opensearch";
import { TARGET_CATALOG_SIZE, buildListingByIndex, iterateCatalog, products as previewProducts } from "../src/data/catalog.js";

const node = process.env.OPENSEARCH_URL || "http://127.0.0.1:9200";
const index = process.env.OPENSEARCH_INDEX || "secondhand_items_v1";
const alias = process.env.OPENSEARCH_ALIAS || "secondhand_items_current";
const targetDocuments = Number(process.env.CATALOG_SIZE || TARGET_CATALOG_SIZE);
const bulkSize = Number(process.env.OPENSEARCH_BULK_SIZE || 5000);
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

function toDocument(product) {
  return {
    item_id: product.item_id,
    brand: product.brand,
    title: product.title,
    description: `${product.brand} ${product.title}. ${product.condition}. ${product.material} ${product.color}. Ships from ${product.country}.`,
    canonical_text: product.canonical_text,
    category: product.category,
    size: product.size,
    price: product.price,
    old_price: product.oldPrice ?? null,
    country: product.country,
    condition: product.condition,
    material: product.material,
    color: product.color,
    image: product.image,
    badge: product.badge,
    reasons: product.reasons,
    availability: product.availability,
    shipping: product.shipping,
    seller_id: product.seller_id,
    seller_tier: product.seller_tier,
    seller_score: product.seller_score,
    listed_at: product.listed_at,
    quality_score: Math.max(product.score, 1),
    freshness_score: Math.max(1, 100 - (Number(product.item_id.slice(-2)) % 30) * 2),
    vector_text: `${product.brand} ${product.title} ${product.category} ${product.material} ${product.color} ${product.reasons.join(" ")}`,
  };
}

const indexBody = {
  settings: {
    number_of_shards: Number(process.env.OPENSEARCH_SHARDS || 1),
    number_of_replicas: Number(process.env.OPENSEARCH_REPLICAS || 0),
    refresh_interval: "-1",
    analysis: {
      normalizer: {
        lowercase_keyword: {
          type: "custom",
          filter: ["lowercase", "asciifolding"],
        },
      },
    },
  },
  mappings: {
    dynamic: false,
    properties: {
      item_id: { type: "keyword" },
      brand: {
        type: "text",
        fields: { keyword: { type: "keyword", normalizer: "lowercase_keyword" } },
      },
      title: {
        type: "text",
        fields: { keyword: { type: "keyword", normalizer: "lowercase_keyword" } },
      },
      description: { type: "text" },
      canonical_text: { type: "text" },
      category: { type: "keyword", normalizer: "lowercase_keyword" },
      size: { type: "keyword" },
      price: { type: "integer" },
      old_price: { type: "integer" },
      country: { type: "keyword", normalizer: "lowercase_keyword" },
      condition: { type: "keyword", normalizer: "lowercase_keyword" },
      material: { type: "keyword", normalizer: "lowercase_keyword" },
      color: { type: "keyword", normalizer: "lowercase_keyword" },
      image: { type: "keyword", index: false },
      badge: { type: "keyword", normalizer: "lowercase_keyword" },
      reasons: { type: "keyword", normalizer: "lowercase_keyword" },
      availability: { type: "keyword" },
      shipping: { type: "keyword", normalizer: "lowercase_keyword" },
      seller_id: { type: "keyword" },
      seller_tier: { type: "keyword", normalizer: "lowercase_keyword" },
      seller_score: { type: "rank_feature" },
      listed_at: { type: "date" },
      quality_score: { type: "rank_feature" },
      freshness_score: { type: "rank_feature" },
      vector_text: { type: "text" },
    },
  },
};

async function main() {
  if (dryRun) {
    const sample = [buildListingByIndex(0), buildListingByIndex(1)].map(toDocument);
    console.log(
      JSON.stringify(
        {
          node,
          index,
          alias,
          documents: targetDocuments,
          bulkSize,
          previewDocuments: previewProducts.length,
          sample,
          mappingFields: Object.keys(indexBody.mappings.properties),
        },
        null,
        2,
      ),
    );
    return;
  }

  const exists = unwrap(await client.indices.exists({ index }));
  if (exists && reset) {
    await client.indices.delete({ index });
  }
  if (!exists || reset) {
    await client.indices.create({ index, body: indexBody });
  }

  const startedAt = Date.now();
  let body = [];
  let indexed = 0;
  for (const product of iterateCatalog(targetDocuments)) {
    const doc = toDocument(product);
    body.push({ index: { _index: index, _id: doc.item_id } }, doc);

    if (body.length / 2 >= bulkSize) {
      await flushBulk(body);
      indexed += body.length / 2;
      body = [];
      logProgress(indexed, startedAt);
    }
  }

  if (body.length) {
    await flushBulk(body);
    indexed += body.length / 2;
    logProgress(indexed, startedAt, true);
  }

  await client.indices.putSettings({ index, body: { index: { refresh_interval: "1s" } } });
  await client.indices.refresh({ index });

  await updateAlias();

  console.log(`Indexed ${indexed} products into ${index} and updated alias ${alias}.`);
}

async function flushBulk(body) {
  const bulkResult = unwrap(await client.bulk({ refresh: false, body }));

  if (bulkResult.errors) {
    const failures = bulkResult.items
      .map((item) => item.index)
      .filter((item) => item?.error)
      .slice(0, 5);
    throw new Error(`Bulk indexing failed: ${JSON.stringify(failures, null, 2)}`);
  }
}

function logProgress(indexed, startedAt, force = false) {
  if (!force && indexed % 100_000 !== 0) return;
  const elapsedSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
  const rate = Math.round(indexed / elapsedSeconds);
  console.log(`Indexed ${indexed}/${targetDocuments} documents (${rate}/s).`);
}

async function updateAlias() {
  const actions = [];
  const aliasExists = await client.indices.existsAlias({ name: alias }).then(unwrap).catch(() => false);
  if (aliasExists) {
    const current = unwrap(await client.indices.getAlias({ name: alias }));
    for (const currentIndex of Object.keys(current)) {
      actions.push({ remove: { index: currentIndex, alias } });
    }
  }
  actions.push({ add: { index, alias } });
  await client.indices.updateAliases({ body: { actions } });
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
