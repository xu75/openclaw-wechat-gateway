import type { NextFunction, Request, Response } from 'express';
import {
  apiErrorCodeFromHttpStatus,
  httpStatusForApiError,
  type ApiErrorCode
} from '../errors/api-error-map.js';
import { isApiErrorCode } from '../errors/api-error-map.js';
import { logError } from '../../observability/logger.js';

type ErrorLike = {
  code?: unknown;
  message?: unknown;
  status?: unknown;
  details?: unknown;
};

export class AppError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly details?: unknown;

  constructor(message: string, opts: { code: ApiErrorCode; status?: number; details?: unknown }) {
    super(message);
    this.name = 'AppError';
    this.code = opts.code;
    this.status = opts.status ?? httpStatusForApiError(opts.code);
    this.details = opts.details;
  }
}

function isErrorLike(value: unknown): value is ErrorLike {
  return typeof value === 'object' && value !== null;
}

function normalizeKnownError(err: unknown): AppError | null {
  if (err instanceof AppError) {
    return err;
  }

  if (!isErrorLike(err)) {
    return null;
  }

  if (isApiErrorCode(err.code)) {
    const message = typeof err.message === 'string' && err.message.trim() ? err.message : 'request failed';
    if (typeof err.status === 'number') {
      return new AppError(message, { code: err.code, status: err.status, details: err.details });
    }
    return new AppError(message, { code: err.code, details: err.details });
  }

  if (typeof err.status === 'number') {
    const mappedCode = apiErrorCodeFromHttpStatus(err.status);
    if (mappedCode) {
      const message =
        typeof err.message === 'string' && err.message.trim() ? err.message : 'request failed';
      return new AppError(message, { code: mappedCode, status: err.status, details: err.details });
    }
  }

  return null;
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  const known = normalizeKnownError(err);
  if (known) {
    logError('api_known_error', {
      request_id: typeof res.getHeader('x-request-id') === 'string' ? (res.getHeader('x-request-id') as string) : undefined,
      stage: 'api_error',
      status: 'failed',
      error_code: known.code,
      status_code: known.status
    });
    const payload: {
      ok: false;
      error: {
        code: ApiErrorCode;
        message: string;
        details?: unknown;
      };
    } = {
      ok: false,
      error: {
        code: known.code,
        message: known.message
      }
    };

    if (known.details !== undefined) {
      payload.error.details = known.details;
    }

    res.status(known.status).json(payload);
    return;
  }

  const requestId = res.getHeader('x-request-id');
  logError('api_unhandled_error', {
    request_id: typeof requestId === 'string' ? requestId : undefined,
    stage: 'api_error',
    status: 'failed',
    error_code: 'INTERNAL_ERROR',
    error: err
  });

  res.status(500).json({
    ok: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: 'internal error'
    }
  });
}
