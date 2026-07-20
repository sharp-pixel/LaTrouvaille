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
    assert train_report.total == 10
    assert eval_report.total == 10


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
    assert "Question: Normalized shopper request: Dress watch under 15000" in prompt[1]["content"]
    assert '"id":"watch-collector"' in prompt[1]["content"]
    assert (
        '"query_expansion":"dress watch reference provenance full set serviced collector steel"' in prompt[1]["content"]
    )
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
    assert decoded_completion["query"]["bool"]["should"][0]["multi_match"]["boost"] == 0.35


def test_canonical_json_is_stable() -> None:
    assert canonical_json({"z": 1, "a": {"b": 2}}) == '{"a":{"b":2},"z":1}'


def test_fixtures_use_canonical_persona_contexts(config: TrainingConfig, policy: CompilerPolicy) -> None:
    expected_expansions = {
        "first-luxury-purchase": "excellent condition very good condition verified timeless versatile value",
        "fashion-insider": "rare archive vintage runway editorial limited edition distinctive",
        "watch-collector": "dress watch reference provenance full set serviced collector steel",
    }
    seen_ids: set[str] = set()
    anonymous_examples = 0
    for path in (config.data.train_file, config.data.eval_file):
        for example in read_examples(path, policy):
            contract_line = example.input.query_text.splitlines()[1]
            contract = json.loads(contract_line.removeprefix("Immutable service contract: "))
            assert isinstance(contract["track_total_hits"], int)
            assert not isinstance(contract["track_total_hits"], bool)
            if contract["sort_mode"] == "recommended":
                assert "rank_features" not in contract
                assert list(contract) == [
                    "filter",
                    "size",
                    "track_total_hits",
                    "sort_mode",
                    "text_operator",
                    "base_text_query",
                    "persona",
                ]
            else:
                assert contract["rank_features"] is False
                assert list(contract) == [
                    "filter",
                    "size",
                    "track_total_hits",
                    "sort_mode",
                    "rank_features",
                    "text_operator",
                    "base_text_query",
                    "persona",
                ]
            persona = contract["persona"]
            persona_id = persona["id"]
            seen_ids.add(persona_id)
            bool_query = example.target_body.to_opensearch()["query"]["bool"]
            should = bool_query.get("should", [])
            if persona_id == "anonymous":
                anonymous_examples += 1
                assert persona == {"id": "anonymous", "version": 1, "mode": "unprofiled"}
                assert not should or "multi_match" not in should[0]
                continue
            assert persona["query_expansion"] == expected_expansions[persona_id]
            assert should[0]["multi_match"] == {
                "query": expected_expansions[persona_id],
                "fields": ["title^5", "brand^3", "canonical_text^3", "description"],
                "operator": "or",
                "boost": 0.35,
            }

    assert seen_ids == {"anonymous", *expected_expansions}
    assert anonymous_examples >= 5


def test_train_fixture_covers_each_sort_with_profiled_and_anonymous_personas(
    config: TrainingConfig,
    policy: CompilerPolicy,
) -> None:
    examples = read_examples(config.data.train_file, policy)
    combinations: set[tuple[str, bool]] = set()
    for example in examples:
        anonymous = '"persona":{"id":"anonymous","version":1,"mode":"unprofiled"}' in example.input.query_text
        combinations.add((example.expectations.sort_mode, not anonymous))
        if anonymous and example.expectations.sort_mode != "recommended":
            assert "should" not in example.target_body.to_opensearch()["query"]["bool"]

    assert combinations == {
        (sort_mode, profiled)
        for sort_mode in ("recommended", "lowest_price", "newest", "price_drop")
        for profiled in (False, True)
    }


def test_train_fixture_contains_persona_only_counterfactual(
    config: TrainingConfig,
    policy: CompilerPolicy,
) -> None:
    persona_ids_by_controls: dict[str, set[str]] = {}
    summaries_by_controls: dict[str, set[str]] = {}
    for example in read_examples(config.data.train_file, policy):
        lines = example.input.query_text.splitlines()
        contract = json.loads(lines[1].removeprefix("Immutable service contract: "))
        persona = contract.pop("persona")
        controls = canonical_json(contract)
        persona_ids_by_controls.setdefault(controls, set()).add(persona["id"])
        summaries_by_controls.setdefault(controls, set()).add(lines[0])

    assert any(
        len(persona_ids) >= 2 and len(summaries_by_controls[controls]) == 1
        for controls, persona_ids in persona_ids_by_controls.items()
    )


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
