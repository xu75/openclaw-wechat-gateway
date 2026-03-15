---
name: publish_wechat
description: Publish the current conversation's Markdown article to WeChat via the Gateway with the explicit command `/publish_wechat`, including `/publish_wechat status <task_id>` and `/publish_wechat confirm <task_id>` follow-ups in Feishu, Telegram, and other OpenClaw channels.
user-invocable: true
disable-model-invocation: true
metadata:
  { "openclaw": { "emoji": "📰", "requires": { "bins": ["bash", "curl", "jq"] } } }
---

# publish_wechat

Use this skill only when the user explicitly invokes the command:

- `/publish_wechat`
- `/publish_wechat status <task_id>`
- `/publish_wechat confirm <task_id>`

Do not auto-trigger on natural-language publish intent. This skill is command-only.

## Global rules

- Never convert Markdown to HTML in OpenClaw.
- Always send the raw Markdown to the bundled script through stdin.
- The script already sets:
  - `content_format=markdown`
  - `preferred_channel=browser`
  - `x-request-id`
- Do not poll `/wechat/publish` while a task is in `waiting_login`.
- `confirm-login` is a single manual action. Never auto-retry it.
- Do not inspect ECS, Gateway logs, browser service logs, or remote agent state unless the user explicitly asks for debugging.
- If the Gateway returns browser startup or publish errors, report the returned `task_id`, `status`, `error.code`, and message, then stop.
- Always return the script output verbatim unless you need to add one short lead-in sentence.
- Never alter or wrap a trailing `MEDIA: ...` line from the script. OpenClaw uses it to send image attachments.
- If the script output contains a trailing `MEDIA: ...` line, stop after returning that output. Never call `read`, `message`, image, attachment, or any fallback send tool for the same QR code.

## `/publish_wechat`

When the user sends `/publish_wechat` with no subcommand:

1. Extract the raw Markdown from the current conversation.
2. Prefer, in order:
   - a fenced ```markdown block in the most recent article message in the thread
   - the most recent non-command message that looks like the article body
   - the most recent earlier non-command message that contains the Markdown document
3. Preserve the content exactly. No Markdown cleanup, HTML conversion, image rewriting, or normalization.
4. Derive a title:
   - first `# Heading`
   - otherwise the first non-empty line, trimmed
   - otherwise `Markdown Publish`
5. Write the extracted Markdown to a temp file with a quoted heredoc so bytes stay unchanged.
6. Run:

```bash
tmp_md="$(mktemp)"
cat <<'EOF' > "$tmp_md"
<raw markdown copied exactly>
EOF
{baseDir}/scripts/wechat_publish_gateway.sh publish --title "<derived title>" --context-id "<current_chat_id or channel id if available>" < "$tmp_md"
rm -f "$tmp_md"
```

7. Return the script output exactly. If the result is `waiting_login`, make sure the reply clearly shows:
   - `task_id`
   - `status`
   - `login_qr_mime`
   - `login_qr_png_base64`
   - `login_qr_png_path`
   - `expires_at`
   - the trailing `MEDIA: <absolute_png_path>` line unchanged so Feishu/Telegram can send the QR code as an image
8. When the output already includes `MEDIA: <absolute_png_path>`, do not do anything else:
   - do not inspect the PNG
   - do not call `read`
   - do not call `message`
   - do not send a second QR image
   - do not add a fallback image send

## `/publish_wechat confirm <task_id>`

When the command starts with `/publish_wechat confirm `:

1. Extract the task id after the command.
2. If it is empty, ask the user to provide a task id.
3. Run:

```bash
{baseDir}/scripts/wechat_publish_gateway.sh confirm-login "<task_id>"
```

4. Return the script output exactly.

## `/publish_wechat status <task_id>`

When the command starts with `/publish_wechat status `:

1. Extract the task id after the command.
2. If it is empty, ask the user to provide a task id.
3. Run:

```bash
{baseDir}/scripts/wechat_publish_gateway.sh status "<task_id>"
```

4. Return the script output exactly.

## Invalid arguments

If the command contains an unsupported subcommand, return this short usage block and do nothing else:

```text
Usage:
/publish_wechat
/publish_wechat status <task_id>
/publish_wechat confirm <task_id>
```

## Response contract

- Success and failure replies must include `task_id` and `status`.
- For `waiting_login`, include QR-related fields and `expires_at`.
- Preserve any `MEDIA: ...` directive line exactly as emitted by the script.
- For `422 IMAGE_POLICY_VIOLATION`, keep `failed_images` and `replaced_count` exactly as returned.
- For `409`, `422`, and `502`, keep the original `error.code` visible.
