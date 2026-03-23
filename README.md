# openclaw-wechat-gateway

Openclaw 到本地 `wechat-publisher-agent` 的发布总控网关（V1）。和https://github.com/xu75/wechat-unofficial-publisher-agent 配套使用。

## V1 能力

1. 固定三条 API：
- `POST /wechat/publish`
- `POST /wechat/publish/:task_id/confirm-login`
- `GET /wechat/publish/:task_id`

2. Gateway 内容处理（不下沉 Agent）：
- markdown -> html
- HTML sanitize
- 图片 URL 规则校验与重写（仅允许绝对 HTTPS）

3. Agent 对接方式（Remote MCP）：
- 默认 Agent 地址 `http://127.0.0.1:14273`（自动走 `/mcp`）
- 工具调用固定使用 `structuredContent` 解析
- 当前使用工具：
  - `publisher_health`
  - `publisher_login_status`
  - `publisher_login_qr_get`
  - `publisher_publish`
- 发布成功判定：`status=accepted` 且 `execution.draft_saved=true`

4. 状态机与登录约束：
- `waiting_login` 不轮询 publish
- `confirm-login` 仅允许一次重试
- `waiting_login` 默认 600s 超时转 `manual_intervention` 并告警

5. 可观测与回放：
- `request_id` 透传
- 结构化日志（`request_id/task_id/stage/status/error_code`）
- sqlite 持久化 `publish_tasks / publish_events / publish_audit_logs`

## 快速开始

```bash
cp .env.example .env
npm install
npm run db:migrate
npm run dev
```

## 命令

```bash
npm run check
npm run test
npm run db:migrate
npm run dev
npm run build
npm run start:prod
```

## 最小联调

```bash
./scripts/smoke-curl.sh
```

## 文档

- [正式使用说明（Agent + Gateway + OpenClaw Skill）](./docs/agent-gateway-openclaw-usage.md)
- [API 合同](./docs/api-contract.md)
- [值班 Runbook](./docs/runbook.md)
- [OpenClaw Skill 说明](./docs/openclaw-wechat-markdown-publish-skill.md)
- [架构蓝图](./ARCHITECTURE_BLUEPRINT.md)
- [交接文档](./PROJECT_HANDOVER.md)
