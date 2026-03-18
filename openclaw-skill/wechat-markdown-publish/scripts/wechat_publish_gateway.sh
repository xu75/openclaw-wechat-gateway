#!/usr/bin/env bash
set -Eeuo pipefail

BASE_URL="${OPENCLAW_WECHAT_GATEWAY_BASE_URL:-http://127.0.0.1:3000}"
AGENT_BASE_URL="${OPENCLAW_WECHAT_AGENT_BASE_URL:-http://127.0.0.1:14273}"
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
  wechat_publish_gateway.sh relogin [--agent-base-url "<url>"] [--output text|json]
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
  local error_code="${1:-}"
  local operation="${2:-}"
  local current_status="${3:-}"
  local task_error_code="${4:-}"

  case "$error_code" in
    STATUS_CONFLICT)
      if [[ "$operation" == "confirm-login" && "$current_status" == "manual_intervention" ]]; then
        printf '%s' '任务已进入 manual_intervention，当前 task 无法继续 confirm。请重新发送 /publish_wechat 新建任务。'
      elif [[ "$operation" == "confirm-login" ]]; then
        printf '%s' '当前任务状态不允许 confirm，或 confirm-login 重试机会已经消耗。'
      else
        printf '%s' '当前任务状态不允许此操作。'
      fi
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
    AGENT_BUSINESS_ERROR)
      if [[ "$task_error_code" == "BROWSER_CONTENT_INJECTION_FAILED" ]]; then
        printf '%s' '本次失败是编辑器注入失败，不是登录失败。请重新发送 /publish_wechat 新建任务重试。'
      else
        printf '%s' 'Gateway 与发布器交互返回业务错误，请重新发起发布。'
      fi
      ;;
    *)
      printf '%s' ''
      ;;
  esac
}

action_hint_message() {
  local operation="${1:-}"
  local current_status="${2:-}"
  local error_code="${3:-}"
  local task_error_code="${4:-}"

  if [[ "$current_status" == "manual_intervention" && "$task_error_code" == "BROWSER_CONTENT_INJECTION_FAILED" ]]; then
    printf '%s' '建议: 直接发送 /publish_wechat 新建任务重试；不要对当前 task 再执行 confirm。'
    return
  fi

  if [[ "$current_status" == "manual_intervention" && "$task_error_code" == "WAITING_LOGIN_TIMEOUT" ]]; then
    printf '%s' '建议: 先发送 /publish_wechat_relogin 获取新二维码，再发送 /publish_wechat。'
    return
  fi

  case "$error_code" in
    STATUS_CONFLICT)
      if [[ "$operation" == "confirm-login" ]]; then
        printf '%s' '建议: 对该 task 停止 confirm。若需继续发布，请发送 /publish_wechat 新建任务。'
      fi
      ;;
    WAITING_LOGIN_TIMEOUT)
      printf '%s' '建议: 发送 /publish_wechat_relogin 获取新二维码，然后重新 /publish_wechat。'
      ;;
    AGENT_SIGNATURE_ERROR)
      printf '%s' '建议: 检查 Gateway 与 Agent 的签名密钥配置是否一致。'
      ;;
    AGENT_UNAVAILABLE)
      printf '%s' '建议: 先检查 Agent/MCP 与 FRP 连通性，再重试 /publish_wechat。'
      ;;
    AGENT_BUSINESS_ERROR)
      if [[ "$task_error_code" != "BROWSER_CONTENT_INJECTION_FAILED" ]]; then
        printf '%s' '建议: 重新发送 /publish_wechat 新建任务；若持续失败，再排查 Gateway 到 Agent 的 MCP 会话。'
      fi
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
  local suppress_base64_text='false'

  # In text mode, always prefer image attachment delivery via MEDIA and avoid base64 blocks.
  if [[ "$OUTPUT_FORMAT" == "text" ]]; then
    suppress_base64_text='true'
  fi

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
    if [[ "$suppress_base64_text" != "true" ]]; then
      printf 'login_qr_png_base64:\n'
      printf '```text\n%s\n```\n' "${login_qr_png_base64:-}"
    fi
    if login_qr_png_path="$(materialize_login_qr_png "$task_id_value" "$login_qr_png_base64" 2>/dev/null)"; then
      printf 'login_qr_png_path: %s\n' "$login_qr_png_path"
    fi
  fi
  if [[ "$status" == "manual_intervention" ]]; then
    local manual_hint
    manual_hint="$(action_hint_message "$operation" "$status" "$error_code" "$error_code")"
    if [[ -n "$manual_hint" ]]; then
      printf 'action_hint: %s\n' "$manual_hint"
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
  local current_task_json="${7:-}"

  local error_code
  error_code="$(jq -r '.code // "INTERNAL_ERROR"' <<<"$error_json")"
  local raw_message
  raw_message="$(jq -r '.message // "request failed"' <<<"$error_json")"
  local task_error_code=''
  if [[ -n "$current_task_json" && "$current_task_json" != "null" ]]; then
    task_error_code="$(jq -r '.error_code // empty' <<<"$current_task_json")"
  fi
  if [[ -z "$task_error_code" ]]; then
    task_error_code="$(jq -r '.details.task.error_code // empty' <<<"$error_json")"
  fi
  local friendly
  friendly="$(friendly_error_message "$error_code" "$operation" "$current_status" "$task_error_code")"
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
  if [[ -n "$task_error_code" ]]; then
    printf 'task.error_code: %s\n' "$task_error_code"
  fi

  local action_hint
  action_hint="$(action_hint_message "$operation" "$current_status" "$error_code" "$task_error_code")"
  if [[ -n "$action_hint" ]]; then
    printf 'action_hint: %s\n' "$action_hint"
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
      --arg user_message "$(format_error_text "$operation" "$request_id_value" "$gateway_request_id" "$requested_task_id" "$current_status" "$error_json" "$current_task_json")" \
      --argjson error "$error_json" \
      --argjson task "$(if [[ -n "$current_task_json" ]]; then printf '%s' "$current_task_json"; else printf '%s' 'null'; fi)" \
      '{ok:false,operation:$operation,request_id:$request_id,gateway_request_id:$gateway_request_id,http_status:$http_status,task_id:$task_id,status:$status,user_message:$user_message,error:$error,task:$task}'
  else
    format_error_text "$operation" "$request_id_value" "$gateway_request_id" "$requested_task_id" "$current_status" "$error_json" "$current_task_json"
  fi
}

