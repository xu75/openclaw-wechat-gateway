# PACKAGE F 集成说明

## 1) 需要改动文件

### 文件
`src/app/bootstrap.ts`

### 具体改动点
1. 在 `requestId` 之后增加“基础请求日志 + trace 关联”中间件：
- 进入请求时记录 `request_start`。
- 响应结束时记录 `request_end`（含耗时、HTTP 状态）。
- 将 `request_id` 放入 trace 上下文，后续日志自动继承。

2. 增加基础指标打点（内存计数器）：
- `http_requests_total{method,route,status}`
- `http_request_errors_total{method,route,status}`

### 原因
- PACKAGE F 已实现结构化日志、trace 上下文和内存 metrics，但并行约束禁止直接修改 `bootstrap`。
- 要满足“请求链路可按 `request_id` 关联”与“快速定位失败阶段”，需要在入口统一接线。

### 建议 patch 片段
```ts
// src/app/bootstrap.ts
import { withTrace } from '../observability/trace.js';
import { logInfo, logError } from '../observability/logger.js';
import { emitCounter } from '../observability/metrics.js';

app.use((req, res, next) => {
  const requestIdHeader = req.header('x-request-id');
  const requestIdValue =
    typeof requestIdHeader === 'string' && requestIdHeader.trim()
      ? requestIdHeader.trim()
      : typeof res.locals.requestId === 'string' && res.locals.requestId.trim()
        ? res.locals.requestId.trim()
        : 'unknown';

  const startedAt = Date.now();
  withTrace({ request_id: requestIdValue, stage: 'http_request', status: 'started' }, () => {
    logInfo('request_start', {
      request_id: requestIdValue,
      stage: 'http_request',
      status: 'started',
      method: req.method,
      route: req.originalUrl
    });
  }).catch(() => undefined);

  res.on('finish', () => {
    const durationMs = Date.now() - startedAt;
    const statusCode = res.statusCode;
    const statusText = statusCode >= 500 ? 'failed' : statusCode >= 400 ? 'client_error' : 'ok';
    const labels = {
      method: req.method,
      route: req.route?.path ? String(req.route.path) : req.path,
      status: String(statusCode)
    };

    emitCounter({ name: 'http_requests_total', labels });
    if (statusCode >= 400) {
      emitCounter({ name: 'http_request_errors_total', labels });
      logError('request_end', {
        request_id: requestIdValue,
        stage: 'http_request',
        status: statusText,
        error_code: `HTTP_${statusCode}`,
        method: req.method,
        route: req.originalUrl,
        status_code: statusCode,
        duration_ms: durationMs
      });
      return;
    }

    logInfo('request_end', {
      request_id: requestIdValue,
      stage: 'http_request',
      status: statusText,
      method: req.method,
      route: req.originalUrl,
      status_code: statusCode,
      duration_ms: durationMs
    });
  });

  next();
});
```
