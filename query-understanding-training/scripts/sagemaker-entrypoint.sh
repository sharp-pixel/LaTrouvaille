#!/usr/bin/env bash
set -euo pipefail

cd /opt/ml/code
nvidia-smi
python --version
mkdir -p /opt/ml/hf-cache
python -m pip install --no-cache-dir -r requirements-sagemaker.txt
python -m pip install --no-deps --no-build-isolation .
python -m query_understanding.cli doctor --training
python -m query_understanding.cli validate-data --config "${TRAINING_CONFIG}"
python -m query_understanding.cli train --execute --config "${TRAINING_CONFIG}"
