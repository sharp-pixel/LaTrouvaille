"""Reproducibility metadata for adapter runs."""

from __future__ import annotations

import hashlib
import json
import subprocess
from datetime import UTC, datetime
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path

from query_understanding.config import TrainingConfig
from query_understanding.schemas import SCHEMA_VERSION

TRACKED_PACKAGES = (
    "accelerate",
    "bitsandbytes",
    "datasets",
    "peft",
    "torch",
    "transformers",
    "trl",
)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def build_run_manifest(config: TrainingConfig, project_root: Path) -> dict[str, object]:
    lockfile = project_root / "uv.lock"
    return {
        "created_at": datetime.now(UTC).isoformat(),
        "objective_version": config.objective.name,
        "schema_version": SCHEMA_VERSION,
        "model": {
            "name_or_path": config.model.name_or_path,
            "revision": config.model.revision,
        },
        "datasets": {
            "train": {"path": str(config.data.train_file), "sha256": sha256_file(config.data.train_file)},
            "eval": {"path": str(config.data.eval_file), "sha256": sha256_file(config.data.eval_file)},
        },
        "policy": {"path": str(config.data.policy_file), "sha256": sha256_file(config.data.policy_file)},
        "system_prompt": {
            "path": str(config.objective.system_prompt_file),
            "sha256": sha256_file(config.objective.system_prompt_file),
        },
        "user_prompt": {
            "path": str(config.objective.user_prompt_file),
            "sha256": sha256_file(config.objective.user_prompt_file),
        },
        "uv_lock_sha256": sha256_file(lockfile) if lockfile.exists() else None,
        "git_commit": _git_commit(project_root),
        "packages": _package_versions(),
        "config": config.model_dump(mode="json"),
    }


def write_run_manifest(config: TrainingConfig, project_root: Path) -> Path:
    config.trainer.output_dir.mkdir(parents=True, exist_ok=True)
    destination = config.trainer.output_dir / "run-manifest.json"
    destination.write_text(
        json.dumps(build_run_manifest(config, project_root), indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return destination


def _package_versions() -> dict[str, str]:
    versions: dict[str, str] = {}
    for package in TRACKED_PACKAGES:
        try:
            versions[package] = version(package)
        except PackageNotFoundError:
            versions[package] = "not-installed"
    return versions


def _git_commit(project_root: Path) -> str | None:
    result = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=project_root,
        check=False,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip() if result.returncode == 0 else None
