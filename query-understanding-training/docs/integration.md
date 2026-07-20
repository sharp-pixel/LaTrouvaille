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

The prototype provisions that boundary through `retail-search-prototype/scripts/configure-agentic-search.mjs`. It registers an OpenAI-compatible remote model in OpenSearch, a native flow agent with `QueryPlanningTool`, and the agentic search pipeline. The configuration script discovers served aliases and prefers the v3 `AGENTIC_FINE_TUNED_MODEL`, falling back to `AGENTIC_BASE_MODEL`. Training and agent registration load the exact same packaged system and user prompt assets. The connector requests a nested JSON-schema shape by default. The immutable contract owns filters, `size`, `track_total_hits`, sort mode, `base_text_query`, `text_operator`, and a bounded persona context. The adapter copies the core controls exactly and may add only the persona's exact `query_expansion` as a low-boost optional scoring clause. Recommended mode omits `rank_features` and emits the canonical rank trio; every explicit sort includes exact `rank_features=false` and omits all rank-feature clauses.

The first question line is not raw shopper text. The service deterministically renders it from `base_text_query`, the exact price ceiling, and sort mode (`cheapest`, `newest`, or `with biggest price drops` where applicable). The Python policy recomputes that line from the immutable contract and rejects any drift, preventing alternate wording from steering the planner away from the canonical base query. If the complete summary and contract exceed the native 1,000-character limit, the request is rejected rather than slicing the summary. The v3 connector and training schema use integer `track_total_hits` values from 0 through 10,000 exclusively.

`AgenticQueryTranslator` replaces the generated search source and preserves only incoming `_source` and `ext`. Consequently, the Node API sends sort intent inside `query_text` rather than attaching an outer sort, and the fine-tuning target omits `_source` while generating all other serving options.

An 8B local model will not fit the prototype’s original 5–15 ms parsing budget. The local agentic request defaults to a separate 15-second timeout and retries with deterministic lexical OpenSearch DSL on failure. Likely production options are aggressive caching, a smaller distilled planner, or a separately budgeted service with circuit breaking and the same deterministic fallback.

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

Persona context is service-owned and uses one of two exact shapes. Anonymous is `{id, version, mode: "unprofiled"}`. A profiled shopper supplies `id`, `version`, `archetype`, `background`, `mental_model`, and `query_expansion`; names, demographics, and images are excluded. The generated core query remains persona-independent, while the optional persona clause is validated byte-for-byte against `query_expansion` and cannot migrate into `must` or `filter`.
