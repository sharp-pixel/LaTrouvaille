# Integration boundary

## Current prototype

The search app now sends natural-language requests through OpenSearch's native Agentic Search pipeline against `secondhand_items_current`. A flow agent and `QueryPlanningTool` use this project's served fine-tuned adapter when its configured model alias is available, or the pinned base model otherwise. The earlier JavaScript compiler remains the deterministic lexical OpenSearch fallback. The mapping does not yet contain the design document’s `concept_scores.*`, identity hierarchy, or k-NN vector fields.

For that reason, this project ships two policies:

- `policy-prototype-v1.yaml` is executable against the current lexical index.
- `policy-hybrid-v1.yaml` describes the future hybrid design and must remain disabled until its mapping and search pipeline exist.

## Recommended rollout

1. Train and evaluate adapters offline.
2. Replay held-out and UBI-derived queries without affecting shopper responses.
3. Inspect the native pipeline's returned `dsl_query`, validate it offline, and compare it with the deterministic lexical baseline.
4. Add shadow traffic and measure query-understanding p50/p95 separately from OpenSearch latency.
5. Introduce a fail-open service boundary only after quality and latency gates pass.

The prototype provisions that boundary through `retail-search-prototype/scripts/configure-agentic-search.mjs`. It registers an OpenAI-compatible remote model in OpenSearch, a native flow agent with `QueryPlanningTool`, and the agentic search pipeline. The configuration script discovers served aliases and prefers `AGENTIC_FINE_TUNED_MODEL`, falling back to `AGENTIC_BASE_MODEL`. Training and agent registration load the exact same packaged system and user prompt assets. The adapter emits one complete search body containing `size`, `track_total_hits`, `query`, and any requested `sort`.

`AgenticQueryTranslator` replaces the generated search source and preserves only incoming `_source` and `ext`. Consequently, the Node API sends sort intent inside `query_text` rather than attaching an outer sort, and the fine-tuning target omits `_source` while generating all other serving options.

An 8B local model will not fit the prototype’s original 5–15 ms parsing budget. The agentic request has a separate 3-second prototype timeout and retries with deterministic lexical OpenSearch DSL on failure. Likely production options are aggressive caching, a smaller distilled planner, or a separately budgeted service with circuit breaking and the same deterministic fallback.

## Safety contract

The native `QueryPlanningTool` executes the generated body inside OpenSearch. The configured prompt and query-field list narrow its scope, but production hardening must still enforce:

- configured index aliases and search pipelines;
- request-provided and service-level field allowlists;
- top-level search-source key and sort-field allowlists;
- query-type allowlists;
- `size`, `from`, `k`, and query-clause limits;
- a ban on scripts, `script_score`, Painless, raw `query_string`, regex, and wildcard queries;
- one bounded repair attempt followed by a deterministic rules/template fallback.

The Python validator implements these checks offline. Before production rollout, add an equivalent request-processor policy or restrict the agent to reviewed search templates so enforcement remains inside the native pipeline.
