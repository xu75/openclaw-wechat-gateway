import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import type { PublishTask } from '../../contracts/domain.js';
import {
  type ConfirmLoginParamsDTO,
  type PublishRequestDTO,
  type PublishTaskView
} from '../../contracts/http.js';
import type { IPublishOrchestrator } from '../../domain/services/publish-orchestrator.js';
import {
  apiErrorCodeFromHttpStatus,
  httpStatusForApiError,
  isApiErrorCode
} from '../errors/api-error-map.js';
import { AppError } from '../middleware/error-handler.js';
import { logError, logInfo } from '../../observability/logger.js';
import { setTraceContext } from '../../observability/trace.js';

const taskIdSchema = z.string().trim().min(1).max(128);
const idempotencyKeySchema = z.string().trim().min(1).max(128);

const publishRequestSchema = z.object({
  task_id: taskIdSchema,
  idempotency_key: idempotencyKeySchema,
  title: z.string().trim().min(1).max(200),
  content: z.string().trim().min(1),
  content_format: z.enum(['markdown', 'html']).optional(),
  preferred_channel: z.enum(['browser', 'official']).optional()
}).strict();

const taskParamsSchema = z.object({
  task_id: taskIdSchema
}).strict();

type OrchestratorError = {
  code?: unknown;
  message?: unknown;
  status?: unknown;
  details?: unknown;
};

function toPublishTaskView(task: PublishTask): PublishTaskView {
  return {
    task_id: task.task_id,
    idempotency_key: task.idempotency_key,
    status: task.status,
    channel: task.channel,
    title: task.title,
    content_format: task.content_format,
    content_hash: task.content_hash,
    login_session_id: task.login_session_id,
    login_session_expires_at: task.login_session_expires_at,
    login_qr_mime: task.login_qr_mime,
    login_qr_png_base64: task.login_qr_png_base64,
    publish_url: task.publish_url,
    error_code: task.error_code,
    error_message: task.error_message,
    created_at: task.created_at,
    updated_at: task.updated_at
  };
}

function mapOrchestratorError(err: unknown): AppError | null {
  if (err instanceof AppError) {
    return err;
  }

  if (!(typeof err === 'object' && err !== null)) {
    return null;
  }

  const e = err as OrchestratorError;

  if (isApiErrorCode(e.code)) {
    const status = typeof e.status === 'number' ? e.status : httpStatusForApiError(e.code);
    const message = typeof e.message === 'string' && e.message.trim() ? e.message : 'request failed';
    return new AppError(message, {
      code: e.code,
      status,
      details: e.details
    });
  }

  if (typeof e.status === 'number') {
    const mappedCode = apiErrorCodeFromHttpStatus(e.status);
    if (mappedCode) {
      const message = typeof e.message === 'string' && e.message.trim() ? e.message : 'request failed';
      return new AppError(message, {
        code: mappedCode,
        status: e.status,
        details: e.details
      });
    }
  }

  return null;
}

function asValidationError(message: string, details: unknown): AppError {
  return new AppError(message, {
    code: 'INVALID_REQUEST',
    details
  });
}

function errorCodeFromUnknown(error: unknown): string {
  if (error instanceof AppError) {
    return error.code;
  }
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.trim()) {
      return code;
    }
  }
  return 'INTERNAL_ERROR';
}

export class PublishHandler {
  constructor(private readonly orchestrator: IPublishOrchestrator) {}

  createAndPublish = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const parsed = publishRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      next(asValidationError('invalid request body', parsed.error.flatten()));
      return;
    }

    try {
      const body: PublishRequestDTO = {
        task_id: parsed.data.task_id,
        idempotency_key: parsed.data.idempotency_key,
        title: parsed.data.title,
        content: parsed.data.content,
        ...(parsed.data.content_format !== undefined ? { content_format: parsed.data.content_format } : {}),
        ...(parsed.data.preferred_channel !== undefined ? { preferred_channel: parsed.data.preferred_channel } : {})
      };
      setTraceContext({
        task_id: body.task_id,
        stage: 'create_and_publish',
        status: 'processing'
      });
      logInfo('publish_create_start', {
        task_id: body.task_id,
        stage: 'create_and_publish',
        status: 'processing'
      });
      const task = await this.orchestrator.createAndPublish(body);
      logInfo('publish_create_done', {
        task_id: task.task_id,
        stage: 'create_and_publish',
        status: task.status
      });
      res.status(200).json({ ok: true, data: toPublishTaskView(task) });
    } catch (err) {
      logError('publish_create_failed', {
        task_id: parsed.data.task_id,
        stage: 'create_and_publish',
        status: 'failed',
        error_code: errorCodeFromUnknown(err)
      });
      next(mapOrchestratorError(err) ?? err);
    }
  };

  confirmLogin = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const parsed = taskParamsSchema.safeParse(req.params);
    if (!parsed.success) {
      next(asValidationError('invalid request params', parsed.error.flatten()));
      return;
    }

    try {
      const params: ConfirmLoginParamsDTO = parsed.data;
      setTraceContext({
        task_id: params.task_id,
        stage: 'confirm_login',
        status: 'processing'
      });
      logInfo('confirm_login_start', {
        task_id: params.task_id,
        stage: 'confirm_login',
        status: 'processing'
      });
      const task = await this.orchestrator.confirmLogin(params.task_id);
      logInfo('confirm_login_done', {
        task_id: task.task_id,
        stage: 'confirm_login',
        status: task.status
      });
      res.status(200).json({ ok: true, data: toPublishTaskView(task) });
    } catch (err) {
      logError('confirm_login_failed', {
        task_id: parsed.data.task_id,
        stage: 'confirm_login',
        status: 'failed',
        error_code: errorCodeFromUnknown(err)
      });
      next(mapOrchestratorError(err) ?? err);
    }
  };

  getTask = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const parsed = taskParamsSchema.safeParse(req.params);
    if (!parsed.success) {
      next(asValidationError('invalid request params', parsed.error.flatten()));
      return;
    }

    try {
      const params: ConfirmLoginParamsDTO = parsed.data;
      setTraceContext({
        task_id: params.task_id,
        stage: 'get_task',
        status: 'processing'
      });
      logInfo('get_task_start', {
        task_id: params.task_id,
        stage: 'get_task',
        status: 'processing'
      });
      const task = await this.orchestrator.getTask(params.task_id);
      logInfo('get_task_done', {
        task_id: task.task_id,
        stage: 'get_task',
        status: task.status
      });
      res.status(200).json({ ok: true, data: toPublishTaskView(task) });
    } catch (err) {
      logError('get_task_failed', {
        task_id: parsed.data.task_id,
        stage: 'get_task',
        status: 'failed',
        error_code: errorCodeFromUnknown(err)
      });
      next(mapOrchestratorError(err) ?? err);
    }
  };
}
