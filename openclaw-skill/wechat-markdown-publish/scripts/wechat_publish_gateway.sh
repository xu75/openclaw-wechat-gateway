#!/usr/bin/env bash
set -Eeuo pipefail

BASE_URL="${OPENCLAW_WECHAT_GATEWAY_BASE_URL:-http://127.0.0.1:3000}"
OUTPUT_FORMAT="text"
REQUEST_ID_PREFIX="${OPENCLAW_WECHAT_REQUEST_ID_PREFIX:-oc-mdpub}"
CONTEXT_ID=""
TITLE=""
TASK_ID=""
IDEMPOTENCY_KEY=""
SUBCOMMAND="${1:-}"

usage() {
  cat <<'EOF'
Usage:
  wechat_publish_gateway.sh publish --title "<title>" [--task-id "<task_id>"] [--idempotency-key "<key>"] [--context-id "<chat_id>"] [--gateway-base-url "<url>"] [--output text|json] < markdown.md
  wechat_publish_gateway.sh confirm-login <task_id> [--gateway-base-url "<url>"] [--output text|json]
  wechat_publish_gateway.sh status <task_id> [--gateway-base-url "<url>"] [--output text|json]
EOF
}

json_escape() {
  jq -Rn --arg v "${1:-}" '$v'
}

slugify() {
  local value="${1:-context}"
  value="$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')"
  value="$(printf '%s' "$value" | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//; s/-{2,}/-/g')"
  if [[ -z "$value" ]]; then
    value="context"
  fi
  printf '%s' "$value"
}

sha256_12() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print substr($1,1,12)}'
    return
  fi
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print substr($1,1,12)}'
    return
  fi
  cksum "$1" | awk '{print $1}'
}

base64_decode_to_file() {
  local output_file="$1"
  if printf '' | base64 --decode >/dev/null 2>&1; then
    base64 --decode >"$output_file"
    return
  fi
  if printf '' | base64 -d >/dev/null 2>&1; then
    base64 -d >"$output_file"
    return
  fi
  if printf '' | base64 -D >/dev/null 2>&1; then
    base64 -D >"$output_file"
    return
  fi
  echo 'No supported base64 decoder found.' >&2
  return 1
}

materialize_login_qr_png() {
  local task_id_value="$1"
  local login_qr_png_base64="$2"

  if [[ -z "$task_id_value" || -z "$login_qr_png_base64" ]]; then
    return 1
  fi

  local state_dir="${OPENCLAW_STATE_DIR:-${HOME:-/root}/.openclaw}"
  local qr_dir=''
  if [[ -n "${OPENCLAW_WECHAT_QR_DIR:-}" ]]; then
    qr_dir="$OPENCLAW_WECHAT_QR_DIR"
  elif [[ "$task_id_value" == mdpub-telegram-* ]]; then
    qr_dir="${state_dir%/}/workspaces/telegram/.openclaw-wechat-publish-qr"
  elif [[ "$task_id_value" == mdpub-feishu-* ]]; then
    qr_dir="${state_dir%/}/workspaces/feishu/.openclaw-wechat-publish-qr"
  elif [[ "$task_id_value" == mdpub-wecom-* ]]; then
    qr_dir="${state_dir%/}/workspaces/wecom/.openclaw-wechat-publish-qr"
  else
    qr_dir="${state_dir%/}/workspace/.openclaw-wechat-publish-qr"
  fi
  mkdir -p "$qr_dir"
  chmod 700 "$qr_dir" 2>/dev/null || true

  local output_file="${qr_dir%/}/${task_id_value}.png"
  if ! printf '%s' "$login_qr_png_base64" | tr -d '\r\n\t ' | base64_decode_to_file "$output_file"; then
    rm -f "$output_file"
    return 1
  fi
  if [[ ! -s "$output_file" ]]; then
    rm -f "$output_file"
    return 1
  fi

  printf '%s' "$output_file"
}

iso_now() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

request_id() {
  printf '%s-%s-%s-%s' "$REQUEST_ID_PREFIX" "$1" "$(date -u +%Y%m%d%H%M%S)" "$RANDOM"
}

