import json
from pathlib import Path

from query_understanding.config import TrainingConfig
from query_understanding.dataset import canonical_json, read_examples, to_prompt_completion, validate_dataset
from query_understanding.policy import CompilerPolicy


def test_checked_in_datasets_validate(config: TrainingConfig, policy: CompilerPolicy) -> None:
    train_report = validate_dataset(config.data.train_file, policy)
    eval_report = validate_dataset(config.data.eval_file, policy)
    assert train_report.ok, train_report.issues
    assert eval_report.ok, eval_report.issues
    assert train_report.total == 6
    assert eval_report.total == 6


def test_source_row_becomes_completion_only_conversation(config: TrainingConfig, policy: CompilerPolicy) -> None:
    example = read_examples(config.data.train_file, policy)[0]
    row = to_prompt_completion(example)
    prompt = row["prompt"]
    completion = row["completion"]
    assert isinstance(prompt, list)
    assert isinstance(completion, list)
    assert prompt[0]["role"] == "system"
    assert prompt[1]["role"] == "user"
    assert completion[0]["role"] == "assistant"
    assert "Question: Shopper request: dress watch." in prompt[1]["content"]
    user_content = prompt[1]["content"]
    assert isinstance(user_content, str)
    mapping_line = next(line for line in user_content.splitlines() if line.startswith("Mapping JSON string: "))
    fields_line = next(line for line in user_content.splitlines() if line.startswith("Query Fields JSON string: "))
    mapping_json = json.loads(mapping_line.removeprefix("Mapping JSON string: "))
    fields_json = json.loads(fields_line.removeprefix("Query Fields JSON string: "))
    assert json.loads(mapping_json) == example.input.index_mapping
    assert json.loads(fields_json) == example.input.query_fields
    assert mapping_line.startswith('Mapping JSON string: "{\\"_doc\\"')
    decoded_completion = json.loads(completion[0]["content"])
    assert decoded_completion == example.target_body.to_opensearch()
    assert "schema_version" not in decoded_completion
    assert "opensearch" not in decoded_completion


def test_canonical_json_is_stable() -> None:
    assert canonical_json({"z": 1, "a": {"b": 2}}) == '{"a":{"b":2},"z":1}'


def test_duplicate_ids_are_rejected(
    tmp_path: Path,
    config: TrainingConfig,
    policy: CompilerPolicy,
) -> None:
    first = config.data.train_file.read_text(encoding="utf-8").splitlines()[0]
    duplicate_file = tmp_path / "duplicate.jsonl"
    duplicate_file.write_text(f"{first}\n{first}\n", encoding="utf-8")
    report = validate_dataset(duplicate_file, policy)
    assert report.ok is False
    assert report.total == 2
    assert report.valid == 1
    assert "duplicate example_id" in report.issues[0].message
