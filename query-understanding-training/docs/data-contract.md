# Native Agentic Search data contract

## Canonical source row

Each JSONL row describes the exact input seen by OpenSearch's `QueryPlanningTool`, offline expectations, and the full search body the model must generate:

```json
{
  "objective_version": "opensearch_agentic_query_planner_v1",
  "example_id": "formal-watch",
  "slice": "intent_disambiguation",
  "input": {
    "query_text": "Shopper request: formal watch.\nRequired filters: availability must equal active.",
    "index_name": "secondhand_items_current",
    "index_mapping": {
      "_doc": {
        "dynamic": "false",
        "properties": {
          "title": {"type": "text"},
          "brand": {"type": "text"},
          "canonical_text": {"type": "text"}
        }
      }
    },
    "query_fields": ["title", "brand", "canonical_text"]
  },
  "expectations": {
    "required_filters": [{"field": "availability", "op": "term", "value": "active"}],
    "result_size": 24,
    "track_total_hits": 10000,
    "sort_mode": "recommended"
  },
  "target_body": {
    "size": 24,
    "track_total_hits": 10000,
    "query": {"bool": {}}
  }
}
```

The loader renders the same system and user prompt templates registered in OpenSearch. Only the canonical JSON serialization of `target_body` is labeled as the assistant completion.

## Native input fields

- `query_text`: the complete natural-language question passed in the `agentic` clause, including service-owned filters, result limit, and sort intent.
- `index_name`: used for offline allowlist checks; it is not part of the completion.
- `index_mapping`: the mapping-source shape emitted by the deployed OpenSearch version. OpenSearch 3.7 wraps it in `_doc`, so the checked-in fixtures do too.
- `query_fields`: the same field allowlist supplied in the native `agentic` query.
- `QueryPlanningTool` serializes both the mapping and `query_fields` as JSON string literals before connector substitution. The offline renderer mirrors that extra serialization layer exactly.
- The custom prompt intentionally omits volatile sample-document and clock fields so the fine-tune sees the same stable inputs at training and serving time.

Persona, expertise, confidence, and mental-model labels do not enter this serving objective. The prototype records persona as evaluation context and does not silently personalize ranking.

## Evaluation expectations

`expectations` never enters the prompt or completion. It specifies:

- required exact/range filters that the generated body must retain;
- the exact result size requested by the service;
- the exact total-hit setting requested by the service;
- one of `recommended`, `lowest_price`, `newest`, or `price_drop` for sort validation.

## Target-body rules

The target is one complete `SearchSourceBuilder`-compatible JSON object:

- Include `size`, `track_total_hits`, `query`, and a requested `sort`; `track_total_hits` must match the service requirement encoded in `query_text`.
- Do not include `_source`; `AgenticQueryTranslator` preserves `_source` from the incoming service request.
- Do not include the index, search pipeline, `agentic` query, metadata envelope, explanations, or Markdown.
- Use only mapped `query_fields` and policy-allowlisted query types.
- Use full-text clauses only on mapped text fields, `prefix` only on keyword-like fields, `rank_feature` only on rank-feature fields, and type-compatible, satisfiable ranges.
- Do not emit `bool.must_not`; this serving objective supports positive retrieval and service-owned filters only.
- Keep scripts, `script_score`, `query_string`, regexp, and wildcard queries forbidden.

Export the formal row schema with:

```bash
uv run --no-editable quft export-schema --output schemas/opensearch_agentic_query_planner_v1.schema.json
```

## Dataset slices

A production corpus should cover at least:

| Slice | Suggested share |
| --- | ---: |
| Clean single-category retrieval | 20% |
| Intent and phrase disambiguation | 20% |
| Exact brand/model lookup | 15% |
| Facets, ranges, and conflicting filters | 15% |
| All supported sort modes | 10% |
| Broad and zero-context queries | 5% |
| Mapping/query-field variation | 10% |
| Adversarial and fallback cases | 5% |

Split duplicate surface queries and mapping variants as groups so near-identical requests cannot leak across train/evaluation partitions.

## Acceptance gates

Before production consideration, evaluate at least:

- JSON and request-body validity: 99.5% or better.
- Policy-valid DSL: 99% or better.
- Required-filter recall: 99.5% or better.
- Sort-mode accuracy: 99% or better.
- Real OpenSearch parse/execution rate: 99% or better.
- QueryPlanningTool fallback-use rate below the agreed error budget.
- Statistically significant lift in NDCG@10, Recall@50, and MRR over the base model and deterministic lexical fallback.

The included evaluator covers structural validity, exact request match, and required-filter recall. Execution, fallback detection, latency, and retrieval metrics require a running OpenSearch index and judged queries.
