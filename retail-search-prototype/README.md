# La Trouvaille Retail Search Prototype

React prototype for a second-hand luxury retail search experience with:

- Extended structured catalogue data in `src/data/catalog.js`
- UBI-style query/event capture in `src/lib/ubi.js`
- Local UBI collector in `scripts/ubi-collector.mjs`
- Optional Tier-2 query rewriter in `scripts/tier2-rewriter.mjs`
- Native OpenSearch Agentic Search backed by the fine-tuned query model, with base-model fallback
- OpenSearch-backed search API with a deterministic lexical fallback in `scripts/search-api.mjs`
- OpenSearch indexing scripts in `scripts/`

The catalogue is generated deterministically from luxury item templates. The browser keeps a bounded `11,040` item preview for home modules and offline fallback, while the OpenSearch indexer streams `2,000,000` unique used-item listings across all categories. Duplicate models are represented as separate seller listings with their own condition, country, price, seller, and listing date.

Tier-1 search caps hit counting for latency, so broad result sets may display lower-bound counts such as `10,000+`. Exact analytics and deeper count jobs belong in a Tier-2 path.

Rule-based rewriting is treated as Tier-2. The search API calls `QUERY_REWRITE_ENDPOINT` with a tight timeout and continues with the base OpenSearch query if that service is unavailable, slow, or has no matching rule. The local `query:rewriter` script is a lightweight Querqy-style adapter stub; it keeps the service boundary explicit so it can later be replaced by Querqy Unplugged. Persona-aware scoring is part of the native Agentic Search plan instead.

Natural-language product queries use OpenSearch's native `agentic` query and an `agentic_query_translator` search pipeline. A streamlined flow agent runs the native `QueryPlanningTool` against a Ministral endpoint. Ordinary OpenAI-compatible provisioning checks `/v1/models`, selects `AGENTIC_FINE_TUNED_MODEL` when that alias is available, and otherwise selects `AGENTIC_BASE_MODEL`. Optional SageMaker provisioning uses a statically configured model name and a SigV4 connector because SageMaker model discovery and authentication differ from a persistent OpenAI API key. If the pipeline is missing or model inference fails at request time, the API retries with the existing deterministic lexical OpenSearch query before falling back to the browser-sized local catalogue.

The fine-tune uses the versioned `opensearch_agentic_query_planner_v3` objective and the same system/user prompt files that are registered with `QueryPlanningTool`. Its completion is the complete executable search body: `size`, `track_total_hits`, `query`, and any requested `sort`. The incoming agentic request owns only `_source`; exact result-size, count, filters, sort, canonical base text, text operator, and a bounded trusted persona context are encoded as a compact immutable JSON contract inside `query_text`. The browser sends only `personaId`; the API resolves the allowlisted profile and excludes names, demographics, and images from model context. The shopper's base text remains required and unchanged. A profiled persona contributes one exact low-boost `multi_match` as the first optional scoring clause, while Anonymous emits no persona clause. Deterministic understanding contributes safe category, material, price, and natural-language sort constraints before the contract is built; an explicit non-default UI sort wins. The builder preserves the complete normalized summary and contract and uses the lexical path if they cannot fit inside the native 1,000-character limit. A detectable internal planner fallback and any response that misses those hard requirements are likewise retried through the persona-aware lexical path.

The training renderer mirrors the native OpenSearch 3.7 prompt representation observed end to end: the mapping source is wrapped in `_doc`, and both the mapping and `query_fields` reach the prompt as JSON-encoded strings. Keep that serialization synchronized with the deployed `QueryPlanningTool` when upgrading OpenSearch.

The API checks `agentic_context.dsl_query` after OpenSearch returns. That is a result-correctness and failover check, not a pre-execution security boundary: native Agentic Search has already executed the generated DSL. The local Compose node caps Boolean queries at 100 clauses; production deployment must also trust the registered planner/connector and enforce OpenSearch-side timeouts, permissions, and resource controls.

See `docs/architecture-report.md` for the current architecture report.

## Run The Prototype

```bash
npm run dev
```

The app runs at `http://127.0.0.1:5173/`.

For the full local search path, run the OpenSearch stack, bootstrap indexes, then start:

```bash
npm run query:rewriter
npm run opensearch:agentic
npm run search:api
UBI_FORWARD_OPENSEARCH=1 npm run ubi:collector
npm run dev
```

The React app calls `http://127.0.0.1:8790/search` and falls back to the same local query matcher if the search API is unavailable.

