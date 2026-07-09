"""Allowlist and resource-budget validation for model-produced OpenSearch requests."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from fnmatch import fnmatchcase
from pathlib import Path

import yaml
from pydantic import BaseModel, ConfigDict, Field

from query_understanding.schemas import Constraint, QueryCompilerInput, QueryCompilerOutput

KNOWN_QUERY_TYPES = frozenset(
    {
        "bool",
        "hybrid",
        "knn",
        "match",
        "multi_match",
        "nested",
        "neural",
        "range",
        "rank_feature",
        "term",
        "terms",
    }
)
FIELD_KEYED_QUERY_TYPES = frozenset({"knn", "match", "neural", "range", "term", "terms"})


class CompilerPolicy(BaseModel):
    model_config = ConfigDict(extra="forbid")

    allowed_indexes: list[str] = Field(min_length=1)
    allowed_fields: list[str] = Field(min_length=1)
    allowed_search_pipelines: list[str] = Field(default_factory=list)
    allowed_query_types: list[str] = Field(min_length=1)
    forbidden_keys: list[str] = Field(default_factory=list)
    allowed_constraint_ops: list[str] = Field(min_length=1)
    max_size: int = Field(default=50, ge=1, le=1_000)
    max_from: int = Field(default=1_000, ge=0)
    max_k: int = Field(default=500, ge=1)
    max_query_clauses: int = Field(default=100, ge=1)


class PolicyViolation(ValueError):
    """Raised when a compiler output exceeds the configured safety policy."""

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

    body = output.opensearch.body
    size = body.get("size")
    if not isinstance(size, int) or isinstance(size, bool) or not 1 <= size <= policy.max_size:
        issues.append(f"body.size must be an integer between 1 and {policy.max_size}")
    offset = body.get("from", 0)
    if not isinstance(offset, int) or isinstance(offset, bool) or not 0 <= offset <= policy.max_from:
        issues.append(f"body.from must be an integer between 0 and {policy.max_from}")

    allowed_fields = [
        field for field in request.allowed_schema.fields if field_is_allowed(field, policy.allowed_fields)
    ]
    clause_count = _inspect_dsl(body, "$", policy, allowed_fields, issues)
    if clause_count > policy.max_query_clauses:
        issues.append(f"DSL has {clause_count} query clauses; limit is {policy.max_query_clauses}")

    if issues:
        raise PolicyViolation(issues)


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


def _check_field(field: str, path: str, allowed_fields: Sequence[str], issues: list[str]) -> None:
    if not field_is_allowed(field, allowed_fields):
        issues.append(f"field is not allowlisted at {path}: {field}")
