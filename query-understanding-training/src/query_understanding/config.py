"""Training configuration loading and path resolution."""

from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path

import yaml
from pydantic import BaseModel, ConfigDict, Field


class ConfigModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ModelSettings(ConfigModel):
    name_or_path: str
    revision: str = Field(min_length=7)
    trust_remote_code: bool = False


class DataSettings(ConfigModel):
    train_file: Path
    eval_file: Path
    policy_file: Path


class QuantizationSettings(ConfigModel):
    load_in_4bit: bool = True
    quant_type: str = "nf4"
    use_double_quant: bool = True
    compute_dtype: str = "bfloat16"


class LoraSettings(ConfigModel):
    rank: int = Field(default=16, ge=1)
    alpha: int = Field(default=32, ge=1)
    dropout: float = Field(default=0.05, ge=0, lt=1)
    target_modules_regex: str = Field(min_length=1)


class TrainerSettings(ConfigModel):
    output_dir: Path
    sequence_length: int = Field(default=2_048, ge=256)
    per_device_train_batch_size: int = Field(default=1, ge=1)
    per_device_eval_batch_size: int = Field(default=1, ge=1)
    gradient_accumulation_steps: int = Field(default=16, ge=1)
    gradient_checkpointing: bool = True
    learning_rate: float = Field(default=1e-4, gt=0)
    lr_scheduler_type: str = "cosine"
    warmup_ratio: float = Field(default=0.03, ge=0, lt=1)
    num_train_epochs: float = Field(default=2.0, gt=0)
    max_grad_norm: float = Field(default=0.3, gt=0)
    optim: str = "paged_adamw_8bit"
    logging_steps: int = Field(default=10, ge=1)
    save_steps: int = Field(default=250, ge=1)
    eval_steps: int = Field(default=250, ge=1)
    save_total_limit: int = Field(default=2, ge=1)
    seed: int = 42
    bf16: bool = True
    fp16: bool = False
    tf32: bool = True
    packing: bool = False
    report_to: list[str] = Field(default_factory=list)


class TrainingConfig(ConfigModel):
    model: ModelSettings
    data: DataSettings
    quantization: QuantizationSettings
    lora: LoraSettings
    trainer: TrainerSettings


def load_training_config(path: Path) -> TrainingConfig:
    config_path = path.resolve()
    raw = yaml.safe_load(config_path.read_text(encoding="utf-8"))
    if not isinstance(raw, Mapping):
        raise ValueError(f"training config must be a YAML object: {path}")
    config = TrainingConfig.model_validate(raw)
    base = config_path.parent
    return config.model_copy(
        update={
            "data": config.data.model_copy(
                update={
                    "train_file": _resolve(config.data.train_file, base),
                    "eval_file": _resolve(config.data.eval_file, base),
                    "policy_file": _resolve(config.data.policy_file, base),
                }
            ),
            "trainer": config.trainer.model_copy(update={"output_dir": _resolve(config.trainer.output_dir, base)}),
        }
    )


def _resolve(path: Path, base: Path) -> Path:
    return path if path.is_absolute() else (base / path).resolve()
