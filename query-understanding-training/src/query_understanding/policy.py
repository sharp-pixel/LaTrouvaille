"""Allowlist and resource-budget validation for model-produced OpenSearch requests."""

from __future__ import annotations

import json
import math
import re
import unicodedata
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from fnmatch import fnmatchcase
from pathlib import Path

import yaml
from pydantic import BaseModel, ConfigDict, Field

from query_understanding.schemas import (
    AgenticExpectations,
    AgenticPlannerInput,
    Constraint,
    QueryCompilerInput,
    QueryCompilerOutput,
    agentic_mapping_properties,
)

KNOWN_QUERY_TYPES = frozenset(
    {
        "bool",
        "hybrid",
        "knn",
        "match",
        "match_all",
        "match_phrase",
        "multi_match",
        "nested",
        "neural",
        "prefix",
        "range",
        "rank_feature",
        "term",
        "terms",
    }
)
FIELD_KEYED_QUERY_TYPES = frozenset({"knn", "match", "match_phrase", "neural", "prefix", "range", "term", "terms"})
TEXT_RELEVANCE_QUERY_TYPES = frozenset({"match", "match_phrase", "multi_match"})
ALLOWED_TOP_LEVEL_KEYS = frozenset({"query", "size", "sort", "track_total_hits"})
INTEGER_FIELD_LIMITS: dict[str, tuple[int, int]] = {
    "byte": (-128, 127),
    "integer": (-2_147_483_648, 2_147_483_647),
    "long": (-9_223_372_036_854_775_808, 9_223_372_036_854_775_807),
    "short": (-32_768, 32_767),
    "unsigned_long": (0, 18_446_744_073_709_551_615),
}
FLOAT_FIELD_TYPES = frozenset({"double", "float", "half_float", "scaled_float"})
NUMERIC_FIELD_TYPES = frozenset(INTEGER_FIELD_LIMITS) | FLOAT_FIELD_TYPES
AGENTIC_SERVICE_FILTER_FIELDS = ("category", "condition", "material", "country")
AGENTIC_SERVICE_MAX_PRICE = 20_000
AGENTIC_SERVICE_MAX_VALUES_PER_FIELD = 20
AGENTIC_SERVICE_MAX_VALUE_LENGTH = 100
AGENTIC_SERVICE_MAX_TEXT_QUERY_LENGTH = 300
AGENTIC_PERSONA_MAX_CONTEXT_LENGTH = 512
AGENTIC_PERSONA_MAX_ID_LENGTH = 64
AGENTIC_PERSONA_MAX_ARCHETYPE_LENGTH = 64
AGENTIC_PERSONA_MAX_BACKGROUND_LENGTH = 160
AGENTIC_PERSONA_MAX_MENTAL_MODEL_LENGTH = 160
AGENTIC_PERSONA_MAX_QUERY_EXPANSION_LENGTH = 120
AGENTIC_PERSONA_EXPANSION_BOOST = 0.35
AGENTIC_CANONICAL_MULTI_MATCH_FIELDS = ["title^5", "brand^3", "canonical_text^3", "description"]
AGENTIC_RECOMMENDED_RANK_FEATURES = (
    ("quality_score", 0.2),
    ("freshness_score", 0.05),
    ("seller_score", 0.02),
)


class CompilerPolicy(BaseModel):
    model_config = ConfigDict(extra="forbid")

    allowed_indexes: list[str] = Field(min_length=1)
    allowed_fields: list[str] = Field(min_length=1)
    allowed_search_pipelines: list[str] = Field(default_factory=list)
    allowed_query_types: list[str] = Field(min_length=1)
    forbidden_keys: list[str] = Field(default_factory=list)
    allowed_constraint_ops: list[str] = Field(min_length=1)
    max_size: int = Field(default=50, ge=1, le=1_000)
    max_track_total_hits: int = Field(default=10_000, ge=0)
    max_k: int = Field(default=500, ge=1)
    max_query_clauses: int = Field(default=100, ge=1)


class PolicyViolation(ValueError):
    """Raised when a generated search body exceeds the configured safety policy."""

    def __init__(self, issues: Sequence[str]) -> None:
        self.issues = tuple(issues)
        super().__init__("; ".join(self.issues))


def load_policy(path: Path) -> CompilerPolicy:
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(raw, Mapping):
        raise ValueError(f"policy must be a YAML object: {path}")
    return CompilerPolicy.model_validate(raw)


def field_is_allowed(field: str, patterns: Sequence[str]) -> bool:
    normalized = field.split("^", maxsplit=1)[0]
    return any(fnmatchcase(normalized, pattern) for pattern in patterns)


def validate_compiler_output(
    request: QueryCompilerInput,
    output: QueryCompilerOutput,
    policy: CompilerPolicy,
) -> None:
    issues: list[str] = []
    allowed_indexes = set(policy.allowed_indexes) & set(request.allowed_schema.indexes)
    if output.opensearch.index not in allowed_indexes:
        issues.append(f"index is not allowlisted: {output.opensearch.index}")

    pipeline = output.opensearch.search_pipeline
    if pipeline is not None:
        allowed_pipelines = set(policy.allowed_search_pipelines) & set(request.allowed_schema.search_pipelines)
        if pipeline not in allowed_pipelines:
            issues.append(f"search pipeline is not allowlisted: {pipeline}")

    if not output.clarification_needed and output.category not in request.allowed_schema.categories:
        issues.append(f"category is not present in the request allowlist: {output.category}")

    for group_name, constraints in (
        ("filters", output.constraints.filters),
        ("must_not", output.constraints.must_not),
    ):
        for index, constraint in enumerate(constraints):
            _validate_constraint(
                constraint,
                f"constraints.{group_name}[{index}]",
                request,
                policy,
                issues,
            )

    _validate_agentic_request_body(request, output.opensearch.body, policy, issues)

    if issues:
        raise PolicyViolation(issues)


def validate_agentic_request_body(
    request: QueryCompilerInput | AgenticPlannerInput,
    body: Mapping[str, object],
    policy: CompilerPolicy,
    expectations: AgenticExpectations | None = None,
) -> None:
    """Validate the raw request body emitted for native QueryPlanningTool use."""

    issues: list[str] = []
    if isinstance(request, AgenticPlannerInput) and request.index_name not in policy.allowed_indexes:
        issues.append(f"index is not allowlisted: {request.index_name}")
    _validate_agentic_request_body(request, body, policy, issues, expectations)
    if issues:
        raise PolicyViolation(issues)


