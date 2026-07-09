"""Text-only chat tokenization with explicit assistant-label masking."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, cast


class ExampleTooLongError(ValueError):
    """Raised instead of truncating a target JSON object."""


def tokenize_prompt_completion(
    row: dict[str, object],
    tokenizer: Any,
    max_length: int,
) -> dict[str, list[int]]:
    prompt = row["prompt"]
    completion = row["completion"]
    if not isinstance(prompt, list) or not isinstance(completion, list):
        raise TypeError("prompt and completion must be message lists")

    prompt_ids = _token_ids(
        tokenizer.apply_chat_template(
            prompt,
            tokenize=True,
            add_generation_prompt=True,
            return_dict=False,
        )
    )
    full_ids = _token_ids(
        tokenizer.apply_chat_template(
            prompt + completion,
            tokenize=True,
            add_generation_prompt=False,
            continue_final_message=True,
            return_dict=False,
        )
    )
    eos_token_id = getattr(tokenizer, "eos_token_id", None)
    if not isinstance(eos_token_id, int):
        raise ValueError("tokenizer must define an integer eos_token_id")
    if not full_ids or full_ids[-1] != eos_token_id:
        full_ids.append(eos_token_id)
    if full_ids[: len(prompt_ids)] != prompt_ids:
        raise ValueError("chat template does not preserve the prompt as a prefix of the completed conversation")
    if len(full_ids) > max_length:
        raise ExampleTooLongError(
            f"tokenized example has {len(full_ids)} tokens; configured sequence_length is {max_length}"
        )
    if len(full_ids) == len(prompt_ids):
        raise ValueError("assistant completion produced no trainable tokens")

    return {
        "input_ids": full_ids,
        "attention_mask": [1] * len(full_ids),
        "labels": [-100] * len(prompt_ids) + full_ids[len(prompt_ids) :],
    }


def tokenize_rows(
    rows: list[dict[str, object]],
    tokenizer: Any,
    max_length: int,
) -> list[dict[str, list[int]]]:
    return [tokenize_prompt_completion(row, tokenizer, max_length) for row in rows]


def _token_ids(value: object) -> list[int]:
    if not isinstance(value, list) or not all(isinstance(token, int) for token in value):
        raise TypeError("chat template must return a list of token IDs")
    return value


@dataclass
class CausalLMCollator:
    """Pad pre-tokenized causal-LM examples without altering their labels."""

    tokenizer: Any
    pad_to_multiple_of: int = 8

    def __call__(self, features: list[dict[str, list[int]]]) -> dict[str, Any]:
        import torch

        if getattr(self.tokenizer, "padding_side", "right") != "right":
            raise ValueError("CausalLMCollator requires right padding")
        model_inputs = [
            {"input_ids": feature["input_ids"], "attention_mask": feature["attention_mask"]} for feature in features
        ]
        batch = cast(
            dict[str, Any],
            self.tokenizer.pad(
                model_inputs,
                padding=True,
                pad_to_multiple_of=self.pad_to_multiple_of,
                return_tensors="pt",
            ),
        )
        width = int(batch["input_ids"].shape[1])
        padded_labels = [feature["labels"] + [-100] * (width - len(feature["labels"])) for feature in features]
        batch["labels"] = torch.tensor(padded_labels, dtype=torch.long)
        return batch
