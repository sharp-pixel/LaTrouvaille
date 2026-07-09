from pathlib import Path

import pytest

from query_understanding.config import TrainingConfig, load_training_config
from query_understanding.policy import CompilerPolicy, load_policy

PROJECT_ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def project_root() -> Path:
    return PROJECT_ROOT


@pytest.fixture
def config(project_root: Path) -> TrainingConfig:
    return load_training_config(project_root / "configs" / "qlora-5090.yaml")


@pytest.fixture
def policy(config: TrainingConfig) -> CompilerPolicy:
    return load_policy(config.data.policy_file)
