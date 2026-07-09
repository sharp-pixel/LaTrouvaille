import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from query_understanding.config import TrainingConfig
from query_understanding.schemas import QueryCompilerOutput, TrainingExample


def _first_example(config: TrainingConfig) -> TrainingExample:
    line = config.data.train_file.read_text(encoding="utf-8").splitlines()[0]
    return TrainingExample.model_validate_json(line)


def test_training_fixture_satisfies_contract(config: TrainingConfig) -> None:
    example = _first_example(config)
    assert example.input.raw_query == "dress watch"
    assert example.output.schema_version == "psg_query_compiler_v1"
    assert sum(example.output.resolution_weights.model_dump().values()) == pytest.approx(1.0)


def test_resolution_weights_must_sum_to_one(config: TrainingConfig) -> None:
    payload = _first_example(config).output.model_dump(mode="json")
    payload["resolution_weights"] = {
        "category": 0.5,
        "brand": 0.5,
        "collection": 0.5,
        "model_line": 0.5,
        "reference": 0.5,
        "variant": 0.5,
    }
    with pytest.raises(ValidationError, match=r"must sum to 1\.0"):
        QueryCompilerOutput.model_validate(payload)


def test_clarification_question_invariant(config: TrainingConfig) -> None:
    payload = _first_example(config).output.model_dump(mode="json")
    payload["clarification_needed"] = True
    payload["clarification_question"] = None
    with pytest.raises(ValidationError, match="clarification_question is required"):
        QueryCompilerOutput.model_validate(payload)


def test_schema_rejects_undeclared_mental_axis(config: TrainingConfig) -> None:
    payload = json.loads(_first_example(config).output.model_dump_json())
    payload["mental_model_weights"]["safe_choice"] = 0.8
    with pytest.raises(ValidationError, match="Extra inputs are not permitted"):
        QueryCompilerOutput.model_validate(payload)


def test_json_schema_forbids_extra_top_level_fields() -> None:
    schema = QueryCompilerOutput.model_json_schema()
    assert schema["additionalProperties"] is False
    assert "opensearch" in schema["required"]


def test_committed_json_schema_matches_model(project_root: Path) -> None:
    committed = json.loads((project_root / "schemas" / "psg_query_compiler_v1.schema.json").read_text(encoding="utf-8"))
    assert committed == QueryCompilerOutput.model_json_schema()
