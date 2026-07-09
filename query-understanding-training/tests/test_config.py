import re
from pathlib import Path

from query_understanding.config import TrainingConfig


def test_config_resolves_paths_and_pins_model(config: TrainingConfig) -> None:
    assert config.model.name_or_path == "mistralai/Ministral-3-8B-Instruct-2512-BF16"
    assert config.model.revision == "06cc81bfd6e45321d8fc8f816576c5b6ac67ec22"
    assert config.data.train_file.is_absolute()
    assert config.data.eval_file.is_absolute()
    assert config.data.policy_file.is_absolute()
    assert config.trainer.output_dir.is_absolute()


def test_config_uses_documented_qlora_baseline(config: TrainingConfig) -> None:
    assert config.quantization.load_in_4bit is True
    assert config.quantization.quant_type == "nf4"
    assert config.quantization.compute_dtype == "bfloat16"
    assert config.trainer.sequence_length == 2048
    assert config.trainer.gradient_accumulation_steps == 16
    assert config.lora.rank == 16
    assert config.lora.alpha == 32
    assert "language_model" in config.lora.target_modules_regex
    assert "vision_tower" not in config.lora.target_modules_regex


def test_lora_regex_targets_text_backbone_only(config: TrainingConfig) -> None:
    target = re.compile(config.lora.target_modules_regex)
    assert target.fullmatch("language_model.model.layers.0.self_attn.q_proj")
    assert target.fullmatch("language_model.model.layers.33.mlp.down_proj")
    assert not target.fullmatch("vision_tower.transformer.layers.0.attention.q_proj")
    assert not target.fullmatch("multi_modal_projector.linear_1")


def test_fixture_paths_exist(config: TrainingConfig) -> None:
    paths: tuple[Path, ...] = (config.data.train_file, config.data.eval_file, config.data.policy_file)
    assert all(path.exists() for path in paths)