friendly_error_message() {
  case "${1:-}" in
    STATUS_CONFLICT)
      printf '%s' '当前任务状态不允许此操作，或 confirm-login 重试机会已经消耗。'
      ;;
    IDEMPOTENCY_CONFLICT)
      printf '%s' '任务标识发生冲突：相同 task_id 或 idempotency_key 已被占用。'
      ;;
    IMAGE_POLICY_VIOLATION)
      printf '%s' '图片策略校验失败，Gateway 已拒绝本次发布。'
      ;;
    CONTENT_INVALID)
      printf '%s' '内容校验失败，Gateway 未接受本次发布。'
      ;;
    AGENT_UNAVAILABLE|AGENT_SIGNATURE_ERROR)
      printf '%s' 'Gateway 下游发布器当前不可用，请稍后重试。'
      ;;
    TASK_NOT_FOUND)
      printf '%s' '找不到对应的发布任务。'
      ;;
    WAITING_LOGIN_TIMEOUT)
      printf '%s' '登录等待已超时，任务已进入人工介入状态。'
      ;;
    INVALID_REQUEST)
      printf '%s' '请求参数不合法。'
      ;;
    *)
      printf '%s' ''
      ;;
  esac
}

emit_json() {
  jq -cn "$@"
}

format_success_text() {
  local operation="$1"
  local gateway_request_id="$2"
  local request_id_value="$3"
  local task_json="$4"
  local status
  status="$(jq -r '.status // "unknown"' <<<"$task_json")"
  local task_id_value
  task_id_value="$(jq -r '.task_id // empty' <<<"$task_json")"
  local publish_url
  publish_url="$(jq -r '.publish_url // empty' <<<"$task_json")"
  local error_code
  error_code="$(jq -r '.error_code // empty' <<<"$task_json")"
  local error_message
  error_message="$(jq -r '.error_message // empty' <<<"$task_json")"
  local login_qr_mime
  login_qr_mime="$(jq -r '.login_qr_mime // empty' <<<"$task_json")"
  local login_qr_png_base64
  login_qr_png_base64="$(jq -r '.login_qr_png_base64 // empty' <<<"$task_json")"
  local expires_at
  expires_at="$(jq -r '.login_session_expires_at // .expires_at // empty' <<<"$task_json")"
  local login_qr_png_path=''

  cat <<EOF
操作: ${operation}
task_id: ${task_id_value}
status: ${status}
request_id: ${request_id_value}
gateway_request_id: ${gateway_request_id}
EOF

  if [[ -n "$publish_url" && "$publish_url" != "null" ]]; then
    printf 'publish_url: %s\n' "$publish_url"
  fi
  if [[ -n "$error_code" ]]; then
    printf 'error.code: %s\n' "$error_code"
  fi
  if [[ -n "$error_message" ]]; then
    printf 'error.message: %s\n' "$error_message"
  fi
  if [[ "$status" == "waiting_login" ]]; then
    printf 'login_qr_mime: %s\n' "${login_qr_mime:-}"
    printf 'expires_at: %s\n' "${expires_at:-}"
    printf 'login_qr_png_base64:\n'
    printf '```text\n%s\n```\n' "${login_qr_png_base64:-}"
    if login_qr_png_path="$(materialize_login_qr_png "$task_id_value" "$login_qr_png_base64" 2>/dev/null)"; then
      printf 'login_qr_png_path: %s\n' "$login_qr_png_path"
      printf 'MEDIA: %s\n' "$login_qr_png_path"
    fi
  fi
}

format_error_text() {
  local operation="$1"
  local request_id_value="$2"
  local gateway_request_id="$3"
  local task_id_value="$4"
  local current_status="$5"
  local error_json="$6"

  local error_code
  error_code="$(jq -r '.code // "INTERNAL_ERROR"' <<<"$error_json")"
  local raw_message
  raw_message="$(jq -r '.message // "request failed"' <<<"$error_json")"
  local friendly
  friendly="$(friendly_error_message "$error_code")"
  local details
  details="$(jq -c '.details // null' <<<"$error_json")"

  cat <<EOF
操作: ${operation}
task_id: ${task_id_value}
status: ${current_status}
request_id: ${request_id_value}
gateway_request_id: ${gateway_request_id}
error.code: ${error_code}
message: ${friendly:-$raw_message}
EOF

  if [[ "$friendly" != "$raw_message" && -n "$raw_message" ]]; then
    printf 'raw_message: %s\n' "$raw_message"
  fi

  if [[ "$error_code" == "IMAGE_POLICY_VIOLATION" ]]; then
    printf 'replaced_count: %s\n' "$(jq -r '.replaced_count // 0' <<<"$details")"
    printf 'failed_images:\n'
    printf '```json\n%s\n```\n' "$(jq -c '.failed_images // []' <<<"$details")"
  elif [[ "$details" != "null" ]]; then
    printf 'details:\n'
    printf '```json\n%s\n```\n' "$details"
  fi
}

