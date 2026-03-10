# 新项目交接文档（可直接贴到新会话）

项目建议名：`openclaw-wechat-gateway`  
定位：ECS 侧控制面/网关，负责 Openclaw 与本地 `wechat-publisher-agent` 的安全编排调用。

---

## 1. 背景与目标

1. 只做“公众号自动发布”链路，不混入 Cat-Cafe 其他业务。
2. 发布模式固定 `assist`，必须审核通过才允许发布。
3. Agent 在本地 Mac 执行实际发布动作，ECS 只做编排和状态管理。
4. 当前现实约束是：官方接口在你的账号条件下不稳定可用，所以业务主通道以 `browser` 为主，官方可作为未来扩展。
5. 登录流程必须解耦：未登录时返回 `waiting_login` + 二维码，不阻塞请求，不轮询骚扰微信后台。

---

## 2. 已确认的关键决策（不要改）

1. 拓扑：`Openclaw -> ECS Gateway -> FRP(remote:14273) -> local Agent(127.0.0.1:4273)`。
2. 端口约定：本地 Agent 用 `4273`，ECS 访问 FRP 端口 `14273`。
3. 鉴权：ECS 调 Agent 必须带 `X-Timestamp + X-Signature(HMAC-SHA256)`。
4. 审核令牌：Agent 侧开启 `review token` 校验，不带会报 `REVIEW_TOKEN_MISSING`。
5. 未登录策略：只返回 `waiting_login`，不轮询 `/publish`，不自动重复触发浏览器动作。
6. 用户动作：Openclaw 展示二维码后，用户点击“已扫码/已登录”，ECS 再单次调用 `/publish`。
7. 超时策略：`waiting_login` 超时（建议 10 分钟）转 `manual_intervention` + 告警。

---

## 3. 当前联调状态（已验证）

1. 本地 Agent `/health` 正常。
2. FRP 已配置并跑通 `remote:14273 -> 127.0.0.1:4273`。
3. ECS `frps allow_ports` 已包含 `14273`，之前 `port not allowed` 已修复。
4. ECS 到 Agent 连通已验证：`curl http://127.0.0.1:14273/health` 返回 200。
5. ECS 发起签名 `/publish`（带 review token）已拿到业务态：
   - `status=waiting_login`
   - `login_qr_available=true`
   - `login_qr_mime=image/png`
   - `login_qr_png_base64` 已直接在响应里返回（可直接给 Openclaw）。

---

## 4. Agent 现有接口契约（Gateway 必须适配）

1. `GET /health`
2. `POST /publish`（签名必需）
3. `POST /agent/config/init`（签名）
4. `POST /agent/config-check`（签名）
5. `POST /callback`（签名）
6. `GET /agent/login-session/:sessionId`（签名，可选）
7. `GET /agent/login-session/:sessionId/qr`（签名，可选）
8. `GET /agent/login-session/by-request/:taskId/:idempotencyKey`（签名，可选）

说明：由于 `/publish` 的 `waiting_login` 已直接携带二维码，6/7/8 可作为兜底接口，不是主链路必需。

---

## 5. `/publish` 主请求与响应（按现状）

### 请求核心字段

```json
{
  "task_id": "string",
  "idempotency_key": "string",
  "title": "string",
  "content": "<p>html</p>",
  "review_approved": true,
  "review_approval_token": "jwt",
  "preferred_channel": "browser"
}
```

### 可能响应状态

1. `accepted`

```json
{
  "status": "accepted",
  "channel": "browser",
  "publish_url": "https://mp.weixin.qq.com/...",
  "task_id": "...",
  "idempotency_key": "..."
}
```

2. `waiting_login`

```json
{
  "status": "waiting_login",
  "channel": "browser",
  "login_url": "https://mp.weixin.qq.com/",
  "login_session_id": "...",
  "login_session_expires_at": "...",
  "login_qr_available": true,
  "login_qr_mime": "image/png",
  "login_qr_png_base64": "....",
  "error_code": "BROWSER_LOGIN_REQUIRED",
  "error_message": "wechat login required; manual scan is needed"
}
```

3. `publish_failed`

```json
{
  "status": "publish_failed",
  "channel": "browser",
  "error_code": "...",
  "error_message": "...",
  "task_id": "...",
  "idempotency_key": "..."
}
```

---

## 6. 新项目（ECS Gateway）需求清单

