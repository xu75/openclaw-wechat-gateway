# Openclaw Wechat Gateway Runbook

## 1) API 联调最小命令

```bash
# 1. 发布
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

# 2. 查询任务（会触发 waiting_login 超时检查）
curl -sS 'http://127.0.0.1:3000/wechat/publish/task-demo-1' \
  -H 'x-request-id: req-demo-1'

# 3. 确认登录（仅 waiting_login 且仅一次重试）
curl -sS -X POST 'http://127.0.0.1:3000/wechat/publish/task-demo-1/confirm-login' \
  -H 'x-request-id: req-demo-1' \
  -H 'Content-Type: application/json'
```

## 2) 告警含义

### `publish_failed`
- 含义：发布调用失败，任务已进入失败分支。
- 关键字段：`task_id` `stage` `status=failed` `error_code`。

### `manual_intervention`
- 含义：任务已进入人工介入状态（登录超时或失败后转人工）。
- 关键字段：`task_id` `stage=manual_intervention` `error_code`。

### `signature_anomaly`
- 含义：签名校验异常（401/403 或签名类错误码）。
- 关键字段：`task_id` `stage=signature_verification` `status=anomaly` `error_code`。

## 3) 常见故障

1. Agent 不可用：`AGENT_UNAVAILABLE` 或 `AGENT_HTTP_5xx` 激增。
2. 登录超时：`waiting_login` -> `manual_intervention`，`error_code=WAITING_LOGIN_TIMEOUT`。
3. 签名异常：`AGENT_SIGNATURE_ERROR` + `signature_anomaly` 告警。
4. 告警 webhook 失败：stderr 出现 `alert_delivery_error`。

## 4) 排查步骤

1. 先按 `request_id` 聚合同一请求日志。
2. 再按 `task_id` 看状态迁移日志与错误码。
3. 到 sqlite 回放任务、事件、审计。

## 5) sqlite 回放命令

```bash
sqlite3 ./data/gateway.db "SELECT * FROM publish_tasks WHERE task_id='task-demo-1';"
sqlite3 ./data/gateway.db "SELECT * FROM publish_events WHERE task_id='task-demo-1' ORDER BY created_at,id;"
sqlite3 ./data/gateway.db "SELECT * FROM publish_audit_logs WHERE task_id='task-demo-1' ORDER BY created_at,id;"
```

## 6) 关键日志字段规范

每条关键日志至少包含：
- `request_id`
- `task_id`（若上下文有任务）
- `stage`
- `status`
- `error_code`（失败时）