gateway_call() {
  local method="$1"
  local path="$2"
  local body_file="${3:-}"
  local request_id_value="$4"
  local headers_file body_out http_status

  headers_file="$(mktemp)"
  body_out="$(mktemp)"
  local url="${BASE_URL%/}${path}"

  if [[ -n "$body_file" ]]; then
    http_status="$(curl -sS -X "$method" "$url" \
      -H "x-request-id: ${request_id_value}" \
      -H 'Content-Type: application/json' \
      --data-binary "@${body_file}" \
      -D "$headers_file" \
      -o "$body_out" \
      -w '%{http_code}')"
  else
    http_status="$(curl -sS -X "$method" "$url" \
      -H "x-request-id: ${request_id_value}" \
      -D "$headers_file" \
      -o "$body_out" \
      -w '%{http_code}')"
  fi

  local gateway_request_id
  gateway_request_id="$(awk 'BEGIN{IGNORECASE=1} /^x-request-id:/ {gsub("\r","",$2); print $2}' "$headers_file" | tail -n 1)"
  if [[ -z "$gateway_request_id" ]]; then
    gateway_request_id="$request_id_value"
  fi

  local body_json
  body_json="$(cat "$body_out")"

  rm -f "$headers_file" "$body_out"

  emit_json \
    --arg request_id "$request_id_value" \
    --arg gateway_request_id "$gateway_request_id" \
    --argjson http_status "${http_status}" \
    --argjson body "${body_json:-null}" \
    '{request_id:$request_id,gateway_request_id:$gateway_request_id,http_status:$http_status,body:$body}'
}

fetch_current_status() {
  local task_id_value="$1"
  local status_request_id
  status_request_id="$(request_id status)"
  local lookup_json
  lookup_json="$(gateway_call GET "/wechat/publish/${task_id_value}" "" "$status_request_id")"
  local lookup_status
  lookup_status="$(jq -r '.http_status' <<<"$lookup_json")"
  if [[ "$lookup_status" =~ ^2 ]] && jq -e '.body.ok == true and .body.data.task_id != null' >/dev/null 2>&1 <<<"$lookup_json"; then
    jq -c '.body.data' <<<"$lookup_json"
    return 0
  fi
  return 1
}

publish_flow() {
  local content_file body_file raw_content context_slug digest task_json result_json
  content_file="$(mktemp)"
  cat > "$content_file"
  if [[ ! -s "$content_file" ]]; then
    echo 'Markdown content is empty.' >&2
    rm -f "$content_file"
    exit 2
  fi

  context_slug="$(slugify "${CONTEXT_ID:-chat}")"
  digest="$(sha256_12 "$content_file")"
  if [[ -z "$TASK_ID" ]]; then
    TASK_ID="mdpub-${context_slug}-$(date -u +%Y%m%d%H%M%S)"
  fi
  if [[ -z "$IDEMPOTENCY_KEY" ]]; then
    IDEMPOTENCY_KEY="${TASK_ID}-${digest}"
  fi

  body_file="$(mktemp)"
  jq -cn \
    --arg task_id "$TASK_ID" \
    --arg idempotency_key "$IDEMPOTENCY_KEY" \
    --arg title "$TITLE" \
    --rawfile content "$content_file" \
    '{
      task_id: $task_id,
      idempotency_key: $idempotency_key,
      title: $title,
      content: $content,
      content_format: "markdown",
      preferred_channel: "browser"
    }' > "$body_file"

  result_json="$(gateway_call POST '/wechat/publish' "$body_file" "$(request_id publish)")"
  emit_result "publish" "$TASK_ID" "$result_json"

  rm -f "$content_file" "$body_file"
}

confirm_login_flow() {
  local task_id_value="$1"
  local result_json
  result_json="$(gateway_call POST "/wechat/publish/${task_id_value}/confirm-login" "" "$(request_id confirm)")"
  emit_result "confirm-login" "$task_id_value" "$result_json"
}

status_flow() {
  local task_id_value="$1"
  local result_json
  result_json="$(gateway_call GET "/wechat/publish/${task_id_value}" "" "$(request_id status)")"
  emit_result "status" "$task_id_value" "$result_json"
}

