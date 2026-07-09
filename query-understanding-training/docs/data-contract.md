# Data contract

## Canonical source row

Each JSONL line has four fields:

```json
{
  "example_id": "dress-watch-quiet-intermediate",
  "slice": "ambiguous_persona",
  "input": {},
  "output": {}
}
```

The loader converts it into a conversational prompt/completion sample:

1. A fixed system message defines the JSON-only compiler and safety constraints.
2. The user message is canonical, key-sorted JSON for `input`.
3. The assistant completion is canonical, key-sorted JSON for `output`.

Only assistant completion tokens receive labels. Examples longer than `sequence_length` fail preprocessing; they are never truncated because partial JSON is a harmful target.

## Input fields

- `raw_query`
- `user_context.persona_summary`
- `user_context.category_expertise`
- optional `user_context.budget`
- `allowed_schema.indexes`
- `allowed_schema.categories`
- `allowed_schema.fields`
- `allowed_schema.search_pipelines`
- optional `current_filters`
- optional `category_ontology`
- `output_schema`, fixed to `psg_query_compiler_v1`

Sensitive personal data should not be copied into `persona_summary`. Store only preference features required for retrieval.

## Output fields

- `schema_version`, fixed to `psg_query_compiler_v1`
- `raw_query`
- `category`
- `query_type`: `lookup`, `comparison`, `recommendation`, `exploratory_search`, or `filter_refinement`
- `user_expertise`: `novice`, `intermediate`, or `expert`
- `confidence`
- `clarification_needed` and `clarification_question`
- six dense `resolution_weights` that sum to 1
- eight dense `mental_model_weights`, each between 0 and 1
- `rewrites.embedding_query`, `keyword_query`, and `negative_query`
- `constraints.filters` and `constraints.must_not`
- `opensearch.index`, optional `search_pipeline`, and `body`

The JSON Schema is generated from `QueryCompilerOutput`:

```bash
uv run --no-editable quft export-schema --output schemas/psg_query_compiler_v1.schema.json
```

## Dataset slices

The production corpus should converge on the design mix:

| Slice | Share |
| --- | ---: |
| Clean single-category | 20% |
| Ambiguous/persona-dependent | 25% |
| Expertise/resolution contrast pairs | 20% |
| Cross-category transfer | 10% |
| OpenSearch DSL hard cases | 15% |
| Negative/repair/clarification cases | 10% |

Split contrast groups by surface query before train/eval partitioning. The same ambiguous query must not leak across splits with only its persona changed.

## Acceptance gates

Before production consideration, evaluate at least:

- JSON and schema validity: 99.5% or better.
- Policy/DSL compile validity: 99% or better.
- Real OpenSearch execution rate: 99% or better.
- Category accuracy: 95% or better.
- Query-type accuracy: 90% or better.
- Expertise/retrieval-resolution accuracy: 85% or better on hard cases.
- Statistically significant lift in NDCG@10, Recall@50, and MRR over prompt-only and rules-only baselines.

The included evaluator covers the structural metrics. Retrieval metrics and execution rate require a judged result set and a running OpenSearch index.
