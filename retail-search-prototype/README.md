# La Trouvaille Retail Search Prototype

React prototype for a second-hand luxury retail search experience with:

- Extended structured catalogue data in `src/data/catalog.js`
- UBI-style query/event capture in `src/lib/ubi.js`
- Local UBI collector in `scripts/ubi-collector.mjs`
- Optional Tier-2 query rewriter in `scripts/tier2-rewriter.mjs`
- Optional Mistral query-understanding adapter in `scripts/mistral-query-understanding.mjs`
- OpenSearch-backed search API in `scripts/search-api.mjs`
- OpenSearch indexing scripts in `scripts/`

The catalogue is generated deterministically from luxury item templates. The browser keeps a bounded `11,040` item preview for home modules and offline fallback, while the OpenSearch indexer streams `2,000,000` unique used-item listings across all categories. Duplicate models are represented as separate seller listings with their own condition, country, price, seller, and listing date.

Tier-1 search caps hit counting for latency, so broad result sets may display lower-bound counts such as `10,000+`. Exact analytics and deeper count jobs belong in a Tier-2 path.

Query rewriting is treated as Tier-2. The search API calls `QUERY_REWRITE_ENDPOINT` with a tight timeout and continues with the base OpenSearch query if rewriting is unavailable, slow, or has no matching rule. The local `query:rewriter` script is a lightweight Querqy-style adapter stub; it keeps the service boundary explicit so it can later be replaced by Querqy Unplugged.

Mistral query understanding is also fail-open and disabled by default. Its adapter speaks the OpenAI-compatible `/v1/chat/completions` API, so `MISTRAL_MODEL` can be either the vanilla checkpoint name or the name exposed by a server that has loaded the QLoRA adapter. It validates the small, safe compiler subset it accepts and returns rewrites plus allowlisted catalog constraints. The search API recompiles those into its own request; it never executes model-produced OpenSearch DSL.

See `docs/architecture-report.md` for the current architecture report.

## Run The Prototype

```bash
npm run dev
```

The app runs at `http://127.0.0.1:5173/`.

For the full local search path, run the OpenSearch stack, bootstrap indexes, then start:

```bash
npm run query:rewriter
npm run query:mistral
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
MISTRAL_QUERY_UNDERSTANDING_MODE=off # off, shadow, or active
MISTRAL_QUERY_UNDERSTANDING_ENDPOINT=http://127.0.0.1:8792/understand
MISTRAL_QUERY_UNDERSTANDING_TIMEOUT_MS=900
MISTRAL_BASE_URL=http://127.0.0.1:8000/v1
MISTRAL_API_KEY=                         # optional for local vLLM/TGI; required by hosted endpoints
MISTRAL_MODEL=ministral-3-8b-instruct-2512
UBI_EVENTS_INDEX=ubi_events
UBI_QUERIES_INDEX=ubi_queries
```

To use a base model, serve the pinned Ministral checkpoint behind an OpenAI-compatible endpoint and start the adapter with `MISTRAL_MODEL` set to that served model name. To use a fine-tuned model, serve the same base checkpoint with the trained LoRA adapter loaded, then set `MISTRAL_MODEL` to that server's adapter/model alias. Begin with `MISTRAL_QUERY_UNDERSTANDING_MODE=shadow`: the model is recorded in the response and UBI query plan but does not affect ranking. Switch to `active` only after offline and shadow evaluation.

### LM Studio

With LM Studio's local server running, use its OpenAI-compatible endpoint (normally port `1234`):

```bash
MISTRAL_BASE_URL=http://127.0.0.1:1234/v1
MISTRAL_MODEL=ministral-3-8b-instruct-2512
MISTRAL_QUERY_UNDERSTANDING_MODE=shadow
npm run query:mistral
MISTRAL_QUERY_UNDERSTANDING_MODE=shadow npm run search:api
```

No API key is needed for the usual local LM Studio server. Keep the model loaded in LM Studio while the adapter is running. Once shadow telemetry looks good, start the search API with `MISTRAL_QUERY_UNDERSTANDING_MODE=active` to apply validated model rewrites and constraints.

Dry-run commands:

```bash
npm run opensearch:index -- --dry-run
npm run opensearch:create-ubi -- --dry-run
```
