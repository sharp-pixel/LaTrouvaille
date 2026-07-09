import inspect

import pytest


def test_pinned_training_stack_exposes_required_apis() -> None:
    peft = pytest.importorskip("peft")
    transformers = pytest.importorskip("transformers")
    trl = pytest.importorskip("trl")

    trainer_parameters = inspect.signature(trl.SFTTrainer).parameters
    assert {"quantization_config", "peft_config", "processing_class", "data_collator"} <= set(trainer_parameters)

    config_parameters = inspect.signature(trl.SFTConfig).parameters
    assert {
        "completion_only_loss",
        "dataset_kwargs",
        "eval_strategy",
        "max_length",
        "model_init_kwargs",
        "packing",
    } <= set(config_parameters)

    assert hasattr(transformers, "AutoTokenizer")
    assert hasattr(transformers, "BitsAndBytesConfig")
    lora = peft.LoraConfig(target_modules=r"^language_model\..*$")
    assert lora.target_modules == r"^language_model\..*$"
