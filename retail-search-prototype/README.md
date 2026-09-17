# La Trouvaille Retail Search Prototype

React prototype for a second-hand luxury retail search experience with:

- Extended structured catalogue data in `src/data/catalog.js`
- UBI-style query/event capture in `src/lib/ubi.js`
- Local UBI collector in `scripts/ubi-collector.mjs`
- Optional Tier-2 query rewriter in `scripts/tier2-rewriter.mjs`
- Native OpenSearch Agentic Search backed by the fine-tuned query model, with base-model fallback
- OpenSearch-backed search API that fails closed when native Agentic Search is unavailable
- OpenSearch indexing scripts in `scripts/`

The catalogue is generated deterministically from 69 luxury item templates. The demo keeps two seller variants per template, producing an evenly represented 138-listing catalogue for homepage previews and OpenSearch. Duplicate models are separate seller listings with their own condition, country, price, seller, and listing date. A two-million-listing profile remains available for explicit scale testing.

Tier-1 search caps hit counting for latency, so broad result sets may display lower-bound counts such as `10,000+`. Exact analytics and deeper count jobs belong in a Tier-2 path.

Rule-based rewriting is treated as Tier-2. The search API calls `QUERY_REWRITE_ENDPOINT` with a tight timeout and continues with the base OpenSearch query if that service is unavailable, slow, or has no matching rule. The local `query:rewriter` script is a lightweight Querqy-style adapter stub; it keeps the service boundary explicit so it can later be replaced by Querqy Unplugged. Persona-aware scoring is part of the native Agentic Search plan instead.

Natural-language product queries use OpenSearch's native `agentic` query and an `agentic_query_translator` search pipeline. A streamlined flow agent runs the native `QueryPlanningTool` against a Ministral endpoint. Ordinary OpenAI-compatible provisioning checks `/v1/models`, selects `AGENTIC_FINE_TUNED_MODEL` when that alias is available, and otherwise selects `AGENTIC_BASE_MODEL`. Optional SageMaker provisioning uses a statically configured model name and a SigV4 connector because SageMaker model discovery and authentication differ from a persistent OpenAI API key. If the pipeline is missing, model inference fails, or the generated DSL is invalid, the API returns HTTP 503 with the underlying error and no catalogue results.

The fine-tune uses the versioned `opensearch_agentic_query_planner_v3` objective and the same system/user prompt files that are registered with `QueryPlanningTool`. Its completion is the complete executable search body: `size`, `track_total_hits`, `query`, and any requested `sort`. The incoming agentic request owns only `_source`. Its three-line `query_text` carries raw shopper wording plus trusted UI controls and bounded persona context. The OpenSearch-side GenAI prompt—not the search API—derives the effective price ceiling and gender affinity: it chooses the smallest shopper, UI, and `persona.strict_max_price` limit, and maps explicit men's or women's intent to that affinity plus `unisex`. The browser sends only `personaId`; the API resolves the allowlisted profile and excludes names, demographics, and images from model context. A profiled persona contributes one exact low-boost `multi_match` as the first optional scoring clause, while Anonymous emits no persona clause. The builder rejects an envelope that exceeds the native 1,000-character limit. A detectable internal planner fallback or structurally unsafe response returns HTTP 503 with no catalogue results.

The training renderer mirrors the native OpenSearch 3.7 prompt representation observed end to end: the mapping source is wrapped in `_doc`, and both the mapping and `query_fields` reach the prompt as JSON-encoded strings. Keep that serialization synchronized with the deployed `QueryPlanningTool` when upgrading OpenSearch.

The API checks `agentic_context.dsl_query` after OpenSearch returns for safe fields, query types, clause limits, required UI controls, and response shape. It does not re-derive shopper budget or gender intent. This is a result-correctness check, not a pre-execution security boundary: native Agentic Search has already executed the generated DSL. The local Compose node caps Boolean queries at 100 clauses; production deployment must also trust the registered planner/connector and enforce OpenSearch-side timeouts, permissions, and resource controls.

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

The React app calls `http://127.0.0.1:8790/search` and renders an explicit error with no catalogue results if the API or Agentic Search is unavailable.

The Query understanding toggle is enabled by default. Turning it off sends `queryUnderstanding: false`, skips the native LLM pipeline, deterministic intent extraction, Tier-2 rules, and persona scoring, and sends the literal query tokens with OR semantics plus explicit UI controls through lexical OpenSearch. This shopper-controlled bypass is the only lexical search path.

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

Build and start the app, OpenSearch, Dashboards, and the fine-tuned vLLM model:

```bash
docker compose -f compose.yml up -d
```