mcp_extract_payload_json() {
  local raw_body="$1"
  local candidate=''

  candidate="$(printf '%s\n' "$raw_body" | sed -n 's/^data:[[:space:]]*//p' | awk 'NF && $0 != "[DONE]" {line=$0} END{print line}')"
  if [[ -n "$candidate" ]]; then
    printf '%s' "$candidate"
    return 0
  fi

  printf '%s' "$raw_body"
}

mcp_post() {
  local payload="$1"
  local mcp_session_id="${2:-}"
  local url="${AGENT_BASE_URL%/}/mcp"
  local headers_file body_out http_status content_type raw_body payload_json is_json response_session_id

  headers_file="$(mktemp)"
  body_out="$(mktemp)"

  if [[ -n "$mcp_session_id" ]]; then
    http_status="$(curl -sS -X POST "$url" \
      -H 'Content-Type: application/json' \
      -H 'Accept: application/json, text/event-stream' \
      -H "mcp-session-id: ${mcp_session_id}" \
      --data-binary "$payload" \
      -D "$headers_file" \
      -o "$body_out" \
      -w '%{http_code}')"
  else
    http_status="$(curl -sS -X POST "$url" \
      -H 'Content-Type: application/json' \
      -H 'Accept: application/json, text/event-stream' \
      --data-binary "$payload" \
      -D "$headers_file" \
      -o "$body_out" \
      -w '%{http_code}')"
  fi

  content_type="$(awk 'BEGIN{IGNORECASE=1} /^content-type:/ {$1=""; sub(/^[[:space:]]*/,"",$0); gsub("\r","",$0); print; exit}' "$headers_file")"
  response_session_id="$(awk 'BEGIN{IGNORECASE=1} /^mcp-session-id:/ {gsub("\r","",$2); print $2; exit}' "$headers_file")"
  raw_body="$(cat "$body_out")"
  payload_json="$(mcp_extract_payload_json "$raw_body")"

  if [[ -n "$payload_json" ]] && jq -e . >/dev/null 2>&1 <<<"$payload_json"; then
    is_json=true
  else
    is_json=false
  fi

  rm -f "$headers_file" "$body_out"

  emit_json \
    --argjson http_status "${http_status}" \
    --arg content_type "$content_type" \
    --arg mcp_session_id "${response_session_id:-}" \
    --arg raw_body "$raw_body" \
    --arg payload_json "$payload_json" \
    --argjson is_json "$is_json" \
    '{http_status:$http_status,content_type:$content_type,mcp_session_id:$mcp_session_id,raw_body:$raw_body,payload_json:$payload_json,is_json:$is_json}'
}

