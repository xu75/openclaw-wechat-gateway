#!/usr/bin/env bash
set -Eeuo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLIENT="${DIR}/wechat_publish_gateway.sh"
BASE_URL="${OPENCLAW_WECHAT_GATEWAY_BASE_URL:-http://127.0.0.1:3000}"

tmp_md="$(mktemp)"
cat <<'EOF' > "$tmp_md"
# OpenClaw Markdown Publish Smoke

This is a smoke run from the OpenClaw skill bundle.

- raw markdown must be forwarded as-is
- content_format must stay markdown
- preferred_channel must stay browser

![cover](https://example.com/cover.png)
EOF

echo '== publish =='
publish_json="$("$CLIENT" publish --gateway-base-url "$BASE_URL" --output json --title 'OpenClaw Smoke Publish' --context-id 'smoke-script' < "$tmp_md")"
echo "$publish_json" | jq .

task_id="$(echo "$publish_json" | jq -r '.task_id')"
status="$(echo "$publish_json" | jq -r '.status')"
[[ -n "$task_id" && "$task_id" != "null" ]] || {
  echo 'publish did not return task_id' >&2
  exit 1
}

echo
echo '== status =='
status_json="$("$CLIENT" status "$task_id" --gateway-base-url "$BASE_URL" --output json)"
echo "$status_json" | jq .

echo
echo '== confirm-login =='
confirm_json="$("$CLIENT" confirm-login "$task_id" --gateway-base-url "$BASE_URL" --output json)"
echo "$confirm_json" | jq .

echo
echo '== confirm-login again =='
confirm_again_json="$("$CLIENT" confirm-login "$task_id" --gateway-base-url "$BASE_URL" --output json)"
echo "$confirm_again_json" | jq .

echo
echo '== assertions =='
echo "$publish_json" | jq -e '.ok == true' >/dev/null
echo "$status_json" | jq -e --arg task "$task_id" '.task_id == $task' >/dev/null
echo "$confirm_again_json" | jq -e '.ok == false and .error.code == "STATUS_CONFLICT"' >/dev/null

if [[ "$status" == "waiting_login" ]]; then
  echo "$publish_json" | jq -e '.task.login_qr_mime != null and .task.login_qr_png_base64 != null and .task.login_session_expires_at != null' >/dev/null
fi

echo 'Smoke checks passed.'

rm -f "$tmp_md"
