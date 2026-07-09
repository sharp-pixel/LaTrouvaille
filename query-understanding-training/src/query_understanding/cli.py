"""Command-line interface for data, schema, training, and evaluation workflows."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Annotated

import typer

from query_understanding.config import load_training_config
from query_understanding.dataset import ValidationReport, validate_dataset
from query_understanding.evaluation import evaluate_predictions
from query_understanding.policy import load_policy
from query_understanding.schemas import QueryCompilerOutput
from query_understanding.training import environment_report, require_supported_python, run_training

app = typer.Typer(no_args_is_help=True, pretty_exceptions_show_locals=False)
DEFAULT_CONFIG = Path("configs/qlora-5090.yaml")


@app.command("show-config")
def show_config(
    config: Annotated[Path, typer.Option("--config", "-c", exists=True)] = DEFAULT_CONFIG,
) -> None:
    """Load, validate, and print the fully resolved training configuration."""
    loaded = load_training_config(config)
    typer.echo(json.dumps(loaded.model_dump(mode="json"), indent=2, sort_keys=True))


@app.command("validate-data")
def validate_data(
    config: Annotated[Path, typer.Option("--config", "-c", exists=True)] = DEFAULT_CONFIG,
) -> None:
    """Validate train/eval JSONL against the schema and OpenSearch safety policy."""
    loaded = load_training_config(config)
    policy = load_policy(loaded.data.policy_file)
    reports = [
        validate_dataset(loaded.data.train_file, policy),
        validate_dataset(loaded.data.eval_file, policy),
    ]
    typer.echo(json.dumps([_report_dict(report) for report in reports], indent=2, sort_keys=True))
    if not all(report.ok for report in reports):
        raise typer.Exit(1)


@app.command("export-schema")
def export_schema(
    output: Annotated[Path | None, typer.Option("--output", "-o")] = None,
) -> None:
    """Export the versioned model-output JSON Schema."""
    rendered = json.dumps(QueryCompilerOutput.model_json_schema(), indent=2, sort_keys=True) + "\n"
    if output is None:
        typer.echo(rendered, nl=False)
        return
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(rendered, encoding="utf-8")
    typer.echo(str(output.resolve()))


@app.command()
def doctor(
    training: Annotated[bool, typer.Option("--training", help="Inspect the optional GPU training stack.")] = False,
) -> None:
    """Report whether the local environment can validate data or run QLoRA."""
    require_supported_python()
    report = environment_report(include_training_stack=training)
    typer.echo(json.dumps(report, indent=2, sort_keys=True))
    if training and not report.get("ready"):
        raise typer.Exit(1)


@app.command()
def train(
    config: Annotated[Path, typer.Option("--config", "-c", exists=True)] = DEFAULT_CONFIG,
    execute: Annotated[
        bool,
        typer.Option("--execute", help="Download the model and start training; omitted means safe dry-run."),
    ] = False,
    resume: Annotated[Path | None, typer.Option("--resume", exists=True)] = None,
) -> None:
    """Validate inputs and optionally run the configured QLoRA job."""
    loaded = load_training_config(config)
    policy = load_policy(loaded.data.policy_file)
    reports = [
        validate_dataset(loaded.data.train_file, policy),
        validate_dataset(loaded.data.eval_file, policy),
    ]
    if not all(report.ok for report in reports):
        typer.echo(json.dumps([_report_dict(report) for report in reports], indent=2, sort_keys=True))
        raise typer.Exit(1)
    if not execute:
        typer.echo(
            json.dumps(
                {
                    "dry_run": True,
                    "config": loaded.model_dump(mode="json"),
                    "datasets": [_report_dict(report) for report in reports],
                    "next": "rerun with --execute on the RTX 5090 host",
                },
                indent=2,
                sort_keys=True,
            )
        )
        return
    destination = run_training(loaded, Path.cwd(), resume_from_checkpoint=resume)
    typer.echo(str(destination))


@app.command()
def evaluate(
    predictions: Annotated[Path, typer.Option("--predictions", "-p", exists=True)],
    config: Annotated[Path, typer.Option("--config", "-c", exists=True)] = DEFAULT_CONFIG,
) -> None:
    """Score model outputs against the configured held-out structural evaluation set."""
    loaded = load_training_config(config)
    policy = load_policy(loaded.data.policy_file)
    report = evaluate_predictions(loaded.data.eval_file, predictions, policy)
    typer.echo(json.dumps(report.to_dict(), indent=2, sort_keys=True))


def _report_dict(report: ValidationReport) -> dict[str, object]:
    return {
        "path": str(report.path),
        "total": report.total,
        "valid": report.valid,
        "slice_counts": report.slice_counts,
        "ok": report.ok,
        "issues": [
            {"line": issue.line, "example_id": issue.example_id, "message": issue.message} for issue in report.issues
        ],
    }


if __name__ == "__main__":
    app()
