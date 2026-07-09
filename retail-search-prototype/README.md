# La Trouvaille Retail Search Prototype

React prototype for a second-hand luxury retail search experience with:

- Extended structured catalogue data in `src/data/catalog.js`
- UBI-style query/event capture in `src/lib/ubi.js`
- Local UBI collector in `scripts/ubi-collector.mjs`
- Optional Tier-2 query rewriter in `scripts/tier2-rewriter.mjs`
- OpenSearch-backed search API in `scripts/search-api.mjs`
- OpenSearch indexing scripts in `scripts/`

The catalogue is generated deterministically from luxury item templates. The browser keeps a bounded `11,040` item preview for home modules and offline fallback, while the OpenSearch indexer streams `2,000,000` unique used-item listings across all categories. Duplicate models are represented as separate seller listings with their own condition, country, price, seller, and listing date.

Tier-1 search caps hit counting for latency, so broad result sets may display lower-bound counts such as `10,000+`. Exact analytics and deeper count jobs belong in a Tier-2 path.

Query rewriting is treated as Tier-2. The search API calls `QUERY_REWRITE_ENDPOINT` with a tight timeout and continues with the base OpenSearch query if rewriting is unavailable, slow, or has no matching rule. The local `query:rewriter` script is a lightweight Querqy-style adapter stub; it keeps the service boundary explicit so it can later be replaced by Querqy Unplugged.

See `docs/architecture-report.md` for the current architecture report.

## Run The Prototype

```bash
npm run dev
```

The app runs at `http://127.0.0.1:5173/`.

For the full local search path, run the OpenSearch stack, bootstrap indexes, then start:

```bash
npm run query:rewriter
npm run search:api
UBI_FORWARD_OPENSEARCH=1 npm run ubi:collector
npm run dev
```

The React app calls `http://127.0.0.1:8790/search` and falls back to the same local query matcher if the search API is unavailable.

## Local UBI Capture

Start the local collector:

```bash
npm run ubi:collector
```

The frontend posts best-effort telemetry to `http://127.0.0.1:8787/ubi` and also keeps recent records in browser localStorage. The collector writes:

- `data/ubi-queries.ndjson`
- `data/ubi-events.ndjson`

To forward records into OpenSearch:

```bash
UBI_FORWARD_OPENSEARCH=1 npm run ubi:collector
```

## Local OpenSearch

Start OpenSearch and Dashboards:

```bash
docker compose -f compose.opensearch.yml up -d
```

Then create UBI indexes and index the catalogue:

```bash
npm run opensearch:bootstrap
```

The catalogue indexer defaults to `2,000,000` generated listings and streams in bulk batches. For a smaller local run:

```bash
CATALOG_SIZE=100000 npm run opensearch:index -- --reset
```

Start the search API:

```bash
npm run query:rewriter
npm run search:api
```

Useful overrides:

```bash
OPENSEARCH_URL=http://127.0.0.1:9200
OPENSEARCH_INDEX=secondhand_items_v1
OPENSEARCH_ALIAS=secondhand_items_current
QUERY_REWRITE_ENDPOINT=http://127.0.0.1:8791/rewrite
QUERY_REWRITE_TIMEOUT_MS=20
UBI_EVENTS_INDEX=ubi_events
UBI_QUERIES_INDEX=ubi_queries
```

Dry-run commands:

```bash
npm run opensearch:index -- --dry-run
npm run opensearch:create-ubi -- --dry-run
```
