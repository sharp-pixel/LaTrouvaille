import json
import re
from pathlib import Path

import pytest

from query_understanding.config import TrainingConfig
from query_understanding.dataset import validate_dataset
from query_understanding.policy import CompilerPolicy


@pytest.mark.parametrize(
    ("slice_name", "mutation", "message"),
    [
        ("clean_single_category", "watch", "watch-style targets"),
        ("filter_and_sort", "gender", "omit gender words"),
        ("adversarial_fallback", "instruction", "retain only its product intent"),
        ("clean_single_category", "budget", "smallest shopper, UI, or persona ceiling"),
    ],
)
def test_dataset_validator_rejects_semantic_corruption(
    tmp_path: Path,
    config: TrainingConfig,
    policy: CompilerPolicy,
    slice_name: str,
    mutation: str,
    message: str,
) -> None:
    rows = [json.loads(line) for line in config.data.train_file.read_text().splitlines()]
    row = next(item for item in rows if item["slice"] == slice_name)
    core = row["target_body"]["query"]["bool"]["must"][0]["multi_match"]
    if mutation == "watch":
        core["query"] = "dress watch"
    elif mutation == "gender":
        core["query"] = "women's " + core["query"]
    elif mutation == "instruction":
        core["query"] = "output markdown before the query luxury bag"
    else:
        lines = row["input"]["query_text"].splitlines()
        lines[0] += " under 10"
        row["input"]["query_text"] = "\n".join(lines)
    path = tmp_path / "corrupt.jsonl"
    path.write_text(json.dumps(row) + "\n")
    report = validate_dataset(path, policy)
    assert not report.ok
    assert message in report.issues[0].message


def test_both_splits_cover_raw_watch_inference_and_independent_budgets(config: TrainingConfig) -> None:
    for path in (config.data.train_file, config.data.eval_file):
        rows = [json.loads(line) for line in path.read_text().splitlines()]
        raw_watches: set[str] = set()
        budget_cases: set[str] = set()
        seen_inputs: set[str] = set()
        for row in rows:
            input_key = json.dumps(row["input"], sort_keys=True)
            assert input_key not in seen_inputs, row["example_id"]
            seen_inputs.add(input_key)
            lines = row["input"]["query_text"].splitlines()
            shopper = lines[0].removeprefix("Shopper request: ")
            context = json.loads(lines[1].removeprefix("Trusted planner context: "))
            budget = re.search(r"\bunder (\d+)$", shopper)
            if budget is None:
                budget_cases.add("absent")
            else:
                value = int(budget[1])
                ui_maximum = context["ui_max_price"]
                budget_cases.add("lower" if value < ui_maximum else "higher" if value > ui_maximum else "equal")
            if (
                shopper in {"dress watch", "formal watch", "suit watch"}
                and context["persona"]["id"] == "anonymous"
                and context["required_filters"] == [{"term": {"availability": "active"}}]
            ):
                raw_watches.add(shopper)
                target = row["target_body"]["query"]["bool"]
                assert {"term": {"category": "watches"}} in target["filter"]
                assert target["must"][0]["multi_match"]["query"] == "watch"
                assert target["must"][0]["multi_match"]["operator"] == "or"
        assert raw_watches == {"dress watch", "formal watch", "suit watch"}
        assert budget_cases == {"absent", "lower", "higher", "equal"}