Compose requires an NVIDIA GPU with working drivers and NVIDIA Container Toolkit.
The `vllm` service uses `vllm/vllm-openai:v0.29.0` and loads the pinned BF16 Ministral checkpoint plus the rank-16
adapter from `../query-understanding-training/artifacts/qlora-agentic-v3/adapter`
and serves `psg-agentic-query-planner-v3` on `http://127.0.0.1:8000/v1`.
Set `VLLM_ADAPTER_PATH` to use another local adapter directory; missing paths fail
startup. Model downloads use the persistent `huggingface-cache` volume and optional
`HF_TOKEN`. The first start includes downloading the base model and initializing vLLM.

The `agentic-setup` service waits for OpenSearch and the fine-tuned model alias,
then registers the pipeline using `http://vllm:8000/v1` inside the Compose network.
The API starts after registration succeeds. Shared planner prompts are mounted
read-only from the sibling training project. The `vllm` provider keeps JSON-schema
output enabled and omits unsupported `uniqueItems`, as the SageMaker path does;
runtime validation still enforces exact field sets. After changing prompts or
connector settings, rerun `docker compose run --rm agentic-setup`.

The containerized app is available at `http://127.0.0.1:5173/`. Its browser-facing
search and telemetry endpoints default to the locally published services and can
be changed when building the image:

```bash
VITE_SEARCH_ENDPOINT=https://search.example.test \
VITE_UBI_ENDPOINT=https://telemetry.example.test/ubi \
docker compose -f compose.yml up -d --build app
```

Vite embeds these values in the static bundle, so rebuild the `app` service after
changing either endpoint.

The Search API container waits for OpenSearch and automatically creates missing UBI
indexes and the catalogue alias before it starts serving requests. To refresh those
resources explicitly from the host, run:

```bash
npm run opensearch:bootstrap
```

The catalogue indexer defaults to the balanced 138-listing demo dataset. Override the size only when testing larger indexes:

```bash
CATALOG_SIZE=2000000 npm run opensearch:index -- --reset
```

Start the search API:

```bash
npm run query:rewriter
npm run opensearch:agentic
npm run search:api
```

For host-managed serving, run `npm run opensearch:agentic` after the model server is available (Compose provisions this automatically). It registers the selected remote model, a native flow agent with `QueryPlanningTool`, and the `secondhand-agentic-search` search pipeline. The model endpoint used by OpenSearch must be reachable from the OpenSearch container; on macOS Docker, the default is `http://host.docker.internal:8000/v1`.

Useful overrides:

