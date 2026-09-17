# Repaired planner promotion validation

Validated on 2026-09-17 against local vLLM 0.29.0 and the native OpenSearch pipeline.

## Cause and serving change

The original adapter was still mounted after the corpus repair run completed.
For Anonymous `Dress watch`, its executed DSL used `Dress watch` with OR matching
and no category filter. The captured response contained 26 Watches and 22 Dresses.

Compose now defaults to `query-understanding-training/artifacts/qlora-agentic-v3-repaired/adapter`,
mounted read-only under the existing `psg-agentic-query-planner-v3` alias. The pinned
BF16 base model, prompt, structured-output schema, and runtime validator are unchanged.
The original adapter is retained; `VLLM_ADAPTER_PATH` can select it for rollback.

Promoted `adapter_model.safetensors` SHA-256:
`5ec58bba6865626314f0e16e665d2c263fbd793dfedcc2b48aaf5c280ef1931f`.

## Candidate checks

The candidate was first loaded under a separate alias alongside the original adapter.
Generation used temperature zero, the production-compatible structured-output schema,
and the shared native planner prompts.

- 64/64 watch-style checks passed: `Dress watch`, `dress watch`, `formal watch`, and
  `suit watch`, each across all four personas and all four UI sort modes. Every
  result filtered to `category: watches`, used core query `watch` with OR, and
  passed the runtime DSL validator.
- 120/120 sampled held-out examples passed both Python policy and supervised-target
  semantic validation. The sample takes one example for each available
  slice/persona/sort combination; it is not a complete evaluation of all 1,160
  held-out rows. 116/120 generated bodies exactly matched the target bodies.
- Four additional checks covered a shopper budget, explicit women's/men's watch
  intent, and a silk dress. Overall, 187/188 strict generation checks passed.

Remaining differences are recorded rather than silently repaired:

- `men's formal watch` generated `watch` with AND instead of the prompt's specified
  OR. It still emitted the Watches filter and the correct men/unisex affinity
  filter. AND and OR have equivalent matching behavior for this single-token query,
  so this difference does not cause cross-category results, but it remains a
  prompt-contract mismatch.
- Four held-out persona variants of `minimal shoulder bag` chose AND instead of
  the target's OR. Both are allowed by the general text recipe; this differs from
  the gold body and can narrow retrieval. All other body content matched.

No generated body was rewritten to make these checks pass.

## Live verification after promotion

The vLLM container became healthy with the repaired adapter confirmed as its
read-only mount. These requests then ran through the app's real same-origin
`/api/search` proxy and native OpenSearch pipeline, using Anonymous, Recommended,
size 48, and query understanding enabled:

| Shopper query | Products returned | Categories returned |
| --- | ---: | --- |
| Dress watch | 27 | Watches |
| dress watch | 27 | Watches |
| formal watch | 27 | Watches |
| suit watch | 27 | Watches |
| silk dress | 10 | Dresses |

All watch-style requests executed `category: watches` plus core query `watch`
with OR. All Recommended bodies omitted sort. The dress control continued to
execute `category: dresses`.

`npm test`: 106 passed. `npm run build`: passed. Browser UI verification was
unavailable because no browser surface was connected; the live API responses
were verified directly.
