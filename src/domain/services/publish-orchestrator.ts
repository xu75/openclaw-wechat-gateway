import { createHash, randomUUID } from 'node:crypto';
import type { AgentPublishRequest, AgentPublishResponse } from '../../contracts/agent.js';
import type { PublishAuditLog, PublishEvent, PublishTask } from '../../contracts/domain.js';
import type { PublishRequestDTO } from '../../contracts/http.js';
import type { ContentPipelineInput, ContentPipelineResult } from '../../content-pipeline/index.js';
import type { AlertType } from '../../notifier/alert.types.js';
import type { AuditLogRepo } from '../../repo/audit-log.repo.js';
import type { PublishEventRepo } from '../../repo/publish-event.repo.js';
import type { PublishTaskRepo } from '../../repo/publish-task.repo.js';
import { AgentClientError } from '../../agent-client/errors.js';
import { AppError } from '../../api/middleware/error-handler.js';
import { logError, logInfo } from '../../observability/logger.js';
import { getTraceContext, setTraceContext } from '../../observability/trace.js';
import { assertTransition } from '../state-machine/publish-state-machine.js';

export interface IPublishOrchestrator {
  createAndPublish(input: PublishRequestDTO): Promise<PublishTask>;
  confirmLogin(taskId: string): Promise<PublishTask>;
  getTask(taskId: string): Promise<PublishTask>;
}

export interface PublishRepoDeps {
  tasks: PublishTaskRepo;
  events: PublishEventRepo;
  audits: AuditLogRepo;
}

export interface PublishAgentClient {
  publish(payload: AgentPublishRequest): Promise<AgentPublishResponse>;
}

export interface PublishContentPipeline {
  run(input: ContentPipelineInput): Promise<ContentPipelineResult>;
}

export interface PublishNotifier {
  send(type: AlertType, payload: Record<string, unknown>): Promise<void>;
}

export interface PublishReviewTokenFactory {
  create(input: { taskId: string; idempotencyKey: string }): string;
}

export interface PublishOrchestratorDeps {
  repo: PublishRepoDeps;
  agentClient: PublishAgentClient;
  contentPipeline: PublishContentPipeline;
  notifier: PublishNotifier;
  reviewTokenFactory: PublishReviewTokenFactory;
  waitingLoginTimeoutSeconds: number;
  now?: () => Date;
  idFactory?: () => string;
}

type PublishTrigger = 'initial_publish' | 'confirm_login';

type AgentMappedResult =
  | {
      kind: 'published';
      reason: string;
      patch: Partial<PublishTask>;
    }
  | {
      kind: 'waiting_login';
      reason: string;
      patch: Partial<PublishTask>;
    }
  | {
      kind: 'publish_failed';
      reason: string;
      errorCode: string;
      errorMessage: string;
    };

export class PublishOrchestrator implements IPublishOrchestrator {
  private readonly deps: PublishOrchestratorDeps;
  private readonly now: () => Date;
  private readonly idFactory: () => string;

  constructor(deps?: PublishOrchestratorDeps) {
    this.deps = deps ?? createUnwiredDeps();
    this.now = this.deps.now ?? (() => new Date());
    this.idFactory = this.deps.idFactory ?? (() => randomUUID());
  }

