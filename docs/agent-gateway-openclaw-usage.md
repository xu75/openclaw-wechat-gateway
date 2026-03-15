# Agent + Gateway + OpenClaw Skill 正式使用说明

本文档用于正式版本的端到端操作说明，覆盖三部分：

1. 本地 `wechat-publisher-agent`（执行面）
2. `openclaw-wechat-gateway`（控制面）
3. OpenClaw Skill `publish_wechat`（用户交互面）

## 1. 架构与边界

固定链路：

`OpenClaw -> Gateway(ECS) -> FRP(127.0.0.1:14273) -> Agent(local 127.0.0.1:4273)`

职责边界：

1. OpenClaw：接收用户命令与 markdown，调用 Gateway。
2. Gateway：内容处理、状态机、签名调用 Agent、审计与告警。
3. Agent：执行 browser/official 发布动作，不做 markdown 解析。

## 2. 版本前置条件

1. Node.js `>=18`
2. Gateway 仓库依赖已安装：`npm install`
3. Agent 已运行且本机可访问 `http://127.0.0.1:4273/health`
4. ECS 到本地 Agent 的 FRP 映射可用：`http://127.0.0.1:14273/health`
5. Gateway 与 Agent 使用同一套签名密钥

## 3. 环境变量

### 3.1 Gateway（本仓库）

参考 `.env.example`：

```bash
PORT=3000
AGENT_BASE_URL=http://127.0.0.1:14273
WECHAT_AGENT_SIGNING_SECRET=replace_me
WECHAT_AGENT_REVIEW_TOKEN_SECRET=replace_me
WECHAT_AGENT_REVIEW_TOKEN_ISSUER=ecs-review
WECHAT_AGENT_REVIEW_TOKEN_TTL_SECONDS=600
WAITING_LOGIN_TIMEOUT_SECONDS=600
ALERT_WEBHOOK=
DB_PATH=./data/gateway.db
```

说明：

1. `AGENT_BASE_URL` 在 ECS 环境应指向 FRP 映射地址 `127.0.0.1:14273`。
2. `WECHAT_AGENT_SIGNING_SECRET` 必须与 Agent 校验端一致。
3. `WAITING_LOGIN_TIMEOUT_SECONDS` 默认 `600`（10 分钟）。

### 3.2 OpenClaw Skill（可选覆盖）

`wechat_publish_gateway.sh` 支持：

```bash
export OPENCLAW_WECHAT_GATEWAY_BASE_URL="http://127.0.0.1:3000"
export OPENCLAW_WECHAT_REQUEST_ID_PREFIX="oc-mdpub"
```

## 4. Gateway 启动与校验

```bash
cp .env.example .env
npm install
npm run db:migrate
npm run check
npm run test
npm run dev
```

健康检查：

```bash
curl -sS http://127.0.0.1:3000/health
```

期望返回：

```json
{"ok":true,"service":"openclaw-wechat-gateway"}
```

## 5. OpenClaw Skill 接入

本仓库内 Skill 目录：

1. `openclaw-skill/wechat-markdown-publish/`
2. `openclaw-skill/wechat-article-style/`

`publish_wechat` 命令集：

1. `/publish_wechat`
2. `/publish_wechat status <task_id>`
3. `/publish_wechat confirm <task_id>`

关键行为（固定）：

1. Skill 不做 markdown -> html 转换。
2. Skill 始终传 `content_format=markdown`、`preferred_channel=browser`。
3. `waiting_login` 只走查询和人工确认，不自动轮询 publish。
4. `confirm-login` 只手动触发一次，不自动重试。

## 6. 端到端发布流程

### 6.1 用户在 OpenClaw 发起

1. 在会话里先发送 Markdown 正文（建议 fenced markdown 或纯 markdown）。
2. 再发送 `/publish_wechat`。

### 6.2 Gateway 处理

1. 执行 `Markdown -> HTML -> sanitize -> image rewrite`。
2. 非法图片 URL（相对路径 / http / data / file）直接返回 `422 IMAGE_POLICY_VIOLATION`。
3. 合法内容调用 Agent `/publish`（带 HMAC 签名与 review token）。

### 6.3 Agent 返回分支

1. `accepted`：任务进入 `published`。
2. `waiting_login`：Gateway 回传二维码字段，OpenClaw展示二维码。
3. `publish_failed`：Gateway 转 `publish_failed -> manual_intervention` 并告警。

### 6.4 用户扫码后确认

在 OpenClaw 执行：

```text
/publish_wechat confirm <task_id>
```

Gateway 仅单次重试发布；重复确认会返回 `409 STATUS_CONFLICT`。

### 6.5 查询状态

```text
/publish_wechat status <task_id>
```

如果 `waiting_login` 已过期，查询时会自动转 `manual_intervention`，不会触发 publish 轮询。

## 7. Gateway API 直连示例

### 7.1 发布

```bash
curl -sS -X POST 'http://127.0.0.1:3000/wechat/publish' \
  -H 'x-request-id: req-demo-1' \
  -H 'Content-Type: application/json' \
  -d '{
    "task_id": "task-demo-1",
    "idempotency_key": "idem-demo-1",
    "title": "demo",
    "content": "# hello",
    "content_format": "markdown",
    "preferred_channel": "browser"
  }'
```

### 7.2 确认登录

```bash
curl -sS -X POST 'http://127.0.0.1:3000/wechat/publish/task-demo-1/confirm-login' \
  -H 'x-request-id: req-demo-1' \
  -H 'Content-Type: application/json'
```

### 7.3 查询任务

```bash
curl -sS 'http://127.0.0.1:3000/wechat/publish/task-demo-1' \
  -H 'x-request-id: req-demo-1'
```

## 8. 常见错误码与处理

1. `IMAGE_POLICY_VIOLATION`：修正文案内图片 URL，仅允许绝对 HTTPS。
2. `IDEMPOTENCY_CONFLICT`：`task_id` 或 `idempotency_key` 与历史任务冲突。
3. `STATUS_CONFLICT`：状态不允许该操作（常见于重复 confirm-login）。
4. `AGENT_UNAVAILABLE`：Agent 不可用或网络不可达。
5. `AGENT_SIGNATURE_ERROR`：签名不一致，检查 `WECHAT_AGENT_SIGNING_SECRET`。
6. `WAITING_LOGIN_TIMEOUT`：登录确认超时，任务已转人工介入。

## 9. 发布前检查清单（建议）

1. `npm run check` 通过。
2. `npm run build` 通过。
3. `npm test` 全绿。
4. `npm run db:migrate` 成功。
5. `GET /health` 正常。
6. 用 `scripts/smoke-curl.sh` 完成一次联调。
7. OpenClaw 内完成一次 `/publish_wechat -> waiting_login -> confirm -> status` 全链路演练。

## 10. 运维与排障入口

1. API 契约：`docs/api-contract.md`
2. 值班手册：`docs/runbook.md`
3. Skill 说明：`docs/openclaw-wechat-markdown-publish-skill.md`
4. Skill 定义：`openclaw-skill/wechat-markdown-publish/SKILL.md`
