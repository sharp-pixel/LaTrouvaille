"""Canonical JSONL validation and conversion into completion-only conversations."""

from __future__ import annotations

import json
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from query_understanding.agentic_objective import (
    build_query_planner_user_prompt,
    load_system_prompt,
    load_user_prompt_template,
)
from query_understanding.policy import CompilerPolicy, PolicyViolation, validate_agentic_request_body
from query_understanding.schemas import TrainingExample

SYSTEM_PROMPT = load_system_prompt()
USER_PROMPT_TEMPLATE = load_user_prompt_template()


@dataclass(frozen=True)
class DatasetIssue:
    line: int
    example_id: str | None
    message: str


@dataclass(frozen=True)
class ValidationReport:
    path: Path
    total: int
    valid: int
    slice_counts: dict[str, int]
    issues: tuple[DatasetIssue, ...]

    @property
    def ok(self) -> bool:
        return not self.issues and self.total == self.valid


class DatasetValidationError(ValueError):
    def __init__(self, report: ValidationReport) -> None:
        self.report = report
        details = "; ".join(f"line {issue.line}: {issue.message}" for issue in report.issues[:5])
        super().__init__(f"dataset validation failed for {report.path}: {details}")


def canonical_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def validate_dataset(path: Path, policy: CompilerPolicy) -> ValidationReport:
    issues: list[DatasetIssue] = []
    seen_ids: set[str] = set()
    slice_counts: Counter[str] = Counter()
    total = 0
    valid = 0

    with path.open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            total += 1
            raw: Any = None
            example_id: str | None = None
            try:
                raw = json.loads(line)
                if isinstance(raw, dict) and isinstance(raw.get("example_id"), str):
                    example_id = raw["example_id"]
                example = TrainingExample.model_validate(raw)
                if example.example_id in seen_ids:
                    raise ValueError(f"duplicate example_id: {example.example_id}")
                validate_agentic_request_body(
                    example.input,
                    example.target_body.to_opensearch(),
                    policy,
                    example.expectations,
                )
            except (json.JSONDecodeError, ValidationError, PolicyViolation, ValueError) as error:
                issues.append(DatasetIssue(line_number, example_id, str(error)))
                continue
            seen_ids.add(example.example_id)
            slice_counts[example.slice.value] += 1
            valid += 1

    return ValidationReport(path, total, valid, dict(sorted(slice_counts.items())), tuple(issues))


def read_examples(path: Path, policy: CompilerPolicy) -> list[TrainingExample]:
    report = validate_dataset(path, policy)
    if not report.ok:
        raise DatasetValidationError(report)
    examples: list[TrainingExample] = []
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                examples.append(TrainingExample.model_validate_json(line))
    return examples


def to_prompt_completion(
    example: TrainingExample,
    system_prompt: str = SYSTEM_PROMPT,
    user_prompt_template: str = USER_PROMPT_TEMPLATE,
) -> dict[str, object]:
    return {
        "prompt": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": build_query_planner_user_prompt(example.input, user_prompt_template)},
        ],
        "completion": [
            {"role": "assistant", "content": canonical_json(example.target_body.to_opensearch())},
        ],
    }


def training_rows(
    path: Path,
    policy: CompilerPolicy,
    system_prompt: str = SYSTEM_PROMPT,
    user_prompt_template: str = USER_PROMPT_TEMPLATE,
) -> list[dict[str, object]]:
    return [
        to_prompt_completion(example, system_prompt, user_prompt_template) for example in read_examples(path, policy)
    ]
