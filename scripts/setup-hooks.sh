#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
HOOKS="$ROOT/.git/hooks"

ln -sf "../../scripts/pre-commit.sh" "$HOOKS/pre-commit"
chmod +x "$HOOKS/pre-commit"

ln -sf "../../scripts/pre-push.sh" "$HOOKS/pre-push"
chmod +x "$HOOKS/pre-push"

echo "Git hooks instalados."
echo "  pre-commit → scripts/pre-commit.sh"
echo "  pre-push   → scripts/pre-push.sh"
