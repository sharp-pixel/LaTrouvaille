# Query Understanding Fine-Tuning

This is the isolated Python project for fine-tuning a deterministic, persona-aware product-search query compiler. It turns a raw query plus user context and an allowlisted catalog schema into a versioned retrieval plan and a policy-checked OpenSearch request.

The project follows the supplied design for `mistralai/Ministral-3-8B-Instruct-2512-BF16` and is intentionally not wired into the customer-blocking search path yet. The current React/Node prototype expects Tier-1 query understanding to complete within a very small latency budget; the adapter should first be evaluated offline and in shadow traffic.

## What is included

- A `uv` project with a committed lockfile, CUDA PyTorch for Linux/Windows x86_64, and native MPS PyTorch for Apple Silicon macOS.
- A strict Pydantic input/output contract for `psg_query_compiler_v1`.
- Canonical JSONL fixtures and completion-only chat conversion.
- Dataset, index, field, query-type, clause-count, `size`, and `k` validation.
- A text-only QLoRA runner for the multimodal Ministral checkpoint.
- Explicit assistant-token masking; target JSON is rejected when it exceeds the sequence limit, never truncated.
- LoRA module selection restricted to `language_model`; vision and projector weights remain frozen.
- Structural evaluation for JSON validity, schema validity, policy validity, category, query type, expertise, and retrieval-resolution accuracy.
- Run manifests with dataset/policy/lock hashes and the immutable base-model revision.

The checked-in JSONL files are executable fixtures, not a production training corpus. The design calls for 1,000–5,000 reviewed SFT examples and at least 1,000 held-out labeled queries.

## Quick start

From this directory:

```bash
uv sync --locked --no-editable
uv run --locked --no-editable quft doctor
uv run --locked --no-editable quft validate-data
uv run --locked --no-editable quft train
uv run --locked --no-editable pytest
```

`quft train` is a safe dry-run unless `--execute` is present. It validates and prints the resolved configuration without downloading the model.

The commands use non-editable installation so the CLI behaves the same on Linux, CI, and macOS environments that hide `.pth` files inside `.venv`.

## RTX 5090 training host

Use Linux with a current NVIDIA driver, Python 3.11, and enough disk space for the base checkpoint, caches, checkpoints, and adapter artifacts.

```bash
uv sync --locked --no-editable --group train
uv run --locked --no-editable quft doctor --training
uv run --locked --no-editable quft train --config configs/qlora-5090.yaml --execute
```

The training configuration starts with the design baseline: 4-bit NF4 QLoRA, BF16 compute, sequence length 2,048, batch size 1, gradient accumulation 16, LoRA rank 16/alpha 32, cosine scheduling, and two epochs.

The base model is pinned to Hugging Face revision `06cc81bfd6e45321d8fc8f816576c5b6ac67ec22`. Update that value deliberately and review chat-template/tokenization behavior before moving it.

## Apple Silicon macOS

The macOS profile uses PyTorch's Metal Performance Shaders (MPS) backend. It deliberately omits CUDA and bitsandbytes: the model runs in native float16 and LoRA adapters are trained without 4-bit quantization.

```bash
uv sync --locked --no-editable --group train
uv run --locked --no-editable quft doctor --training
uv run --locked --no-editable quft train --config configs/lora-macos.yaml --execute
```

The 8B multimodal checkpoint is memory intensive without 4-bit quantization. The macOS profile reduces the sequence length to 1,024, but a high-memory Apple Silicon machine is still required for actual training. Validation, dry runs, and the unit suite do not require the training group:

```bash
uv sync --locked --no-editable
uv run --locked --no-editable pytest
uv run --locked --no-editable quft train --config configs/lora-macos.yaml
```

## Commands

```bash
# Resolve and inspect all paths and hyperparameters
uv run --no-editable quft show-config

# Validate train and evaluation examples against the contract and policy
uv run --no-editable quft validate-data

# Export the formal output JSON Schema
uv run --no-editable quft export-schema --output schemas/psg_query_compiler_v1.schema.json

# Validate the setup without downloading model weights
uv run --no-editable quft train

# Score held-out predictions
uv run --no-editable quft evaluate --predictions predictions/eval.jsonl
```

Prediction rows use this shape:

```json
{"example_id":"formal-watch-quiet-expert","output":{"schema_version":"psg_query_compiler_v1"}}
```

`output` may be a JSON object or a JSON string. It must contain the full contract to count as schema-valid.

## Data contract choices

The design document leaves a few points implicit. This implementation makes them reproducible:

- Source rows store structured `input` and `output` objects. The loader serializes both canonically and creates conversational prompt/completion records at training time.
- Completion labels are masked explicitly; training does not depend on `{% generation %}` markers in the model chat template.
- `connoisseur` is normalized to the `expert` label before examples enter this dataset.
- Resolution weights are dense and must sum to 1 within a 0.01 tolerance.
- Mental-model weights are dense, independently bounded to `[0, 1]`, and use the eight declared universal axes. Undeclared labels such as `safe_choice` do not enter the v1 schema.
- The model produces both a structured plan and a DSL candidate because that is the supplied training target. The candidate is never trusted directly: policy validation is mandatory and production should recompile or sanitize it.

See [docs/data-contract.md](docs/data-contract.md) for the full row format and slice targets.

## OpenSearch profiles

`configs/policy-prototype-v1.yaml` matches the current `secondhand_items_current` lexical index. It is the active training/evaluation profile so fixtures can be executed against today’s prototype.

`configs/policy-hybrid-v1.yaml` captures the future design-document fields, vector queries, and `psg-hybrid-v1` pipeline. Do not execute that profile until OpenSearch actually has the required concept scores, identity fields, k-NN vectors, and search pipeline.

See [docs/integration.md](docs/integration.md) for the boundary with the existing Node service.

## Project layout

```text
configs/                     QLoRA and OpenSearch policy profiles
data/                        Small reviewed train/eval fixtures
docs/                        Contract and integration decisions
src/query_understanding/     Schema, validation, tokenization, training, evaluation, CLI
tests/                       CPU-only unit and golden-path tests
artifacts/                   Ignored run outputs and adapter checkpoints
```
