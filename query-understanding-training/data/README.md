# Dataset directory

`train.jsonl` and `eval.jsonl` are small, reviewed fixtures for validating the pipeline. They are deliberately too small for meaningful fine-tuning.

Before a real run:

1. Build 1,000–5,000 reviewed SFT examples with the target slice distribution.
2. Build a separate hard evaluation set with at least 1,000 labeled queries.
3. Group split by normalized surface query, persona version, and mapping variant.
4. Validate all examples with `uv run --no-editable quft validate-data`.
5. Review token lengths on the pinned model/chat template; compact or reject oversized rows instead of truncating assistant JSON.
6. Treat local UBI files as weak source material only. Deduplicate and human-review them before use.
7. Capture the deployed QueryPlanningTool mapping-source shape, including its `_doc` wrapper where present, and render its mapping/query-fields JSON-string parameters exactly with the shared prompt.
8. Ensure the target is a raw body with no `_source` or legacy compiler envelope.
9. Cover every supported sort mode with both profiled and anonymous personas. Include counterfactual rows whose service controls are identical and whose only difference is persona context.
10. Generate runtime-shaped rows from the same compact immutable service contract used by `buildAgenticQueryText`, including the deterministic normalized first-line summary, integer `track_total_hits` in the range 0–10,000, conditional explicit-sort `rank_features=false`, exact `base_text_query`, `text_operator`, persona shape, and persona-clause copies; keep every final `query_text` within the native 1,000-character limit and reject rather than truncate when the complete three-line envelope does not fit.
11. Keep names, demographics, and images out of model context. Human-review every persona `query_expansion` against the indexed text vocabulary and cap it at 120 characters.
