#!/usr/bin/env sh
# Install .githooks as the active git hooks directory for this clone (#1153).
# Run once after cloning: bun run pre-commit-setup
set -e
git config core.hooksPath .githooks
chmod +x .githooks/pre-commit
echo "hooks installed — gitleaks will scan staged changes on every commit"
