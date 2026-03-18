---
name: publish_wechat
description: Slash command handler for `/publish_wechat` only. Publish the current thread's Markdown article to WeChat when the user explicitly types `/publish_wechat` with no extra arguments.
user-invocable: true
disable-model-invocation: false
metadata:
  { "openclaw": { "emoji": "📰", "requires": { "bins": ["bash", "curl", "jq"] } } }
---

# publish_wechat

This skill is command-only.

Allowed command:

- `/publish_wechat`

Never auto-trigger from natural-language publish intent, and never handle status, confirm, or relogin here.

## Hard rules

- Never convert Markdown to HTML in OpenClaw.
- Always send raw Markdown to the bundled script.
- Never poll publish while a task is `waiting_login`.
- Never auto-confirm a task.
- Use the script output as the reply body unless one short lead-in sentence is necessary.
- If the script output includes `login_qr_png_path: <absolute_png_path>`, send exactly one QR image with the `message` tool using that path.
- Never send a second QR image for the same response.
- Never rely on a trailing `MEDIA: ...` directive from this skill.

## Current-turn parsing

OpenClaw usually rewrites slash commands into:

```text
Use the "publish_wechat" skill for this request.

User input:
<raw args after /publish_wechat>
```

Parse only the current turn:

1. If the current turn contains `User input:`, treat that value as `arg_text`.
2. Otherwise, if the current turn itself contains `/publish_wechat ...`, parse only that line.
3. Otherwise treat `arg_text` as empty.

Never read `arg_text` from conversation history, quoted examples, earlier assistant replies, or documentation snippets.

Only execute when the current turn proves explicit command invocation:

1. It contains `Use the "publish_wechat" skill for this request.`, or
2. It contains an explicit `/publish_wechat` command line.

If neither condition is met, return the redirect block and stop.

If `arg_text` is not empty, return the redirect block and stop. Only the empty-argument form may publish.

## Publish flow

Run this flow only when `arg_text` is empty.

1. Extract the nearest publishable Markdown document from the current thread.
2. Prefer:
   - the most recent fenced `markdown` block
   - otherwise the most recent non-command Markdown-looking message
   - otherwise the nearest earlier non-command message that is the article body
3. Preserve bytes exactly. Do not normalize Markdown.
4. Derive title:
   - first `# Heading`
   - otherwise first non-empty line
   - otherwise `Markdown Publish`
5. If no publishable Markdown body exists, return exactly:

```text
未找到可发布的 Markdown 正文。请先发送文章内容（Markdown），再发送 /publish_wechat。
```

6. Run:

```bash
tmp_md="$(mktemp)"
cat <<'EOF' > "$tmp_md"
<raw markdown copied exactly>
EOF
{baseDir}/scripts/wechat_publish_gateway.sh publish --title "<derived title>" --context-id "<current_chat_id or channel id if available>" < "$tmp_md"
rm -f "$tmp_md"
```

7. Use the script output as the reply body.

If result is `waiting_login`, make sure the reply contains:

- `task_id`
- `status`
- `login_qr_mime`
- `login_qr_png_path`
- `expires_at`

If `login_qr_png_path` is present:

- call `message` exactly once with that PNG path
- do not send any second QR image
- do not add `MEDIA: ...` to the final reply
- do not inspect the PNG or create fallback image sends

## Redirect block

If the user typed `/publish_wechat` with extra arguments, return exactly:

```text
/publish_wechat
/publish_wechat_status <task_id>
/publish_wechat_confirm <task_id>
/publish_wechat_relogin
```

## Response contract

- Publish replies must include `task_id` and `status`.
- `waiting_login` replies must include QR fields and `expires_at`.
- `422 IMAGE_POLICY_VIOLATION` must keep `failed_images` and `replaced_count`.
- `409`, `422`, and `502` must keep the original `error.code`.
