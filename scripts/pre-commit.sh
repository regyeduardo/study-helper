#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"

echo "[pre-commit] Executando testes unitários..."

echo "  → pytest (api)"
(cd "$ROOT/backend/api" && python -m pytest -q)

echo "  → vitest (web)"
(cd "$ROOT/frontend/web" && npm run test -- --run)

echo "[pre-commit] Todos os testes passaram."
