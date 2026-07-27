import test from "node:test";
import assert from "node:assert/strict";
import {
  DEMO_CATALOG_SIZE,
  DEMO_LISTINGS_PER_PRODUCT,
  SCALE_CATALOG_SIZE,
  productSpecs,
  products,
} from "../src/data/catalog.js";

test("demo catalogue keeps an even, small set of seller variants", () => {
  assert.equal(DEMO_LISTINGS_PER_PRODUCT, 2);
  assert.equal(DEMO_CATALOG_SIZE, productSpecs.length * DEMO_LISTINGS_PER_PRODUCT);
  assert.equal(products.length, DEMO_CATALOG_SIZE);
  assert.equal(SCALE_CATALOG_SIZE, 2_000_000);

  const listingsByProduct = new Map();
  products.forEach((product) => {
    const productKey = `${product.brand}\u0000${product.title}`;
    listingsByProduct.set(productKey, (listingsByProduct.get(productKey) || 0) + 1);
  });

  assert.equal(listingsByProduct.size, productSpecs.length);
  assert.deepEqual([...listingsByProduct.values()], Array(productSpecs.length).fill(DEMO_LISTINGS_PER_PRODUCT));
});

test("every listing has a searchable gender affinity", () => {
  const affinities = new Set(products.map((product) => product.genderAffinity));

  assert.deepEqual([...affinities].sort(), ["men", "unisex", "women"]);
  for (const product of products) {
    assert.match(product.canonical_text, new RegExp(`\\b${product.genderAffinity}\\b`));
  }
});

test("watch gender affinity follows product size and jewellery styling", () => {
  const affinityByTitle = Object.fromEntries(products.map((product) => [product.title, product.genderAffinity]));

  assert.equal(affinityByTitle["Cadre Francais steel watch"], "women");
  assert.equal(affinityByTitle["Feline bracelet watch"], "women");
  assert.equal(affinityByTitle["Evermark steel watch"], "unisex");
  assert.equal(affinityByTitle["Viper Coil watch"], "women");
});
