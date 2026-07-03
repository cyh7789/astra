#!/usr/bin/env bash
# 本地單節點 CockroachDB（開發/測試用，insecure 僅限 localhost）
set -euo pipefail
cd "$(dirname "$0")/.."
STORE_DIR=".astra-data/crdb"
mkdir -p "$STORE_DIR"
exec cockroach start-single-node \
  --insecure \
  --store="$STORE_DIR" \
  --listen-addr=localhost:26257 \
  --http-addr=localhost:8090 \
  --background
