# Repository Guidelines

## Project Structure & Module Organization
This repository contains two independent projects:

- `query-understanding-training/`: Python `uv` project for query compiler training, validation, and evaluation.
- `retail-search-prototype/`: React/Vite prototype with OpenSearch scripts, local UBI capture, and static assets.

Key locations:

- `query-understanding-training/src/query_understanding/`: core Python package
- `query-understanding-training/tests/`: pytest suite
- `query-understanding-training/configs/`: training and policy profiles
- `retail-search-prototype/src/`: React app source
- `retail-search-prototype/scripts/`: OpenSearch, API, and data tooling
- `retail-search-prototype/public/assets/`: product images and other static assets

## Build, Test, and Development Commands
Run commands from the relevant subproject directory.

### Python project

```bash
uv sync --locked --no-editable
uv run --locked --no-editable pytest
uv run --no-editable quft validate-data
uv run --no-editable quft train
```

### React prototype

```bash
npm install
npm run dev
npm run build
npm run opensearch:bootstrap
```

`npm run dev` starts the local UI. `npm run build` verifies the production bundle.

## Coding Style & Naming Conventions
Use ASCII unless a file already uses Unicode. Keep edits small and aligned with existing patterns.

- Python: 4-space indentation, `ruff` formatting/linting, `mypy --strict`, type annotations for public code.
- JavaScript/React: ES modules, functional components, descriptive camelCase for variables/functions, PascalCase for components.
- File names: use lowercase with hyphens for docs/assets and `snake_case.py` for Python modules.

## Testing Guidelines
Python tests use `pytest`; keep unit tests in `query-understanding-training/tests/` and name them `test_*.py`. Use markers only when needed: `integration`, `gpu`, `model`.

The React project does not currently ship a formal test suite. Verify UI or script changes with `npm run build` and, when relevant, a local browser check plus OpenSearch bootstrap scripts.

## Commit & Pull Request Guidelines
There is no long Git history yet, so use concise imperative commit subjects, such as `Add base project files and ignore rules`.

For pull requests, include:

- A short summary of the change
- Commands run for verification
- Screenshots for UI changes in `retail-search-prototype`
- Notes about any data, OpenSearch, or GPU requirements

## Agent-Specific Notes
`retail-search-prototype/AGENTS.md` contains prototype-specific workflow notes. Keep that file in sync with any durable UI or process changes made in the prototype.
