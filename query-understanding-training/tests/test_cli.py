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


def test_build_data_check_command(project_root: Path, monkeypatch) -> None:
    monkeypatch.chdir(project_root)
    result = CliRunner().invoke(app, ["build-data", "--check"])
    assert result.exit_code == 0, result.output
    assert '"group_overlap": []' in result.output
    assert '"ranking_family_overlap": []' in result.output
    assert '"rows": 4640' in result.output
