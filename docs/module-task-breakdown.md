# Module Task Breakdown (可派工)

## A. API 接入层

### 目标

1. 完成 HTTP 协议、入参校验、统一错误输出。

### 关键函数签名

```ts
class PublishHandler {
  createAndPublish(req: Request, res: Response, next: NextFunction): Promise<void>;
  confirmLogin(req: Request, res: Response, next: NextFunction): Promise<void>;
  getTask(req: Request, res: Response, next: NextFunction): Promise<void>;
}

function buildWechatPublishRoutes(handler: PublishHandler): Router;
function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void;
```

### 任务单

1. 接入 zod 校验并补全所有输入边界。
2. 完善 `ApiErrorCode -> HTTP` 映射。
3. 加 `x-request-id` 透传和日志字段。

## B. 内容处理管线

### 目标

1. markdown/html 统一成可发布 html。

### 关键函数签名

```ts
interface ContentPipelineInput {
  content: string;
  content_format: 'markdown' | 'html';
}

interface ContentPipelineResult {
  content_html: string;
  replaced_count: number;
  failed_images: Array<{ source: string; reason: string }>;
}

function runContentPipeline(input: ContentPipelineInput): Promise<ContentPipelineResult>;
function markdownToHtml(input: { markdown: string }): Promise<{ html: string }>;
function sanitizeHtml(input: { html: string }): Promise<{ html: string }>;
function rewriteImages(html: string): Promise<ImageRewriteResult>;
```

### 任务单

1. 引入 `unified + remark-parse + remark-gfm + remark-rehype + rehype-stringify`。
2. 引入 `rehype-sanitize` 并固定白名单。
3. 完成图片 URL 策略（拒绝相对路径、禁止 `data/file`）。
4. 产出处理报告字段并回写审计日志。

## C. Agent Client + 安全

### 目标

1. Gateway 内部封装签名与 token 生成。

### 关键函数签名

```ts
function sha256Hex(body: string): string;
function hmacSha256Hex(secret: string, text: string): string;
function buildSigningText(method: string, path: string, timestamp: string, bodySha256: string): string;
function createReviewToken(input: ReviewTokenInput): string;

class PublisherClient {
  publish(payload: AgentPublishRequest): Promise<AgentPublishResponse>;
}
```

### 任务单

1. 增加时间窗防重放逻辑（5 分钟）。
2. 统一 Agent 异常模型和重试策略（仅在允许场景重试）。
3. 补齐签名、token 单测向量。

## D. 领域编排 + 状态机

### 目标

1. 严格执行任务状态迁移并保证幂等。

### 关键函数签名

```ts
interface IPublishOrchestrator {
  createAndPublish(input: PublishRequestDTO): Promise<PublishTask>;
  confirmLogin(taskId: string): Promise<PublishTask>;
  getTask(taskId: string): Promise<PublishTask>;
}

function assertTransition(from: PublishTaskStatus, to: PublishTaskStatus): void;
```

### 任务单

1. 落地状态图合法迁移校验。
2. `waiting_login` 超时转人工。
3. `confirm-login` 单次重试上限控制。
4. 幂等键冲突处理与返回策略。

## E. Repo + sqlite

### 目标

1. 持久化任务、事件、审计链路。

### 关键函数签名

```ts
function openSqlite(dbPath?: string): SqliteDatabase;
function runMigrations(dbPath?: string): void;

interface PublishTaskRepo {
  findByTaskId(taskId: string): Promise<PublishTask | null>;
  findByIdempotencyKey(idempotencyKey: string): Promise<PublishTask | null>;
  create(task: PublishTask): Promise<void>;
  update(taskId: string, patch: Partial<PublishTask>): Promise<PublishTask>;
}
```

### 任务单

1. 实现 sqlite repository concrete class。
2. 增加事务封装（task + event 同事务）。
3. 增加查询分页与按 task_id 回放接口。

## F. 告警与可观测

### 目标

1. 发布异常可被发现、定位、回放。

### 关键函数签名

```ts
class AlertNotifier {
  send(type: AlertType, payload: Record<string, unknown>): Promise<void>;
}

function logInfo(message: string, fields?: LogFields): void;
function logError(message: string, fields?: LogFields): void;
```

### 任务单

1. 接入 webhook/IM 告警。
2. 输出结构化日志并对接采集系统。
3. 暴露基础 metrics（请求量、失败率、等待登录超时数）。

## 并行开发建议

1. 第 1 周：A + C + E（先跑通骨架）。
2. 第 2 周：D + B（打通核心编排链路）。
3. 第 3 周：F + 测试/压测/灰度。

## 每包 DoD（Definition of Done）

1. 单元测试覆盖核心分支。
2. 文档中函数签名与代码一致。
3. 至少 1 条联调用例可复现。
4. 错误码和日志字段可用于排障。
