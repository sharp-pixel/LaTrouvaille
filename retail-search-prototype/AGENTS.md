# Prototype Instructions

Run the local server yourself and open the preview in the in-app browser. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

The demo login action is a persona selector. Keep Anonymous as the default, show each persona's background and mental model, make the selector available on desktop and mobile, and attach the active persona to UBI query and event records. Persona selection intentionally personalizes the native query rewrite and softly boosts close matches in local fallback ranking; changing persona must refetch the active results, and the personalized rewrite is exposed in the query strip. The browser sends only `personaId` to search. Resolve that ID server-side to the allowlisted search context (`personaId`, version, archetype, background, mental model, and a query expansion capped at 120 characters); never transmit persona names, demographics, or images as model context. Store the effective rewrite once in UBI plus only the compact personalization status/identity summary. Persona portraits are original fictional assets in a warm cartoonish 3D render style; keep Anonymous deliberately faceless and non-demographic.

Catalog content belongs to a fictional luxury universe. Do not introduce real brand or model names in listings, search suggestions, query rules, fixtures, screenshots, or documentation. Keep each fictional house consistent across categories and reuse its established model vocabulary; French maisons use French house/model language, Italian fashion houses use Italianate names, Swiss watchmakers use horological/Geneva language, and Anglo-American labels use English names.

Cart listings are unique: the cart has no quantity controls, cannot contain the same listing twice, and starts empty on each fresh app load.

The customer-facing UBI summary is scoped to the active query ID. Show the current query and only interactions linked to it; do not expose internal search-enhancement implementation details such as Querqy or Agentic Search status. Hovering or keyboard-focusing the current UBI query must reveal the actual OpenSearch DSL in a readable popup.

Customer natural-language queries use the native OpenSearch Agentic Search pipeline configured by `scripts/configure-agentic-search.mjs`. Prefer the served fine-tuned model alias and fall back to the pinned base model alias during provisioning. Keep the deterministic lexical OpenSearch request as the runtime fail-open path, and preserve local catalogue fallback for a full OpenSearch outage.

The planner owns the full generated body except service-owned `_source`. Keep its exact size, total-hit, hard-filter, text-intent, field/type, clause-budget, and sort contract synchronized across the shared prompts, training policy, and runtime response validator. The `agentic_context` check is post-execution correctness validation, not a security sandbox; production safeguards belong in OpenSearch-side permissions and resource limits.

Keep the composed native `query_text` at or below OpenSearch's 1,000-character limit. The local OpenAI-compatible connector enables JSON-schema output by default; set `AGENTIC_STRUCTURED_OUTPUT=false` only for a provider that does not implement OpenAI `response_format: json_schema`.

OpenSearch 3.7's native planner prompt passes a `_doc`-wrapped mapping source and serializes the mapping and query-field array as JSON string literals. Keep training fixtures and the offline prompt renderer faithful to that captured representation when changing mappings or OpenSearch versions.