def _validate_agentic_request_body(
    request: QueryCompilerInput | AgenticPlannerInput,
    body: Mapping[str, object],
    policy: CompilerPolicy,
    issues: list[str],
    expectations: AgenticExpectations | None = None,
) -> None:
    for key in body:
        if key not in ALLOWED_TOP_LEVEL_KEYS:
            issues.append(f"unsupported top-level search key: {key}")
    size = body.get("size")
    if not isinstance(size, int) or isinstance(size, bool) or not 1 <= size <= policy.max_size:
        issues.append(f"body.size must be an integer between 1 and {policy.max_size}")
    query = body.get("query")
    if not isinstance(query, Mapping):
        issues.append("body.query must be an object")
    else:
        _validate_query_structure(query, "body.query", policy, issues)
        if isinstance(request, AgenticPlannerInput):
            _validate_agentic_query_semantics(query, request, policy, issues)
        if (
            isinstance(request, AgenticPlannerInput)
            and _has_nonblank_shopper_query(request)
            and not _query_requires_text_relevance(query, _request_text_fields(request, policy))
        ):
            issues.append("body.query must include a required positive text relevance clause")
    track_total_hits = body.get("track_total_hits")
    if (
        not isinstance(track_total_hits, int)
        or isinstance(track_total_hits, bool)
        or not 0 <= track_total_hits <= policy.max_track_total_hits
    ):
        issues.append(f"body.track_total_hits must be an integer between 0 and {policy.max_track_total_hits}")

    allowed_fields = _request_fields(request, policy)
    clause_count = _inspect_dsl(body, "$", policy, allowed_fields, issues)
    if clause_count > policy.max_query_clauses:
        issues.append(f"DSL has {clause_count} query clauses; limit is {policy.max_query_clauses}")
    sort_field_types: Mapping[str, object] | None = None
    if isinstance(request, AgenticPlannerInput):
        sort_field_types = {
            field: definition.get("type") for field, definition in _request_field_definitions(request).items()
        }
    _inspect_sort(body.get("sort"), allowed_fields, issues, sort_field_types)

    persona_expansion: str | None = None
    if isinstance(request, AgenticPlannerInput):
        persona_expansion = _validate_agentic_service_contract(request, body, policy, expectations, issues)

    if expectations:
        if size != expectations.result_size:
            issues.append("body.size does not match expectations.result_size")
        if not _strict_scalar_equal(body.get("track_total_hits"), expectations.track_total_hits):
            issues.append("body.track_total_hits does not match expectations.track_total_hits")
        for constraint in expectations.required_filters:
            if not constraint_is_present(body, constraint):
                issues.append(f"required filter is missing: {constraint.field} {constraint.op}")
        if isinstance(query, Mapping):
            _validate_required_constraint_placement(
                query,
                {constraint.field for constraint in expectations.required_filters},
                issues,
            )
        _validate_expected_sort(body, expectations.sort_mode, issues)
        if isinstance(query, Mapping):
            _validate_expected_text_recipe(query, expectations.sort_mode, persona_expansion is not None, issues)
            _validate_expected_ranking(query, expectations.sort_mode, persona_expansion, issues)


def _validate_agentic_service_contract(
    request: AgenticPlannerInput,
    body: Mapping[str, object],
    policy: CompilerPolicy,
    expectations: AgenticExpectations | None,
    issues: list[str],
) -> str | None:
    lines = request.query_text.splitlines()
    prefix = "Immutable service contract: "
    instruction = (
        "Copy the core contract exactly. Apply persona only through the system persona-should recipe. Follow sort_mode."
    )
    if len(lines) != 3 or not lines[1].startswith(prefix) or lines[2] != instruction:
        issues.append("input.query_text must use the exact three-line native service-contract template")
        return None
    try:
        contract = json.loads(lines[1][len(prefix) :])
    except json.JSONDecodeError:
        issues.append("input.query_text immutable service contract must be valid JSON")
        return None
    required_contract_keys = {
        "base_text_query",
        "filter",
        "persona",
        "size",
        "sort_mode",
        "text_operator",
        "track_total_hits",
    }
    if (
        not isinstance(contract, dict)
        or not required_contract_keys <= set(contract)
        or set(contract) - required_contract_keys != ({"rank_features"} if "rank_features" in contract else set())
    ):
        issues.append("input.query_text immutable service contract has invalid keys")
        return None
    contract_track_total_hits = contract.get("track_total_hits")
    if (
        not isinstance(contract_track_total_hits, int)
        or isinstance(contract_track_total_hits, bool)
        or not 0 <= contract_track_total_hits <= policy.max_track_total_hits
    ):
        issues.append(
            "immutable service contract track_total_hits must be an integer between "
            f"0 and {policy.max_track_total_hits}"
        )
    expected_summary = _normalized_shopper_summary(contract)
    if expected_summary is None or lines[0] != f"Normalized shopper request: {expected_summary}":
        issues.append("input.query_text normalized shopper request does not match the immutable service contract")
    _validate_agentic_service_filters(contract.get("filter"), issues)
    persona_expansion = _validate_agentic_persona(contract.get("persona"), issues)

    query = body.get("query")
    actual_filters: object = None
    if isinstance(query, Mapping):
        bool_query = query.get("bool")
        if isinstance(bool_query, Mapping):
            actual_filters = bool_query.get("filter")
    if contract.get("filter") != actual_filters:
        issues.append("target body must copy the immutable service contract filters exactly")
    if expectations and contract.get("filter") != [
        _constraint_filter_clause(constraint) for constraint in expectations.required_filters
    ]:
        issues.append("immutable service contract filters must match expectations.required_filters exactly")
    if not _strict_scalar_equal(contract.get("size"), body.get("size")):
        issues.append("target body must copy the immutable service contract size exactly")
    if not _strict_scalar_equal(contract.get("track_total_hits"), body.get("track_total_hits")):
        issues.append("target body must copy the immutable service contract track_total_hits exactly")
    actual_text_query: object = None
    actual_text_operator: object = None
    if isinstance(query, Mapping):
        bool_query = query.get("bool")
        if isinstance(bool_query, Mapping):
            must = bool_query.get("must")
            if isinstance(must, list) and len(must) == 1 and isinstance(must[0], Mapping):
                multi_match = must[0].get("multi_match")
                if isinstance(multi_match, Mapping):
                    actual_text_query = multi_match.get("query")
                    actual_text_operator = multi_match.get("operator")
    contract_text_query = contract.get("base_text_query")
    if not isinstance(contract_text_query, str) or not contract_text_query.strip():
        issues.append("immutable service contract base_text_query must be nonblank text")
    else:
        if len(contract_text_query) > AGENTIC_SERVICE_MAX_TEXT_QUERY_LENGTH:
            issues.append("immutable service contract base_text_query must be at most 300 characters")
        if not _is_canonical_persona_text(contract_text_query, AGENTIC_SERVICE_MAX_TEXT_QUERY_LENGTH):
            issues.append("immutable service contract base_text_query must be canonical single-line text")
        if contract_text_query != actual_text_query:
            issues.append("target body must copy the immutable service contract base_text_query exactly")
    if contract.get("text_operator") not in {"and", "or"}:
        issues.append("immutable service contract text_operator must be and or or")
    elif contract.get("text_operator") != actual_text_operator:
        issues.append("target body must copy the immutable service contract text_operator exactly")
    sort_mode = contract.get("sort_mode")
    rank_features_enabled: bool | None = None
    if sort_mode not in {"listed_at_desc", "old_price_desc", "price_asc", "recommended"}:
        issues.append("immutable service contract sort_mode is unsupported")
    elif sort_mode == "recommended":
        rank_features_enabled = True
        if "rank_features" in contract:
            issues.append("recommended service contract must omit rank_features")
    else:
        rank_features_enabled = False
        if contract.get("rank_features") is not False:
            issues.append("explicit-sort service contract requires rank_features=false")
    if expectations:
        expected_mode = {
            "recommended": "recommended",
            "lowest_price": "price_asc",
            "newest": "listed_at_desc",
            "price_drop": "old_price_desc",
        }[expectations.sort_mode]
        if contract.get("sort_mode") != expected_mode:
            issues.append("immutable service contract sort_mode does not match expectations.sort_mode")
    if isinstance(query, Mapping):
        _validate_agentic_persona_clause(query, persona_expansion, issues)
        if rank_features_enabled is not None:
            _validate_contract_rank_features(query, rank_features_enabled, persona_expansion, issues)
    return persona_expansion