emit_result() {
  local operation="$1"
  local requested_task_id="$2"
  local response_json="$3"
  local request_id_value gateway_request_id http_status

  request_id_value="$(jq -r '.request_id' <<<"$response_json")"
  gateway_request_id="$(jq -r '.gateway_request_id' <<<"$response_json")"
  http_status="$(jq -r '.http_status' <<<"$response_json")"

  if [[ "$http_status" =~ ^2 ]] && jq -e '.body.ok == true and .body.data != null' >/dev/null 2>&1 <<<"$response_json"; then
    local task_json qr_png_path
    task_json="$(jq -c '.body.data' <<<"$response_json")"
    qr_png_path="$(materialize_login_qr_png "$(jq -r '.task_id // empty' <<<"$task_json")" "$(jq -r '.login_qr_png_base64 // empty' <<<"$task_json")" 2>/dev/null || true)"
    if [[ "$OUTPUT_FORMAT" == "json" ]]; then
      emit_json \
        --arg operation "$operation" \
        --arg request_id "$request_id_value" \
        --arg gateway_request_id "$gateway_request_id" \
        --argjson http_status "$http_status" \
        --arg task_id "$(jq -r '.task_id // empty' <<<"$task_json")" \
        --arg status "$(jq -r '.status // "unknown"' <<<"$task_json")" \
        --arg user_message "$(format_success_text "$operation" "$gateway_request_id" "$request_id_value" "$task_json")" \
        --arg qr_png_path "$qr_png_path" \
        --argjson task "$task_json" \
        '{ok:true,operation:$operation,request_id:$request_id,gateway_request_id:$gateway_request_id,http_status:$http_status,task_id:$task_id,status:$status,user_message:$user_message,qr_png_path:($qr_png_path|select(length>0)),task:$task}'
    else
      format_success_text "$operation" "$gateway_request_id" "$request_id_value" "$task_json"
    fi
    return 0
  fi

  local error_json current_task_json current_status
  error_json="$(jq -c '.body.error // {code:"INTERNAL_ERROR",message:"request failed"}' <<<"$response_json")"
  current_status="unknown"
  current_task_json=''
  if [[ -n "$requested_task_id" ]]; then
    if current_task_json="$(fetch_current_status "$requested_task_id" 2>/dev/null)"; then
      current_status="$(jq -r '.status // "unknown"' <<<"$current_task_json")"
    elif [[ "$operation" == "publish" ]]; then
      current_status="request_failed"
    fi
  fi

  if [[ "$OUTPUT_FORMAT" == "json" ]]; then
    emit_json \
      --arg operation "$operation" \
      --arg request_id "$request_id_value" \
      --arg gateway_request_id "$gateway_request_id" \
      --argjson http_status "$http_status" \
      --arg task_id "$requested_task_id" \
      --arg status "$current_status" \
      --arg user_message "$(format_error_text "$operation" "$request_id_value" "$gateway_request_id" "$requested_task_id" "$current_status" "$error_json")" \
      --argjson error "$error_json" \
      --argjson task "$(if [[ -n "$current_task_json" ]]; then printf '%s' "$current_task_json"; else printf '%s' 'null'; fi)" \
      '{ok:false,operation:$operation,request_id:$request_id,gateway_request_id:$gateway_request_id,http_status:$http_status,task_id:$task_id,status:$status,user_message:$user_message,error:$error,task:$task}'
  else
    format_error_text "$operation" "$request_id_value" "$gateway_request_id" "$requested_task_id" "$current_status" "$error_json"
  fi
}

shift || true

while [[ $# -gt 0 ]]; do
  case "$1" in
    --gateway-base-url)
      BASE_URL="${2:-}"
      shift 2
      ;;
    --output)
      OUTPUT_FORMAT="${2:-}"
      shift 2
      ;;
    --context-id)
      CONTEXT_ID="${2:-}"
      shift 2
      ;;
    --title)
      TITLE="${2:-}"
      shift 2
      ;;
    --task-id)
      TASK_ID="${2:-}"
      shift 2
      ;;
    --idempotency-key)
      IDEMPOTENCY_KEY="${2:-}"
      shift 2
      ;;
    -*)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      break
      ;;
  esac
done

case "$SUBCOMMAND" in
  publish)
    if [[ -z "$TITLE" ]]; then
      echo '--title is required for publish' >&2
      exit 2
    fi
    publish_flow
    ;;
  confirm-login)
    if [[ $# -lt 1 ]]; then
      echo 'task_id is required for confirm-login' >&2
      exit 2
    fi
    confirm_login_flow "$1"
    ;;
  status)
    if [[ $# -lt 1 ]]; then
      echo 'task_id is required for status' >&2
      exit 2
    fi
    status_flow "$1"
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
