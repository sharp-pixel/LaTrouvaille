import pytest

from query_understanding.tokenization import ExampleTooLongError, tokenize_prompt_completion


class FakeTokenizer:
    eos_token_id = 2

    def apply_chat_template(
        self,
        messages: list[dict[str, str]],
        *,
        tokenize: bool,
        add_generation_prompt: bool,
        return_dict: bool,
        continue_final_message: bool = False,
    ) -> list[int]:
        assert tokenize is True
        assert return_dict is False
        del add_generation_prompt
        del continue_final_message
        rendered = "".join(f"<{message['role']}>{message['content']}" for message in messages)
        return list(rendered.encode("utf-8"))


def _row() -> dict[str, object]:
    return {
        "prompt": [
            {"role": "system", "content": "JSON only"},
            {"role": "user", "content": '{"raw_query":"dress watch"}'},
        ],
        "completion": [{"role": "assistant", "content": '{"category":"watch"}'}],
    }


def test_tokenization_masks_prompt_and_keeps_completion() -> None:
    tokenized = tokenize_prompt_completion(_row(), FakeTokenizer(), max_length=512)
    first_label = next(index for index, label in enumerate(tokenized["labels"]) if label != -100)
    assert tokenized["labels"][:first_label] == [-100] * first_label
    assert tokenized["labels"][first_label:] == tokenized["input_ids"][first_label:]
    assert tokenized["attention_mask"] == [1] * len(tokenized["input_ids"])
    assert tokenized["input_ids"][-1] == FakeTokenizer.eos_token_id


def test_tokenization_rejects_instead_of_truncating_json() -> None:
    with pytest.raises(ExampleTooLongError, match="sequence_length"):
        tokenize_prompt_completion(_row(), FakeTokenizer(), max_length=10)
