# Dataset directory

`train.jsonl` and `eval.jsonl` are small, reviewed fixtures for validating the pipeline. They are deliberately too small for meaningful fine-tuning.

Before a real run:

1. Build 1,000–5,000 reviewed SFT examples with the target slice distribution.
2. Build a separate hard evaluation set with at least 1,000 labeled queries.
3. Group split by normalized surface query and contrast-pair family.
4. Validate all examples with `uv run --no-editable quft validate-data`.
5. Review token lengths on the pinned model/chat template; compact or reject oversized rows instead of truncating assistant JSON.
6. Treat local UBI files as weak source material only. Deduplicate and human-review them before use.
