#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

DB_FILE="e2e/.tmp/e2e.db"
mkdir -p e2e/.tmp
rm -f "$DB_FILE" "$DB_FILE-shm" "$DB_FILE-wal"

export DB_DRIVER=sqlite
export SQLITE_FILE="$DB_FILE"
export AUTH_MODE=email
export SEED_ON_BOOT=demo
export BOOTSTRAP_ADMIN_EMAIL="e2e-admin@example.com"
export PORT=4400
export PUBLIC_WEB_ORIGIN="http://localhost:4400"
export JIRA_BASE_URL="http://localhost:4610"
export JIRA_EMAIL="stub@example.com"
export JIRA_API_TOKEN="stub-token"
export SCHEDULER_ENABLED=false

exec node server/dist/index.js
