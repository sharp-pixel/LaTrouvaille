import json
import sys
from contextlib import nullcontext
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from query_understanding import inference
from query_understanding.config import load_training_config


@pytest.fixture
def inference_stack(monkeypatch):
    class TextConfig:
        pass

    class MultimodalConfig:
        pass

    tokenizer = Mock(eos_token="</s>", eos_token_id=2)
    tokenizer.apply_chat_template.return_value = [11, 12]
    tokenizer.decode.return_value = '{"size":24}'
    inputs = Mock()
    inputs.to.return_value = {"input_ids": SimpleNamespace(shape=(1, 2)), "attention_mask": [1, 1]}
    tokenizer.pad.return_value = inputs

    # Only the continuation slice is needed; no tensor or accelerator allocation.
    class Generated:
        def __getitem__(self, key):
            assert key == (slice(None), slice(2, None))
            return [[31, 2]]

    model = Mock(device="test-device")
    model.generate.return_value = Generated()
    multimodal_loader = Mock(_model_mapping={MultimodalConfig: object})
    text_loader = Mock(_model_mapping={TextConfig: object})
    multimodal_loader.from_pretrained.return_value = model
    text_loader.from_pretrained.return_value = model
    auto_config = Mock()
    auto_config.from_pretrained.side_effect = lambda name, **kwargs: (
        TextConfig() if "Qwen" in name else MultimodalConfig()
    )
    quantizer = Mock(side_effect=lambda **kwargs: kwargs)
    torch = SimpleNamespace(
        cuda=SimpleNamespace(is_available=lambda: True),
        backends=SimpleNamespace(mps=SimpleNamespace(is_available=lambda: False)),
        bfloat16="bf16",
        float16="fp16",
        float32="fp32",
        inference_mode=nullcontext,
    )
    peft = Mock()
    peft.from_pretrained.return_value = model
    monkeypatch.setitem(sys.modules, "torch", torch)
    monkeypatch.setitem(sys.modules, "peft", SimpleNamespace(PeftModel=peft))
    monkeypatch.setitem(
        sys.modules,
        "transformers",
        SimpleNamespace(
            AutoConfig=auto_config,
            AutoModelForCausalLM=text_loader,
            AutoModelForImageTextToText=multimodal_loader,
            AutoTokenizer=SimpleNamespace(from_pretrained=Mock(return_value=tokenizer)),
            BitsAndBytesConfig=quantizer,
        ),
    )
    monkeypatch.setattr(inference, "read_examples", lambda *_: [SimpleNamespace(example_id="fixture")])
    monkeypatch.setattr(
        inference,
        "to_prompt_completion",
        lambda *_: {
            "prompt": [{"role": "user", "content": "bags"}],
        },
    )
    return SimpleNamespace(
        torch=torch,
        multimodal=multimodal_loader,
        text=text_loader,
        quantizer=quantizer,
        tokenizer=tokenizer,
        peft=peft,
        model=model,
    )


@pytest.mark.parametrize(
    "profile,loader",
    [
        ("qlora-5090.yaml", "multimodal"),
        ("qlora-qwen3-sagemaker.yaml", "text"),
    ],
)
def test_prediction_generation_selects_model_architecture(project_root, tmp_path, inference_stack, profile, loader):
    config = load_training_config(project_root / "configs" / profile)
    output = tmp_path / "predictions.jsonl"
    assert inference.generate_predictions(config, output, adapter_path=tmp_path / "adapter") == 1
    selected = getattr(inference_stack, loader).from_pretrained
    selected.assert_called_once()
    assert selected.call_args.args == (config.model.name_or_path,)
    assert selected.call_args.kwargs["revision"] == config.model.revision
    assert json.loads(output.read_text()) == {"example_id": "fixture", "output": '{"size":24}'}
    inference_stack.peft.from_pretrained.assert_called_once()
    assert inference_stack.model.generate.call_args.kwargs["do_sample"] is False


@pytest.mark.parametrize("backend", ["mps", "cpu"])
def test_unquantized_inference_honors_backend_without_bitsandbytes(project_root, tmp_path, inference_stack, backend):
    config = load_training_config(project_root / "configs" / "lora-macos.yaml")
    inference_stack.torch.cuda.is_available = lambda: False
    inference_stack.torch.backends.mps.is_available = lambda: backend == "mps"
    inference.generate_predictions(config, tmp_path / "out.jsonl")
    kwargs = inference_stack.multimodal.from_pretrained.call_args.kwargs
    assert kwargs["device_map"] == {"": backend}
    assert kwargs["quantization_config"] is None
    assert kwargs["dtype"] == "fp16"
    inference_stack.quantizer.assert_not_called()


def test_four_bit_inference_rejects_missing_cuda_before_loading_weights(config, tmp_path, inference_stack):
    inference_stack.torch.cuda.is_available = lambda: False
    with pytest.raises(RuntimeError, match=r"4-bit.*CUDA"):
        inference.generate_predictions(config, tmp_path / "out.jsonl")
    inference_stack.multimodal.from_pretrained.assert_not_called()
    inference_stack.quantizer.assert_not_called()


@pytest.mark.parametrize("arguments", [{"batch_size": 0}, {"max_new_tokens": 0}, {"limit": 0}])
def test_invalid_generation_limits_fail_before_loading_models(config, tmp_path, inference_stack, arguments):
    with pytest.raises(ValueError):
        inference.generate_predictions(config, tmp_path / "out.jsonl", **arguments)
    inference_stack.multimodal.from_pretrained.assert_not_called()