def _normalized_shopper_summary(contract: Mapping[str, object]) -> str | None:
    base_text_query = contract.get("base_text_query")
    filters = contract.get("filter")
    sort_mode = contract.get("sort_mode")
    if not isinstance(base_text_query, str) or not isinstance(filters, list) or len(filters) < 2:
        return None
    price_clause = filters[1]
    if not isinstance(price_clause, Mapping):
        return None
    range_clause = price_clause.get("range")
    if not isinstance(range_clause, Mapping):
        return None
    price = range_clause.get("price")
    if not isinstance(price, Mapping):
        return None
    price_limit = price.get("lte")
    if not isinstance(price_limit, int) or isinstance(price_limit, bool):
        return None
    if sort_mode == "price_asc":
        return f"cheapest {base_text_query} under {price_limit}"
    if sort_mode == "listed_at_desc":
        return f"newest {base_text_query} under {price_limit}"
    if sort_mode == "old_price_desc":
        return f"{base_text_query} with biggest price drops under {price_limit}"
    if sort_mode == "recommended":
        return f"{base_text_query} under {price_limit}"
    return None


def _validate_agentic_persona(value: object, issues: list[str]) -> str | None:
    if not isinstance(value, Mapping):
        issues.append("immutable service contract persona must be an object")
        return None

    anonymous_keys = {"id", "mode", "version"}
    profiled_keys = {"archetype", "background", "id", "mental_model", "query_expansion", "version"}
    keys = set(value)
    if keys == anonymous_keys:
        if value.get("id") != "anonymous" or value.get("mode") != "unprofiled" or value.get("version") != 1:
            issues.append("anonymous persona must be exactly id=anonymous, version=1, mode=unprofiled")
        return None
    if keys != profiled_keys:
        issues.append("profiled persona has invalid keys")
        return None

    persona_id = value.get("id")
    if (
        not isinstance(persona_id, str)
        or len(persona_id) > AGENTIC_PERSONA_MAX_ID_LENGTH
        or persona_id == "anonymous"
        or re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", persona_id) is None
    ):
        issues.append("profiled persona id must be a non-anonymous lowercase kebab-case identifier")
    version = value.get("version")
    if not isinstance(version, int) or isinstance(version, bool) or not 1 <= version <= 1_000:
        issues.append("profiled persona version must be an integer between 1 and 1000")

    limits = {
        "archetype": AGENTIC_PERSONA_MAX_ARCHETYPE_LENGTH,
        "background": AGENTIC_PERSONA_MAX_BACKGROUND_LENGTH,
        "mental_model": AGENTIC_PERSONA_MAX_MENTAL_MODEL_LENGTH,
        "query_expansion": AGENTIC_PERSONA_MAX_QUERY_EXPANSION_LENGTH,
    }
    for field, limit in limits.items():
        if not _is_canonical_persona_text(value.get(field), limit):
            issues.append(f"profiled persona {field} must contain 1-{limit} canonical single-line characters")
    if len(json.dumps(dict(value), ensure_ascii=False, separators=(",", ":"))) > AGENTIC_PERSONA_MAX_CONTEXT_LENGTH:
        issues.append(f"profiled persona context must be at most {AGENTIC_PERSONA_MAX_CONTEXT_LENGTH} characters")
    expansion = value.get("query_expansion")
    return expansion if isinstance(expansion, str) and expansion else None


def _is_canonical_persona_text(value: object, maximum: int) -> bool:
    return (
        isinstance(value, str)
        and 1 <= len(value) <= maximum
        and "\n" not in value
        and "\r" not in value
        and re.sub(r"\s+", " ", value).strip() == value
    )


def _persona_multi_match_clause(expansion: str) -> dict[str, object]:
    return {
        "multi_match": {
            "query": expansion,
            "fields": AGENTIC_CANONICAL_MULTI_MATCH_FIELDS,
            "operator": "or",
            "boost": AGENTIC_PERSONA_EXPANSION_BOOST,
        }
    }


def _validate_agentic_persona_clause(
    query: Mapping[str, object],
    persona_expansion: str | None,
    issues: list[str],
) -> None:
    bool_query = query.get("bool")
    if not isinstance(bool_query, Mapping):
        return
    should = bool_query.get("should", [])
    should_clauses = should if isinstance(should, list) else []
    direct_multi_match_clauses = [
        clause for clause in should_clauses if isinstance(clause, Mapping) and set(clause) == {"multi_match"}
    ]
    if persona_expansion is None:
        if direct_multi_match_clauses:
            issues.append("anonymous persona must omit the persona multi_match clause")
        return
    expected = _persona_multi_match_clause(persona_expansion)
    if not should_clauses or should_clauses[0] != expected or direct_multi_match_clauses != [expected]:
        issues.append("profiled persona requires its exact multi_match as the first bool.should clause")


def _validate_contract_rank_features(
    query: Mapping[str, object],
    enabled: bool,
    persona_expansion: str | None,
    issues: list[str],
) -> None:
    bool_query = query.get("bool")
    if not isinstance(bool_query, Mapping):
        return
    expected_should: list[object] = []
    if persona_expansion is not None:
        expected_should.append(_persona_multi_match_clause(persona_expansion))
    if enabled:
        expected_should.extend(
            {"rank_feature": {"field": field, "boost": boost}} for field, boost in AGENTIC_RECOMMENDED_RANK_FEATURES
        )
    actual_should = bool_query.get("should")
    if expected_should:
        if actual_should != expected_should:
            issues.append("target body does not match the immutable service contract rank_features recipe")
    elif actual_should is not None:
        issues.append("target body must omit bool.should when rank_features is false and persona is unprofiled")


def _validate_agentic_service_filters(value: object, issues: list[str]) -> None:
    if not isinstance(value, list) or not 2 <= len(value) <= 2 + len(AGENTIC_SERVICE_FILTER_FIELDS):
        issues.append("immutable service contract filters must use the canonical two-to-six-clause recipe")
        return
    if value[0] != {"term": {"availability": "active"}}:
        issues.append("immutable service contract filters must start with availability=active")

    price_clause = value[1]
    price_limit: object = None
    if isinstance(price_clause, Mapping) and set(price_clause) == {"range"}:
        range_query = price_clause["range"]
        if isinstance(range_query, Mapping) and set(range_query) == {"price"}:
            price_bounds = range_query["price"]
            if isinstance(price_bounds, Mapping) and set(price_bounds) == {"lte"}:
                price_limit = price_bounds["lte"]
    if (
        not isinstance(price_limit, int)
        or isinstance(price_limit, bool)
        or not 1 <= price_limit <= AGENTIC_SERVICE_MAX_PRICE
    ):
        issues.append("immutable service contract filters must use price lte 1..20000 as the second clause")

    previous_field_index = -1
    for clause in value[2:]:
        if not isinstance(clause, Mapping) or len(clause) != 1:
            issues.append("immutable service contract facet filters must be canonical term or terms clauses")
            continue
        query_type, payload = next(iter(clause.items()))
        if query_type not in {"term", "terms"} or not isinstance(payload, Mapping) or len(payload) != 1:
            issues.append("immutable service contract facet filters must be canonical term or terms clauses")
            continue
        field, raw_filter_value = next(iter(payload.items()))
        if field not in AGENTIC_SERVICE_FILTER_FIELDS:
            issues.append(f"immutable service contract contains an unsupported facet filter: {field}")
            continue
        field_index = AGENTIC_SERVICE_FILTER_FIELDS.index(field)
        if field_index <= previous_field_index:
            issues.append("immutable service contract facet filters must follow runtime field order without duplicates")
        previous_field_index = field_index

        raw_values = raw_filter_value if query_type == "terms" else [raw_filter_value]
        expected_minimum = 2 if query_type == "terms" else 1
        if (
            not isinstance(raw_values, list)
            or not expected_minimum <= len(raw_values) <= AGENTIC_SERVICE_MAX_VALUES_PER_FIELD
            or any(not _is_canonical_service_filter_value(item) for item in raw_values)
            or len(set(raw_values)) != len(raw_values)
        ):
            issues.append(f"immutable service contract {field} filter values are not canonical")


