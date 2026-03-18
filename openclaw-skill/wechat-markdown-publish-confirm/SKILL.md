---
name: publish_wechat_confirm
description: Slash command handler for `/publish_wechat_confirm <task_id>` only. Confirm one waiting_login WeChat publish task exactly once.
user-invocable: true
disable-model-invocation: true
metadata:
  { "openclaw": { "emoji": "✅", "requires": { "bins": ["bash", "curl", "jq"] } } }
---

# publish_wechat_confirm

This skill is command-only.

Allowed command:

- `/publish_wechat_confirm <task_id>`

Never auto-trigger from natural-language login confirmation.

## Hard rules

- Never call publish from this skill.
- Never query status unless the script itself does it internally.
- Never relogin from this skill.
- Never retry confirm more than the backend already allows.
- Return the script output verbatim unless one short lead-in sentence is necessary.

## Current-turn parsing

OpenClaw usually rewrites slash commands into:

```text
Use the "publish_wechat_confirm" skill for this request.

User input:
<raw args after /publish_wechat_confirm>
```

Parse only the current turn:

1. If the current turn contains `User input:`, treat that value as `task_id`.
2. Otherwise, if the current turn itself contains `/publish_wechat_confirm ...`, parse only that line.
3. Otherwise treat `task_id` as empty.

Never read `task_id` from conversation history, quoted examples, earlier assistant replies, or documentation snippets.

Only execute when the current turn proves explicit command invocation:

1. It contains `Use the "publish_wechat_confirm" skill for this request.`, or
2. It contains an explicit `/publish_wechat_confirm` command line.

If neither condition is met, return exactly:

```text
/publish_wechat_confirm <task_id>
```

## Required input

If `task_id` is empty, return exactly:

```text
/publish_wechat_confirm <task_id>
```

Otherwise run:

```bash
{baseDir}/../wechat-markdown-publish/scripts/wechat_publish_gateway.sh confirm-login "<task_id>"
```

Return the script output exactly.

## Response contract

- Replies must include `task_id` and `status`.
- `409`, `422`, and `502` must keep the original `error.code`.
