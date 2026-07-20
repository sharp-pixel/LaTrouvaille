import json
from copy import deepcopy
from pathlib import Path

import pytest

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
    assert report.examples == 10
    assert report.predictions_found == 10
    assert report.json_validity == 1.0
    assert report.request_body_validity == 1.0
    assert report.dsl_policy_validity == 1.0
    assert report.exact_request_match == 1.0
    assert report.persona_clause_exact_match == 1.0
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
    assert report.persona_clause_exact_match == 0.0


def test_persona_clause_metric_is_independent_from_required_filters(
    tmp_path: Path,
    config: TrainingConfig,
    policy: CompilerPolicy,
) -> None:
    examples = read_examples(config.data.eval_file, policy)
    predictions = tmp_path / "predictions.jsonl"
    rows: list[str] = []
    mutated = 0
    for example in examples:
        output = example.target_body.to_opensearch()
        bool_query = output["query"]["bool"]
        should = bool_query.get("should", [])
        if should and "multi_match" in should[0]:
            should[0]["multi_match"]["query"] = "wrong persona expansion"
            mutated += 1
        rows.append(json.dumps({"example_id": example.example_id, "output": output}) + "\n")
    predictions.write_text("".join(rows), encoding="utf-8")

    report = evaluate_predictions(config.data.eval_file, predictions, policy)

    assert mutated > 0
    assert report.required_constraint_recall == 1.0
    assert report.persona_clause_exact_match < 1.0
    assert report.dsl_policy_validity < 1.0


def test_persona_clause_metric_rejects_persona_after_rank_feature(
    tmp_path: Path,
    config: TrainingConfig,
    policy: CompilerPolicy,
) -> None:
    examples = read_examples(config.data.eval_file, policy)
    predictions = tmp_path / "predictions.jsonl"
    rows: list[str] = []
    reordered = 0
    for example in examples:
        output = example.target_body.to_opensearch()
        should = output["query"]["bool"].get("should", [])
        if reordered == 0 and len(should) > 1 and "multi_match" in should[0]:
            should[0], should[1] = should[1], should[0]
            reordered += 1
        rows.append(json.dumps({"example_id": example.example_id, "output": output}) + "\n")
    predictions.write_text("".join(rows), encoding="utf-8")

    report = evaluate_predictions(config.data.eval_file, predictions, policy)

    assert reordered == 1
    assert report.request_body_validity == 1.0
    assert report.persona_clause_exact_match == 0.9
    assert report.dsl_policy_validity == 0.9


@pytest.mark.parametrize("leak_target", ("must", "filter"))
def test_persona_clause_metric_rejects_persona_leaking_into_required_clauses(
    leak_target: str,
    tmp_path: Path,
    config: TrainingConfig,
    policy: CompilerPolicy,
) -> None:
    examples = read_examples(config.data.eval_file, policy)
    predictions = tmp_path / f"predictions-{leak_target}.jsonl"
    rows: list[str] = []
    leaked = 0
    for example in examples:
        output = example.target_body.to_opensearch()
        bool_query = output["query"]["bool"]
        should = bool_query.get("should", [])
        if leaked == 0 and should and "multi_match" in should[0]:
            bool_query[leak_target].append(deepcopy(should[0]))
            leaked += 1
        rows.append(json.dumps({"example_id": example.example_id, "output": output}) + "\n")
    predictions.write_text("".join(rows), encoding="utf-8")

    report = evaluate_predictions(config.data.eval_file, predictions, policy)

    assert leaked == 1
    assert report.request_body_validity == 1.0
    assert report.persona_clause_exact_match == 0.9
    assert report.dsl_policy_validity == 0.9


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
    expected_presence_sensitive_score = round((len(examples) - normalized_away_nulls) / len(examples), 6)
    assert report.dsl_policy_validity == expected_presence_sensitive_score
    assert report.exact_request_match == expected_presence_sensitive_score