  async createAndPublish(input: PublishRequestDTO): Promise<PublishTask> {
    const taskId = input.task_id.trim();
    const idempotencyKey = input.idempotency_key.trim();
    setTraceContext({
      task_id: taskId,
      stage: 'orchestration',
      status: 'processing'
    });
    logInfo('orchestrator_create_and_publish_start', {
      task_id: taskId,
      stage: 'orchestration',
      status: 'processing'
    });
    const existingByTaskId = await this.deps.repo.tasks.findByTaskId(taskId);
    const existingByIdempotency = await this.deps.repo.tasks.findByIdempotencyKey(idempotencyKey);

    if (existingByTaskId && existingByTaskId.idempotency_key !== idempotencyKey) {
      throw new AppError('task_id already exists with another idempotency_key', {
        code: 'IDEMPOTENCY_CONFLICT',
        details: {
          task_id: taskId,
          idempotency_key: idempotencyKey,
          existing_task_id: existingByTaskId.task_id,
          existing_idempotency_key: existingByTaskId.idempotency_key
        }
      });
    }

    if (existingByIdempotency && existingByIdempotency.task_id !== taskId) {
      throw new AppError('idempotency_key already exists for another task_id', {
        code: 'IDEMPOTENCY_CONFLICT',
        details: {
          task_id: taskId,
          idempotency_key: idempotencyKey,
          existing_task_id: existingByIdempotency.task_id,
          existing_idempotency_key: existingByIdempotency.idempotency_key
        }
      });
    }

    if (existingByTaskId && existingByTaskId.idempotency_key === idempotencyKey) {
      logInfo('orchestrator_idempotent_hit', {
        task_id: taskId,
        stage: 'idempotency',
        status: existingByTaskId.status
      });
      return this.resolveWaitingLoginTimeoutIfNeeded(existingByTaskId, 'idempotent_get_existing_task');
    }

    const contentFormat = input.content_format ?? 'html';
    const channel = input.preferred_channel ?? 'browser';
    const nowIso = this.nowIso();

    const initializedTask: PublishTask = {
      task_id: taskId,
      idempotency_key: idempotencyKey,
      status: 'approved',
      channel,
      title: input.title,
      content_format: contentFormat,
      content_hash: sha256Hex(input.content),
      content_html: input.content,
      login_session_id: null,
      login_session_expires_at: null,
      login_qr_mime: null,
      login_qr_png_base64: null,
      publish_url: null,
      error_code: null,
      error_message: null,
      retry_count: 0,
      created_at: nowIso,
      updated_at: nowIso
    };

    await this.deps.repo.tasks.create(initializedTask);
    await this.appendEvent(taskId, null, 'approved', 'task_initialized');
    await this.appendAudit({
      task_id: taskId,
      stage: 'task_input_initialized',
      trigger: 'create_and_publish',
      payload: {
        task_id: taskId,
        idempotency_key: idempotencyKey,
        title: input.title,
        content_format: contentFormat,
        preferred_channel: channel
      }
    });

    const pipelineResult = await this.deps.contentPipeline.run({
      content: input.content,
      content_format: contentFormat
    });

    await this.appendAudit({
      task_id: taskId,
      stage: 'content_pipeline_result',
      trigger: 'create_and_publish',
      payload: {
        replaced_count: pipelineResult.replaced_count,
        failed_images: pipelineResult.failed_images
      }
    });

    const taskWithPipeline = await this.deps.repo.tasks.update(taskId, {
      content_html: pipelineResult.content_html,
      content_hash: sha256Hex(pipelineResult.content_html)
    });

    const publishingTask = await this.transition(taskWithPipeline, 'publishing', 'initial_publish');
    return this.publishOnce(publishingTask, 'initial_publish');
  }

  async confirmLogin(taskId: string): Promise<PublishTask> {
    setTraceContext({
      task_id: taskId,
      stage: 'confirm_login',
      status: 'processing'
    });
    const task = await this.deps.repo.tasks.findByTaskId(taskId);
    if (!task) {
      throw new AppError('task not found', {
        code: 'TASK_NOT_FOUND'
      });
    }

    if (task.status !== 'waiting_login') {
      throw new AppError('confirm-login is only allowed in waiting_login status', {
        code: 'STATUS_CONFLICT',
        details: {
          current_status: task.status
        }
      });
    }

    if (this.isWaitingLoginExpired(task)) {
      const moved = await this.moveWaitingLoginToManual(task, 'waiting_login_timeout_before_confirm');
      throw new AppError('waiting_login already timed out', {
        code: 'WAITING_LOGIN_TIMEOUT',
        details: {
          task: moved
        }
      });
    }

    if (task.retry_count >= 1) {
      throw new AppError('confirm-login retry limit exceeded', {
        code: 'STATUS_CONFLICT',
        details: {
          current_status: task.status,
          retry_count: task.retry_count
        }
      });
    }

    const publishingTask = await this.transition(task, 'publishing', 'confirm_login_retry_once', {
      retry_count: task.retry_count + 1
    });
    return this.publishOnce(publishingTask, 'confirm_login');
  }

