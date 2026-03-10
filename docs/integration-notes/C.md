# Package C Integration Notes

## 1) 需要改的文件
- `src/contracts/agent.ts`

## 2) 具体改动点
- 新增 Agent 响应类型映射：
  - `AgentPublishResponseMap`
  - `AgentPublishStatus`
  - `AgentPublishResponseOf<S>`
- 新增运行时解析函数：
  - `parseAgentPublishResponse(value: unknown): AgentPublishResponse`

## 3) 原因
- 当前并行子任务限制下，Package C 只能修改 `src/agent-client/**`。
- `PublisherClient` 已在 `src/agent-client/agent-response.ts` 内实现运行时校验与 typed union 返回。
- 为了统一契约层类型能力，建议总控将同等能力合并到 `src/contracts/agent.ts`，并让 `agent-response.ts` 改为复用契约层导出的解析器。

## 4) 建议 patch 片段
```ts
// src/contracts/agent.ts
export interface AgentPublishResponseMap {
  accepted: AgentAcceptedResponse;
  waiting_login: AgentWaitingLoginResponse;
  publish_failed: AgentFailedResponse;
}

export type AgentPublishStatus = keyof AgentPublishResponseMap;
export type AgentPublishResponseOf<S extends AgentPublishStatus> = AgentPublishResponseMap[S];

export function parseAgentPublishResponse(value: unknown): AgentPublishResponse {
  // 推荐使用 zod 或类型守卫进行 status 分支校验
  // 必须在 accepted/waiting_login/publish_failed 三类间做判别
  throw new Error('implement in controller session');
}
```
