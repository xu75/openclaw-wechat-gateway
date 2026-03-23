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
2. Gateway：内容处理、状态机、调用 Agent MCP tools、审计与告警。
3. Agent：执行 browser/official 发布动作，不做 markdown 解析。

### 1.1 为什么拆分 Gateway 和 Agent

1. 职责清晰：Gateway 是控制面（内容处理/状态机/审计），Agent 是执行面（发布动作）。
2. 稳定性更好：内容策略和业务编排变更不会直接影响本地发布内核。
3. 安全边界明确：OpenClaw 不直接接触 Agent 密钥和执行细节。
4. 可维护性更高：可独立升级内容管线、签名策略、告警体系。
5. 可扩展性更好：后续切换模型、样式、图片策略，优先改 Gateway 即可。

### 1.2 部署模式说明

推荐生产模式：

1. Agent 在本地机器。（这样微信后台看到的操作都是在日常电脑上做的）
2. Openclaw + Gateway 在 ECS 或其他小龙虾机器上。
3. 通过 FRP 暴露本地 Agent 给 ECS（`14273 -> 4273`）。

也支持单机模式（开发/小规模使用）：

1. OpenClaw、Gateway、Agent 全部在同一台机器。
2. Gateway 直接连 `127.0.0.1:4273`，不需要 FRP。

## 2. 版本前置条件

1. Node.js `>=18`
2. Gateway 仓库依赖已安装：`npm install`
3. Agent 已运行且本机可访问 `http://127.0.0.1:4273/health`
4. ECS 到本地 Agent 的 FRP 映射可用：`http://127.0.0.1:14273/health`
5. Gateway 可访问 Agent 的 MCP 入口（默认 `${AGENT_BASE_URL}/mcp`）

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

1. `AGENT_BASE_URL` 取决于部署模式：
   - ECS Gateway：`http://127.0.0.1:14273`（FRP 映射）
   - 单机 Gateway：`http://127.0.0.1:4273`（直连 Agent）
   - Gateway 会自动使用 `${AGENT_BASE_URL}/mcp` 作为 MCP 主入口
2. `WECHAT_AGENT_SIGNING_SECRET` 当前在 MCP 链路中不参与请求签名，但网关启动仍要求该变量非空（兼容保留项）。
3. `WAITING_LOGIN_TIMEOUT_SECONDS` 默认 `600`（10 分钟）。

### 3.2 OpenClaw Skill（可选覆盖）

`wechat_publish_gateway.sh` 支持：

```bash
export OPENCLAW_WECHAT_GATEWAY_BASE_URL="http://127.0.0.1:3000"
export OPENCLAW_WECHAT_REQUEST_ID_PREFIX="oc-mdpub"
```

### 3.3 单机部署配置（OpenClaw 与 Agent 同机）

当 OpenClaw 和 Agent 在同一台机器时，常见两种配置：

1. Gateway 也同机（最简单）
   - Gateway `.env`:
     - `AGENT_BASE_URL=http://127.0.0.1:4273`
   - OpenClaw Skill:
     - `OPENCLAW_WECHAT_GATEWAY_BASE_URL=http://127.0.0.1:3000`
   - 不需要 FRP。

2. Gateway 在 ECS（当前推荐生产方案）
   - Gateway `.env`:
     - `AGENT_BASE_URL=http://127.0.0.1:14273`
   - 需要 FRP：`ECS:14273 -> local:4273`
   - OpenClaw Skill:
     - `OPENCLAW_WECHAT_GATEWAY_BASE_URL=<你的ECS Gateway地址>`

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
2. `/publish_wechat_status <task_id>`
3. `/publish_wechat_confirm <task_id>`
4. `/publish_wechat_relogin`

关键行为（固定）：

1. Skill 不做 markdown -> html 转换。
2. Skill 始终传 `content_format=markdown`、`preferred_channel=browser`。
3. `waiting_login` 只走查询和人工确认，不自动轮询 publish。
4. `confirm-login` 只手动触发一次，不自动重试。
5. 只有显式 `/publish_wechat` / `/publish_wechat_status` / `/publish_wechat_confirm` / `/publish_wechat_relogin` 命令才允许执行发布相关动作。
6. 自然语言里的“发到公众号 / 再发一遍 wechat”不会直接发布，只有显式 slash 命令才会执行。

## 6. 端到端发布流程

### 6.1 用户在 OpenClaw 发起

1. 在会话里先发送 Markdown 正文（建议 fenced markdown 或纯 markdown）。
2. 再发送 `/publish_wechat`。

### 6.2 Gateway 处理

1. 执行 `Markdown -> HTML -> sanitize -> image rewrite`。
2. 非法图片 URL（相对路径 / http / data / file）直接返回 `422 IMAGE_POLICY_VIOLATION`。
3. 合法内容调用 Agent Remote MCP（`/mcp`）：
   - `publisher_health`
   - `publisher_login_status`
   - 需要登录时 `publisher_login_qr_get`
   - `publisher_publish`
4. 发布成功判定条件：`status=accepted` 且 `execution.draft_saved=true`（表示已保存草稿，不代表已发表）。

### 6.3 Agent 返回分支

1. `accepted`：任务进入 `published`。
2. `waiting_login`：Gateway 回传二维码字段，OpenClaw展示二维码。
3. `publish_failed`：Gateway 转 `publish_failed -> manual_intervention` 并告警。

### 6.4 用户扫码后确认

在 OpenClaw 执行：

```text
/publish_wechat_confirm <task_id>
```

Gateway 仅单次重试发布；重复确认会返回 `409 STATUS_CONFLICT`。

### 6.5 查询状态

```text
/publish_wechat_status <task_id>
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
7. OpenClaw 内完成一次 `/publish_wechat -> waiting_login -> /publish_wechat_confirm -> /publish_wechat_status` 全链路演练。

## 10. 运维与排障入口

1. API 契约：`docs/api-contract.md`
2. 值班手册：`docs/runbook.md`
3. Skill 说明：`docs/openclaw-wechat-markdown-publish-skill.md`
4. Skill 定义：`openclaw-skill/wechat-markdown-publish/SKILL.md`