def _is_canonical_service_filter_value(value: object) -> bool:
    if not isinstance(value, str) or not 1 <= len(value) <= AGENTIC_SERVICE_MAX_VALUE_LENGTH or value.strip() != value:
        return False
    decomposed = unicodedata.normalize("NFKD", value)
    normalized = "".join(character for character in decomposed if not unicodedata.combining(character)).lower()
    return value == normalized


def _validate_query_structure(
    value: object,
    path: str,
    policy: CompilerPolicy,
    issues: list[str],
) -> None:
    if not isinstance(value, Mapping) or len(value) != 1:
        issues.append(f"{path} must contain exactly one query type")
        return
    query_type, payload = next(iter(value.items()))
    if query_type not in KNOWN_QUERY_TYPES:
        issues.append(f"unsupported query type at {path}: {query_type}")
        return
    if query_type not in policy.allowed_query_types:
        issues.append(f"query type is not allowlisted at {path}: {query_type}")
        return

    if query_type == "bool":
        if not isinstance(payload, Mapping):
            issues.append(f"{path}.bool must be an object")
            return
        allowed_bool_keys = {
            "adjust_pure_negative",
            "boost",
            "filter",
            "minimum_should_match",
            "must",
            "should",
        }
        for key in payload:
            if key not in allowed_bool_keys:
                issues.append(f"unsupported bool key at {path}.bool: {key}")
        if "minimum_should_match" in payload:
            minimum_should_match = payload["minimum_should_match"]
            raw_should = payload.get("should", [])
            should_count = len(raw_should) if isinstance(raw_should, list) else int(isinstance(raw_should, Mapping))
            if (
                not isinstance(minimum_should_match, int)
                or isinstance(minimum_should_match, bool)
                or not 0 <= minimum_should_match <= should_count
            ):
                issues.append(
                    f"{path}.bool.minimum_should_match must be an integer between 0 and "
                    f"the {should_count} should clauses"
                )
        for clause_name in ("filter", "must", "must_not", "should"):
            clauses = payload.get(clause_name, [])
            if isinstance(clauses, Mapping):
                clauses = [clauses]
            if not isinstance(clauses, list):
                issues.append(f"{path}.bool.{clause_name} must be an object or list")
                continue
            for index, clause in enumerate(clauses):
                _validate_query_structure(clause, f"{path}.bool.{clause_name}[{index}]", policy, issues)
    elif query_type == "hybrid":
        queries = payload.get("queries") if isinstance(payload, Mapping) else None
        if not isinstance(queries, list) or not queries:
            issues.append(f"{path}.hybrid.queries must be a non-empty list")
        else:
            for index, query in enumerate(queries):
                _validate_query_structure(query, f"{path}.hybrid.queries[{index}]", policy, issues)
    elif query_type == "nested":
        nested_query = payload.get("query") if isinstance(payload, Mapping) else None
        _validate_query_structure(nested_query, f"{path}.nested.query", policy, issues)


def _has_nonblank_shopper_query(request: AgenticPlannerInput) -> bool:
    first_line = request.query_text.splitlines()[0].strip()
    for prefix in ("Normalized shopper request:", "Shopper request (untrusted text):", "Shopper request:"):
        if first_line.casefold().startswith(prefix.casefold()):
            shopper_query = first_line[len(prefix) :].strip().removesuffix(".").strip()
            return bool(shopper_query) and shopper_query.casefold() != "show all available items"
    return bool(first_line)


def _query_requires_text_relevance(query: object, text_fields: set[str]) -> bool:
    if not isinstance(query, Mapping) or len(query) != 1:
        return False
    query_type, payload = next(iter(query.items()))
    if query_type in TEXT_RELEVANCE_QUERY_TYPES:
        return _is_nonempty_text_query(query_type, payload, text_fields)
    if query_type != "bool" or not isinstance(payload, Mapping):
        return False

    must = payload.get("must", [])
    if isinstance(must, Mapping):
        must_clauses = [must]
    elif isinstance(must, list):
        must_clauses = must
    else:
        must_clauses = []
    for clause in must_clauses:
        if not isinstance(clause, Mapping) or len(clause) != 1:
            continue
        clause_type, clause_payload = next(iter(clause.items()))
        if clause_type in TEXT_RELEVANCE_QUERY_TYPES and _is_nonempty_text_query(
            clause_type,
            clause_payload,
            text_fields,
        ):
            return True
    return False


def _is_nonempty_text_query(query_type: object, payload: object, text_fields: set[str]) -> bool:
    if not isinstance(payload, Mapping):
        return False
    if query_type in {"match", "match_phrase"}:
        if len(payload) != 1:
            return False
        field, value = next(iter(payload.items()))
        return isinstance(field, str) and field in text_fields and isinstance(value, str) and bool(value.strip())
    if query_type != "multi_match":
        return False
    query_text = payload.get("query")
    fields = payload.get("fields")
    return (
        isinstance(query_text, str)
        and bool(query_text.strip())
        and isinstance(fields, list)
        and bool(fields)
        and all(isinstance(field, str) and field.split("^", maxsplit=1)[0] in text_fields for field in fields)
    )


def _validate_required_constraint_placement(
    query: Mapping[str, object],
    required_fields: set[str],
    issues: list[str],
) -> None:
    direct_filter_counts = dict.fromkeys(required_fields, 0)

    def visit(node: object, path: str, *, direct_root_filter: bool = False, root: bool = False) -> None:
        if not isinstance(node, Mapping) or len(node) != 1:
            return
        query_type, payload = next(iter(node.items()))
        if not isinstance(payload, Mapping):
            return

        if query_type in FIELD_KEYED_QUERY_TYPES:
            for field in payload:
                if field not in required_fields:
                    continue
                if not direct_root_filter or query_type not in {"range", "term", "terms"}:
                    issues.append(
                        f"required constraint field {field} is only allowed as a direct body.query.bool.filter clause"
                    )
                else:
                    direct_filter_counts[field] += 1
        elif query_type == "multi_match":
            fields = payload.get("fields", [])
            if isinstance(fields, list):
                for field in fields:
                    base_field = field.split("^", maxsplit=1)[0] if isinstance(field, str) else None
                    if base_field in required_fields:
                        issues.append(f"required constraint field {base_field} must not be used for text relevance")
        elif query_type == "rank_feature":
            field = payload.get("field")
            if isinstance(field, str) and field in required_fields:
                issues.append(f"required constraint field {field} must not be used for rank_feature scoring")

        if query_type == "bool":
            for clause_name in ("filter", "must", "must_not", "should"):
                clauses = payload.get(clause_name, [])
                if isinstance(clauses, Mapping):
                    clauses = [clauses]
                if not isinstance(clauses, list):
                    continue
                for index, clause in enumerate(clauses):
                    visit(
                        clause,
                        f"{path}.bool.{clause_name}[{index}]",
                        direct_root_filter=root and clause_name == "filter",
                    )
        elif query_type == "hybrid":
            queries = payload.get("queries", [])
            if isinstance(queries, list):
                for index, child in enumerate(queries):
                    visit(child, f"{path}.hybrid.queries[{index}]")
        elif query_type == "nested":
            visit(payload.get("query"), f"{path}.nested.query")

    visit(query, "body.query", root=True)
    for field, count in direct_filter_counts.items():
        if count != 1:
            issues.append(
                f"required constraint field {field} must appear in exactly one direct body.query.bool.filter clause"
            )


