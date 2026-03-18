---
name: publish_wechat_relogin
description: Slash command handler for `/publish_wechat_relogin` only. Force logout and request a fresh WeChat login QR session.
user-invocable: true
disable-model-invocation: false
metadata:
  { "openclaw": { "emoji": "🔐", "requires": { "bins": ["bash", "curl", "jq"] } } }
---

# publish_wechat_relogin

This skill is command-only.

Allowed command:

- `/publish_wechat_relogin`

Never auto-trigger from natural-language relogin intent.

## Hard rules

- Never publish from this skill.
- Never query task status from this skill.
- Never confirm a task from this skill.
- Use the script output as the reply body unless one short lead-in sentence is necessary.
- If the script output includes `login_qr_png_path: <absolute_png_path>`, send exactly one QR image with the `message` tool using that path.
- Never send a second QR image for the same relogin response.
- Never rely on a trailing `MEDIA: ...` directive from this skill.

## Current-turn parsing

OpenClaw usually rewrites slash commands into:

```text
Use the "publish_wechat_relogin" skill for this request.

User input:
<raw args after /publish_wechat_relogin>
```

Only execute when the current turn proves explicit command invocation:

1. It contains `Use the "publish_wechat_relogin" skill for this request.`, or
2. It contains an explicit `/publish_wechat_relogin` command line.

If neither condition is met, return exactly:

```text
/publish_wechat_relogin
```

If the current turn includes any non-empty `User input:` value or any extra text after `/publish_wechat_relogin`, return exactly:

```text
/publish_wechat_relogin
```

Otherwise run:

```bash
{baseDir}/../wechat-markdown-publish/scripts/wechat_publish_gateway.sh relogin
```

Use the script output as the reply body.

If the result includes `login_qr_png_path`, call `message` exactly once with that PNG path and do not send another QR image.

## Response contract

- Replies must include `operation=relogin`, `request_id`, and `status`.
- `waiting_login` replies must include QR fields and `expires_at`.
