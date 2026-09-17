"""Semantic checks for supervised targets, beyond the executable DSL policy."""

from __future__ import annotations

import json
import re
from typing import Any, cast

from query_understanding.schemas import DatasetSlice, TrainingExample

WATCH_STYLE = re.compile(r"\b(?:dress|formal|suit) watch\b", re.IGNORECASE)
GENDER_WORD = re.compile(
    r"\b(?:woman|women|female|lady|ladies|man|men|male|gentleman|gentlemen|unisex)\b", re.IGNORECASE
)


def validate_training_target(example: TrainingExample) -> None:
    """Reject known prompt/target contradictions in the supervised corpus.

    These checks are training-data quality checks, not a replacement for the
    runtime DSL contract or a security boundary for arbitrary shopper wording.
    """
    body = cast(dict[str, Any], example.target_body.to_opensearch())
    lines = example.input.query_text.splitlines()
    shopper = lines[0].removeprefix("Shopper request: ")
    context = json.loads(lines[1].removeprefix("Trusted planner context: "))
    core = body["query"]["bool"]["must"][0]["multi_match"]
    text = core["query"]
    filters = body["query"]["bool"]["filter"]

    if WATCH_STYLE.search(shopper):
        if text != "watch" or core["operator"] != "or":
            raise ValueError("watch-style targets must use core query watch with operator or")
        if {"term": {"category": "watches"}} not in filters:
            raise ValueError("watch-style targets must include the Watches category filter")
    if GENDER_WORD.search(text):
        raise ValueError("target core query must omit gender words")
    if example.slice == DatasetSlice.ADVERSARIAL_FALLBACK:
        # These synthetic adversarial fixtures name one of two product intents.
        # Instruction text belongs only in the input, never in the gold query.
        product = re.search(r"\b(luxury bag|collector watch)\b", shopper)
        if product is not None and text != product.group(1):
            raise ValueError("adversarial target must retain only its product intent")
    if re.match(r"please find\b", text, re.IGNORECASE):
        raise ValueError("target core query must omit request scaffolding")

    # Generated budget examples deliberately use an unambiguous integer syntax.
    # Check against the input, independently of the generator's expectations.
    budgets = [int(value) for value in re.findall(r"\bunder (\d+)\b", shopper)]
    ceiling = min(context["ui_max_price"], context["persona"].get("strict_max_price", 20_000), *budgets)
    actual_prices = [clause["range"]["price"].get("lte") for clause in filters if "price" in clause.get("range", {})]
    if actual_prices != [ceiling]:
        raise ValueError("target price must equal the smallest shopper, UI, or persona ceiling")