def _validate_constraint(
    constraint: Constraint,
    path: str,
    request: QueryCompilerInput,
    policy: CompilerPolicy,
    issues: list[str],
) -> None:
    if constraint.op not in policy.allowed_constraint_ops:
        issues.append(f"{path}.op is not allowlisted: {constraint.op}")
    if not field_is_allowed(constraint.field, policy.allowed_fields):
        issues.append(f"{path}.field is not allowed by policy: {constraint.field}")
    if not field_is_allowed(constraint.field, request.allowed_schema.fields):
        issues.append(f"{path}.field is not allowed by request: {constraint.field}")


def _request_fields(request: QueryCompilerInput | AgenticPlannerInput, policy: CompilerPolicy) -> list[str]:
    if isinstance(request, QueryCompilerInput):
        candidates = request.allowed_schema.fields
    else:
        properties = agentic_mapping_properties(request.index_mapping)
        mapped_fields = set(properties)
        candidates = [field for field in request.query_fields if field.split(".", maxsplit=1)[0] in mapped_fields]
    return [field for field in candidates if field_is_allowed(field, policy.allowed_fields)]


def _request_text_fields(request: AgenticPlannerInput, policy: CompilerPolicy) -> set[str]:
    properties = agentic_mapping_properties(request.index_mapping)
    allowed_fields = set(_request_fields(request, policy))
    text_fields: set[str] = set()
    for field in request.query_fields:
        base_field = field.split("^", maxsplit=1)[0]
        mapping = properties.get(base_field)
        if field in allowed_fields and isinstance(mapping, Mapping) and mapping.get("type") == "text":
            text_fields.add(base_field)
    return text_fields


def _validate_agentic_query_semantics(
    query: Mapping[str, object],
    request: AgenticPlannerInput,
    policy: CompilerPolicy,
    issues: list[str],
) -> None:
    text_fields = _request_text_fields(request, policy)
    field_definitions = _request_field_definitions(request)
    field_types = {
        field: field_type
        for field, definition in field_definitions.items()
        if isinstance((field_type := definition.get("type")), str)
    }

    def visit(node: object, path: str) -> None:
        if not isinstance(node, Mapping) or len(node) != 1:
            return
        query_type, payload = next(iter(node.items()))
        if not isinstance(payload, Mapping):
            return

        if query_type in {"match", "match_phrase"}:
            if len(payload) != 1:
                issues.append(f"{path}.{query_type} must name exactly one mapped text field")
            else:
                field, value = next(iter(payload.items()))
                if field not in text_fields:
                    issues.append(f"{path}.{query_type} requires a mapped text field: {field}")
                if not isinstance(value, str) or not value.strip():
                    issues.append(f"{path}.{query_type} must contain nonblank query text")
        elif query_type == "multi_match":
            query_text = payload.get("query")
            fields = payload.get("fields")
            if not isinstance(query_text, str) or not query_text.strip():
                issues.append(f"{path}.multi_match.query must be nonblank text")
            if not isinstance(fields, list) or not fields:
                issues.append(f"{path}.multi_match.fields must be a non-empty list")
            else:
                for field in fields:
                    base_field = field.split("^", maxsplit=1)[0] if isinstance(field, str) else None
                    if base_field not in text_fields:
                        issues.append(f"{path}.multi_match requires mapped text fields: {base_field}")
        elif query_type == "range":
            _validate_range_payload(payload, path, field_types, issues)
        elif query_type in {"term", "terms"}:
            _validate_exact_payload(
                payload,
                path,
                query_type=query_type,
                field_definitions=field_definitions,
                issues=issues,
            )
        elif query_type == "prefix":
            _validate_single_typed_field(
                payload,
                path,
                query_type="prefix",
                field_types=field_types,
                expected_types={"constant_keyword", "keyword", "wildcard"},
                issues=issues,
            )
        elif query_type == "rank_feature":
            field = payload.get("field")
            unsupported = sorted(str(key) for key in set(payload) - {"boost", "field"})
            if unsupported:
                issues.append(f"{path}.rank_feature has unsupported keys: {', '.join(unsupported)}")
            if not isinstance(field, str) or field_types.get(field) != "rank_feature":
                issues.append(f"{path}.rank_feature requires a mapped rank_feature field: {field}")
            boost = payload.get("boost")
            if boost is not None and (
                not isinstance(boost, (int, float)) or isinstance(boost, bool) or not math.isfinite(boost)
            ):
                issues.append(f"{path}.rank_feature.boost must be a finite number")

        if query_type == "bool":
            _validate_conjunctive_constraints(payload, path, field_definitions, issues)
            for clause_name in ("filter", "must", "must_not", "should"):
                clauses = payload.get(clause_name, [])
                if isinstance(clauses, Mapping):
                    clauses = [clauses]
                if isinstance(clauses, list):
                    for index, clause in enumerate(clauses):
                        visit(clause, f"{path}.bool.{clause_name}[{index}]")
        elif query_type == "hybrid":
            queries = payload.get("queries", [])
            if isinstance(queries, list):
                for index, child in enumerate(queries):
                    visit(child, f"{path}.hybrid.queries[{index}]")
        elif query_type == "nested":
            visit(payload.get("query"), f"{path}.nested.query")

    visit(query, "body.query")


def _validate_single_typed_field(
    payload: Mapping[object, object],
    path: str,
    *,
    query_type: str,
    field_types: Mapping[str, str],
    expected_types: set[str],
    issues: list[str],
) -> None:
    if len(payload) != 1:
        issues.append(f"{path}.{query_type} must name exactly one field")
        return
    field, value = next(iter(payload.items()))
    if not isinstance(field, str) or field_types.get(field) not in expected_types:
        issues.append(f"{path}.{query_type} requires a compatible mapped field: {field}")
    if not isinstance(value, str) or not value.strip():
        issues.append(f"{path}.{query_type} must contain nonblank text")


def _request_field_definitions(request: AgenticPlannerInput) -> dict[str, Mapping[str, object]]:
    properties = agentic_mapping_properties(request.index_mapping)
    definitions: dict[str, Mapping[str, object]] = {}
    for field in request.query_fields:
        definition = properties.get(field)
        if isinstance(definition, Mapping):
            definitions[field] = definition
    return definitions


def _validate_exact_payload(
    payload: Mapping[object, object],
    path: str,
    *,
    query_type: str,
    field_definitions: Mapping[str, Mapping[str, object]],
    issues: list[str],
) -> None:
    if len(payload) != 1:
        issues.append(f"{path}.{query_type} must name exactly one field")
        return
    field, raw_value = next(iter(payload.items()))
    definition = field_definitions.get(field) if isinstance(field, str) else None
    if definition is None or not _exact_field_type_is_supported(definition.get("type")):
        issues.append(f"{path}.{query_type} requires a mapped exact-value field: {field}")
        return
    values = raw_value if query_type == "terms" else [raw_value]
    if not isinstance(values, list) or not values or len(values) > 100:
        issues.append(f"{path}.{query_type} must contain between 1 and 100 values")
        return
    if any(_mapped_exact_value_key(value, definition) is None for value in values):
        issues.append(f"{path}.{query_type}.{field} contains a value incompatible with its mapped type")


def _exact_field_type_is_supported(field_type: object) -> bool:
    return isinstance(field_type, str) and field_type in {
        "boolean",
        "byte",
        "constant_keyword",
        "date",
        "date_nanos",
        "double",
        "float",
        "half_float",
        "integer",
        "ip",
        "keyword",
        "long",
        "scaled_float",
        "short",
        "unsigned_long",
        "wildcard",
    }


