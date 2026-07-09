"""Offline structural evaluation for generated compiler outputs."""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from query_understanding.dataset import read_examples
from query_understanding.policy import CompilerPolicy, PolicyViolation, validate_compiler_output
from query_understanding.schemas import QueryCompilerOutput


@dataclass(frozen=True)
class EvaluationReport:
    examples: int
    predictions_found: int
    json_validity: float
    schema_validity: float
    dsl_policy_validity: float
    category_accuracy: float
    query_type_accuracy: float
    expertise_accuracy: float
    resolution_accuracy: float

    def to_dict(self) -> dict[str, object]:
        return asdict(self)


def evaluate_predictions(dataset_path: Path, predictions_path: Path, policy: CompilerPolicy) -> EvaluationReport:
    examples = read_examples(dataset_path, policy)
    predictions = _read_predictions(predictions_path)
    total = len(examples)
    found = json_valid = schema_valid = policy_valid = 0
    category_correct = query_type_correct = expertise_correct = resolution_correct = 0

    for example in examples:
        if example.example_id not in predictions:
            continue
        found += 1
        raw_output = predictions[example.example_id]
        try:
            decoded = json.loads(raw_output) if isinstance(raw_output, str) else raw_output
        except json.JSONDecodeError:
            continue
        json_valid += 1
        try:
            output = QueryCompilerOutput.model_validate(decoded)
        except ValidationError:
            continue
        schema_valid += 1
        try:
            validate_compiler_output(example.input, output, policy)
        except PolicyViolation:
            pass
        else:
            policy_valid += 1

        gold = example.output
        category_correct += output.category == gold.category
        query_type_correct += output.query_type == gold.query_type
        expertise_correct += output.user_expertise == gold.user_expertise
        resolution_correct += _highest_resolution(output) == _highest_resolution(gold)

    return EvaluationReport(
        examples=total,
        predictions_found=found,
        json_validity=_ratio(json_valid, total),
        schema_validity=_ratio(schema_valid, total),
        dsl_policy_validity=_ratio(policy_valid, total),
        category_accuracy=_ratio(category_correct, total),
        query_type_accuracy=_ratio(query_type_correct, total),
        expertise_accuracy=_ratio(expertise_correct, total),
        resolution_accuracy=_ratio(resolution_correct, total),
    )


def _read_predictions(path: Path) -> dict[str, object]:
    predictions: dict[str, object] = {}
    with path.open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            row: Any = json.loads(line)
            if not isinstance(row, dict) or not isinstance(row.get("example_id"), str) or "output" not in row:
                raise ValueError(f"invalid prediction row at line {line_number}")
            if row["example_id"] in predictions:
                raise ValueError(f"duplicate prediction for {row['example_id']}")
            predictions[row["example_id"]] = row["output"]
    return predictions


def _highest_resolution(output: QueryCompilerOutput) -> str:
    weights = output.resolution_weights.model_dump()
    return max(weights, key=weights.__getitem__)


def _ratio(numerator: int, denominator: int) -> float:
    return round(numerator / denominator, 6) if denominator else 0.0
