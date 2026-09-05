#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"

echo "[pre-push] Iniciando stack de teste..."
docker compose -f "$ROOT/compose.yml" -f "$ROOT/compose.test.yml" up -d --wait

cleanup() {
  echo "[pre-push] Derrubando stack de teste..."
  docker compose -f "$ROOT/compose.yml" -f "$ROOT/compose.test.yml" down
}
trap cleanup EXIT

echo "[pre-push] Executando suite E2E..."
(cd "$ROOT/e2e" && npm ci --prefer-offline && npx playwright test)

echo "[pre-push] E2E passou."