```bash
OPENSEARCH_URL=http://127.0.0.1:9200
OPENSEARCH_INDEX=secondhand_items_v2
OPENSEARCH_ALIAS=secondhand_items_current
QUERY_REWRITE_ENDPOINT=http://127.0.0.1:8791/rewrite
QUERY_REWRITE_TIMEOUT_MS=20
OPENSEARCH_AGENTIC_SEARCH_MODE=active # active or off
OPENSEARCH_AGENTIC_SEARCH_PIPELINE=secondhand-agentic-search
OPENSEARCH_AGENTIC_SEARCH_TIMEOUT_MS=30000
OPENSEARCH_AGENTIC_MODEL_ID=          # optional pre-registered OpenSearch model ID
AGENTIC_MODEL_PROVIDER=openai         # openai, vllm or sagemaker
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

No API key is needed for the usual local LM Studio server. The registered connector uses LM Studio's `response_format: json_schema` mode to constrain root and nested query shapes, mapped field names, filters, ranking clauses, and sorts. Runtime shape validation still checks `agentic_context.dsl_query`; a mismatch returns HTTP 503. Keep the selected model loaded while OpenSearch handles agentic queries. To use literal lexical search intentionally, turn off Query understanding in the UI; setting `OPENSEARCH_AGENTIC_SEARCH_MODE=off` while Query understanding remains enabled returns HTTP 503.

### Amazon SageMaker

The optional SageMaker path deploys the pinned `mistralai/Ministral-3-8B-Instruct-2512-BF16` revision to one `ml.g5.2xlarge` real-time endpoint in `eu-west-1`. It uses the AWS vLLM 0.29.0 SageMaker DLC tag `0.29.0-gpu-py312-cu130-ubuntu24.04-sagemaker`, loads only the language model, caps the model context at 4,096 tokens, limits concurrency to four sequences, and retains JSON-schema structured output. The endpoint is billable whenever it is `InService`.

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

The deploy command refuses to replace an existing endpoint. This is intentional: blue/green endpoint updates can temporarily require additional instance quota. Delete and recreate during a maintenance window, or request sufficient quota before implementing zero-downtime updates.

After validating a LoRA artifact, replace the existing endpoint during a maintenance window without requesting a second instance:

```bash
export SAGEMAKER_MINISTRAL_ADAPTER_MODEL_DATA_URL=s3://BUCKET/path/to/model.tar.gz
npm run sagemaker:update
```

The update creates the replacement model and endpoint configuration first, briefly removes the endpoint, then recreates it under the same name. If replacement startup fails, it restores the previous endpoint configuration and removes the failed replacement resources.

Configure the self-managed OpenSearch prototype to invoke SageMaker through an `aws_sigv4` ML Commons connector:

```bash
export AGENTIC_MODEL_PROVIDER=sagemaker
export SAGEMAKER_REGION=eu-west-1
export SAGEMAKER_MINISTRAL_ENDPOINT=la-trouvaille-ministral
export SAGEMAKER_MINISTRAL_MODEL=psg-agentic-query-planner-v3
export SAGEMAKER_CONNECTOR_ACCESS_KEY_ID=DEDICATED_INVOKER_ACCESS_KEY
export SAGEMAKER_CONNECTOR_SECRET_ACCESS_KEY=DEDICATED_INVOKER_SECRET_KEY
npm run opensearch:agentic
npm run search:api
```

The adapter alias above requires a deployed LoRA artifact. For a fresh base-only
endpoint, omit `SAGEMAKER_MINISTRAL_MODEL`: connector provisioning defaults to
the base alias `ministral-3-8b-instruct-2512`, matching the deployment default.

The connector identity needs only `sagemaker:InvokeEndpoint` on:

```text
arn:aws:sagemaker:eu-west-1:ACCOUNT_ID:endpoint/la-trouvaille-ministral
```

For this self-managed local OpenSearch node, the configuration script requires explicit, non-expiring `SAGEMAKER_CONNECTOR_ACCESS_KEY_ID` and `SAGEMAKER_CONNECTOR_SECRET_ACCESS_KEY` values and stores them in OpenSearch's encrypted connector credential field. It intentionally does not export the active AWS CLI profile or reuse generic AWS environment credentials, which might belong to a broader principal. Create a dedicated principal whose only permission is the `sagemaker:InvokeEndpoint` resource shown above. Temporary session credentials are rejected by default because their token would expire without refresh. For a bounded local test only, set `SAGEMAKER_CONNECTOR_SESSION_TOKEN` and `SAGEMAKER_CONNECTOR_ALLOW_SESSION_CREDENTIALS=true`; the connector will stop working when the session expires and must not be treated as durable configuration. Connector setup merges its trusted endpoint into the existing OpenSearch allowlist and does not disable private-IP access used by an existing local connector. The SageMaker connector omits the JSON Schema `uniqueItems` annotation for vLLM compatibility; the runtime DSL validator still enforces exact field sets, filter values, and clause ordering. For production, prefer Amazon OpenSearch Service with an assumable, least-privilege IAM connector role instead of long-lived access keys.

Delete the billable endpoint, endpoint configuration, and SageMaker model resource together:

```bash
npm run sagemaker:delete
```

The deployment defaults can be overridden with `SAGEMAKER_MINISTRAL_ENDPOINT`, `SAGEMAKER_MINISTRAL_INSTANCE_TYPE`, `SAGEMAKER_MINISTRAL_MODEL_ID`, `SAGEMAKER_MINISTRAL_MODEL_REVISION`, `SAGEMAKER_MINISTRAL_MODEL`, and `SAGEMAKER_VLLM_IMAGE_TAG`. Keep the default model revision synchronized with `query-understanding-training/configs/qlora-5090.yaml`. To load a validated SageMaker training artifact, set `SAGEMAKER_MINISTRAL_ADAPTER_MODEL_DATA_URL` to its `model.tar.gz` S3 URI. The deployment mounts the artifact, loads `/opt/ml/model/qlora-agentic-v3/adapter`, and exposes it under `SAGEMAKER_MINISTRAL_ADAPTER_NAME` (default `psg-agentic-query-planner-v3`) while retaining the base-model alias for rollback and comparison.

References: [AWS supported images](https://aws.github.io/deep-learning-containers/reference/available_images/#vllm-ubuntu), [AWS vLLM SageMaker deployment](https://aws.github.io/deep-learning-containers/vllm/deployment/sagemaker/), [AWS vLLM configuration](https://aws.github.io/deep-learning-containers/vllm/configuration/), and [OpenSearch SageMaker connectors](https://docs.opensearch.org/latest/ml-commons-plugin/remote-models/connectors/).

Dry-run commands:

```bash
npm run opensearch:index -- --dry-run
npm run opensearch:create-ubi -- --dry-run
OPENSEARCH_AGENTIC_MODEL_ID=existing-model-id npm run opensearch:agentic -- --dry-run
AGENTIC_MODEL_PROVIDER=sagemaker npm run opensearch:agentic -- --dry-run
```
