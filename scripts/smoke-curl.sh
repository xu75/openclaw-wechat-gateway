#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
TASK_ID="${TASK_ID:-task-smoke-$(date +%s)}"
IDEMPOTENCY_KEY="${IDEMPOTENCY_KEY:-idem-${TASK_ID}}"
REQUEST_ID="${REQUEST_ID:-req-smoke-$(date +%s)}"

echo '== POST /wechat/publish =='
curl -sS -X POST "${BASE_URL}/wechat/publish" \
  -H "x-request-id: ${REQUEST_ID}" \
  -H 'Content-Type: application/json' \
  -d '{
    "task_id": "'"${TASK_ID}"'",
    "idempotency_key": "'"${IDEMPOTENCY_KEY}"'",
    "title": "Smoke Test",
    "content": "# hello from smoke\n\n![img](https://example.com/a.png)",
    "content_format": "markdown",
    "preferred_channel": "browser"
  }'
echo
echo

echo '== GET /wechat/publish/:task_id =='
curl -sS -X GET "${BASE_URL}/wechat/publish/${TASK_ID}" \
  -H "x-request-id: ${REQUEST_ID}"
echo
echo

echo '== POST /wechat/publish/:task_id/confirm-login =='
curl -sS -X POST "${BASE_URL}/wechat/publish/${TASK_ID}/confirm-login" \
  -H "x-request-id: ${REQUEST_ID}" \
  -H 'Content-Type: application/json' || true
echo
