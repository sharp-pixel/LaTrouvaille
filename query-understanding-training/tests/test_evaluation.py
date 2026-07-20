import json
from pathlib import Path

from query_understanding.config import TrainingConfig
from query_understanding.dataset import read_examples
from query_understanding.evaluation import evaluate_predictions
from query_understanding.policy import CompilerPolicy


def test_perfect_predictions_score_one(
    tmp_path: Path,
    config: TrainingConfig,
    policy: CompilerPolicy,
) -> None:
    examples = read_examples(config.data.eval_file, policy)
    predictions = tmp_path / "predictions.jsonl"
    predictions.write_text(
        "".join(
            json.dumps(
                {"example_id": example.example_id, "output": example.target_body.to_opensearch()},
                separators=(",", ":"),
            )
            + "\n"
            for example in examples
        ),
        encoding="utf-8",
    )
    report = evaluate_predictions(config.data.eval_file, predictions, policy)
    assert report.examples == 6
    assert report.predictions_found == 6
    assert report.json_validity == 1.0
    assert report.request_body_validity == 1.0
    assert report.dsl_policy_validity == 1.0
    assert report.exact_request_match == 1.0
    assert report.required_constraint_recall == 1.0


def test_missing_predictions_count_against_constraint_recall(
    tmp_path: Path,
    config: TrainingConfig,
    policy: CompilerPolicy,
) -> None:
    example = read_examples(config.data.eval_file, policy)[0]
    predictions = tmp_path / "predictions.jsonl"
    predictions.write_text(
        json.dumps({"example_id": example.example_id, "output": example.target_body.to_opensearch()}) + "\n",
        encoding="utf-8",
    )
    report = evaluate_predictions(config.data.eval_file, predictions, policy)
    assert report.required_constraint_recall < 1.0


def test_query_only_output_is_not_a_valid_request_body(
    tmp_path: Path,
    config: TrainingConfig,
    policy: CompilerPolicy,
) -> None:
    examples = read_examples(config.data.eval_file, policy)
    predictions = tmp_path / "predictions.jsonl"
    predictions.write_text(
        "".join(
            json.dumps({"example_id": example.example_id, "output": {"query": {"match_all": {}}}}) + "\n"
            for example in examples
        ),
        encoding="utf-8",
    )
    report = evaluate_predictions(config.data.eval_file, predictions, policy)
    assert report.request_body_validity == 0.0


def test_exact_match_uses_original_decoded_json(
    tmp_path: Path,
    config: TrainingConfig,
    policy: CompilerPolicy,
) -> None:
    examples = read_examples(config.data.eval_file, policy)
    predictions = tmp_path / "predictions.jsonl"
    rows: list[str] = []
    normalized_away_nulls = 0
    for example in examples:
        output = example.target_body.to_opensearch()
        if "sort" not in output:
            output["sort"] = None
            normalized_away_nulls += 1
        rows.append(json.dumps({"example_id": example.example_id, "output": output}) + "\n")
    predictions.write_text("".join(rows), encoding="utf-8")

    report = evaluate_predictions(config.data.eval_file, predictions, policy)

    assert report.request_body_validity == 1.0
    assert report.dsl_policy_validity == 1.0
    assert report.exact_request_match == round((len(examples) - normalized_away_nulls) / len(examples), 6)
