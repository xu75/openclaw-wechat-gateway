export type AgentClientErrorCode =
  | 'AGENT_SIGNATURE_ERROR'
  | 'AGENT_UNAVAILABLE'
  | 'AGENT_BUSINESS_ERROR';

export interface AgentClientErrorOptions {
  code: AgentClientErrorCode;
  status: number;
  body?: unknown;
  cause?: unknown;
}

type ErrorBodyLike = {
  error_code?: unknown;
  error_message?: unknown;
  message?: unknown;
};

function textContainsSignatureHint(text: string): boolean {
  const normalized = text.toUpperCase();
  return normalized.includes('SIGNATURE') || normalized.includes('HMAC');
}

function extractCandidateTexts(body: unknown): string[] {
  if (typeof body === 'string') {
    return [body];
  }

  if (!(typeof body === 'object' && body !== null)) {
    return [];
  }

  const record = body as ErrorBodyLike;
  const texts: string[] = [];

  if (typeof record.error_code === 'string') {
    texts.push(record.error_code);
  }
  if (typeof record.error_message === 'string') {
    texts.push(record.error_message);
  }
  if (typeof record.message === 'string') {
    texts.push(record.message);
  }

  return texts;
}

function hasSignatureHint(body: unknown): boolean {
  return extractCandidateTexts(body).some(textContainsSignatureHint);
}

function bodyMessage(body: unknown): string | null {
  if (typeof body === 'string' && body.trim()) {
    return body;
  }

  if (typeof body === 'object' && body !== null) {
    const record = body as ErrorBodyLike;
    if (typeof record.error_message === 'string' && record.error_message.trim()) {
      return record.error_message;
    }
    if (typeof record.message === 'string' && record.message.trim()) {
      return record.message;
    }
  }

  return null;
}

export class AgentClientError extends Error {
  readonly code: AgentClientErrorCode;
  readonly status: number;
  readonly body?: unknown;

  constructor(message: string, options: AgentClientErrorOptions) {
    super(message);
    this.name = 'AgentClientError';
    this.code = options.code;
    this.status = options.status;
    this.body = options.body;
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

export function classifyAgentHttpFailure(status: number, body: unknown): AgentClientErrorCode {
  if (status === 401 || status === 403 || hasSignatureHint(body)) {
    return 'AGENT_SIGNATURE_ERROR';
  }

  if (status >= 500 || status === 408 || status === 429) {
    return 'AGENT_UNAVAILABLE';
  }

  return 'AGENT_BUSINESS_ERROR';
}

export function createAgentHttpError(status: number, body: unknown): AgentClientError {
  const code = classifyAgentHttpFailure(status, body);
  const message = bodyMessage(body) ?? `agent request failed: ${status}`;

  return new AgentClientError(message, {
    code,
    status,
    body
  });
}

export function createAgentUnavailableError(cause: unknown): AgentClientError {
  return new AgentClientError('agent unavailable', {
    code: 'AGENT_UNAVAILABLE',
    status: 502,
    cause
  });
}

export function createAgentBusinessError(message: string, body?: unknown): AgentClientError {
  return new AgentClientError(message, {
    code: 'AGENT_BUSINESS_ERROR',
    status: 502,
    body
  });
}
