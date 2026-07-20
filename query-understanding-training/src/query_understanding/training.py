"""LoRA/QLoRA training entrypoint for the text-only query compiler task."""

from __future__ import annotations

import platform
import sys
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Any

from query_understanding.config import TrainingConfig
from query_understanding.dataset import training_rows
from query_understanding.policy import load_policy
from query_understanding.provenance import write_run_manifest
from query_understanding.tokenization import CausalLMCollator, tokenize_rows


def environment_report(include_training_stack: bool = False) -> dict[str, object]:
    report: dict[str, object] = {
        "python": platform.python_version(),
        "platform": platform.platform(),
        "training_stack_requested": include_training_stack,
    }
    if not include_training_stack:
        return report

    packages = {}
    for package in ("torch", "transformers", "trl", "peft", "datasets", "accelerate", "bitsandbytes"):
        try:
            packages[package] = version(package)
        except PackageNotFoundError:
            packages[package] = "not-installed"
    report["packages"] = packages

    try:
        import torch
    except ImportError:
        report.update({"cuda_available": False, "ready": False, "error": "install the train dependency group"})
        return report

    cuda_available = torch.cuda.is_available()
    mps_available = bool(
        getattr(torch.backends, "mps", None)
        and torch.backends.mps.is_built()
        and torch.backends.mps.is_available()
    )
    backend = "cuda" if cuda_available else "mps" if mps_available else "cpu"
    required_packages = ("transformers", "trl", "peft", "datasets", "accelerate")
    stack_available = all(packages.get(package) != "not-installed" for package in required_packages)
    bf16_supported = bool(cuda_available and torch.cuda.is_bf16_supported())
    report.update(
        {
            "backend": backend,
            "cuda_available": cuda_available,
            "mps_available": mps_available,
            "torch_cuda": torch.version.cuda,
            "bf16_supported": bf16_supported,
            "device": (
                torch.cuda.get_device_name(0) if cuda_available else "Apple Silicon GPU" if mps_available else None
            ),
        }
    )
    report["ready"] = bool(
        stack_available
        and (
            (cuda_available and bf16_supported and packages.get("bitsandbytes") != "not-installed")
            or mps_available
        )
    )
    return report


def run_training(config: TrainingConfig, project_root: Path, resume_from_checkpoint: Path | None = None) -> Path:
    report = environment_report(include_training_stack=True)
    if not report.get("ready"):
        raise RuntimeError(f"training environment is not ready: {report}")

    import torch
    from datasets import Dataset
    from peft import LoraConfig, TaskType
    from transformers import AutoTokenizer, BitsAndBytesConfig
    from trl import SFTConfig, SFTTrainer

    policy = load_policy(config.data.policy_file)
    train_rows = training_rows(config.data.train_file, policy)
    eval_rows = training_rows(config.data.eval_file, policy)

    tokenizer = AutoTokenizer.from_pretrained(
        config.model.name_or_path,
        revision=config.model.revision,
        trust_remote_code=config.model.trust_remote_code,
    )
    if tokenizer.eos_token is None:
        raise RuntimeError("model tokenizer does not define an EOS token")
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
    tokenizer.padding_side = "right"

    tokenized_train = tokenize_rows(train_rows, tokenizer, config.trainer.sequence_length)
    tokenized_eval = tokenize_rows(eval_rows, tokenizer, config.trainer.sequence_length)
    train_dataset = Dataset.from_list(tokenized_train)
    eval_dataset = Dataset.from_list(tokenized_eval)

    backend = str(report["backend"])
    if config.quantization.load_in_4bit and backend != "cuda":
        raise RuntimeError("4-bit bitsandbytes quantization requires CUDA; use configs/lora-macos.yaml on macOS")
    quantization_config = (
        BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type=config.quantization.quant_type,
            bnb_4bit_use_double_quant=config.quantization.use_double_quant,
            bnb_4bit_compute_dtype=_torch_dtype(config.quantization.compute_dtype, torch),
        )
        if config.quantization.load_in_4bit
        else None
    )
    peft_config = LoraConfig(
        r=config.lora.rank,
        lora_alpha=config.lora.alpha,
        lora_dropout=config.lora.dropout,
        target_modules=config.lora.target_modules_regex,
        bias="none",
        task_type=TaskType.CAUSAL_LM,
    )
    args = SFTConfig(
        output_dir=str(config.trainer.output_dir),
        model_init_kwargs={
            "revision": config.model.revision,
            "dtype": _torch_dtype(config.quantization.compute_dtype, torch),
            "trust_remote_code": config.model.trust_remote_code,
            "use_cache": False,
            "device_map": {"": 0 if backend == "cuda" else backend},
        },
        per_device_train_batch_size=config.trainer.per_device_train_batch_size,
        per_device_eval_batch_size=config.trainer.per_device_eval_batch_size,
        gradient_accumulation_steps=config.trainer.gradient_accumulation_steps,
        gradient_checkpointing=config.trainer.gradient_checkpointing,
        learning_rate=config.trainer.learning_rate,
        lr_scheduler_type=config.trainer.lr_scheduler_type,
        warmup_ratio=config.trainer.warmup_ratio,
        num_train_epochs=config.trainer.num_train_epochs,
        max_grad_norm=config.trainer.max_grad_norm,
        optim=config.trainer.optim,
        logging_steps=config.trainer.logging_steps,
        save_strategy="steps",
        save_steps=config.trainer.save_steps,
        eval_strategy="steps",
        eval_steps=config.trainer.eval_steps,
        save_total_limit=config.trainer.save_total_limit,
        seed=config.trainer.seed,
        data_seed=config.trainer.seed,
        bf16=config.trainer.bf16,
        fp16=config.trainer.fp16,
        tf32=config.trainer.tf32,
        packing=config.trainer.packing,
        max_length=None,
        completion_only_loss=False,
        dataset_kwargs={"skip_prepare_dataset": True},
        remove_unused_columns=False,
        report_to=config.trainer.report_to,
    )
    trainer = SFTTrainer(
        model=config.model.name_or_path,
        args=args,
        train_dataset=train_dataset,
        eval_dataset=eval_dataset,
        processing_class=tokenizer,
        data_collator=CausalLMCollator(tokenizer),
        quantization_config=quantization_config,
        peft_config=peft_config,
    )
    _assert_language_model_only_trainables(trainer.model)
    write_run_manifest(config, project_root)
    trainer.train(resume_from_checkpoint=str(resume_from_checkpoint) if resume_from_checkpoint else None)
    trainer.save_model(str(config.trainer.output_dir / "adapter"))
    return config.trainer.output_dir


def _torch_dtype(name: str, torch_module: Any) -> Any:
    try:
        return getattr(torch_module, name)
    except AttributeError as error:
        raise ValueError(f"unsupported torch dtype: {name}") from error


def _assert_language_model_only_trainables(model: Any) -> None:
    trainable = [name for name, parameter in model.named_parameters() if parameter.requires_grad]
    if not trainable:
        raise RuntimeError("PEFT created no trainable parameters; check target_modules_regex")
    unexpected = [name for name in trainable if "language_model.model.layers." not in name]
    if unexpected:
        preview = ", ".join(unexpected[:10])
        raise RuntimeError(f"trainable parameters escaped the text backbone: {preview}")
    if any("vision_tower" in name or "multi_modal_projector" in name for name in trainable):
        raise RuntimeError("vision or multimodal projector parameters must remain frozen")


def require_supported_python() -> None:
    if not (sys.version_info.major == 3 and sys.version_info.minor in {11, 12}):
        raise RuntimeError("training requires Python 3.11 or 3.12")
