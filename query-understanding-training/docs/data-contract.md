# Native Agentic Search data contract

## Canonical source row

Each JSONL row describes the exact input seen by OpenSearch's `QueryPlanningTool`, offline expectations, and the full search body the model must generate:

```json
{
  "objective_version": "opensearch_agentic_query_planner_v3",
  "example_id": "formal-watch",
  "slice": "intent_disambiguation",
  "input": {
    "query_text": "Normalized shopper request: Dress watch under 5000\nImmutable service contract: {\"filter\":[{\"term\":{\"availability\":\"active\"}},{\"range\":{\"price\":{\"lte\":5000}}},{\"term\":{\"category\":\"watches\"}}],\"size\":24,\"track_total_hits\":10000,\"sort_mode\":\"recommended\",\"text_operator\":\"or\",\"base_text_query\":\"Dress watch\",\"persona\":{\"id\":\"watch-collector\",\"version\":1,\"archetype\":\"Watch collector\",\"background\":\"An experienced collector tracking dress watches across Europe and comfortable with resale pricing.\",\"mental_model\":\"A specialist inventory: exact model, condition, provenance, and price are decision fields.\",\"query_expansion\":\"dress watch reference provenance full set serviced collector steel\"}}\nCopy the core contract exactly. Apply persona only through the system persona-should recipe. Follow sort_mode.",
    "index_name": "secondhand_items_current",
    "index_mapping": {
      "_doc": {
        "dynamic": "false",
        "properties": {
          "title": {"type": "text"},
          "brand": {"type": "text"},
          "canonical_text": {"type": "text"},
          "description": {"type": "text"},
          "availability": {"type": "keyword"},
          "category": {"type": "keyword"},
          "price": {"type": "integer"},
          "quality_score": {"type": "rank_feature"},
          "freshness_score": {"type": "rank_feature"},
          "seller_score": {"type": "rank_feature"}
        }
      }
    },
    "query_fields": ["title", "brand", "canonical_text", "description", "availability", "category", "price", "quality_score", "freshness_score", "seller_score"]
  },
  "expectations": {
    "required_filters": [{"field": "availability", "op": "term", "value": "active"}, {"field": "price", "op": "lte", "value": 5000}, {"field": "category", "op": "term", "value": "watches"}],
    "result_size": 24,
    "track_total_hits": 10000,
    "sort_mode": "recommended"
  },
  "target_body": {
    "size": 24,
    "track_total_hits": 10000,
    "query": {
      "bool": {
        "filter": [{"term": {"availability": "active"}}, {"range": {"price": {"lte": 5000}}}, {"term": {"category": "watches"}}],
        "must": [{"multi_match": {"query": "Dress watch", "fields": ["title^5", "brand^3", "canonical_text^3", "description"], "operator": "or"}}],
        "should": [{"multi_match": {"query": "dress watch reference provenance full set serviced collector steel", "fields": ["title^5", "brand^3", "canonical_text^3", "description"], "operator": "or", "boost": 0.35}}, {"rank_feature": {"field": "quality_score", "boost": 0.2}}, {"rank_feature": {"field": "freshness_score", "boost": 0.05}}, {"rank_feature": {"field": "seller_score", "boost": 0.02}}]
      }
    }
  }
}
```

The loader renders the same system and user prompt templates registered in OpenSearch. Only the canonical JSON serialization of `target_body` is labeled as the assistant completion.

## Native input fields

- `query_text`: the complete, at-most-1,000-character planner question passed in the `agentic` clause. Its first line is a deterministic normalized summary derived from `base_text_query`, the service price ceiling, and `sort_mode`; raw shopper wording never reaches the planner. The remaining lines carry service-owned filters, result limit, total-hit setting, sort mode, canonical base text query, text operator, and persona in a compact immutable JSON contract. Reject an oversized envelope; never truncate the normalized summary or contract.
- `track_total_hits`: an integer from 0 through 10,000, matching the native connector's structured-output schema and runtime normalization. Boolean values are not valid v3 training or serving targets.
- `rank_features`: a conditional explicit-sort guard. Recommended contracts omit it; every explicit sort includes exactly `"rank_features":false`.
- `index_name`: used for offline allowlist checks; it is not part of the completion.
- `index_mapping`: the mapping-source shape emitted by the deployed OpenSearch version. OpenSearch 3.7 wraps it in `_doc`, so the checked-in fixtures do too.
- `query_fields`: the same field allowlist supplied in the native `agentic` query.
- `QueryPlanningTool` serializes both the mapping and `query_fields` as JSON string literals before connector substitution. The offline renderer mirrors that extra serialization layer exactly.
- The custom prompt intentionally omits volatile sample-document and clock fields so the fine-tune sees the same stable inputs at training and serving time.