The Query understanding toggle is enabled by default. Turning it off sends `queryUnderstanding: false`, skips the native LLM pipeline, deterministic intent extraction, Tier-2 rules, and persona scoring, and sends the literal query tokens with OR semantics plus explicit UI controls through lexical OpenSearch or the local outage fallback.

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
docker compose -f compose.yml up -d
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
npm run opensearch:agentic
npm run search:api
```

Run `npm run opensearch:agentic` after the model server is available. It registers the selected remote model, a native flow agent with `QueryPlanningTool`, and the `secondhand-agentic-search` search pipeline. The model endpoint used by OpenSearch must be reachable from the OpenSearch container; on macOS Docker, the default is `http://host.docker.internal:8000/v1`.

Useful overrides:

```bash
OPENSEARCH_URL=http://127.0.0.1:9200
OPENSEARCH_INDEX=secondhand_items_v1
OPENSEARCH_ALIAS=secondhand_items_current
QUERY_REWRITE_ENDPOINT=http://127.0.0.1:8791/rewrite
QUERY_REWRITE_TIMEOUT_MS=20
OPENSEARCH_AGENTIC_SEARCH_MODE=active # active or off
OPENSEARCH_AGENTIC_SEARCH_PIPELINE=secondhand-agentic-search
OPENSEARCH_AGENTIC_SEARCH_TIMEOUT_MS=30000
OPENSEARCH_AGENTIC_MODEL_ID=          # optional pre-registered OpenSearch model ID
AGENTIC_MODEL_PROVIDER=openai         # openai or sagemaker
AGENTIC_MODEL_DISCOVERY_BASE_URL=http://127.0.0.1:8000/v1
AGENTIC_MODEL_BASE_URL=http://host.docker.internal:8000/v1
AGENTIC_MODEL_API_KEY=local           # use a real key for authenticated endpoints
AGENTIC_STRUCTURED_OUTPUT=true        # OpenAI json_schema; set false for incompatible providers
AGENTIC_FINE_TUNED_MODEL=psg-agentic-query-planner-v3
AGENTIC_BASE_MODEL=ministral-3-8b-instruct-2512
UBI_EVENTS_INDEX=ubi_events
UBI_QUERIES_INDEX=ubi_queries
```

Serve the pinned Ministral checkpoint behind an OpenAI-compatible endpoint. If the trained LoRA adapter is loaded, expose it using the `AGENTIC_FINE_TUNED_MODEL` alias. The configuration script prefers that exact alias; when it is absent from `/v1/models`, it uses the exact `AGENTIC_BASE_MODEL` alias instead. To reuse a model that is already registered in OpenSearch, set `OPENSEARCH_AGENTIC_MODEL_ID`; in that case model discovery and connector registration are skipped. Clear or replace pre-registered v1/v2 model IDs during the v3 rollout, because this override bypasses compatibility-aware alias selection.

### LM Studio

With LM Studio's local server running, use its OpenAI-compatible endpoint (normally port `1234`):

```bash
AGENTIC_MODEL_DISCOVERY_BASE_URL=http://127.0.0.1:1234/v1
AGENTIC_MODEL_BASE_URL=http://host.docker.internal:1234/v1
AGENTIC_FINE_TUNED_MODEL=psg-agentic-query-planner-v3
AGENTIC_BASE_MODEL=ministral-3-8b-instruct-2512
npm run opensearch:agentic
npm run search:api
```

No API key is needed for the usual local LM Studio server. The registered connector uses LM Studio's `response_format: json_schema` mode to constrain root and nested query shapes, mapped field names, filters, ranking clauses, and sorts. Exact contract copying is still verified from `agentic_context.dsl_query`; a mismatch triggers lexical OpenSearch retry. Keep the selected model loaded while OpenSearch handles agentic queries. Set `OPENSEARCH_AGENTIC_SEARCH_MODE=off` to use only the deterministic lexical query path.

### Amazon SageMaker

The optional SageMaker path deploys the pinned `mistralai/Ministral-3-8B-Instruct-2512-BF16` revision to one `ml.g6.2xlarge` real-time endpoint in `eu-west-1`. It uses the dated AWS vLLM 0.25.1 SageMaker DLC tag `0.25.1-gpu-py312-cu130-ubuntu22.04-sagemaker-v1.3-2026-07-22-22-50-11`, loads only the language model, caps the model context at 4,096 tokens, limits concurrency to four sequences, and retains JSON-schema structured output. The endpoint is billable whenever it is `InService`.

