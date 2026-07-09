from pathlib import Path

from typer.testing import CliRunner

from query_understanding.cli import app


def test_validate_data_command(project_root: Path, monkeypatch) -> None:
    monkeypatch.chdir(project_root)
    result = CliRunner().invoke(app, ["validate-data"])
    assert result.exit_code == 0, result.output
    assert '"ok": true' in result.output


def test_train_defaults_to_safe_dry_run(project_root: Path, monkeypatch) -> None:
    monkeypatch.chdir(project_root)
    result = CliRunner().invoke(app, ["train"])
    assert result.exit_code == 0, result.output
    assert '"dry_run": true' in result.output
    assert "rerun with --execute" in result.output
