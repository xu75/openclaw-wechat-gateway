# WeChat Markdown Publish Skill

This skill lets OpenClaw users send Markdown documents from chat channels such as Feishu and Telegram to the WeChat Gateway.

Natural-language publish intent does not execute by default. Users must use explicit slash commands for execution.

## Command

- `/publish_wechat`
- `/publish_wechat_status <task_id>`
- `/publish_wechat_confirm <task_id>`
- `/publish_wechat_relogin`

This skill is now command-first and does not rely on vague natural-language triggering.

## Feishu Example

1. Send the Markdown document in the same thread. Recommended forms:
   - plain Markdown message
   - fenced block with ```markdown
2. Send `/publish_wechat`.
3. OpenClaw extracts the nearest Markdown document from the current conversation and sends the raw Markdown to `POST /wechat/publish`.
4. If Gateway returns `waiting_login`, OpenClaw replies with:
   - `task_id`
   - `status`
   - `login_qr_mime`
   - `login_qr_png_path`
   - `expires_at`
5. When `login_qr_png_path` is present, OpenClaw should send exactly one QR image using that path.
6. After scanning the QR code, send `/publish_wechat_confirm <task_id>`.
7. Query any time with `/publish_wechat_status <task_id>`.

If the user only says things like “发到公众号” or “再发一遍 wechat”, OpenClaw should not publish directly. It should wait for explicit slash commands above.

## Relogin Command

Use relogin when agent/browser login state is stale and you need a fresh login session before publish:

```text
/publish_wechat_relogin
```

This command only triggers agent relogin.

- It does not publish any article.
- It does not auto-confirm any task.
- If it returns `login_qr_png_path`, OpenClaw should send exactly one QR image using that path.

## Behavior Notes

- OpenClaw does not convert Markdown to HTML.
- The bundled client always sends:
  - `task_id`
  - `idempotency_key`
  - `title`
  - `content`
  - `content_format=markdown`
  - `preferred_channel=browser`
- All requests include `x-request-id`.
- `waiting_login` only uses `GET /wechat/publish/:task_id` for follow-up status checks.
- `confirm-login` is never auto-retried by OpenClaw.
- `422 IMAGE_POLICY_VIOLATION` keeps `failed_images` and `replaced_count` unchanged in the reply.
- The skill should not SSH to ECS or inspect remote logs when the publish command fails; it should return the Gateway error to the user and stop.

## Manual Smoke Run

```bash
/opt/openclaw/openclaw-patched/skills/wechat-markdown-publish/scripts/smoke_gateway_publish.sh
```

Relogin direct script example:

```bash
/opt/openclaw/openclaw-patched/skills/wechat-markdown-publish/scripts/wechat_publish_gateway.sh relogin --output json
```

## Environment Override

Default Gateway base URL:

```bash
http://127.0.0.1:3000
```

Override when needed:

```bash
export OPENCLAW_WECHAT_GATEWAY_BASE_URL="http://127.0.0.1:3000"
```
