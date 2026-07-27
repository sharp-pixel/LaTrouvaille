import assert from "node:assert/strict";
import test from "node:test";
import { ensureOpenSearchBootstrap } from "../scripts/start-search-api.mjs";

function createFixture(initialResources = [], infoFailures = 0) {
  const resources = new Set(initialResources);
  let infoCalls = 0;
  const client = {
    async info() {
      infoCalls += 1;
      if (infoCalls <= infoFailures) throw new Error("OpenSearch is starting");
    },
    indices: {
      async exists({ index }) {
        return resources.has(index);
      },
    },
  };
  return { client, infoCalls: () => infoCalls, resources };
}

const quietLogger = {
  log() {},
  warn() {},
};

test("search API startup skips bootstrap when all resources exist", async () => {
  const fixture = createFixture(["secondhand_items_current", "ubi_events", "ubi_queries"]);
  const scripts = [];

  const result = await ensureOpenSearchBootstrap({
    client: fixture.client,
    runScript: async (script) => scripts.push(script),
    logger: quietLogger,
  });

  assert.equal(result.bootstrapped, false);
  assert.deepEqual(scripts, []);
});

test("search API startup bootstraps only the missing catalogue", async () => {
  const fixture = createFixture(["ubi_events", "ubi_queries"]);
  const scripts = [];

  const result = await ensureOpenSearchBootstrap({
    client: fixture.client,
    runScript: async (script) => {
      scripts.push(script);
      fixture.resources.add("secondhand_items_current");
    },
    logger: quietLogger,
  });

  assert.equal(result.bootstrapped, true);
  assert.deepEqual(scripts, ["index-opensearch.mjs"]);
});

test("search API startup bootstraps UBI indexes when either one is missing", async () => {
  const fixture = createFixture(["secondhand_items_current", "ubi_events"]);
  const scripts = [];

  await ensureOpenSearchBootstrap({
    client: fixture.client,
    runScript: async (script) => {
      scripts.push(script);
      fixture.resources.add("ubi_events");
      fixture.resources.add("ubi_queries");
    },
    logger: quietLogger,
  });

  assert.deepEqual(scripts, ["create-ubi-indexes.mjs"]);
});

test("search API startup waits for OpenSearch before checking resources", async () => {
  const fixture = createFixture(
    ["secondhand_items_current", "ubi_events", "ubi_queries"],
    2,
  );
  let sleeps = 0;

  await ensureOpenSearchBootstrap({
    client: fixture.client,
    retries: 3,
    retryDelayMs: 0,
    sleepFn: async () => {
      sleeps += 1;
    },
    logger: quietLogger,
  });

  assert.equal(fixture.infoCalls(), 3);
  assert.equal(sleeps, 2);
});

test("search API startup fails when bootstrap does not create required resources", async () => {
  const fixture = createFixture(["ubi_events", "ubi_queries"]);

  await assert.rejects(
    ensureOpenSearchBootstrap({
      client: fixture.client,
      runScript: async () => {},
      logger: quietLogger,
    }),
    /bootstrap incomplete; missing: catalog/,
  );
});