1. 对 Openclaw 暴露统一业务接口，不让 Openclaw 直接碰 Agent 密钥。
2. 在 Gateway 内部实现 Agent 请求签名。
3. 在 Gateway 内部生成 `review_approval_token`（与 Agent 校验规则一致）。
4. 统一状态机管理：`approved -> publishing -> waiting_login -> publishing -> published`。
5. `waiting_login` 时把二维码原样回传 Openclaw。
6. 提供“确认已登录再试一次”的接口，触发单次重试发布。
7. 超时未确认登录自动转人工并告警。
8. 全链路审计日志：请求、签名校验结果、状态迁移、错误码、耗时。
9. 幂等保证：同 `idempotency_key` 不重复创建业务终态。
10. 告警：`publish_failed`、`manual_intervention`、签名异常。

---

## 7. 新项目概要设计

### 7.1 组件分层

1. `api`：对 Openclaw 的 HTTP 接口。
2. `service`：发布编排与状态迁移。
3. `agent-client`：封装签名、调用 Agent、重试策略。
4. `token-service`：生成 `review_approval_token`。
5. `repo`：任务表、事件表、审计日志表。
6. `notifier`：告警推送。

### 7.2 建议 API（Gateway 对 Openclaw）

1. `POST /wechat/publish`
2. `POST /wechat/publish/:task_id/confirm-login`
3. `GET /wechat/publish/:task_id`
4. `POST /wechat/publish/:task_id/cancel`（可选）

### 7.3 `POST /wechat/publish` 行为

1. 校验入参并创建任务。
2. 生成 `review_approval_token`。
3. 调 Agent `/publish`。
4. 若 `accepted`：置 `published` 或 `publishing_done`。
5. 若 `waiting_login`：置 `waiting_login`，返回二维码给 Openclaw。
6. 若 `publish_failed`：按错误类型置 `publish_failed` 或触发少量重试后转人工。

### 7.4 `confirm-login` 行为

1. 仅允许当前任务状态是 `waiting_login`。
2. 再次单次调用 Agent `/publish`。
3. 成功则 `published`。
4. 失败则 `publish_failed` 或 `manual_intervention`。

### 7.5 数据模型（最小）

1. `publish_tasks`
2. `publish_events`
3. `publish_audit_logs`

建议字段：
- `task_id`
- `idempotency_key`
- `status`
- `channel`
- `title`
- `content_hash`
- `reviewer`
- `review_approved_at`
- `login_session_id`
- `login_session_expires_at`
- `publish_url`
- `error_code`
- `error_message`
- `retry_count`
- `duration_ms`
- `created_at`
- `updated_at`

---

## 8. 安全与签名细节（必须一致）

1. 签名串：`METHOD + "\n" + PATH + "\n" + TIMESTAMP + "\n" + BODY_SHA256`
2. Header：
   - `X-Timestamp`
   - `X-Signature`
3. 时间窗：5 分钟防重放。
4. 密钥：`WECHAT_AGENT_SIGNING_SECRET` 单独管理，禁止写入仓库。
5. 审核 token secret 与签名 secret 建议隔离，可先兼容同值。

---

## 9. 风控策略（已定）

1. 不做 `waiting_login` 轮询调用 `/publish`。
2. 不做高频重试触发浏览器行为。
3. 仅在用户确认“已扫码”时再单次调用。
4. 浏览器自动化动作中已加人类延时和随机抖动。

---

## 10. 环境变量建议（Gateway）

1. `AGENT_BASE_URL=http://127.0.0.1:14273`
2. `WECHAT_AGENT_SIGNING_SECRET=...`
3. `WECHAT_AGENT_REVIEW_TOKEN_SECRET=...`
4. `WECHAT_AGENT_REVIEW_TOKEN_ISSUER=ecs-review`
5. `WAITING_LOGIN_TIMEOUT_SECONDS=600`
6. `ALERT_WEBHOOK=...`
7. `DB_URL=...`

---

## 11. 验收标准（新项目必须满足）

1. Openclaw 发起发布后，ECS 能正确调用 Agent。
2. 未登录时 Openclaw 能收到并展示二维码（来自 `login_qr_png_base64`）。
3. 用户确认后单次重试可完成发布。
4. 全程无轮询 `/publish`。
5. 超时自动进入 `manual_intervention` 并触发告警。
6. 任一失败可按 `task_id` 查全链路日志。

---

## 12. 迁移与上线建议

1. 新仓库独立开发，不改 Agent 仓库主逻辑。
2. 本地联调通过后再部署 ECS。
3. 先灰度给测试任务，再全量。
4. 任何密钥不入库，只进 ECS secret 管理。
