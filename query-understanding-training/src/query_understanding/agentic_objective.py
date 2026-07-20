"""Prompt construction for the native OpenSearch QueryPlanningTool objective."""

from __future__ import annotations

import json
from importlib.resources import files
from pathlib import Path

from query_understanding.schemas import AgenticPlannerInput

OBJECTIVE_NAME = "opensearch_agentic_query_planner_v1"


def load_system_prompt(path: Path | None = None) -> str:
    prompt = (
        path.read_text(encoding="utf-8")
        if path is not None
        else files("query_understanding")
        .joinpath("prompts/opensearch-agentic-query-planner-v1.txt")
        .read_text(encoding="utf-8")
    ).strip()
    if not prompt:
        raise ValueError(f"agentic objective system prompt is empty: {path or 'packaged resource'}")
    return prompt


def load_user_prompt_template(path: Path | None = None) -> str:
    template = (
        path.read_text(encoding="utf-8")
        if path is not None
        else files("query_understanding")
        .joinpath("prompts/opensearch-agentic-query-planner-user-v1.txt")
        .read_text(encoding="utf-8")
    ).strip()
    if not template:
        raise ValueError(f"agentic objective user prompt is empty: {path or 'packaged resource'}")
    return template


def build_query_planner_user_prompt(request: AgenticPlannerInput, template: str | None = None) -> str:
    rendered = template or load_user_prompt_template()
    replacements = {
        "${parameters.question}": request.query_text,
        "${parameters.index_mapping:-}": _native_string_parameter(request.index_mapping),
        "${parameters.query_fields:-}": _native_string_parameter(request.query_fields),
    }
    for placeholder, value in replacements.items():
        rendered = rendered.replace(placeholder, value)
    return rendered


def _compact_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _native_string_parameter(value: object) -> str:
    """Mirror QueryPlanningTool's Gson serialization of mapping and query-field strings."""

    return json.dumps(_compact_json(value), ensure_ascii=False)