  async getTask(taskId: string): Promise<PublishTask> {
    setTraceContext({
      task_id: taskId,
      stage: 'get_task',
      status: 'processing'
    });
    const task = await this.deps.repo.tasks.findByTaskId(taskId);
    if (!task) {
      throw new AppError('task not found', {
        code: 'TASK_NOT_FOUND'
      });
    }

    return this.resolveWaitingLoginTimeoutIfNeeded(task, 'get_task');
  }

  private async resolveWaitingLoginTimeoutIfNeeded(task: PublishTask, trigger: string): Promise<PublishTask> {
    if (task.status !== 'waiting_login') {
      return task;
    }

    if (!this.isWaitingLoginExpired(task)) {
      return task;
    }

    return this.moveWaitingLoginToManual(task, `${trigger}_waiting_login_timeout`);
  }

  private async publishOnce(task: PublishTask, trigger: PublishTrigger): Promise<PublishTask> {
    const reviewToken = this.deps.reviewTokenFactory.create({
      taskId: task.task_id,
      idempotencyKey: task.idempotency_key
    });

    const payload: AgentPublishRequest = {
      task_id: task.task_id,
      idempotency_key: task.idempotency_key,
      title: task.title,
      content: task.content_html,
      review_approved: true,
      review_approval_token: reviewToken,
      preferred_channel: task.channel
    };

    await this.appendAudit({
      task_id: task.task_id,
      stage: 'agent_publish_request',
      trigger,
      payload: {
        task_id: payload.task_id,
        idempotency_key: payload.idempotency_key,
        title: payload.title,
        preferred_channel: payload.preferred_channel
      }
    });

    try {
      const response = await this.deps.agentClient.publish(payload);
      await this.appendAudit({
        task_id: task.task_id,
        stage: 'agent_publish_response',
        trigger,
        payload: response
      });

      const mapped = this.mapAgentResponse(response, trigger);
      await this.appendAudit({
        task_id: task.task_id,
        stage: 'agent_response_mapped',
        trigger,
        payload: mapped
      });

      if (mapped.kind === 'published') {
        return this.transition(task, 'published', mapped.reason, mapped.patch);
      }

      if (mapped.kind === 'waiting_login') {
        return this.transition(task, 'waiting_login', mapped.reason, mapped.patch);
      }

      return this.publishFailedThenManual(task, mapped.errorCode, mapped.errorMessage, mapped.reason);
    } catch (error) {
      return this.handlePublishError(task, error, trigger);
    }
  }

  private mapAgentResponse(response: AgentPublishResponse, trigger: PublishTrigger): AgentMappedResult {
    if (response.status === 'accepted') {
      return {
        kind: 'published',
        reason: 'agent_accepted',
        patch: {
          channel: response.channel,
          publish_url: response.publish_url ?? null,
          error_code: null,
          error_message: null,
          login_session_id: null,
          login_session_expires_at: null,
          login_qr_mime: null,
          login_qr_png_base64: null
        }
      };
    }

    if (response.status === 'waiting_login') {
      return {
        kind: 'waiting_login',
        reason: 'agent_waiting_login',
        patch: {
          channel: response.channel,
          login_session_id: response.login_session_id ?? null,
          login_session_expires_at: this.computeEffectiveLoginExpiry(response.login_session_expires_at),
          login_qr_mime: response.login_qr_mime ?? null,
          login_qr_png_base64: response.login_qr_png_base64 ?? null,
          publish_url: null,
          error_code: response.error_code ?? 'BROWSER_LOGIN_REQUIRED',
          error_message: response.error_message ?? 'wechat login required; manual scan is needed'
        }
      };
    }

    if (response.status === 'publish_failed') {
      return {
        kind: 'publish_failed',
        reason: `agent_publish_failed_${trigger}`,
        errorCode: response.error_code ?? 'PUBLISH_FAILED',
        errorMessage: response.error_message ?? 'publish failed'
      };
    }

    const unknownStatus = (response as { status: string }).status;
    return {
      kind: 'publish_failed',
      reason: `agent_unknown_status_${trigger}`,
      errorCode: 'UNKNOWN_AGENT_STATUS',
      errorMessage: `unknown agent status: ${String(unknownStatus)}`
    };
  }

