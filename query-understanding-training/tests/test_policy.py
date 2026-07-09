import pytest

from query_understanding.config import TrainingConfig
from query_understanding.dataset import read_examples
from query_understanding.policy import CompilerPolicy, PolicyViolation, validate_compiler_output
from query_understanding.schemas import QueryCompilerOutput


def _example(config: TrainingConfig, policy: CompilerPolicy):
    return read_examples(config.data.train_file, policy)[0]


def test_valid_fixture_passes_policy(config: TrainingConfig, policy: CompilerPolicy) -> None:
    example = _example(config, policy)
    validate_compiler_output(example.input, example.output, policy)


def test_policy_rejects_oversized_request(config: TrainingConfig, policy: CompilerPolicy) -> None:
    example = _example(config, policy)
    payload = example.output.model_dump(mode="json")
    payload["opensearch"]["body"]["size"] = policy.max_size + 1
    output = QueryCompilerOutput.model_validate(payload)
    with pytest.raises(PolicyViolation, match=r"body\.size"):
        validate_compiler_output(example.input, output, policy)


def test_policy_rejects_scripts(config: TrainingConfig, policy: CompilerPolicy) -> None:
    example = _example(config, policy)
    payload = example.output.model_dump(mode="json")
    payload["opensearch"]["body"]["query"] = {
        "script_score": {
            "query": {"match": {"title": "dress watch"}},
            "script": {"source": "_score * 100"},
        }
    }
    output = QueryCompilerOutput.model_validate(payload)
    with pytest.raises(PolicyViolation, match="forbidden DSL key"):
        validate_compiler_output(example.input, output, policy)


def test_policy_rejects_invented_fields(config: TrainingConfig, policy: CompilerPolicy) -> None:
    example = _example(config, policy)
    payload = example.output.model_dump(mode="json")
    payload["opensearch"]["body"]["query"] = {"term": {"private_margin": "high"}}
    output = QueryCompilerOutput.model_validate(payload)
    with pytest.raises(PolicyViolation, match="private_margin"):
        validate_compiler_output(example.input, output, policy)
