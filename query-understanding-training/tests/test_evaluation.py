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
                {"example_id": example.example_id, "output": example.output.model_dump(mode="json")},
                separators=(",", ":"),
            )
            + "\n"
            for example in examples
        ),
        encoding="utf-8",
    )
    report = evaluate_predictions(config.data.eval_file, predictions, policy)
    assert report.examples == 3
    assert report.predictions_found == 3
    assert report.json_validity == 1.0
    assert report.schema_validity == 1.0
    assert report.dsl_policy_validity == 1.0
    assert report.category_accuracy == 1.0
    assert report.query_type_accuracy == 1.0
    assert report.expertise_accuracy == 1.0
    assert report.resolution_accuracy == 1.0
