import type { PublishTaskStatus } from './domain.js';

export interface PublishRequestDTO {
  task_id: string;
  idempotency_key: string;
  title: string;
  content: string;
  content_format?: 'markdown' | 'html';
  preferred_channel?: 'browser' | 'official';
}

export interface ConfirmLoginParamsDTO {
  task_id: string;
}

export interface PublishTaskView {
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

export interface ApiSuccess<T> {
  ok: true;
  data: T;
}

export type ApiErrorCode =
  | 'INVALID_REQUEST'
  | 'TASK_NOT_FOUND'
  | 'STATUS_CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'CONTENT_INVALID'
  | 'IMAGE_POLICY_VIOLATION'
  | 'AGENT_UNAVAILABLE'
  | 'AGENT_SIGNATURE_ERROR'
  | 'WAITING_LOGIN_TIMEOUT'
  | 'NOT_IMPLEMENTED'
  | 'INTERNAL_ERROR';

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

const API_ERROR_CODES = Object.keys(API_ERROR_HTTP_STATUS) as ApiErrorCode[];

export function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return typeof value === 'string' && API_ERROR_CODES.includes(value as ApiErrorCode);
}

export function httpStatusForApiError(code: ApiErrorCode): number {
  return API_ERROR_HTTP_STATUS[code];
}

export function apiErrorCodeFromHttpStatus(status: number): ApiErrorCode | null {
  switch (status) {
    case 400:
      return 'INVALID_REQUEST';
    case 404:
      return 'TASK_NOT_FOUND';
    case 409:
      return 'STATUS_CONFLICT';
    case 422:
      return 'CONTENT_INVALID';
    case 501:
      return 'NOT_IMPLEMENTED';
    case 502:
      return 'AGENT_UNAVAILABLE';
    default:
      return null;
  }
}

export interface ApiError {
  ok: false;
  error: {
    code: ApiErrorCode;
    message: string;
    details?: unknown;
  };
}