The deployment command requires the AWS CLI and an existing SageMaker model execution role. The role must trust `sagemaker.amazonaws.com` and allow the SageMaker service to pull the pinned DLC image. Inspect the exact resources without creating anything:

```bash
export SAGEMAKER_REGION=eu-west-1
export SAGEMAKER_EXECUTION_ROLE_ARN=arn:aws:iam::ACCOUNT_ID:role/SageMakerExecutionRole
npm run sagemaker:plan
```

Create the endpoint only when ready to begin incurring charges:

```bash
npm run sagemaker:deploy
npm run sagemaker:status
```

The deploy command refuses to replace an existing endpoint. This is intentional: the current account quota permits one `ml.g6.2xlarge`, while a blue/green endpoint update can temporarily require a second instance. Delete and recreate during a maintenance window, or request quota for two instances before implementing zero-downtime updates.

Configure the self-managed OpenSearch prototype to invoke SageMaker through an `aws_sigv4` ML Commons connector:

```bash
export AGENTIC_MODEL_PROVIDER=sagemaker
export SAGEMAKER_REGION=eu-west-1
export SAGEMAKER_MINISTRAL_ENDPOINT=la-trouvaille-ministral
export SAGEMAKER_MINISTRAL_MODEL=ministral-3-8b-instruct-2512
export SAGEMAKER_CONNECTOR_ACCESS_KEY_ID=DEDICATED_INVOKER_ACCESS_KEY
export SAGEMAKER_CONNECTOR_SECRET_ACCESS_KEY=DEDICATED_INVOKER_SECRET_KEY
npm run opensearch:agentic
npm run search:api
```

The connector identity needs only `sagemaker:InvokeEndpoint` on:

```text
arn:aws:sagemaker:eu-west-1:ACCOUNT_ID:endpoint/la-trouvaille-ministral
```

For this self-managed local OpenSearch node, the configuration script requires explicit, non-expiring `SAGEMAKER_CONNECTOR_ACCESS_KEY_ID` and `SAGEMAKER_CONNECTOR_SECRET_ACCESS_KEY` values and stores them in OpenSearch's encrypted connector credential field. It intentionally does not export the active AWS CLI profile or reuse generic AWS environment credentials, which might belong to a broader principal. Create a dedicated principal whose only permission is the `sagemaker:InvokeEndpoint` resource shown above. Temporary session credentials are rejected because their token would expire without refresh. Connector setup merges its trusted endpoint into the existing OpenSearch allowlist and does not disable private-IP access used by an existing local connector. The SageMaker connector removes the JSON Schema `uniqueItems` annotation because vLLM 0.25.1 does not implement it; the runtime DSL validator still enforces exact field sets, filter values, and clause ordering. For production, prefer Amazon OpenSearch Service with an assumable, least-privilege IAM connector role instead of long-lived access keys.

Delete the billable endpoint, endpoint configuration, and SageMaker model resource together:

```bash
npm run sagemaker:delete
```

The deployment defaults can be overridden with `SAGEMAKER_MINISTRAL_ENDPOINT`, `SAGEMAKER_MINISTRAL_INSTANCE_TYPE`, `SAGEMAKER_MINISTRAL_MODEL_ID`, `SAGEMAKER_MINISTRAL_MODEL_REVISION`, `SAGEMAKER_MINISTRAL_MODEL`, and `SAGEMAKER_VLLM_IMAGE_TAG`. Keep the default model revision synchronized with `query-understanding-training/configs/qlora-5090.yaml`. The current command serves the pinned base model; add the trained LoRA under the `psg-agentic-query-planner-v3` alias only after validating adapter loading and held-out planner accuracy on this DLC.

References: [AWS vLLM SageMaker deployment](https://aws.github.io/deep-learning-containers/vllm/deployment/sagemaker/), [AWS vLLM configuration](https://aws.github.io/deep-learning-containers/vllm/configuration/), and [OpenSearch SageMaker connectors](https://docs.opensearch.org/latest/ml-commons-plugin/remote-models/connectors/).

Dry-run commands:

```bash
npm run opensearch:index -- --dry-run
npm run opensearch:create-ubi -- --dry-run
OPENSEARCH_AGENTIC_MODEL_ID=existing-model-id npm run opensearch:agentic -- --dry-run
AGENTIC_MODEL_PROVIDER=sagemaker npm run opensearch:agentic -- --dry-run
```
