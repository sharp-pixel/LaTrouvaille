"""Versioned input, output, and dataset contracts."""

from __future__ import annotations

import math
from enum import StrEnum
from typing import Literal, Self

from pydantic import BaseModel, ConfigDict, Field, JsonValue, model_validator

SCHEMA_VERSION = "psg_query_compiler_v1"


class StrictModel(BaseModel):
    """Base model that rejects accidental contract drift."""

    model_config = ConfigDict(extra="forbid")


class QueryType(StrEnum):
    LOOKUP = "lookup"
    COMPARISON = "comparison"
    RECOMMENDATION = "recommendation"
    EXPLORATORY_SEARCH = "exploratory_search"
    FILTER_REFINEMENT = "filter_refinement"


class Expertise(StrEnum):
    NOVICE = "novice"
    INTERMEDIATE = "intermediate"
    EXPERT = "expert"


class DatasetSlice(StrEnum):
    CLEAN_SINGLE_CATEGORY = "clean_single_category"
    AMBIGUOUS_PERSONA = "ambiguous_persona"
    EXPERTISE_CONTRAST = "expertise_contrast"
    CROSS_CATEGORY = "cross_category"
    DSL_HARD_CASE = "dsl_hard_case"
    NEGATIVE_REPAIR = "negative_repair"


class Budget(StrictModel):
    minimum: float | None = Field(default=None, ge=0)
    maximum: float | None = Field(default=None, ge=0)
    currency: str = Field(default="EUR", min_length=3, max_length=3)

    @model_validator(mode="after")
    def validate_bounds(self) -> Self:
        if self.minimum is not None and self.maximum is not None and self.minimum > self.maximum:
            raise ValueError("budget minimum cannot exceed maximum")
        return self


class UserContext(StrictModel):
    persona_summary: str = Field(min_length=1, max_length=2_000)
    category_expertise: dict[str, Expertise] = Field(default_factory=dict)
    budget: Budget | None = None


class AllowedSchema(StrictModel):
    indexes: list[str] = Field(min_length=1)
    categories: list[str] = Field(min_length=1)
    fields: list[str] = Field(min_length=1)
    search_pipelines: list[str] = Field(default_factory=list)


class QueryCompilerInput(StrictModel):
    raw_query: str = Field(min_length=1, max_length=1_000)
    user_context: UserContext
    allowed_schema: AllowedSchema
    current_filters: list[Constraint] = Field(default_factory=list)
    category_ontology: dict[str, JsonValue] = Field(default_factory=dict)
    output_schema: Literal["psg_query_compiler_v1"] = "psg_query_compiler_v1"


class ResolutionWeights(StrictModel):
    category: float = Field(ge=0, le=1)
    brand: float = Field(ge=0, le=1)
    collection: float = Field(ge=0, le=1)
    model_line: float = Field(ge=0, le=1)
    reference: float = Field(ge=0, le=1)
    variant: float = Field(ge=0, le=1)

    @model_validator(mode="after")
    def validate_sum(self) -> Self:
        total = sum(self.model_dump().values())
        if not math.isclose(total, 1.0, abs_tol=0.01):
            raise ValueError(f"resolution weights must sum to 1.0 (received {total:.4f})")
        return self


class MentalModelWeights(StrictModel):
    quiet_luxury: float = Field(ge=0, le=1)
    visible_status: float = Field(ge=0, le=1)
    craftsmanship: float = Field(ge=0, le=1)
    performance: float = Field(ge=0, le=1)
    utility: float = Field(ge=0, le=1)
    heritage: float = Field(ge=0, le=1)
    novelty: float = Field(ge=0, le=1)
    value_retention: float = Field(ge=0, le=1)


class Rewrites(StrictModel):
    embedding_query: str = Field(min_length=1, max_length=4_000)
    keyword_query: str = Field(min_length=1, max_length=4_000)
    negative_query: str = Field(default="", max_length=4_000)


class Constraint(StrictModel):
    field: str = Field(min_length=1, max_length=200)
    op: Literal["term", "terms", "eq", "gt", "gte", "lt", "lte"]
    value: JsonValue


class Constraints(StrictModel):
    filters: list[Constraint] = Field(default_factory=list)
    must_not: list[Constraint] = Field(default_factory=list)


class OpenSearchRequest(StrictModel):
    index: str = Field(min_length=1, max_length=200)
    search_pipeline: str | None = Field(default=None, max_length=200)
    body: dict[str, JsonValue]


class QueryCompilerOutput(StrictModel):
    schema_version: Literal["psg_query_compiler_v1"] = "psg_query_compiler_v1"
    raw_query: str = Field(min_length=1, max_length=1_000)
    category: str = Field(pattern=r"^[a-z][a-z0-9_]*$")
    query_type: QueryType
    user_expertise: Expertise
    confidence: float = Field(ge=0, le=1)
    clarification_needed: bool
    clarification_question: str | None = Field(default=None, max_length=1_000)
    resolution_weights: ResolutionWeights
    mental_model_weights: MentalModelWeights
    rewrites: Rewrites
    constraints: Constraints
    opensearch: OpenSearchRequest

    @model_validator(mode="after")
    def validate_clarification(self) -> Self:
        if self.clarification_needed and not self.clarification_question:
            raise ValueError("clarification_question is required when clarification_needed is true")
        if not self.clarification_needed and self.clarification_question is not None:
            raise ValueError("clarification_question must be null when clarification_needed is false")
        return self


class TrainingExample(StrictModel):
    example_id: str = Field(pattern=r"^[a-z0-9][a-z0-9_-]*$")
    slice: DatasetSlice
    input: QueryCompilerInput
    output: QueryCompilerOutput

    @model_validator(mode="after")
    def validate_pair(self) -> Self:
        if self.input.raw_query != self.output.raw_query:
            raise ValueError("input and output raw_query values must match exactly")
        return self
