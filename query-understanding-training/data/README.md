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
9. Generate runtime-shaped rows from the same compact immutable service contract used by `buildAgenticQueryText`, including raw shopper wording, integer `track_total_hits` in the range 0–10,000, conditional explicit-sort `rank_features=false`, trusted persona shape, and persona-clause copies; keep every final `query_text` within the native 1,000-character limit and reject rather than truncate when the complete three-line envelope does not fit.
10. Keep names, demographics, and images out of model context. Human-review every persona `query_expansion` against the indexed text vocabulary and cap it at 120 characters.

## Semantic target checks and repaired training run

`validate-data` also checks the supervised target text against the shared prompt:
dress/formal/suit watch requests use `watch` with `operator: or` and a Watches
filter; gender and request-scaffolding words stay out of the core query; the
synthetic adversarial fixtures retain only their product intent. Integer `under`
budgets are checked independently against the UI and optional persona ceilings.
These are training-data checks, not a runtime security boundary.

Both splits include Anonymous bare watch requests with no trusted category
filter, plus absent shopper budgets and shopper budgets below, above, and equal
to the UI ceiling. Target categories can therefore be inferred rather than
always copied. The fifth non-mapping variant uses `please find` scaffolding
instead of repeating an identical input. Ranking families and persona
counterfactuals remain within one split.

Use the separate repair-run configuration to preserve the currently served
adapter:

```bash
BNB_CUDA_VERSION=130 uv run --locked --no-editable quft train --execute --config configs/qlora-5090-repaired.yaml
```

It writes to `artifacts/qlora-agentic-v3-repaired`. Validate the candidate before
switching the read-only serving mount from the existing adapter. The repaired
run starts from the pinned base checkpoint, not from the old adapter/checkpoint.
