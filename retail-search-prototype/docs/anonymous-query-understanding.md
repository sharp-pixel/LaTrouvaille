# Anonymous query understanding

With Query understanding enabled, Anonymous requests follow:

`App -> POST /search -> compileAnonymousQuery -> OpenSearch DSL -> results + query plan`

The server resolves the allowlisted persona ID before choosing the route. Missing
and unknown IDs resolve to Anonymous. The compiler lives in
`scripts/rules-query-understanding.mjs` and imports the catalogue vocabulary. It
does not call QueryPlanningTool, inference, or the Tier-2 rewrite service.
OpenSearch receives `search_pipeline=_none`, including when an index has a default
pipeline. Named personas continue through the existing agentic pipeline.

## Rules

| Input | Behavior |
| --- | --- |
| `black leather Maison Bellune bags` | Hard brand, color, material, and category filters; no remaining text requirement |
| `Maison Bellune Page bag` | Hard brand/category filters and required residual text `page` |
| `bags preferably black` | Hard category filter with an optional color boost |
| `bags ideally under 500 but from France` | Optional price preference, hard category and seller-country filters |
| `black or brown bags without canvas` | Color alternatives, category filter, material exclusion |
| `watches between 500 and 1500` | Inclusive price interval, intersected with the explicit UI ceiling |
| `watches under 1500` | Strict upper bound; `up to 1500` is inclusive |
| `white gold rings` | Exact White gold material, Jewellery category, and residual `ring` |
| `dress watch` | Watches category, optional style text, no gender inference |

Recognized conditions and explicit gender are also supported. Women's and men's
requests include the corresponding affinity plus unisex. Nothing is inferred
from a persona profile. Multiword entities use longest matching spans; brand
matching preserves punctuation in the indexed keyword value. Product numbers
and unknown descriptive text remain searchable. Subtype terms remain required
so boots do not silently become all shoes. Attribute-only and empty requests
need no residual text match.

Preference and exclusion scope ends at a comma, semicolon, or explicit hard
marker such as `but`, `only`, or `must`. Same-field entity values are alternatives;
different fields intersect. Explicit UI facets form separate hard constraints,
so conflicting UI/text constraints can correctly yield no matches. This is a
bounded English rules grammar, not a general natural-language parser; nested
Boolean expressions and comparative product reasoning are not supported.

Amounts use the catalogue's EUR prices. Decimal and common thousands separators,
`k`, upper/lower bounds, and `between ... and ...` / `from ... to ...` intervals
are recognized. Multiple hard bounds intersect, including the UI ceiling. A
preferred price is a scoring clause and never overwrites the UI ceiling.

The existing `country` metadata is **seller location**, not manufacturing origin.
Country names and demonyms use that field and are labelled Seller country in
the query plan. Explicit `made in` / `manufactured in` language stays in residual
text because the catalogue has no verified origin field.

## Response and controls

The response keeps the existing product and query-plan contracts, adds
`queryUnderstanding.engine: "rules"`, and reports recognized constraints with
`hard`, `soft`, or `exclude` modes and the remaining `residualQuery`. The actual
executed body, including service-owned `_source`, is returned as `dslQuery` for
the existing UBI persistence and popup. Personalization remains `unprofiled`.

The browser sends raw text and explicit controls; it does not infer Anonymous's
budget. The agentic model picker is hidden for Anonymous. Disabling Query
understanding retains the existing literal unboosted OR search and UI-only
`post_filter`. No route falls back to local catalogue results on service errors.

Verification: `npm test`, `npm run build`, and live API/browser checks against
OpenSearch. Parser regressions are in `tests/rules-query-understanding.test.js`;
HTTP routing/failure regressions use a stub OpenSearch service in
`tests/search-api-routing.test.js`.
