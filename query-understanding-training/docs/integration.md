# Integration boundary

## Current prototype

The existing search app performs Tier-1 query understanding in JavaScript and compiles a lexical OpenSearch request against `secondhand_items_current`. The OpenSearch mapping does not yet contain the design document’s `concept_scores.*`, identity hierarchy, or k-NN vector fields.

For that reason, this project ships two policies:

- `policy-prototype-v1.yaml` is executable against the current lexical index.
- `policy-hybrid-v1.yaml` describes the future hybrid design and must remain disabled until its mapping and search pipeline exist.

## Recommended rollout

1. Train and evaluate adapters offline.
2. Replay held-out and UBI-derived queries without affecting shopper responses.
3. Validate every output, recompile/sanitize the DSL, and compare it with the rules-only baseline.
4. Add shadow traffic and measure query-understanding p50/p95 separately from OpenSearch latency.
5. Introduce a fail-open service boundary only after quality and latency gates pass.

An 8B local model will not fit the prototype’s current 5–15 ms Tier-1 parsing budget or the 20 ms Tier-2 rewrite timeout. Do not replace the in-process JavaScript parser with a blocking network call by default. Likely production options are asynchronous enrichment, aggressive caching, a smaller distilled model, or a separately budgeted service with a deterministic fallback.

## Safety contract

The generated OpenSearch body is an intermediate artifact. Before execution, the application must enforce:

- configured index aliases and search pipelines;
- request-provided and service-level field allowlists;
- query-type allowlists;
- `size`, `from`, `k`, and query-clause limits;
- a ban on scripts, `script_score`, Painless, raw `query_string`, regex, and wildcard queries;
- one bounded repair attempt followed by a deterministic rules/template fallback.

The Python validator implements these offline checks. A production service should port or call the same contract at the execution boundary.