emit_relogin_success() {
  local request_id_value="$1"
  local status_value="$2"
  local message_value="$3"
  local result_json="$4"
  local data_url_regex='^data:([^;]+);base64,(.+)$'

  if [[ "$OUTPUT_FORMAT" == "json" ]]; then
    local qr_data qr_mime expires_at qr_base64 qr_png_path
    qr_data="$(jq -r '.structuredContent.qr.data // .structuredContent.session.qr.data // empty' <<<"$result_json")"
    qr_mime="$(jq -r '.structuredContent.qr.format // .structuredContent.session.qr.format // empty' <<<"$result_json")"
    expires_at="$(jq -r '.structuredContent.session.expires_at // .structuredContent.qr.expires_at // empty' <<<"$result_json")"
    qr_base64=''
    qr_png_path=''

    if [[ "$qr_data" =~ $data_url_regex ]]; then
      qr_mime="${BASH_REMATCH[1]}"
      qr_base64="${BASH_REMATCH[2]}"
      qr_png_path="$(materialize_login_qr_png "relogin-${request_id_value}" "$qr_base64" 2>/dev/null || true)"
    fi

    emit_json \
      --arg operation "relogin" \
      --arg request_id "$request_id_value" \
      --arg status "$status_value" \
      --arg message "$message_value" \
      --arg login_qr_mime "$qr_mime" \
      --arg login_session_expires_at "$expires_at" \
      --arg login_qr_png_base64 "$qr_base64" \
      --arg qr_png_path "$qr_png_path" \
      --argjson result "$result_json" \
      '{ok:true,operation:$operation,request_id:$request_id,status:$status,message:$message,login_qr_mime:($login_qr_mime|select(length>0)),login_session_expires_at:($login_session_expires_at|select(length>0)),login_qr_png_base64:($login_qr_png_base64|select(length>0)),qr_png_path:($qr_png_path|select(length>0)),result:$result}'
  else
    local qr_data qr_mime expires_at qr_base64 qr_png_path
    local suppress_base64_text='false'
    qr_data="$(jq -r '.structuredContent.qr.data // .structuredContent.session.qr.data // empty' <<<"$result_json")"
    qr_mime="$(jq -r '.structuredContent.qr.format // .structuredContent.session.qr.format // empty' <<<"$result_json")"
    expires_at="$(jq -r '.structuredContent.session.expires_at // .structuredContent.qr.expires_at // empty' <<<"$result_json")"
    qr_base64=''
    qr_png_path=''

    # In text mode, always prefer single MEDIA image delivery and avoid base64 blocks.
    if [[ "$OUTPUT_FORMAT" == "text" ]]; then
      suppress_base64_text='true'
    fi

    if [[ "$qr_data" =~ $data_url_regex ]]; then
      qr_mime="${BASH_REMATCH[1]}"
      qr_base64="${BASH_REMATCH[2]}"
      qr_png_path="$(materialize_login_qr_png "relogin-${request_id_value}" "$qr_base64" 2>/dev/null || true)"
    fi

    cat <<EOF
operation: relogin
request_id: ${request_id_value}
status: ${status_value}
message: ${message_value}
EOF
    if [[ "$status_value" == "waiting_login" ]]; then
      printf 'login_qr_mime: %s\n' "${qr_mime:-}"
      printf 'expires_at: %s\n' "${expires_at:-}"
      if [[ "$suppress_base64_text" != "true" ]]; then
        printf 'login_qr_png_base64:\n'
        printf '```text\n%s\n```\n' "${qr_base64:-}"
      fi
      if [[ -n "$qr_png_path" ]]; then
        printf 'login_qr_png_path: %s\n' "$qr_png_path"
      fi
    fi
  fi
}