def _validate_range_payload(
    payload: Mapping[object, object],
    path: str,
    field_types: Mapping[str, str],
    issues: list[str],
) -> None:
    if len(payload) != 1:
        issues.append(f"{path}.range must name exactly one field")
        return
    field, raw_bounds = next(iter(payload.items()))
    if not isinstance(field, str) or not isinstance(raw_bounds, Mapping) or not raw_bounds:
        issues.append(f"{path}.range must contain non-empty bounds for one field")
        return
    allowed_operators = {"gt", "gte", "lt", "lte"}
    if any(operator not in allowed_operators for operator in raw_bounds):
        issues.append(f"{path}.range.{field} supports only gt/gte/lt/lte")
        return

    field_type = field_types.get(field)
    if field_type in INTEGER_FIELD_LIMITS:
        comparable = {operator: _integer_range_value(value, field_type) for operator, value in raw_bounds.items()}
    elif field_type in FLOAT_FIELD_TYPES:
        comparable = {operator: _numeric_range_value(value) for operator, value in raw_bounds.items()}
    elif field_type in {"date", "date_nanos"}:
        comparable = {operator: _date_range_value(value) for operator, value in raw_bounds.items()}
    else:
        issues.append(f"{path}.range is not supported for mapped field {field}")
        return
    if any(value is None for value in comparable.values()):
        issues.append(f"{path}.range.{field} contains a value incompatible with mapped type {field_type}")
        return
    entries = [(str(operator), value) for operator, value in comparable.items() if value is not None]
    satisfiable = (
        _integer_range_entries_are_satisfiable(entries, INTEGER_FIELD_LIMITS[field_type])
        if isinstance(field_type, str) and field_type in INTEGER_FIELD_LIMITS
        else _range_entries_are_satisfiable(entries)
    )
    if not satisfiable:
        issues.append(f"{path}.range.{field} is unsatisfiable")


def _validate_conjunctive_constraints(
    payload: Mapping[object, object],
    path: str,
    field_definitions: Mapping[str, Mapping[str, object]],
    issues: list[str],
) -> None:
    exact_domains_by_field: dict[str, list[dict[tuple[str, object], object]]] = {}
    bounds_by_field: dict[str, list[tuple[str, float]]] = {}
    clause_count_by_field: dict[str, int] = {}

    for clause_name in ("filter", "must"):
        raw_clauses = payload.get(clause_name, [])
        clauses = [raw_clauses] if isinstance(raw_clauses, Mapping) else raw_clauses
        if not isinstance(clauses, list):
            continue
        for clause in clauses:
            if not isinstance(clause, Mapping) or len(clause) != 1:
                continue
            query_type, query_payload = next(iter(clause.items()))
            if not isinstance(query_payload, Mapping) or len(query_payload) != 1:
                continue
            field, raw_value = next(iter(query_payload.items()))
            if not isinstance(field, str):
                continue

            if query_type in {"term", "terms"}:
                raw_values = raw_value if query_type == "terms" else [raw_value]
                definition = field_definitions.get(field)
                if (
                    not isinstance(raw_values, list)
                    or not raw_values
                    or any(not _is_term_primitive(value) for value in raw_values)
                    or definition is None
                ):
                    continue
                keyed_values = [(_mapped_exact_value_key(value, definition), value) for value in raw_values]
                if any(key is None for key, _value in keyed_values):
                    continue
                domain = {key: value for key, value in keyed_values if key is not None}
                exact_domains_by_field.setdefault(field, []).append(domain)
                continue

            if query_type != "range" or not isinstance(raw_value, Mapping):
                continue
            raw_bounds = raw_value
            field_type = field_definitions.get(field, {}).get("type")
            if not isinstance(field_type, str) or (
                field_type not in NUMERIC_FIELD_TYPES and field_type not in {"date", "date_nanos"}
            ):
                continue
            converted = [(operator, _mapped_range_value(value, field_type)) for operator, value in raw_bounds.items()]
            if any(operator not in {"gt", "gte", "lt", "lte"} or value is None for operator, value in converted):
                continue
            clause_count_by_field[field] = clause_count_by_field.get(field, 0) + 1
            bounds_by_field.setdefault(field, []).extend(
                (str(operator), value) for operator, value in converted if value is not None
            )

    for field, domains in exact_domains_by_field.items():
        common_keys = set(domains[0])
        for domain in domains[1:]:
            common_keys.intersection_update(domain)
        if not common_keys:
            issues.append(f"{path}.bool conjunctive {field} exact constraints are unsatisfiable")
            continue

        bounds = bounds_by_field.get(field, [])
        if not bounds:
            continue
        field_type = field_definitions.get(field, {}).get("type")
        candidates = [_mapped_range_value(domains[0][key], field_type) for key in common_keys]
        if all(candidate is not None for candidate in candidates) and not any(
            _range_entries_match_value(bounds, candidate) for candidate in candidates if candidate is not None
        ):
            issues.append(f"{path}.bool conjunctive {field} exact/range constraints are unsatisfiable")

    for field, bounds in bounds_by_field.items():
        field_type = field_definitions.get(field, {}).get("type")
        satisfiable = (
            _integer_range_entries_are_satisfiable(bounds, INTEGER_FIELD_LIMITS[field_type])
            if isinstance(field_type, str) and field_type in INTEGER_FIELD_LIMITS
            else _range_entries_are_satisfiable(bounds)
        )
        if clause_count_by_field[field] > 1 and not satisfiable:
            issues.append(f"{path}.bool conjunctive {field} ranges are unsatisfiable")


def _mapped_exact_value_key(
    value: object,
    definition: Mapping[str, object],
) -> tuple[str, object] | None:
    field_type = definition.get("type")
    if field_type == "boolean":
        return ("boolean", value) if isinstance(value, bool) else None
    if isinstance(field_type, str) and field_type in INTEGER_FIELD_LIMITS:
        numeric = _integer_range_value(value, field_type)
        return ("number", numeric) if numeric is not None else None
    if isinstance(field_type, str) and field_type in FLOAT_FIELD_TYPES:
        numeric = _numeric_range_value(value)
        return ("number", numeric) if numeric is not None else None
    if isinstance(field_type, str) and field_type in {"date", "date_nanos"}:
        timestamp = _date_range_value(value)
        return ("date", timestamp) if timestamp is not None else None
    if (
        not isinstance(field_type, str)
        or field_type not in {"constant_keyword", "ip", "keyword", "wildcard"}
        or not isinstance(value, str)
    ):
        return None
    normalizer = definition.get("normalizer")
    if normalizer is None:
        return "string", value
    if normalizer != "lowercase_keyword":
        return None
    decomposed = unicodedata.normalize("NFKD", value)
    normalized = "".join(character for character in decomposed if not unicodedata.combining(character)).lower()
    return "string", normalized


def _range_entries_match_value(bounds: Sequence[tuple[str, float]], value: float) -> bool:
    return all(
        (operator == "gt" and value > bound)
        or (operator == "gte" and value >= bound)
        or (operator == "lt" and value < bound)
        or (operator == "lte" and value <= bound)
        for operator, bound in bounds
    )


