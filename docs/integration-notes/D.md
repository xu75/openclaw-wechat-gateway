# PACKAGE D Integration Notes

## 1) 需要改动文件
- `src/app/bootstrap.ts`

## 2) 具体改动点
- 以构造参数方式注入 `PublishOrchestrator` 依赖：
  - `repo.tasks / repo.events / repo.audits`
  - `agentClient.publish`
  - `contentPipeline.run`
  - `notifier.send`
  - `reviewTokenFactory.create`
  - `waitingLoginTimeoutSeconds`
- 保持路由层调用 `buildWechatPublishRoutes(orchestrator)`，不要传 `PublishHandler` 实例。

## 3) 原因
- PACKAGE D 已将编排器改为“依赖驱动”，领域层不直接耦合具体基础设施实现。
- 当前无接线时，`PublishOrchestrator` 会触发 `NOT_IMPLEMENTED`（防止误运行未注入实例）。

## 4) 建议 patch 片段
```ts
// src/app/bootstrap.ts
import { PublishOrchestrator } from '../domain/services/publish-orchestrator.js';
import { buildWechatPublishRoutes } from '../api/routes/wechat-publish.routes.js';

const orchestrator = new PublishOrchestrator({
  repo: {
    tasks: /* PublishTaskRepo impl */,
    events: /* PublishEventRepo impl */,
    audits: /* AuditLogRepo impl */
  },
  agentClient: {
    publish: async (payload) => {
      // call PublisherClient
    }
  },
  contentPipeline: {
    run: async (input) => {
      // call runContentPipeline
    }
  },
  notifier: {
    send: async (type, payload) => {
      // call AlertNotifier
    }
  },
  reviewTokenFactory: {
    create: ({ taskId, idempotencyKey }) => {
      // call createReviewToken
      return '...';
    }
  },
  waitingLoginTimeoutSeconds: 600
});

app.use('/wechat', buildWechatPublishRoutes(orchestrator));
```
