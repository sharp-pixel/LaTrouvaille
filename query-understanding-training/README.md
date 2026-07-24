# Native Agentic Search Query-Planning Fine-Tuning

This Python project fine-tunes the model used by OpenSearch's native Agentic Search `QueryPlanningTool`. The serving objective is deliberately narrow: given the exact native question, index mapping, and `query_fields`, emit one complete, policy-checked OpenSearch request body.

The assistant completion contains `size`, integer `track_total_hits` (0–10,000), `query`, and any requested `sort`. It never contains an index, search pipeline, `_source`, compiler envelope, intent metadata, confidence scores, or prose. OpenSearch preserves the service-owned `_source` while replacing the rest of the incoming search body with the model-generated body.

## What is included

- A `uv` project with a committed lockfile, CUDA PyTorch for Linux/Windows x86_64, and native MPS PyTorch for Apple Silicon macOS.
- A strict `opensearch_agentic_query_planner_v3` dataset contract.
- Shared system and user prompt assets used by both training and OpenSearch agent registration.
- A deterministic 4,640-row training corpus and 1,160-row grouped evaluation corpus, plus completion-only chat conversion.
- Dataset, index, mapping/query-field intersection, top-level key, sort, required-filter, query-type, clause-count, `size`, and `k` validation.
- A text-only QLoRA runner for the multimodal Ministral checkpoint.
- Explicit assistant-token masking; target JSON is rejected when it exceeds the sequence limit, never truncated.
- LoRA module selection restricted to `language_model`; vision and projector weights remain frozen.
- Structural evaluation for JSON validity, request-body validity, policy validity, exact request match, exact persona-clause match, and required-filter recall.
- Run manifests with objective, prompt, dataset, policy, lock, and immutable base-model hashes.

The checked-in JSONL files are reproducibly generated, policy-valid training and
evaluation corpora. They cover all supported slices, personas, sorts, facets,
mapping shapes, result budgets, and adversarial instructions. Forty four-way
ranking families hold the request constant while varying only recommended,
lowest-price, newest, and price-drop behavior. Generated examples still require
human review and retrieval-quality evaluation before a production model release.

## Quick start

From this directory:

```bash
uv sync --locked --no-editable
uv run --locked --no-editable quft doctor
uv run --locked --no-editable quft build-data --check
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

## SageMaker training

SageMaker Training does not currently expose `ml.g6.2xlarge` in `eu-west-1`.
The training launcher therefore uses `ml.g5.2xlarge`, which has the same 24 GiB
of GPU memory and an account quota of one on-demand job. The live G6 inference
endpoint is independent and remains billable while training runs.

The launcher creates a dedicated execution role, an encrypted private artifact
bucket, uploads the current source tree, and uses the pinned AWS PyTorch 2.9 /
CUDA 13.0 training DLC. Start with the two-step memory and compatibility smoke
job:

```bash
node scripts/sagemaker-training.mjs plan smoke
node scripts/sagemaker-training.mjs launch smoke
```

Only after the smoke job completes with safe peak VRAM should the full two-epoch
job be launched:

```bash
node scripts/sagemaker-training.mjs launch full
```

The base model is pinned to Hugging Face revision `06cc81bfd6e45321d8fc8f816576c5b6ac67ec22`. Update that value deliberately and review chat-template/tokenization behavior before moving it.

## Apple Silicon macOS

The macOS profile uses PyTorch's Metal Performance Shaders (MPS) backend. It deliberately omits CUDA and bitsandbytes: the model runs in native float16 and LoRA adapters are trained without 4-bit quantization.

```bash
uv sync --locked --no-editable --group train
uv run --locked --no-editable quft doctor --training
uv run --locked --no-editable quft train --config configs/lora-macos.yaml --execute
```

The 8B multimodal checkpoint is memory intensive without 4-bit quantization. The macOS profile uses a 2,048-token sequence length so the native double-encoded mapping prompt and complete JSON target are never truncated; a high-memory Apple Silicon machine is still required for actual training. Validation, dry runs, and the unit suite do not require the training group:

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

# Export the native objective row schema
uv run --no-editable quft export-schema --output schemas/opensearch_agentic_query_planner_v3.schema.json

# Validate the setup without downloading model weights
uv run --no-editable quft train

# Score held-out predictions
uv run --no-editable quft evaluate --predictions predictions/eval.jsonl
```

Prediction rows use this shape:

```json
{"example_id":"formal-watch-quiet-expert","output":{"size":24,"track_total_hits":10000,"query":{"bool":{}}}}
```

`output` may be a JSON object or a JSON string. Its root must be the executable OpenSearch request body.

## Data contract choices

The design document leaves a few points implicit. This implementation makes them reproducible:

- Source rows store the exact native `query_text`, including a deterministic normalized first-line summary, its compact immutable service contract, mapping, query fields, evaluation expectations, and target body. Raw shopper wording is excluded. The v3 contract owns filters, size, integer hit counting, sort mode, `base_text_query`, `text_operator`, and a bounded nested persona. Explicit sorts additionally require `rank_features=false`; recommended mode omits that key. Metadata never enters the assistant completion. Oversized three-line envelopes are rejected rather than truncating the deterministic summary.
- Training and `scripts/configure-agentic-search.mjs` load the same packaged system and user prompt files, preventing serving/training prompt drift.
- The offline renderer mirrors QueryPlanningTool's JSON-string serialization of the OpenSearch 3.7 `_doc` mapping source and `query_fields`; this shape was verified against a live native request.
- Completion labels are masked explicitly; training does not depend on `{% generation %}` markers in the model chat template.
- The core `bool.must` query always copies `base_text_query` and `text_operator` exactly. A profiled persona contributes one exact, low-boost `multi_match` as the first `bool.should` clause; the anonymous persona contributes no clause. Persona context cannot change filters, core relevance, sorting, limits, or hit counting.
- `_source` is omitted from every target because the agentic request processor preserves the incoming service-owned `_source`.
- Explicit sort modes are learned inside the generated body; the incoming `agentic` request must not carry an outer `sort`.
- The legacy `psg_query_compiler_v1` classes/schema remain only as offline annotation compatibility and are not serving targets.

See [docs/data-contract.md](docs/data-contract.md) for the full row format and slice targets.

## OpenSearch profiles

`configs/policy-prototype-v1.yaml` matches the current `secondhand_items_current` lexical index. It is the active training/evaluation profile so fixtures can be executed against today’s prototype.

`configs/policy-hybrid-v1.yaml` captures the future design-document fields, vector queries, and `psg-hybrid-v1` pipeline. Do not execute that profile until OpenSearch actually has the required concept scores, identity fields, k-NN vectors, and search pipeline.

See [docs/integration.md](docs/integration.md) for the boundary with the existing Node service.

## Project layout

```text
configs/                     QLoRA and OpenSearch policy profiles
data/                        Generated train/eval corpora and review guidance
docs/                        Contract and integration decisions
src/query_understanding/     Schema, validation, tokenization, training, evaluation, CLI
tests/                       CPU-only unit and golden-path tests
artifacts/                   Ignored run outputs and adapter checkpoints
```