The anonymous persona is exactly `{"id":"anonymous","version":1,"mode":"unprofiled"}`. A profiled persona has exactly `id`, `version`, `archetype`, `background`, `mental_model`, and `query_expansion`. The bounded context deliberately excludes names, demographics, and images. `query_expansion` is optional scoring context only; it never changes core matching or hard constraints.

## Evaluation expectations

`expectations` never enters the prompt or completion. It specifies:

- required exact/range filters that the generated body must retain;
- the exact result size requested by the service;
- the exact total-hit setting requested by the service;
- one of `recommended`, `lowest_price`, `newest`, or `price_drop` for sort validation.

## Target-body rules

The target is one complete `SearchSourceBuilder`-compatible JSON object:

- Include `size`, integer `track_total_hits`, and `query`; include `sort` only for an explicit non-recommended mode. `track_total_hits` must match the service requirement encoded in `query_text`.
- Do not include `_source`; `AgenticQueryTranslator` preserves `_source` from the incoming service request.
- Do not include the index, search pipeline, `agentic` query, metadata envelope, explanations, or Markdown.
- Use only mapped `query_fields` and policy-allowlisted query types.
- Use full-text clauses only on mapped text fields, `prefix` only on keyword-like fields, `rank_feature` only on rank-feature fields, and type-compatible, satisfiable ranges.
- Copy the contract's `base_text_query` and `text_operator` exactly into the canonical four-field `multi_match` in `bool.must`.
- For a profiled persona, copy `persona.query_expansion` exactly into one four-field `multi_match` with operator `or` and boost `0.35`. It must be the first `bool.should` clause. Anonymous and unprofiled personas omit this clause.
- Keep service filters in runtime order: active availability, the integer `price.lte` ceiling, then at most one normalized `term`/`terms` clause for category, condition, material, and country.
- Recommended ranking appends the canonical quality, freshness, and seller `rank_feature` clauses after the optional persona clause and omits `sort`. Explicit sort modes omit rank-feature clauses but retain the single persona `should` clause for profiled shoppers.
- `sort_mode=recommended` requires all three canonical rank clauses and forbids a `rank_features` key. `rank_features=false` on an explicit sort forbids every rank-feature clause. The policy cross-checks both conditional shapes.
- Do not emit `bool.must_not`; this serving objective supports positive retrieval and service-owned filters only.
- Keep scripts, `script_score`, `query_string`, regexp, and wildcard queries forbidden.

Export the formal row schema with:

```bash
uv run --no-editable quft export-schema --output schemas/opensearch_agentic_query_planner_v3.schema.json
```

## Dataset slices

A production corpus should cover at least:

| Slice | Suggested share |
| --- | ---: |
| Clean single-category retrieval | 20% |
| Intent and phrase disambiguation | 20% |
| Exact brand/model lookup | 15% |
| Facets, ranges, and conflicting filters | 15% |
| Matched contrasts across all supported sort modes | 10% |
| Broad and zero-context queries | 5% |
| Mapping/query-field variation | 10% |
| Adversarial and fallback cases | 5% |

Split duplicate surface queries and mapping variants as groups so near-identical requests cannot leak across train/evaluation partitions.

The checked-in generator instantiates 1,160 semantic groups with five
persona/mapping counterfactuals each. This includes 40 request families rendered
in all four ranking modes; only the sort contract and its required rank-feature
shape change within a family. It writes 4,640 training examples and 1,160
evaluation examples while keeping every scenario group and every four-way
ranking family wholly within one split. `quft build-data --check` is the
reproducibility and leakage gate.

## Acceptance gates

Before production consideration, evaluate at least:

- JSON and request-body validity: 99.5% or better.
- Policy-valid DSL: 99% or better.
- Required-filter recall: 99.5% or better.
- Exact persona-clause match: 99.5% or better.
- Sort-mode accuracy: 99% or better.
- Real OpenSearch parse/execution rate: 99% or better.
- QueryPlanningTool fallback-use rate below the agreed error budget.
- Statistically significant lift in NDCG@10, Recall@50, and MRR over the base model and deterministic lexical fallback.

The included evaluator covers structural validity, exact request match, exact persona-clause match, and required-filter recall. Execution, fallback detection, latency, and persona-segmented retrieval metrics require a running OpenSearch index and judged queries.
