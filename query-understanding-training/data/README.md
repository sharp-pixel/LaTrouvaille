# Dataset directory

`train.jsonl` and `eval.jsonl` are generated, policy-valid corpora for the native
OpenSearch query-planning objective. The checked-in split contains 4,640 training
rows and 1,160 held-out rows.

Regenerate them and print the coverage report with:

```bash
uv run --no-editable quft build-data
uv run --no-editable quft build-data --check
uv run --no-editable quft validate-data
```

The generator uses 1,160 semantic request groups with five persona/mapping
counterfactuals per group. Forty four-way ranking families keep all retrieval
controls fixed and vary only recommended, lowest-price, newest, and price-drop
behavior. It assigns whole groups and whole ranking families to the 80/20 split,
preventing the same service controls from appearing in both training and
evaluation.

Before a production run:

1. Human-review generated rows and any additional UBI-derived examples.
2. Preserve the group split when adding normalized surface queries or mapping variants.
3. Validate all examples with `uv run --no-editable quft validate-data`.
4. Review token lengths on the pinned model/chat template; compact or reject oversized rows instead of truncating assistant JSON.
5. Treat local UBI files as weak source material only. Deduplicate and human-review them before use.
6. Capture the deployed QueryPlanningTool mapping-source shape, including its `_doc` wrapper where present, and render its mapping/query-fields JSON-string parameters exactly with the shared prompt.
7. Ensure the target is a raw body with no `_source` or legacy compiler envelope.
8. Cover every supported sort mode with both profiled and anonymous personas. Include matched four-way ranking families and persona-only counterfactuals; keep each family within one split.
9. Generate runtime-shaped rows from the same compact immutable service contract used by `buildAgenticQueryText`, including the deterministic normalized first-line summary, integer `track_total_hits` in the range 0–10,000, conditional explicit-sort `rank_features=false`, exact `base_text_query`, `text_operator`, persona shape, and persona-clause copies; keep every final `query_text` within the native 1,000-character limit and reject rather than truncate when the complete three-line envelope does not fit.
10. Keep names, demographics, and images out of model context. Human-review every persona `query_expansion` against the indexed text vocabulary and cap it at 120 characters.