  private async handlePublishError(task: PublishTask, error: unknown, trigger: PublishTrigger): Promise<PublishTask> {
    const statusCode = error instanceof AgentClientError ? error.status : 500;
    const body = error instanceof AgentClientError ? asErrorBody(error.body) : null;
    const classifiedCode = error instanceof AgentClientError ? error.code : null;
    const errorCode =
      classifiedCode === 'AGENT_SIGNATURE_ERROR'
        ? 'AGENT_SIGNATURE_ERROR'
        : typeof body?.error_code === 'string'
        ? body.error_code
        : error instanceof AgentClientError
          ? error.code
          : `AGENT_HTTP_${statusCode}`;
    const errorMessage =
      typeof body?.error_message === 'string'
        ? body.error_message
        : error instanceof Error
          ? error.message
          : 'agent request failed';

    await this.appendAudit({
      task_id: task.task_id,
      stage: 'agent_publish_error',
      trigger,
      payload: {
        status_code: statusCode,
        error_code: errorCode,
        error_message: errorMessage,
        error_body: body
      }
    });
    logError('agent_publish_error', {
      task_id: task.task_id,
      stage: 'agent_publish',
      status: 'failed',
      error_code: errorCode
    });

    if (statusCode === 401 || statusCode === 403 || errorCode.includes('SIGNATURE')) {
      await this.safeNotify('signature_anomaly', {
        task_id: task.task_id,
        trigger,
        status_code: statusCode,
        error_code: errorCode,
        error_message: errorMessage
      });
    }

    return this.publishFailedThenManual(task, errorCode, errorMessage, `agent_http_error_${trigger}`);
  }

  private async publishFailedThenManual(
    task: PublishTask,
    errorCode: string,
    errorMessage: string,
    reason: string
  ): Promise<PublishTask> {
    const failedTask = await this.transition(task, 'publish_failed', reason, {
      error_code: errorCode,
      error_message: errorMessage
    });
    await this.safeNotify('publish_failed', {
      task_id: failedTask.task_id,
      error_code: errorCode,
      error_message: errorMessage
    });

    const manualTask = await this.transition(failedTask, 'manual_intervention', `${reason}_to_manual`, {
      error_code: errorCode,
      error_message: errorMessage
    });
    await this.safeNotify('manual_intervention', {
      task_id: manualTask.task_id,
      reason,
      error_code: errorCode,
      error_message: errorMessage
    });

    return manualTask;
  }

  private async moveWaitingLoginToManual(task: PublishTask, reason: string): Promise<PublishTask> {
    const moved = await this.transition(task, 'manual_intervention', reason, {
      error_code: 'WAITING_LOGIN_TIMEOUT',
      error_message: 'waiting_login timed out before confirmation'
    });
    logError('waiting_login_timed_out', {
      task_id: moved.task_id,
      stage: 'waiting_login',
      status: 'manual_intervention',
      error_code: 'WAITING_LOGIN_TIMEOUT'
    });

    await this.safeNotify('manual_intervention', {
      task_id: moved.task_id,
      reason,
      error_code: moved.error_code,
      error_message: moved.error_message
    });

    return moved;
  }

  private async transition(
    task: PublishTask,
    toStatus: PublishTask['status'],
    reason: string,
    patch: Partial<PublishTask> = {}
  ): Promise<PublishTask> {
    assertTransition(task.status, toStatus);

    const updated = await this.deps.repo.tasks.update(task.task_id, {
      ...patch,
      status: toStatus
    });

    await this.appendEvent(task.task_id, task.status, toStatus, reason);
    await this.appendAudit({
      task_id: task.task_id,
      stage: 'status_transition',
      trigger: reason,
      payload: {
        from_status: task.status,
        to_status: toStatus,
        patch
      }
    });
    if (toStatus === 'publish_failed' || toStatus === 'manual_intervention') {
      logError('task_status_transition', {
        task_id: updated.task_id,
        stage: 'status_transition',
        status: toStatus,
        error_code: updated.error_code ?? undefined,
        from_status: task.status,
        to_status: toStatus,
        reason
      });
    } else {
      logInfo('task_status_transition', {
        task_id: updated.task_id,
        stage: 'status_transition',
        status: toStatus,
        from_status: task.status,
        to_status: toStatus,
        reason
      });
    }

    return updated;
  }

