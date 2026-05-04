#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

: "${WRIGHTFUL_URL:=http://localhost:5173}"
: "${WRIGHTFUL_TOKEN:=$(jq -r .apiKey ../dashboard/.dev.vars.seed.json)}"
: "${LOAD_TEST_COUNT:=1000}"
: "${LOAD_TEST_WORKERS:=16}"

export WRIGHTFUL_URL WRIGHTFUL_TOKEN LOAD_TEST_COUNT LOAD_TEST_WORKERS

echo "→ Running $LOAD_TEST_COUNT tests across $LOAD_TEST_WORKERS workers → $WRIGHTFUL_URL"

exec npx playwright test --config playwright.load.config.ts "$@"
