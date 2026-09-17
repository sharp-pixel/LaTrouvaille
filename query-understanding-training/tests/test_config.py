import re
import tomllib
from pathlib import Path

from query_understanding import __version__
from query_understanding.config import TrainingConfig, load_training_config


def test_module_version_matches_package_metadata(project_root: Path) -> None:
    package_metadata = tomllib.loads((project_root / "pyproject.toml").read_text(encoding="utf-8"))
    assert __version__ == package_metadata["project"]["version"]


def test_config_resolves_paths_and_pins_model(config: TrainingConfig) -> None:
    assert config.model.name_or_path == "mistralai/Ministral-3-8B-Instruct-2512-BF16"
    assert config.model.revision == "06cc81bfd6e45321d8fc8f816576c5b6ac67ec22"
    assert config.data.train_file.is_absolute()
    assert config.data.eval_file.is_absolute()
    assert config.data.policy_file.is_absolute()
    assert config.objective.name == "opensearch_agentic_query_planner_v3"
    assert config.objective.system_prompt_file.is_absolute()
    assert config.objective.system_prompt_file.exists()
    assert config.objective.user_prompt_file.is_absolute()
    assert config.objective.user_prompt_file.exists()
    assert config.trainer.output_dir.is_absolute()
    assert config.trainer.output_dir.name == "qlora-agentic-v3"


def test_config_uses_documented_qlora_baseline(config: TrainingConfig) -> None:
    assert config.quantization.load_in_4bit is True
    assert config.quantization.quant_type == "nf4"
    assert config.quantization.compute_dtype == "bfloat16"
    assert config.trainer.sequence_length == 2112
    assert config.trainer.gradient_accumulation_steps == 16
    assert config.trainer.max_steps == -1
    assert config.lora.rank == 16
    assert config.lora.alpha == 32
    assert "language_model" in config.lora.target_modules_regex
    assert "vision_tower" not in config.lora.target_modules_regex


def test_lora_regex_targets_text_backbone_only(config: TrainingConfig) -> None:
    target = re.compile(config.lora.target_modules_regex)
    assert target.fullmatch("model.language_model.layers.0.self_attn.q_proj")
    assert target.fullmatch("model.language_model.layers.33.mlp.down_proj")
    assert not target.fullmatch("vision_tower.transformer.layers.0.attention.q_proj")
    assert not target.fullmatch("multi_modal_projector.linear_1")


def test_fixture_paths_exist(config: TrainingConfig) -> None:
    paths: tuple[Path, ...] = (
        config.data.train_file,
        config.data.eval_file,
        config.data.policy_file,
        config.objective.system_prompt_file,
        config.objective.user_prompt_file,
    )
    assert all(path.exists() for path in paths)


def test_sagemaker_configs_use_smoke_then_full_training(project_root: Path) -> None:
    smoke = load_training_config(project_root / "configs" / "qlora-sagemaker-smoke.yaml")
    full = load_training_config(project_root / "configs" / "qlora-sagemaker.yaml")

    assert smoke.trainer.max_steps == 2
    assert smoke.trainer.gradient_accumulation_steps == 2
    assert str(smoke.trainer.output_dir).startswith("/opt/ml/model/")
    assert full.trainer.max_steps == -1
    assert full.trainer.gradient_accumulation_steps == 16
    assert full.trainer.num_train_epochs == 2
    assert str(full.trainer.output_dir).startswith("/opt/ml/model/")


def test_macos_config_uses_native_mps_compatible_lora(project_root: Path) -> None:
    config = load_training_config(project_root / "configs" / "lora-macos.yaml")

    assert config.quantization.load_in_4bit is False
    assert config.quantization.compute_dtype == "float16"
    assert config.trainer.optim == "adamw_torch"
    assert config.trainer.sequence_length == 2112
    assert config.trainer.bf16 is False
    assert config.trainer.fp16 is True
    assert config.trainer.tf32 is False
    assert config.trainer.output_dir.name == "lora-macos-agentic-v3"
