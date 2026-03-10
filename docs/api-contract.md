# API Contract (Gateway -> Openclaw)

## Global Rules

- Base path: `/wechat`
- Response envelope:
  - Success: `{ "ok": true, "data": ... }`
  - Error: `{ "ok": false, "error": { "code", "message", "details?" } }`
- Request ID:
  - Client may send header `x-request-id`.
  - If missing/invalid, gateway generates one and always echoes it in response header `x-request-id`.

## Validation Rules

- All request body schemas are `strict` (unknown fields are rejected).
- `task_id`: trimmed string, length `1..128`.
- `idempotency_key`: trimmed string, length `1..128`.
- `title`: trimmed string, length `1..200`.
- `content`: trimmed non-empty string.
- `content_format`: optional enum `markdown | html`.
- `preferred_channel`: optional enum `browser | official`.

## 1) POST /wechat/publish

### Request DTO

```ts
interface PublishRequestDTO {
  task_id: string;
  idempotency_key: string;
  title: string;
  content: string;
  content_format?: 'markdown' | 'html';
  preferred_channel?: 'browser' | 'official';
}
```

### Success Response

```ts
interface ApiSuccess<PublishTaskView> {
  ok: true;
  data: PublishTaskView;
}
```

### Behavior

1. Validate request and apply idempotency checks.
2. Run content pipeline in gateway: markdown/html normalize -> sanitize -> image policy rewrite.
3. Send signed `/publish` request to agent.
4. Transition task state and append event/audit logs.
5. Return task view.

## 2) POST /wechat/publish/:task_id/confirm-login

### Params DTO

```ts
interface ConfirmLoginParamsDTO {
  task_id: string;
}
```

### Success Response

```ts
interface ApiSuccess<PublishTaskView> {
  ok: true;
  data: PublishTaskView;
}
```

### Behavior

1. Only allowed when current status is `waiting_login`.
2. Gateway retries publish exactly once (`retry_count` max 1).
3. Returns latest task view after retry result.

## 3) GET /wechat/publish/:task_id

### Success Response

```ts
interface ApiSuccess<PublishTaskView> {
  ok: true;
  data: PublishTaskView;
}
```

### Behavior

1. Query task by `task_id`.
2. No polling publish is triggered.
3. If task is `waiting_login` and expired, it auto-transitions to `manual_intervention` and emits alert.

## PublishTaskView

```ts
type PublishTaskStatus =
  | 'approved'
  | 'publishing'
  | 'waiting_login'
  | 'published'
  | 'publish_failed'
  | 'manual_intervention';

interface PublishTaskView {
  task_id: string;
  idempotency_key: string;
  status: PublishTaskStatus;
  channel: 'browser' | 'official';
  title: string;
  content_format: 'markdown' | 'html';
  content_hash: string;
  login_session_id: string | null;
  login_session_expires_at: string | null;
  login_qr_mime: string | null;
  login_qr_png_base64: string | null;
  publish_url: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}
```

## Error Model

```ts
interface ApiError {
  ok: false;
  error: {
    code: ApiErrorCode;
    message: string;
    details?: unknown;
  };
}
```

### Error Codes -> HTTP Status

Single source of truth is in [`src/contracts/http.ts`](../src/contracts/http.ts) via `API_ERROR_HTTP_STATUS`.

1. `INVALID_REQUEST` -> 400
2. `TASK_NOT_FOUND` -> 404
3. `STATUS_CONFLICT` -> 409
4. `IDEMPOTENCY_CONFLICT` -> 409
5. `CONTENT_INVALID` -> 422
6. `IMAGE_POLICY_VIOLATION` -> 422
7. `AGENT_UNAVAILABLE` -> 502
8. `AGENT_SIGNATURE_ERROR` -> 502
9. `WAITING_LOGIN_TIMEOUT` -> 409
10. `NOT_IMPLEMENTED` -> 501
11. `INTERNAL_ERROR` -> 500
