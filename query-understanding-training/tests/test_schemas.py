import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from query_understanding.config import TrainingConfig
from query_understanding.schemas import AgenticRequestBody, TrainingExample


def _first_example(config: TrainingConfig) -> TrainingExample:
    line = config.data.train_file.read_text(encoding="utf-8").splitlines()[0]
    return TrainingExample.model_validate_json(line)


def test_training_fixture_satisfies_contract(config: TrainingConfig) -> None:
    example = _first_example(config)
    assert "Shopper request: Dress watch under 15000" in example.input.query_text
    assert example.objective_version == "opensearch_agentic_query_planner_v3"
    assert example.target_body.size == 24
    assert "_source" not in example.target_body.to_opensearch()
    assert "_doc" in example.input.index_mapping


def test_target_rejects_service_owned_source(config: TrainingConfig) -> None:
    payload = json.loads(_first_example(config).model_dump_json())
    payload["target_body"]["_source"] = ["item_id"]
    with pytest.raises(ValidationError, match="Extra inputs are not permitted"):
        TrainingExample.model_validate(payload)


@pytest.mark.parametrize(("field", "value"), (("size", "24"), ("track_total_hits", "10000")))
def test_request_body_rejects_coerced_scalar_types(
    field: str,
    value: str,
    config: TrainingConfig,
) -> None:
    payload = _first_example(config).target_body.to_opensearch()
    payload[field] = value
    with pytest.raises(ValidationError):
        AgenticRequestBody.model_validate(payload)


def test_target_requires_exact_result_size(config: TrainingConfig) -> None:
    payload = json.loads(_first_example(config).model_dump_json())
    payload["target_body"]["size"] -= 1
    with pytest.raises(ValidationError, match=r"expectations\.result_size"):
        TrainingExample.model_validate(payload)


@pytest.mark.parametrize("value", (True, False))
def test_target_rejects_boolean_total_hits(value: bool, config: TrainingConfig) -> None:
    payload = json.loads(_first_example(config).model_dump_json())
    payload["expectations"]["track_total_hits"] = value
    payload["target_body"]["track_total_hits"] = value
    with pytest.raises(ValidationError, match="track_total_hits"):
        TrainingExample.model_validate(payload)


def test_native_query_text_limit_is_enforced(config: TrainingConfig) -> None:
    payload = json.loads(_first_example(config).model_dump_json())
    payload["input"]["query_text"] = "x" * 1001
    with pytest.raises(ValidationError, match="at most 1000 characters"):
        TrainingExample.model_validate(payload)


def test_json_schema_forbids_extra_top_level_fields() -> None:
    schema = TrainingExample.model_json_schema()
    assert schema["additionalProperties"] is False
    assert "target_body" in schema["required"]


def test_committed_json_schema_matches_model(project_root: Path) -> None:
    committed = json.loads(
        (project_root / "schemas" / "opensearch_agentic_query_planner_v3.schema.json").read_text(encoding="utf-8")
    )
    assert committed == TrainingExample.model_json_schema()
