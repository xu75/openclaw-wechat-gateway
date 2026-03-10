# PACKAGE A 集成说明

## 1) 需要改动文件

### 文件
`src/contracts/http.ts`

### 具体改动点
1. 增加 API 错误码到 HTTP 状态码的统一映射常量。
2. 增加 `isApiErrorCode`、`httpStatusForApiError`、`apiErrorCodeFromHttpStatus` 工具函数。

### 原因
PACKAGE A 的 API 层已经在 `src/api/errors/api-error-map.ts` 实现了映射；为避免重复与漂移，建议总控把映射上移到 contracts 作为单一真相源。

### 建议 patch 片段
```ts
// src/contracts/http.ts
export const API_ERROR_HTTP_STATUS = {
  INVALID_REQUEST: 400,
  TASK_NOT_FOUND: 404,
  STATUS_CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  CONTENT_INVALID: 422,
  IMAGE_POLICY_VIOLATION: 422,
  AGENT_UNAVAILABLE: 502,
  AGENT_SIGNATURE_ERROR: 502,
  WAITING_LOGIN_TIMEOUT: 409,
  NOT_IMPLEMENTED: 501,
  INTERNAL_ERROR: 500
} as const satisfies Record<ApiErrorCode, number>;

export function isApiErrorCode(value: unknown): value is ApiErrorCode { ... }
export function httpStatusForApiError(code: ApiErrorCode): number { ... }
export function apiErrorCodeFromHttpStatus(status: number): ApiErrorCode | null { ... }
```

## 2) 需要改动文件

### 文件
`src/app/bootstrap.ts`

### 具体改动点
1. 将路由挂载从“传入 `PublishHandler` 实例”调整为“传入 `IPublishOrchestrator`”。
2. `buildWechatPublishRoutes` 在路由层内部构造 handler，以满足 API 层仅依赖接口。

### 原因
当前为了遵守“禁止改 bootstrap”的并行约束，PACKAGE A 保持了向后兼容签名；若要严格满足“API 层只依赖 `IPublishOrchestrator`”，需要总控统一改接线。

### 建议 patch 片段
```ts
// src/api/routes/wechat-publish.routes.ts
export function buildWechatPublishRoutes(orchestrator: IPublishOrchestrator): Router {
  const handler = new PublishHandler(orchestrator);
  ...
}

// src/app/bootstrap.ts
const orchestrator: IPublishOrchestrator = new PublishOrchestrator();
app.use('/wechat', buildWechatPublishRoutes(orchestrator));
```

## 3) 需要改动文件

### 文件
`docs/api-contract.md`

### 具体改动点
1. 明确统一响应格式（成功 `data` / 失败 `error`）。
2. 补充 API 入参校验规则（`strict`、字段长度与枚举值）。
3. 补充 `x-request-id` 规则。
4. 将错误码映射标注为与 contracts 单一来源一致。

### 原因
PACKAGE A 已在代码层实现这些行为，文档需要由总控统一更新。

### 建议 patch 片段
```md
## Global Response Envelope
成功：{ ok: true, data: ... }
失败：{ ok: false, error: { code, message, details? } }

## Request ID
请求可带 x-request-id；缺失或非法时服务端生成并在响应头回写。
```
