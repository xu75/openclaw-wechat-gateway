export interface AgentPublishRequest {
  task_id: string;
  idempotency_key: string;
  title: string;
  content: string;
  review_approved: true;
  review_approval_token: string;
  preferred_channel: 'browser' | 'official';
}

export interface AgentAcceptedResponse {
  status: 'accepted';
  channel: 'browser' | 'official';
  publish_url: string;
  task_id: string;
  idempotency_key: string;
}

export interface AgentWaitingLoginResponse {
  status: 'waiting_login';
  channel: 'browser' | 'official';
  login_url?: string;
  login_session_id?: string;
  login_session_expires_at?: string;
  login_qr_available?: boolean;
  login_qr_mime?: string;
  login_qr_png_base64?: string;
  error_code?: string;
  error_message?: string;
}

export interface AgentFailedResponse {
  status: 'publish_failed';
  channel?: 'browser' | 'official';
  error_code?: string;
  error_message?: string;
  task_id?: string;
  idempotency_key?: string;
}

export type AgentPublishResponse =
  | AgentAcceptedResponse
  | AgentWaitingLoginResponse
  | AgentFailedResponse;

export interface AgentPublishResponseMap {
  accepted: AgentAcceptedResponse;
  waiting_login: AgentWaitingLoginResponse;
  publish_failed: AgentFailedResponse;
}

export type AgentPublishStatus = keyof AgentPublishResponseMap;
export type AgentPublishResponseOf<S extends AgentPublishStatus> = AgentPublishResponseMap[S];

const CHANNEL_VALUES = new Set(['browser', 'official']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function asOptionalString(value: unknown): string | undefined {
  const normalized = asString(value);
  return normalized ?? undefined;
}

function asOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asChannel(value: unknown): 'browser' | 'official' | null {
  return typeof value === 'string' && CHANNEL_VALUES.has(value)
    ? (value as 'browser' | 'official')
    : null;
}

function parseAccepted(value: Record<string, unknown>): AgentAcceptedResponse {
  const channel = asChannel(value.channel);
  const publishUrl = asString(value.publish_url);
  const taskId = asString(value.task_id);
  const idempotencyKey = asString(value.idempotency_key);

  if (!channel || !publishUrl || !taskId || !idempotencyKey) {
    throw new TypeError('invalid accepted response');
  }

  return {
    status: 'accepted',
    channel,
    publish_url: publishUrl,
    task_id: taskId,
    idempotency_key: idempotencyKey
  };
}

function parseWaitingLogin(value: Record<string, unknown>): AgentWaitingLoginResponse {
  const channel = asChannel(value.channel);
  if (!channel) {
    throw new TypeError('invalid waiting_login response');
  }

  const result: AgentWaitingLoginResponse = {
    status: 'waiting_login',
    channel
  };

  const loginUrl = asOptionalString(value.login_url);
  if (loginUrl !== undefined) {
    result.login_url = loginUrl;
  }
  const loginSessionId = asOptionalString(value.login_session_id);
  if (loginSessionId !== undefined) {
    result.login_session_id = loginSessionId;
  }
  const loginSessionExpiresAt = asOptionalString(value.login_session_expires_at);
  if (loginSessionExpiresAt !== undefined) {
    result.login_session_expires_at = loginSessionExpiresAt;
  }
  const loginQrAvailable = asOptionalBoolean(value.login_qr_available);
  if (loginQrAvailable !== undefined) {
    result.login_qr_available = loginQrAvailable;
  }
  const loginQrMime = asOptionalString(value.login_qr_mime);
  if (loginQrMime !== undefined) {
    result.login_qr_mime = loginQrMime;
  }
  const loginQrPngBase64 = asOptionalString(value.login_qr_png_base64);
  if (loginQrPngBase64 !== undefined) {
    result.login_qr_png_base64 = loginQrPngBase64;
  }
  const errorCode = asOptionalString(value.error_code);
  if (errorCode !== undefined) {
    result.error_code = errorCode;
  }
  const errorMessage = asOptionalString(value.error_message);
  if (errorMessage !== undefined) {
    result.error_message = errorMessage;
  }

  return result;
}

function parseFailed(value: Record<string, unknown>): AgentFailedResponse {
  const channel = asChannel(value.channel);
  if (value.channel !== undefined && !channel) {
    throw new TypeError('invalid publish_failed response');
  }

  const result: AgentFailedResponse = { status: 'publish_failed' };
  if (channel) {
    result.channel = channel;
  }

  const errorCode = asOptionalString(value.error_code);
  if (errorCode !== undefined) {
    result.error_code = errorCode;
  }
  const errorMessage = asOptionalString(value.error_message);
  if (errorMessage !== undefined) {
    result.error_message = errorMessage;
  }
  const taskId = asOptionalString(value.task_id);
  if (taskId !== undefined) {
    result.task_id = taskId;
  }
  const idempotencyKey = asOptionalString(value.idempotency_key);
  if (idempotencyKey !== undefined) {
    result.idempotency_key = idempotencyKey;
  }

  return result;
}

export function parseAgentPublishResponse(value: unknown): AgentPublishResponse {
  if (!isRecord(value)) {
    throw new TypeError('agent response must be an object');
  }

  const status = asString(value.status);
  if (status === 'accepted') {
    return parseAccepted(value);
  }
  if (status === 'waiting_login') {
    return parseWaitingLogin(value);
  }
  if (status === 'publish_failed') {
    return parseFailed(value);
  }

  throw new TypeError(`unknown agent response status: ${String(value.status)}`);
}