emit_relogin_error() {
  local request_id_value="$1"
  local status_value="$2"
  local message_value="$3"
  local error_code="$4"
  local error_message="$5"
  local details_json="${6:-null}"

  if [[ "$OUTPUT_FORMAT" == "json" ]]; then
    emit_json \
      --arg operation "relogin" \
      --arg request_id "$request_id_value" \
      --arg status "$status_value" \
      --arg message "$message_value" \
      --arg error_code "$error_code" \
      --arg error_message "$error_message" \
      --argjson details "$details_json" \
      '{ok:false,operation:$operation,request_id:$request_id,status:$status,message:$message,error:{code:$error_code,message:$error_message},details:$details}'
  else
    cat <<EOF
operation: relogin
request_id: ${request_id_value}
status: ${status_value}
message: ${message_value}
error.code: ${error_code}
error.message: ${error_message}
EOF
    if [[ "$details_json" != "null" ]]; then
      printf 'details:\n'
      printf '```json\n%s\n```\n' "$details_json"
    fi
  fi
}

relogin_flow() {
  local request_id_value init_payload notify_payload call_payload mcp_session_id
  local init_response notify_response call_response
  local init_json notify_json call_json
  local call_result_json status_value message_value

  request_id_value="$(request_id relogin)"

  init_payload="$(jq -cn \
    --arg id "${request_id_value}-initialize" \
    '{jsonrpc:"2.0",id:$id,method:"initialize",params:{protocolVersion:"2024-11-05",capabilities:{},clientInfo:{name:"wechat_publish_gateway",version:"1.0.0"}}}')"
  if ! init_response="$(mcp_post "$init_payload" 2>/dev/null)"; then
    emit_relogin_error "$request_id_value" "failed" "Agent relogin initialize request failed." "MCP_REQUEST_FAILED" "failed to call initialize"
    return 0
  fi
  if ! jq -e '.http_status >= 200 and .http_status < 300' >/dev/null 2>&1 <<<"$init_response"; then
    emit_relogin_error \
      "$request_id_value" \
      "failed" \
      "Agent relogin initialize request failed." \
      "MCP_HTTP_$(jq -r '.http_status' <<<"$init_response")" \
      "initialize returned non-2xx status" \
      "$(jq -c '{stage:"initialize",http_status,content_type,raw_body}' <<<"$init_response")"
    return 0
  fi
  if ! jq -e '.is_json == true' >/dev/null 2>&1 <<<"$init_response"; then
    emit_relogin_error \
      "$request_id_value" \
      "failed" \
      "Agent relogin initialize response is not JSON." \
      "MCP_BAD_RESPONSE" \
      "initialize returned non-JSON payload" \
      "$(jq -c '{stage:"initialize",http_status,content_type,raw_body}' <<<"$init_response")"
    return 0
  fi
  init_json="$(jq -r '.payload_json' <<<"$init_response")"
  if jq -e '.error != null' >/dev/null 2>&1 <<<"$init_json"; then
    emit_relogin_error \
      "$request_id_value" \
      "failed" \
      "Agent relogin initialize returned error." \
      "$(jq -r '.error.code // "MCP_INITIALIZE_ERROR" | tostring' <<<"$init_json")" \
      "$(jq -r '.error.message // "initialize failed"' <<<"$init_json")" \
      "$(jq -c . <<<"$init_json")"
    return 0
  fi

  mcp_session_id="$(jq -r '.mcp_session_id // empty' <<<"$init_response")"
  if [[ -z "$mcp_session_id" ]]; then
    emit_relogin_error \
      "$request_id_value" \
      "failed" \
      "Agent relogin initialize did not return a session." \
      "MCP_SESSION_MISSING" \
      "initialize response missing mcp-session-id header" \
      "$(jq -c '{stage:"initialize",http_status,content_type,mcp_session_id,raw_body}' <<<"$init_response")"
    return 0
  fi

  notify_payload='{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'
  if ! notify_response="$(mcp_post "$notify_payload" "$mcp_session_id" 2>/dev/null)"; then
    emit_relogin_error "$request_id_value" "failed" "Agent initialized notification failed." "MCP_REQUEST_FAILED" "failed to send notifications/initialized"
    return 0
  fi
  if ! jq -e '.http_status >= 200 and .http_status < 300' >/dev/null 2>&1 <<<"$notify_response"; then
    emit_relogin_error \
      "$request_id_value" \
      "failed" \
      "Agent initialized notification failed." \
      "MCP_HTTP_$(jq -r '.http_status' <<<"$notify_response")" \
      "notifications/initialized returned non-2xx status" \
      "$(jq -c '{stage:"notifications/initialized",http_status,content_type,raw_body}' <<<"$notify_response")"
    return 0
  fi
  if jq -e '.is_json == true' >/dev/null 2>&1 <<<"$notify_response"; then
    notify_json="$(jq -r '.payload_json' <<<"$notify_response")"
    if jq -e '.error != null' >/dev/null 2>&1 <<<"$notify_json"; then
      emit_relogin_error \
        "$request_id_value" \
        "failed" \
        "Agent initialized notification returned error." \
        "$(jq -r '.error.code // "MCP_INITIALIZED_ERROR" | tostring' <<<"$notify_json")" \
        "$(jq -r '.error.message // "notifications/initialized failed"' <<<"$notify_json")" \
        "$(jq -c . <<<"$notify_json")"
      return 0
    fi
  fi

  call_payload="$(jq -cn \
    --arg id "${request_id_value}-tools-call" \
    '{jsonrpc:"2.0",id:$id,method:"tools/call",params:{name:"publisher_relogin",arguments:{}}}')"
  if ! call_response="$(mcp_post "$call_payload" "$mcp_session_id" 2>/dev/null)"; then
    emit_relogin_error "$request_id_value" "failed" "Agent relogin tool call failed." "MCP_REQUEST_FAILED" "failed to call tools/call"
    return 0
  fi
  if ! jq -e '.http_status >= 200 and .http_status < 300' >/dev/null 2>&1 <<<"$call_response"; then
    emit_relogin_error \
      "$request_id_value" \
      "failed" \
      "Agent relogin tool call failed." \
      "MCP_HTTP_$(jq -r '.http_status' <<<"$call_response")" \
      "tools/call returned non-2xx status" \
      "$(jq -c '{stage:"tools/call",http_status,content_type,raw_body}' <<<"$call_response")"
    return 0
  fi
  if ! jq -e '.is_json == true' >/dev/null 2>&1 <<<"$call_response"; then
    emit_relogin_error \
      "$request_id_value" \
      "failed" \
      "Agent relogin tool response is not JSON." \
      "MCP_BAD_RESPONSE" \
      "tools/call returned non-JSON payload" \
      "$(jq -c '{stage:"tools/call",http_status,content_type,raw_body}' <<<"$call_response")"
    return 0
  fi

  call_json="$(jq -r '.payload_json' <<<"$call_response")"
  if jq -e '.error != null' >/dev/null 2>&1 <<<"$call_json"; then
    emit_relogin_error \
      "$request_id_value" \
      "failed" \
      "Agent relogin returned MCP error." \
      "$(jq -r '.error.code // "MCP_TOOL_ERROR" | tostring' <<<"$call_json")" \
      "$(jq -r '.error.message // "tools/call failed"' <<<"$call_json")" \
      "$(jq -c . <<<"$call_json")"
    return 0
  fi

  call_result_json="$(jq -c '.result // {}' <<<"$call_json")"
  if jq -e '.isError == true' >/dev/null 2>&1 <<<"$call_result_json"; then
    emit_relogin_error \
      "$request_id_value" \
      "failed" \
      "Agent relogin tool reported an error." \
      "$(jq -r '.error.code // "MCP_TOOL_ERROR" | tostring' <<<"$call_result_json")" \
      "$(jq -r '.error.message // (.content[]? | select(.type=="text") | .text) // "publisher_relogin failed"' <<<"$call_result_json")" \
      "$call_result_json"
    return 0
  fi

  status_value="$(jq -r '.structuredContent.status // .status // "ok"' <<<"$call_result_json")"
  message_value="$(jq -r '.structuredContent.message // .message // (.content[]? | select(.type=="text") | .text) // "publisher_relogin triggered"' <<<"$call_result_json")"

  emit_relogin_success "$request_id_value" "$status_value" "$message_value" "$call_result_json"
}

shift || true

while [[ $# -gt 0 ]]; do
  case "$1" in
    --gateway-base-url)
      BASE_URL="${2:-}"
      shift 2
      ;;
    --agent-base-url)
      AGENT_BASE_URL="${2:-}"
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
  relogin)
    relogin_flow
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
