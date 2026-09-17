"""Deterministic local prediction generation for query-planner adapters."""

from __future__ import annotations

import json
from pathlib import Path

from query_understanding.config import TrainingConfig
from query_understanding.dataset import read_examples, to_prompt_completion
from query_understanding.policy import load_policy


def generate_predictions(
    config: TrainingConfig,
    output_path: Path,
    adapter_path: Path | None = None,
    batch_size: int = 8,
    max_new_tokens: int = 1024,
    limit: int | None = None,
) -> int:
    """Generate deterministic raw completions for the configured evaluation corpus.

    Raw model text is intentionally written without JSON repair. The structural
    evaluator should therefore reject Markdown fences, prose, and malformed
    request bodies exactly as OpenSearch would.
    """
    if batch_size < 1:
        raise ValueError("batch_size must be at least 1")
    if max_new_tokens < 1:
        raise ValueError("max_new_tokens must be at least 1")
    if limit is not None and limit < 1:
        raise ValueError("limit must be at least 1 when provided")

    import torch
    from peft import PeftModel
    from transformers import (
        AutoConfig,
        AutoModelForCausalLM,
        AutoModelForImageTextToText,
        AutoTokenizer,
        BitsAndBytesConfig,
    )

    mps = getattr(torch.backends, "mps", None)
    device = "cuda" if torch.cuda.is_available() else "mps" if mps and mps.is_available() else "cpu"
    if config.quantization.load_in_4bit and device != "cuda":
        raise RuntimeError("4-bit bitsandbytes quantization requires CUDA; use an unquantized profile on MPS or CPU")

    policy = load_policy(config.data.policy_file)
    examples = read_examples(config.data.eval_file, policy)
    if limit is not None:
        examples = examples[:limit]
    system_prompt = config.objective.system_prompt_file.read_text(encoding="utf-8").strip()
    user_prompt_template = config.objective.user_prompt_file.read_text(encoding="utf-8").strip()

    tokenizer = AutoTokenizer.from_pretrained(
        config.model.name_or_path,
        revision=config.model.revision,
        trust_remote_code=config.model.trust_remote_code,
    )
    if tokenizer.eos_token is None:
        raise RuntimeError("model tokenizer does not define an EOS token")
    tokenizer.pad_token = tokenizer.eos_token
    tokenizer.padding_side = "left"
    model_config = AutoConfig.from_pretrained(
        config.model.name_or_path,
        revision=config.model.revision,
        trust_remote_code=config.model.trust_remote_code,
    )
    model_loader = (
        AutoModelForImageTextToText
        if type(model_config) in AutoModelForImageTextToText._model_mapping
        else AutoModelForCausalLM
    )
    quantization_config = (
        BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type=config.quantization.quant_type,
            bnb_4bit_use_double_quant=config.quantization.use_double_quant,
            bnb_4bit_compute_dtype=getattr(torch, config.quantization.compute_dtype),
        )
        if config.quantization.load_in_4bit
        else None
    )
    model = model_loader.from_pretrained(
        config.model.name_or_path,
        config=model_config,
        revision=config.model.revision,
        dtype=getattr(torch, config.quantization.compute_dtype),
        trust_remote_code=config.model.trust_remote_code,
        device_map={"": 0 if device == "cuda" else device},
        quantization_config=quantization_config,
    )
    if adapter_path is not None:
        model = PeftModel.from_pretrained(model, str(adapter_path.resolve()))
    model.eval()

    rows = [
        (example.example_id, to_prompt_completion(example, system_prompt, user_prompt_template)["prompt"])
        for example in examples
    ]
    rendered: list[str] = []
    for start in range(0, len(rows), batch_size):
        batch = rows[start : start + batch_size]
        encoded = [
            tokenizer.apply_chat_template(prompt, tokenize=True, add_generation_prompt=True, return_dict=False)
            for _, prompt in batch
        ]
        model_inputs = tokenizer.pad(
            [{"input_ids": token_ids, "attention_mask": [1] * len(token_ids)} for token_ids in encoded],
            padding=True,
            return_tensors="pt",
        ).to(model.device)
        with torch.inference_mode():
            generated = model.generate(
                **model_inputs,
                do_sample=False,
                max_new_tokens=max_new_tokens,
                eos_token_id=tokenizer.eos_token_id,
                pad_token_id=tokenizer.pad_token_id,
            )
        prompt_width = model_inputs["input_ids"].shape[1]
        for (example_id, _), completion_ids in zip(batch, generated[:, prompt_width:], strict=True):
            completion = tokenizer.decode(completion_ids, skip_special_tokens=True)
            rendered.append(json.dumps({"example_id": example_id, "output": completion}, ensure_ascii=False) + "\n")
        print(f"generated {min(start + len(batch), len(rows))}/{len(rows)}", flush=True)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text("".join(rendered), encoding="utf-8")
    return len(rendered)
