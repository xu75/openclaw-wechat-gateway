# openclaw-wechat-gateway 架构蓝图（可直接派工）

## 1. 项目定位

`openclaw-wechat-gateway` 是 ECS 侧控制面，职责是把 Openclaw 的发布请求编排成 Agent 可执行任务，并稳定处理登录、人机协同、审计和告警。

固定边界：

1. 内容处理在 Gateway（Markdown/HTML/图片规则）。
2. 发布执行在 Agent（official/browser）。
3. Openclaw 只调 Gateway，不接触 Agent 密钥。

固定拓扑：

1. `Openclaw -> ECS Gateway -> FRP(127.0.0.1:14273) -> local Agent(127.0.0.1:4273)`。

## 2. 现状与目标

当前仓库已有 MVP（JS 单层文件）：

1. 已有 API 三件套：`/wechat/publish`、`/confirm-login`、`/wechat/publish/:task_id`。
2. 已有 HMAC 签名、review token、`waiting_login` 分支和超时转人工。
3. 现存短板：无内容管线、无 TS 分层、无 sqlite、测试覆盖不足。

目标版本（V1）：

1. TypeScript 分层架构。
2. `content-pipeline`（markdown/html 统一输出 html）。
3. sqlite 任务/事件/审计持久化。
4. 可观测性与告警标准化。
5. 可并行开发的模块边界。

## 3. 目标目录结构（建议）

```text
openclaw-wechat-gateway/
  src/
    app/
      server.ts
      bootstrap.ts
    api/
      routes/
        wechat-publish.routes.ts
      handlers/
        publish.handler.ts
      middleware/
        error-handler.ts
        request-id.ts
    contracts/
      http.ts
      domain.ts
      agent.ts
    config/
      env.ts
      constants.ts
    domain/
      entities/
        publish-task.ts
      services/
        publish-orchestrator.ts
      state-machine/
        publish-state-machine.ts
    content-pipeline/
      index.ts
      markdown-to-html.ts
      sanitize-html.ts
      image-rewriter.ts
      validators.ts
    agent-client/
      sign.ts
      token.ts
      publisher-client.ts
      errors.ts
    repo/
      sqlite/
        client.ts
        migrations.ts
      publish-task.repo.ts
      publish-event.repo.ts
      audit-log.repo.ts
    notifier/
      alert.ts
      alert.types.ts
    observability/
      logger.ts
      metrics.ts
      trace.ts
    tests/
      unit/
      integration/
      fixtures/
  migrations/
    001_init.sql
  scripts/
    dev.sh
    smoke-curl.sh
  docs/
    api-contract.md
    runbook.md
  .env.example
  README.md
```

## 4. 模块职责与负责人包

### 包 A：API 接入层

1. 维护路由、入参校验（zod）、错误码规范。
2. 暴露 API：
   `POST /wechat/publish`
   `POST /wechat/publish/:task_id/confirm-login`
   `GET /wechat/publish/:task_id`
3. 保证响应结构稳定，支持 Openclaw 前端直接渲染二维码。

交付物：

1. `api/routes + handlers + middleware`
2. `docs/api-contract.md`

### 包 B：内容处理管线

1. 输入支持 `content_format=markdown|html`。
2. markdown 流程：`parse -> gfm -> html -> sanitize -> image rewrite`。
3. html 流程：`sanitize -> image rewrite`。
4. 统一输出：`content_html`、处理报告（替换数/失败列表/阻断原因）。

交付物：

1. `content-pipeline/*`
2. 单元测试：markdown、sanitize、图片规则。

### 包 C：Agent 客户端与安全

1. 实现签名：`METHOD + "\n" + PATH + "\n" + TIMESTAMP + "\n" + BODY_SHA256`。
2. 注入 `X-Timestamp`、`X-Signature`。
3. 生成 `review_approval_token`（HS256，`iss=ecs-review`）。
4. 统一 Agent 错误映射（`accepted`/`waiting_login`/`publish_failed`/HTTP 异常）。

交付物：

1. `agent-client/*`
2. 签名和 token 用例测试。

### 包 D：领域编排与状态机

1. 严格执行状态迁移：
   `approved -> publishing -> waiting_login -> publishing -> published`
   `waiting_login --timeout--> manual_intervention`
   `publish_failed -> manual_intervention`
2. `confirm-login` 只允许单次重试。
3. 不做 `waiting_login` 轮询。

交付物：

1. `domain/services/publish-orchestrator.ts`
2. `domain/state-machine/publish-state-machine.ts`
3. 状态机测试矩阵。

### 包 E：存储与审计

1. sqlite 三表：任务、事件、审计日志。
2. 幂等约束：`task_id` 唯一、`idempotency_key` 唯一。
3. 保证可按 `task_id` 回放全链路。

