# WeChat Markdown Publish Skill

This skill lets OpenClaw users send Markdown documents from chat channels such as Feishu and Telegram to the WeChat Gateway.

## Command

- `/publish_wechat`
- `/publish_wechat status <task_id>`
- `/publish_wechat confirm <task_id>`

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
   - `login_qr_png_base64`
   - `login_qr_png_path`
   - `expires_at`
   - a trailing `MEDIA: <absolute_png_path>` directive that OpenClaw turns into a real QR image message in Feishu/Telegram
5. After scanning the QR code, send `/publish_wechat confirm <task_id>`.
6. Query any time with `/publish_wechat status <task_id>`.

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

## Environment Override

Default Gateway base URL:

```bash
http://127.0.0.1:3000
```

Override when needed:

```bash
export OPENCLAW_WECHAT_GATEWAY_BASE_URL="http://127.0.0.1:3000"
```
