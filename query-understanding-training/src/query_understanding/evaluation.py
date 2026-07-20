"""Offline structural evaluation for native Agentic Search request bodies."""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from query_understanding.dataset import read_examples
from query_understanding.policy import (
    CompilerPolicy,
    PolicyViolation,
    constraint_is_present,
    validate_agentic_request_body,
)
from query_understanding.schemas import AgenticRequestBody


@dataclass(frozen=True)
class EvaluationReport:
    examples: int
    predictions_found: int
    json_validity: float
    request_body_validity: float
    dsl_policy_validity: float
    exact_request_match: float
    persona_clause_exact_match: float
    required_constraint_recall: float

    def to_dict(self) -> dict[str, object]:
        return asdict(self)


def evaluate_predictions(dataset_path: Path, predictions_path: Path, policy: CompilerPolicy) -> EvaluationReport:
    examples = read_examples(dataset_path, policy)
    predictions = _read_predictions(predictions_path)
    total = len(examples)
    found = json_valid = request_body_valid = policy_valid = exact_match = persona_match = 0
    constraints_found = constraints_total = 0

    for example in examples:
        required_constraints = example.expectations.required_filters
        constraints_total += len(required_constraints)
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
            request_body = AgenticRequestBody.model_validate(decoded)
        except ValidationError:
            continue
        request_body_valid += 1
        body = request_body.to_opensearch()
        policy_body = decoded if isinstance(decoded, dict) else body
        try:
            validate_agentic_request_body(example.input, policy_body, policy, example.expectations)
        except PolicyViolation:
            pass
        else:
            policy_valid += 1

        exact_match += decoded == example.target_body.to_opensearch()
        persona_match += _persona_clause_positions(body) == _persona_clause_positions(
            example.target_body.to_opensearch()
        )
        constraints_found += sum(constraint_is_present(body, constraint) for constraint in required_constraints)

    return EvaluationReport(
        examples=total,
        predictions_found=found,
        json_validity=_ratio(json_valid, total),
        request_body_validity=_ratio(request_body_valid, total),
        dsl_policy_validity=_ratio(policy_valid, total),
        exact_request_match=_ratio(exact_match, total),
        persona_clause_exact_match=_ratio(persona_match, total),
        required_constraint_recall=_ratio(constraints_found, constraints_total),
    )


def _persona_clause_positions(body: object) -> list[tuple[tuple[str | int, ...], object]]:
    """Return every multi-match clause with its full query path.

    The first required ``bool.must`` multi-match is part of this signature on
    purpose. Comparing the full path-aware signature ensures that a persona
    clause cannot be copied into ``must``, ``filter``, or a nested bool while
    the expected ``bool.should`` clause still makes the persona metric pass.
    """

    positions: list[tuple[tuple[str | int, ...], object]] = []

    def visit(value: object, path: tuple[str | int, ...]) -> None:
        if isinstance(value, dict):
            if set(value) == {"multi_match"}:
                positions.append((path, value))
            for key, child in value.items():
                visit(child, (*path, key))
        elif isinstance(value, list):
            for index, child in enumerate(value):
                visit(child, (*path, index))

    if isinstance(body, dict) and isinstance(body.get("query"), dict):
        visit(body["query"], ("query",))
    return positions


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


def _ratio(numerator: int, denominator: int) -> float:
    return round(numerator / denominator, 6) if denominator else 0.0