交付物：

1. `migrations/001_init.sql`
2. `repo/*`
3. 集成测试（repo + state machine）。

### 包 F：告警与可观测

1. 告警事件：`publish_failed`、`manual_intervention`、`signature_anomaly`。
2. 标准日志字段：`task_id`、`idempotency_key`、`event`、`status`、`duration_ms`。
3. 增加 health/readiness 与基础 metrics。

交付物：

1. `notifier/*`
2. `observability/*`
3. `docs/runbook.md`（故障处理手册）。

## 5. API 契约（Gateway 对 Openclaw）

### POST /wechat/publish

请求字段：

1. `task_id`（string）
2. `idempotency_key`（string）
3. `title`（string）
4. `content`（string）
5. `content_format`（`markdown` 或 `html`，默认 `html`）

返回重点：

1. `status=published|waiting_login|manual_intervention|publish_failed`
2. `waiting_login` 时必须回传：
   `login_qr_mime`
   `login_qr_png_base64`
   `login_session_expires_at`

### POST /wechat/publish/:task_id/confirm-login

1. 仅 `waiting_login` 可调用。
2. 触发一次 publish 重试。
3. 不可进入自动轮询。

### GET /wechat/publish/:task_id

1. 返回当前状态与最近错误信息。
2. 若 `waiting_login` 超时，查询时应触发转 `manual_intervention`。

## 6. 数据库最小模型（sqlite）

`publish_tasks`：

1. `task_id` TEXT PRIMARY KEY
2. `idempotency_key` TEXT UNIQUE NOT NULL
3. `status` TEXT NOT NULL
4. `channel` TEXT NOT NULL DEFAULT 'browser'
5. `title` TEXT NOT NULL
6. `content_format` TEXT NOT NULL
7. `content_hash` TEXT NOT NULL
8. `content_html` TEXT NOT NULL
9. `login_session_id` TEXT
10. `login_session_expires_at` TEXT
11. `publish_url` TEXT
12. `error_code` TEXT
13. `error_message` TEXT
14. `retry_count` INTEGER NOT NULL DEFAULT 0
15. `created_at` TEXT NOT NULL
16. `updated_at` TEXT NOT NULL

`publish_events`：

1. `id` TEXT PRIMARY KEY
2. `task_id` TEXT NOT NULL
3. `from_status` TEXT
4. `to_status` TEXT NOT NULL
5. `reason` TEXT NOT NULL
6. `created_at` TEXT NOT NULL

`publish_audit_logs`：

1. `id` TEXT PRIMARY KEY
2. `task_id` TEXT NOT NULL
3. `stage` TEXT NOT NULL
4. `trigger` TEXT NOT NULL
5. `payload_json` TEXT NOT NULL
6. `created_at` TEXT NOT NULL

## 7. 关键非功能约束

1. 安全：密钥全走环境变量或 ECS Secret，不入库。
2. 稳定：超时默认 600 秒，严格禁止轮询 publish。
3. 可追踪：每次状态迁移必须写事件。
4. 幂等：重复请求返回同任务，不重复执行终态动作。
5. 可扩展：`official` 通道保留扩展位，默认 `browser`。

## 8. 开发里程碑（可并行）

### Sprint 1（P0，1 周）

1. TS 工程化和目录骨架。
2. API 层 + 状态机 + Agent 签名调用迁移完成。
3. sqlite 三表上线，替换 JSON store。
4. 跑通 `waiting_login` 主链路。

### Sprint 2（P1，1 周）

1. 内容管线接入（markdown/html 统一到 html）。
2. 图片 URL 规则与阻断策略上线。
3. 单元测试补齐核心模块。
4. 交付 `smoke-curl.sh` 联调脚本。

### Sprint 3（P2，1 周）

1. 告警/审计/runbook 完整化。
2. 增加集成测试与回归测试。
3. 灰度发布与回滚预案。
4. 发布验收与交接。

## 9. 验收清单（上线门槛）

1. Markdown 输入稳定转换成 HTML，sanitize 生效。
2. 非法图片链接可拦截并返回明确错误。
3. Gateway 调 Agent 签名正确，401/403 能触发 `signature_anomaly`。
4. `waiting_login` 能直接返回二维码给 Openclaw。
5. `confirm-login` 只能单次重试且可成功推进状态。
6. 超时自动转人工并发告警。
7. 按 `task_id` 能查完整任务、事件、审计链路。

## 10. 立即开工顺序（建议）

1. 先建 TS 骨架、迁移配置与启动脚本（包 A/E 先行）。
2. 并行开发包 C 与包 D（签名+状态机）。
3. 接入包 B 内容管线。
4. 最后做包 F 可观测与 runbook。