  private computeEffectiveLoginExpiry(agentExpiresAt: string | undefined): string {
    const capped = new Date(this.now().getTime() + this.deps.waitingLoginTimeoutSeconds * 1000);
    if (!agentExpiresAt) {
      return capped.toISOString();
    }

    const fromAgent = new Date(agentExpiresAt);
    if (Number.isNaN(fromAgent.getTime())) {
      return capped.toISOString();
    }

    return fromAgent.getTime() <= capped.getTime() ? fromAgent.toISOString() : capped.toISOString();
  }

  private isWaitingLoginExpired(task: PublishTask): boolean {
    if (!task.login_session_expires_at) {
      return false;
    }

    const expiresAt = new Date(task.login_session_expires_at);
    if (Number.isNaN(expiresAt.getTime())) {
      return false;
    }

    return expiresAt.getTime() <= this.now().getTime();
  }

  private async appendEvent(
    taskId: string,
    fromStatus: PublishEvent['from_status'],
    toStatus: PublishEvent['to_status'],
    reason: string
  ): Promise<void> {
    await this.deps.repo.events.append({
      id: this.idFactory(),
      task_id: taskId,
      from_status: fromStatus,
      to_status: toStatus,
      reason,
      created_at: this.nowIso()
    });
  }

  private async appendAudit(input: {
    task_id: string;
    stage: string;
    trigger: string;
    payload: unknown;
  }): Promise<void> {
    const record: PublishAuditLog = {
      id: this.idFactory(),
      task_id: input.task_id,
      stage: input.stage,
      trigger: input.trigger,
      payload_json: JSON.stringify(input.payload ?? null),
      created_at: this.nowIso()
    };
    await this.deps.repo.audits.append(record);
  }

  private async safeNotify(type: AlertType, payload: Record<string, unknown>): Promise<void> {
    const trace = getTraceContext();
    const enrichedPayload: Record<string, unknown> = {
      ...payload
    };
    if (typeof enrichedPayload.request_id !== 'string' && typeof trace?.request_id === 'string') {
      enrichedPayload.request_id = trace.request_id;
    }
    if (typeof enrichedPayload.task_id !== 'string' && typeof trace?.task_id === 'string') {
      enrichedPayload.task_id = trace.task_id;
    }

    try {
      await this.deps.notifier.send(type, enrichedPayload);
    } catch (error) {
      if (typeof enrichedPayload.task_id !== 'string') {
        return;
      }
      await this.appendAudit({
        task_id: enrichedPayload.task_id,
        stage: 'notifier_failed',
        trigger: type,
        payload: {
          notify_type: type,
          notify_payload: enrichedPayload,
          error: error instanceof Error ? error.message : String(error)
        }
      });
    }
  }

  private nowIso(): string {
    return this.now().toISOString();
  }
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function asErrorBody(value: unknown): { error_code?: string; error_message?: string } | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  return value as { error_code?: string; error_message?: string };
}

function createUnwiredDeps(): PublishOrchestratorDeps {
  const notWired = (): never => {
    throw new AppError('publish orchestration dependencies are not wired', {
      code: 'NOT_IMPLEMENTED'
    });
  };

  return {
    repo: {
      tasks: {
        findByTaskId: async () => notWired(),
        findByIdempotencyKey: async () => notWired(),
        create: async () => notWired(),
        update: async () => notWired()
      },
      events: {
        append: async () => notWired(),
        listByTaskId: async () => notWired()
      },
      audits: {
        append: async () => notWired(),
        listByTaskId: async () => notWired()
      }
    },
    agentClient: {
      publish: async () => notWired()
    },
    contentPipeline: {
      run: async () => notWired()
    },
    notifier: {
      send: async () => notWired()
    },
    reviewTokenFactory: {
      create: () => notWired()
    },
    waitingLoginTimeoutSeconds: 600
  };
}
