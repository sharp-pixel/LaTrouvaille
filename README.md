# La Trouvaille — Agentic Search on OpenSearch

A working demonstration of **OpenSearch native Agentic Search** for a second-hand luxury
marketplace: a shopper types ordinary words, an LLM planner turns them into an OpenSearch
query DSL body, and OpenSearch executes it.

The repository holds the two halves of that story — the **storefront and search service**
that use Agentic Search, and the **fine-tuning project** for the planner model behind it.

```
LaTrouvaille/
├── retail-search-prototype/        React storefront + OpenSearch search API
├── query-understanding-training/   QLoRA fine-tuning for the query planner
└── AGENTS.md                       repo conventions and build commands
```

---

## The problem

Lexical search has no idea what a phrase *means*. Search a luxury catalogue for
**"dress watch"** and BM25 scores every *dress* highly, because "dress" is a strong term in
dress titles. The shopper asked for a watch and gets evening gowns.

## The approach

Instead of hand-writing synonym rules for every such phrase, ask a language model to plan
the query. OpenSearch 3.x ships this natively:

```
shopper types "dress watch"
        │
        ▼
  agentic query  ──► search pipeline (agentic_query_translator)
                          │
                          ▼
                     ML agent → QueryPlanningTool → LLM planner
                          │
                          ▼
              generated OpenSearch DSL, executed in place
```

The planner recognises *dress watch* as a watch style, emits
`{"term":{"category":"watches"}}`, rewrites the text query to `"watch"`, and the dresses
disappear. Nothing about the index or the analyzers changed — only the query.

## What makes this more than a demo

Three properties the prototype deliberately proves out:

**A contract, not a wish.** The planner is given a strict system prompt (root keys, allowed
query types, clause limits, exact ranking recipe) and the response is validated
clause-by-clause after execution. An invalid plan fails the request rather than silently
returning wrong results.

**Trusted vs untrusted input.** The `query_text` sent to the planner has three lines:
the shopper's raw words (untrusted data, never instructions), a server-authored context
object (required filters, price ceiling, result budget, sort mode, persona), and a guardrail
instruction. The browser sends only a `personaId`; the service resolves the allowlisted
profile and never passes names, demographics, or images to the model.

**Personalisation that cannot distort retrieval.** A shopper profile contributes exactly one
low-boost `multi_match` in `bool.should` — scoring-only, so it re-ranks but never filters.
The single exception is an explicit `strict_max_price`, which is allowed to tighten the
price filter.

**Small models are enough — with the right prompt.** The planner runs on an 8B model,
4-bit quantised, on one mid-range GPU. Getting there took prompt engineering rather than a
bigger model: prose rules alone were read and ignored, while one *literal worked example*
fixed the failures. See the prompt files under
[`query-understanding-training/src/query_understanding/prompts/`](query-understanding-training/src/query_understanding/prompts/).

---

## Detailed documentation

Each subproject documents its own setup, commands, and design decisions:

| Document | Covers |
|---|---|
| **[retail-search-prototype/README.md](retail-search-prototype/README.md)** | Running the storefront and search API, local OpenSearch via Compose, the agentic pipeline, UBI capture, Tier-2 rewriting, and the model-provider options (LM Studio, SageMaker) |
| **[retail-search-prototype/docs/architecture-report.md](retail-search-prototype/docs/architecture-report.md)** | Current architecture report |
| **[retail-search-prototype/docs/fictional-catalog.md](retail-search-prototype/docs/fictional-catalog.md)** | How the catalogue data is generated |
| **[query-understanding-training/README.md](query-understanding-training/README.md)** | The fine-tuning objective, dataset contract, validation, QLoRA runner, evaluation metrics, and training hosts (RTX 5090, SageMaker, Apple Silicon) |
| **[query-understanding-training/docs/data-contract.md](query-understanding-training/docs/data-contract.md)** | Row schema and policy rules for training data |
| **[query-understanding-training/docs/integration.md](query-understanding-training/docs/integration.md)** | Wiring a trained model back into OpenSearch |
| **[query-understanding-training/data/README.md](query-understanding-training/data/README.md)** | Dataset directory layout |
| **[AGENTS.md](AGENTS.md)** | Repository guidelines, project structure, build and test commands |

---

## Quick start

The two projects are independent; run commands from inside the relevant directory.

**Storefront and search** — needs a local OpenSearch with the ML and neural-search plugins,
plus a reachable planner model:

```bash
cd retail-search-prototype
npm install
npm run opensearch:bootstrap     # create the index and load the catalogue
npm run opensearch:agentic       # register connector, model, agent, search pipeline
npm run search:api               # search service on :8790
npm run dev                      # UI on :5173
```

**Planner fine-tuning** — Python, managed with `uv`:

```bash
cd query-understanding-training
uv sync --locked --no-editable
uv run --locked --no-editable quft doctor          # resolve paths and hyperparameters
uv run --locked --no-editable quft validate-data   # check the corpus against the contract
uv run --locked --no-editable quft train
```

Full prerequisites, environment variables, and provider-specific setup are in the
subproject READMEs linked above.

---

## Model configuration notes

The planner is provider-agnostic. `scripts/configure-agentic-search.mjs` registers the
connector, model, agent, and search pipeline, and reads its settings from the environment
so several models can be registered side by side for comparison:

| Variable | Purpose |
|---|---|
| `OPENSEARCH_AGENTIC_SEARCH_PIPELINE` | pipeline to create, and the search API's default |
| `OPENSEARCH_AGENTIC_SYSTEM_PROMPT_FILE` | planner prompt to register — lets one model use a model-specific prompt while others keep the shared contract |
| `OPENSEARCH_AGENTIC_MODEL_NAME` / `_CONNECTOR_NAME` / `_AGENT_NAME` | naming, when registering more than one planner |
| `AGENTIC_MODEL_PROVIDER` | `openai` (OpenAI-compatible endpoint) or `sagemaker` (SigV4) |
| `AGENTIC_CONNECTOR_TIMEOUT_SECONDS` | connector read/connection timeout; ml-commons defaults to 30s, which is tight for a planner that needs 10–20s |

Because `_ml/models/_register` and `_ml/agents/_register` always mint a new id (there is no
upsert), re-running the configure script leaves the previous model and agent behind while
the pipeline moves to the new one. Prune the orphans periodically — and repoint anything
referencing an agent *before* deleting it.