def _numeric_range_value(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    converted = float(value)
    return converted if math.isfinite(converted) else None


def _integer_range_value(value: object, field_type: str) -> float | None:
    numeric = _numeric_range_value(value)
    if numeric is None or not numeric.is_integer():
        return None
    lower, upper = INTEGER_FIELD_LIMITS[field_type]
    return numeric if lower <= numeric <= upper else None


def _mapped_range_value(value: object, field_type: object) -> float | None:
    if isinstance(field_type, str) and field_type in INTEGER_FIELD_LIMITS:
        return _integer_range_value(value, field_type)
    if isinstance(field_type, str) and field_type in FLOAT_FIELD_TYPES:
        return _numeric_range_value(value)
    if isinstance(field_type, str) and field_type in {"date", "date_nanos"}:
        return _date_range_value(value)
    return None


def _date_range_value(value: object) -> float | None:
    numeric = _numeric_range_value(value)
    if numeric is not None:
        return numeric
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.timestamp() * 1_000


def _range_entries_are_satisfiable(bounds: Sequence[tuple[str, float]]) -> bool:
    lower: list[tuple[float, bool]] = []
    upper: list[tuple[float, bool]] = []
    for operator, value in bounds:
        if operator in {"gt", "gte"}:
            lower.append((value, operator == "gt"))
        elif operator in {"lt", "lte"}:
            upper.append((value, operator == "lt"))
    if not lower or not upper:
        return True
    lower_value, lower_strict = max(lower, key=lambda item: (item[0], item[1]))
    upper_value, upper_strict = min(upper, key=lambda item: (item[0], not item[1]))
    return lower_value < upper_value or (lower_value == upper_value and not lower_strict and not upper_strict)


def _integer_range_entries_are_satisfiable(
    bounds: Sequence[tuple[str, float]],
    limits: tuple[int, int],
) -> bool:
    lower: float = limits[0]
    upper: float = limits[1]
    for operator, value in bounds:
        if operator in {"gt", "gte"}:
            candidate = value + 1 if operator == "gt" else value
            lower = max(lower, candidate)
        elif operator in {"lt", "lte"}:
            candidate = value - 1 if operator == "lt" else value
            upper = min(upper, candidate)
    return lower <= upper


def _inspect_dsl(
    value: object,
    path: str,
    policy: CompilerPolicy,
    allowed_fields: Sequence[str],
    issues: list[str],
) -> int:
    if isinstance(value, list):
        return sum(
            _inspect_dsl(item, f"{path}[{index}]", policy, allowed_fields, issues) for index, item in enumerate(value)
        )
    if not isinstance(value, dict):
        return 0

    clause_count = 0
    for key, child in value.items():
        child_path = f"{path}.{key}"
        if key in policy.forbidden_keys:
            issues.append(f"forbidden DSL key at {child_path}")
        if key in KNOWN_QUERY_TYPES:
            clause_count += 1
            if key not in policy.allowed_query_types:
                issues.append(f"query type is not allowlisted at {child_path}: {key}")
        if key == "k" and (not isinstance(child, int) or isinstance(child, bool) or not 1 <= child <= policy.max_k):
            issues.append(f"{child_path} must be an integer between 1 and {policy.max_k}")
        if key == "terms":
            _inspect_terms_payload(child, child_path, issues)
        if key in FIELD_KEYED_QUERY_TYPES and isinstance(child, dict):
            for field in child:
                _check_field(field, child_path, allowed_fields, issues)
        if key == "multi_match" and isinstance(child, dict):
            fields = child.get("fields", [])
            if not isinstance(fields, list):
                issues.append(f"{child_path}.fields must be a list")
            else:
                for field in fields:
                    if isinstance(field, str):
                        _check_field(field, f"{child_path}.fields", allowed_fields, issues)
                    else:
                        issues.append(f"{child_path}.fields contains a non-string value")
        if key == "rank_feature" and isinstance(child, dict):
            field = child.get("field")
            if isinstance(field, str):
                _check_field(field, f"{child_path}.field", allowed_fields, issues)
            else:
                issues.append(f"{child_path}.field must be a string")
        if key == "_source":
            _inspect_source_fields(child, child_path, allowed_fields, issues)
        clause_count += _inspect_dsl(child, child_path, policy, allowed_fields, issues)
    return clause_count


def _inspect_terms_payload(value: object, path: str, issues: list[str]) -> None:
    if not isinstance(value, Mapping) or len(value) != 1:
        issues.append(f"{path} must contain exactly one field with a non-empty array of primitive values")
        return
    field, terms = next(iter(value.items()))
    if isinstance(terms, Mapping):
        issues.append(f"{path}.{field} must be an array of primitive values; terms lookup is forbidden")
        return
    if not isinstance(field, str) or not isinstance(terms, list) or not terms or len(terms) > 100:
        issues.append(f"{path} must contain exactly one field with a non-empty array of primitive values")
        return
    if any(not _is_term_primitive(term) for term in terms):
        issues.append(f"{path}.{field} must be a non-empty array of primitive values; terms lookup is forbidden")


def _is_term_primitive(value: object) -> bool:
    return isinstance(value, (bool, int, str)) or (isinstance(value, float) and math.isfinite(value))


def _inspect_source_fields(value: object, path: str, allowed_fields: Sequence[str], issues: list[str]) -> None:
    candidates: list[object] = []
    if isinstance(value, list):
        candidates.extend(value)
    elif isinstance(value, dict):
        for key in ("includes", "excludes"):
            fields = value.get(key, [])
            if isinstance(fields, list):
                candidates.extend(fields)
    for field in candidates:
        if isinstance(field, str):
            _check_field(field, path, allowed_fields, issues)
        else:
            issues.append(f"{path} contains a non-string field")


def _inspect_sort(
    value: object,
    allowed_fields: Sequence[str],
    issues: list[str],
    field_types: Mapping[str, object] | None = None,
) -> None:
    if value is None:
        return
    if not isinstance(value, list):
        issues.append("body.sort must be a list")
        return
    if not value:
        issues.append("body.sort must not be empty")
        return
    for index, clause in enumerate(value):
        if not isinstance(clause, Mapping) or len(clause) != 1:
            issues.append(f"body.sort[{index}] must be an object naming exactly one field")
            continue
        field, options = next(iter(clause.items()))
        if not isinstance(field, str):
            issues.append(f"body.sort[{index}] field must be a string")
            continue
        if field != "_score":
            _check_field(field, f"body.sort[{index}]", allowed_fields, issues)
            if field_types and field_types.get(field) in {"rank_feature", "rank_features", "text"}:
                issues.append(f"body.sort[{index}] uses unsortable mapped field: {field}")
        if not isinstance(options, Mapping):
            issues.append(f"body.sort[{index}].{field} must be an options object")
            continue
        unsupported_options = sorted(set(options) - {"missing", "order"})
        if unsupported_options:
            issues.append(f"body.sort[{index}].{field} has unsupported options: {', '.join(unsupported_options)}")
        if options.get("order") not in {"asc", "desc"}:
            issues.append(f"body.sort[{index}].{field}.order must be asc or desc")
        if "missing" in options and options["missing"] not in {"_first", "_last"}:
            issues.append(f"body.sort[{index}].{field}.missing must be _first or _last")


def _validate_expected_sort(body: Mapping[str, object], sort_mode: str, issues: list[str]) -> None:
    value = body.get("sort")
    if sort_mode == "recommended":
        if "sort" not in body:
            return
        issues.append("body.sort must be omitted for recommended ranking")
        return

    requirements = {
        "lowest_price": ("price", "asc", None),
        "newest": ("listed_at", "desc", None),
        "price_drop": ("old_price", "desc", "_last"),
    }
    expected = requirements[sort_mode]
    if not isinstance(value, list) or len(value) != 2:
        issues.append(f"body.sort must contain exactly two clauses for {sort_mode}")
        return
    first = _sort_clause(value, 0)
    if first != expected:
        field, order, missing = expected
        suffix = f" with missing={missing}" if missing else ""
        issues.append(f"body.sort must use {field} {order}{suffix} as the primary sort for {sort_mode}")
    if _sort_clause(value, 1) != ("_score", "desc", None):
        issues.append(f"body.sort must use _score desc as the secondary sort for {sort_mode}")


def _validate_expected_text_recipe(
    query: Mapping[str, object],
    sort_mode: str,
    has_persona_expansion: bool,
    issues: list[str],
) -> None:
    bool_query = query.get("bool")
    if not isinstance(bool_query, Mapping):
        issues.append("body.query must use the canonical root bool recipe")
        return
    expected_keys = (
        {"filter", "must", "should"} if sort_mode == "recommended" or has_persona_expansion else {"filter", "must"}
    )
    if set(bool_query) != expected_keys:
        issues.append(f"body.query.bool keys must be exactly: {', '.join(sorted(expected_keys))}")

    must = bool_query.get("must")
    if not isinstance(must, list) or len(must) != 1 or not isinstance(must[0], Mapping):
        issues.append("body.query.bool.must must contain exactly one direct multi_match")
        return
    clause = must[0]
    if set(clause) != {"multi_match"} or not isinstance(clause.get("multi_match"), Mapping):
        issues.append("body.query.bool.must must contain exactly one direct multi_match")
        return
    multi_match = clause["multi_match"]
    assert isinstance(multi_match, Mapping)
    expected_keys = {"fields", "operator", "query"}
    expected_fields = AGENTIC_CANONICAL_MULTI_MATCH_FIELDS
    if set(multi_match) != expected_keys:
        issues.append("canonical multi_match keys must be exactly fields, operator, and query")
    if multi_match.get("fields") != expected_fields:
        issues.append("canonical multi_match fields do not match the service recipe")
    query_text = multi_match.get("query")
    if not isinstance(query_text, str) or not query_text.strip():
        issues.append("canonical multi_match query must be nonblank text")
    if multi_match.get("operator") not in {"and", "or"}:
        issues.append("canonical multi_match operator must be and or or")


def _validate_expected_ranking(
    query: Mapping[str, object],
    sort_mode: str,
    persona_expansion: str | None,
    issues: list[str],
) -> None:
    clauses: list[tuple[str, object, str]] = []

    def visit(node: object, path: str) -> None:
        if not isinstance(node, Mapping) or len(node) != 1:
            return
        query_type, payload = next(iter(node.items()))
        if not isinstance(payload, Mapping):
            return
        if query_type == "rank_feature":
            clauses.append((str(payload.get("field")), payload.get("boost"), path))
            return
        if query_type != "bool":
            return
        for clause_name in ("filter", "must", "should"):
            children = payload.get(clause_name, [])
            if isinstance(children, Mapping):
                children = [children]
            if isinstance(children, list):
                for index, child in enumerate(children):
                    visit(child, f"{path}.bool.{clause_name}[{index}]")

    visit(query, "body.query")
    bool_query = query.get("bool")
    should = bool_query.get("should") if isinstance(bool_query, Mapping) else None
    expected_should: list[object] = []
    if persona_expansion is not None:
        expected_should.append(_persona_multi_match_clause(persona_expansion))
    if sort_mode == "recommended":
        expected_should.extend(
            {"rank_feature": {"field": field, "boost": boost}} for field, boost in AGENTIC_RECOMMENDED_RANK_FEATURES
        )

    if not expected_should:
        if should is not None or clauses:
            issues.append(f"bool.should and rank_feature clauses must be omitted for {sort_mode}")
        return
    if sort_mode != "recommended" and clauses:
        issues.append(f"rank_feature clauses must be omitted for {sort_mode}")
    if not isinstance(should, list) or should != expected_should:
        if sort_mode == "recommended" and persona_expansion is None:
            issues.append("recommended ranking requires exactly three canonical rank_feature clauses")
        elif persona_expansion is not None:
            issues.append("personalization and ranking must use the exact canonical bool.should recipe")
        else:
            issues.append(f"bool.should must use the canonical recipe for {sort_mode}")
        return

    expected = dict(AGENTIC_RECOMMENDED_RANK_FEATURES) if sort_mode == "recommended" else {}
    if len(clauses) != len(expected):
        if sort_mode == "recommended":
            issues.append("recommended ranking requires exactly three canonical rank_feature clauses")
        else:
            issues.append(f"rank_feature clauses must be omitted for {sort_mode}")
        return
    seen: set[str] = set()
    for field, boost, path in clauses:
        if re.fullmatch(r"body\.query\.bool\.should\[\d+\]", path) is None or expected.get(field) != boost:
            issues.append(
                "recommended rank_feature clauses must use canonical fields, boosts, and bool.should placement"
            )
            return
        if field in seen:
            issues.append(f"recommended rank_feature field is duplicated: {field}")
            return
        seen.add(field)


def _sort_clause(value: object, index: int) -> tuple[str, str | None, str | None] | None:
    if not isinstance(value, list) or len(value) <= index:
        return None
    clause = value[index]
    if isinstance(clause, str):
        return clause, None, None
    if not isinstance(clause, dict) or len(clause) != 1:
        return None
    field, options = next(iter(clause.items()))
    if not isinstance(field, str):
        return None
    if isinstance(options, str):
        return field, options, None
    if not isinstance(options, dict):
        return field, None, None
    order = options.get("order")
    missing = options.get("missing")
    return (
        field,
        order if isinstance(order, str) else None,
        missing if isinstance(missing, str) else None,
    )


def constraint_is_present(body: Mapping[str, object], constraint: Constraint) -> bool:
    for clause in _direct_positive_filter_clauses(body.get("query")):
        if _clause_contains_constraint(clause, constraint):
            return True
    return False


def _constraint_filter_clause(constraint: Constraint) -> dict[str, object]:
    if constraint.op in {"term", "eq"}:
        return {"term": {constraint.field: constraint.value}}
    if constraint.op == "terms":
        return {"terms": {constraint.field: constraint.value}}
    return {"range": {constraint.field: {constraint.op: constraint.value}}}


def _clause_contains_constraint(clause: object, constraint: Constraint) -> bool:
    if not isinstance(clause, Mapping) or len(clause) != 1:
        return False
    query_type, payload = next(iter(clause.items()))
    if not isinstance(payload, Mapping) or len(payload) != 1 or constraint.field not in payload:
        return False
    actual = payload[constraint.field]

    if constraint.op in {"term", "eq"}:
        return query_type == "term" and _strict_scalar_equal(actual, constraint.value)
    if constraint.op == "terms":
        if query_type != "terms":
            return False
        actual_values = _primitive_set(actual)
        expected_values = _primitive_set(constraint.value)
        return actual_values is not None and actual_values == expected_values
    if constraint.op not in {"gt", "gte", "lt", "lte"} or query_type != "range":
        return False
    if not isinstance(actual, Mapping) or constraint.op not in actual:
        return False
    return _strict_scalar_equal(actual[constraint.op], constraint.value)


def _direct_positive_filter_clauses(query: object) -> list[object]:
    if not isinstance(query, Mapping) or set(query) != {"bool"}:
        return []
    bool_query = query["bool"]
    if not isinstance(bool_query, Mapping):
        return []
    filters = bool_query.get("filter", [])
    if isinstance(filters, Mapping):
        return [filters]
    return filters if isinstance(filters, list) else []


def _primitive_set(value: object) -> frozenset[tuple[str, str]] | None:
    if not isinstance(value, list) or not value:
        return None
    keys: set[tuple[str, str]] = set()
    for item in value:
        key = _term_primitive_key(item)
        if key is None:
            return None
        keys.add(key)
    return frozenset(keys)


def _term_primitive_key(value: object) -> tuple[str, str] | None:
    if isinstance(value, bool):
        return "boolean", "true" if value else "false"
    if isinstance(value, str):
        return "string", value
    if isinstance(value, int):
        return "integer", str(value)
    if isinstance(value, float):
        return "number", repr(value)
    return None


def _strict_scalar_equal(left: object, right: object) -> bool:
    return type(left) is type(right) and left == right


def _check_field(field: str, path: str, allowed_fields: Sequence[str], issues: list[str]) -> None:
    if not field_is_allowed(field, allowed_fields):
        issues.append(f"field is not allowlisted at {path}: {field}")
