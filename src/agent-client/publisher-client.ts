import {
  type AgentAcceptedResponse,
  type AgentFailedResponse,
  type AgentPublishRequest,
  type AgentPublishResponse,
  type AgentWaitingLoginResponse
} from '../contracts/agent.js';
import { DEFAULT_AGENT_BASE_URL } from '../config/constants.js';
import { createAgentBusinessError, createAgentHttpError, createAgentUnavailableError } from './errors.js';

export interface PublisherClientOptions {
  baseUrl?: string;
  signingSecret: string;
  fetchImpl?: typeof fetch;
}

type ToolStatus = 'accepted' | 'waiting_login' | 'publish_failed';

type JsonRpcResponse = {
  result?: unknown;
  error?: unknown;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function asOptionalString(value: unknown): string | undefined {
  return asString(value) ?? undefined;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function asToolStatus(value: unknown): ToolStatus | null {
  if (value === 'accepted' || value === 'waiting_login' || value === 'publish_failed') {
    return value;
  }
  return null;
}

function resolveMcpEndpoint(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (!url.pathname || url.pathname === '/') {
    url.pathname = '/mcp';
  } else {
    url.pathname = url.pathname.replace(/\/+$/, '');
  }
  return url.toString();
}

function parseResponseBody(text: string, contentType: string): unknown {
  if (!text.trim()) {
    return null;
  }

  if (contentType.includes('text/event-stream')) {
    const payloads = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .filter((line) => line.length > 0);

    for (let index = payloads.length - 1; index >= 0; index -= 1) {
      const payload = payloads[index];
      if (!payload) {
        continue;
      }
      try {
        return JSON.parse(payload) as unknown;
      } catch {
        continue;
      }
    }
    return text;
  }

  const shouldParseJson = contentType.includes('application/json') || text.trim().startsWith('{');
  if (!shouldParseJson) {
    return text;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function parseDataUrl(value: string): { mime: string | null; base64: string | null } {
  const matched = /^data:([^;]+);base64,(.+)$/i.exec(value.trim());
  if (!matched) {
    return { mime: null, base64: null };
  }
  return {
    mime: matched[1] ? matched[1].trim() : null,
    base64: matched[2] ? matched[2].trim() : null
  };
}

function collectErrorHintTexts(body: unknown): string[] {
  const texts: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === 'string' && value.trim()) {
      texts.push(value.toLowerCase());
    }
  };

  push(body);
  const root = asRecord(body);
  if (!root) {
    return texts;
  }

  push(root.message);
  push(root.error_message);
  push(root.error_code);

  const error = asRecord(root.error);
  if (error) {
    push(error.message);
    push(error.code);
  }

  return texts;
}

function isInvalidSessionResponse(status: number, body: unknown): boolean {
  if (status !== 400) {
    return false;
  }

  const hints = collectErrorHintTexts(body);
  if (hints.length === 0) {
    return false;
  }

  return hints.some(
    (text) =>
      text.includes('no valid session id provided') ||
      text.includes('invalid session') ||
      text.includes('session not found') ||
      text.includes('mcp-session-id') ||
      text.includes('session id')
  );
}

function mapPublishFailed(
  structured: Record<string, unknown>,
  fallbackCode: string,
  fallbackMessage: string
): AgentFailedResponse {
  const error = asRecord(structured.error);
  return {
    status: 'publish_failed',
    channel: 'browser',
    error_code: asString(error?.code) ?? fallbackCode,
    error_message: asString(error?.message) ?? asString(structured.message) ?? fallbackMessage
  };
}

function mapWaitingLogin(
  structured: Record<string, unknown>,
  channel: 'browser' | 'official'
): AgentWaitingLoginResponse {
  const session = asRecord(structured.session);
  const qr = asRecord(structured.qr) ?? asRecord(session?.qr);
  const error = asRecord(structured.error);
  const qrData = asOptionalString(qr?.data);
  const parsedDataUrl = qrData ? parseDataUrl(qrData) : { mime: null, base64: null };
  const fallbackMessage = asString(structured.message) ?? 'wechat login required; manual scan is needed';

  const response: AgentWaitingLoginResponse = {
    status: 'waiting_login',
    channel,
    login_qr_available: asBoolean(qr?.available) ?? false,
    error_code: asString(error?.code) ?? 'BROWSER_LOGIN_REQUIRED',
    error_message: asString(error?.message) ?? fallbackMessage
  };

  const sessionId = asOptionalString(session?.session_id);
  if (sessionId !== undefined) {
    response.login_session_id = sessionId;
  }

  const expiresAt = asOptionalString(session?.expires_at);
  if (expiresAt !== undefined) {
    response.login_session_expires_at = expiresAt;
  }

  const qrMime = parsedDataUrl.mime ?? asOptionalString(qr?.format);
  if (qrMime !== undefined) {
    response.login_qr_mime = qrMime;
  }

  if (parsedDataUrl.base64 !== null) {
    response.login_qr_png_base64 = parsedDataUrl.base64;
  }

  return response;
}

function mapAccepted(
  structured: Record<string, unknown>,
  payload: AgentPublishRequest
): AgentAcceptedResponse {
  const execution = asRecord(structured.execution);
  const browser = asRecord(structured.browser);
  const currentUrl = asOptionalString(execution?.current_url) ?? asOptionalString(browser?.current_url);

  const response: AgentAcceptedResponse = {
    status: 'accepted',
    channel: payload.preferred_channel,
    task_id: payload.task_id,
    idempotency_key: payload.idempotency_key
  };

  if (currentUrl !== undefined) {
    response.publish_url = currentUrl;
  }

  return response;
}

export class PublisherClient {
  private readonly mcpEndpoint: string;
  private readonly fetchImpl: typeof fetch;
  private mcpSessionId: string | null = null;
  private initPromise: Promise<void> | null = null;
  private healthyChecked = false;
  private rpcSeq = 1;

  constructor(private readonly options: PublisherClientOptions) {
    const rawBaseUrl = options.baseUrl ?? process.env.AGENT_BASE_URL ?? DEFAULT_AGENT_BASE_URL;
    this.mcpEndpoint = resolveMcpEndpoint(rawBaseUrl.trim() || DEFAULT_AGENT_BASE_URL);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async publish(payload: AgentPublishRequest): Promise<AgentPublishResponse> {
    await this.ensureInitialized();
    await this.ensureHealthy();

    const loginStatusStructured = await this.callTool('publisher_login_status', {});
    const loginStatus = asToolStatus(loginStatusStructured.status);
    const loggedIn = asBoolean(loginStatusStructured.logged_in) === true;

    if (loginStatus === 'publish_failed') {
      return mapPublishFailed(
        loginStatusStructured,
        'BROWSER_LOGIN_REQUIRED',
        'publisher_login_status failed'
      );
    }

    if (!(loginStatus === 'accepted' && loggedIn)) {
      const qrStructured = await this.callTool('publisher_login_qr_get', { refresh: false });
      const qrStatus = asToolStatus(qrStructured.status);
      if (qrStatus === 'publish_failed') {
        return mapPublishFailed(
          qrStructured,
          'BROWSER_QR_CAPTURE_FAILED',
          'publisher_login_qr_get failed'
        );
      }
      return mapWaitingLogin(qrStructured, payload.preferred_channel);
    }

    const publishStructured = await this.callTool('publisher_publish', {
      title: payload.title,
      content_html: payload.content
    });

    const publishStatus = asToolStatus(publishStructured.status);
    if (publishStatus === 'waiting_login') {
      return mapWaitingLogin(publishStructured, payload.preferred_channel);
    }
    if (publishStatus === 'publish_failed') {
      return mapPublishFailed(publishStructured, 'BROWSER_CONTENT_INJECTION_FAILED', 'publisher_publish failed');
    }
    if (publishStatus !== 'accepted') {
      return mapPublishFailed(
        publishStructured,
        'UNKNOWN_PUBLISH_STATUS',
        `unknown publish status: ${String(publishStructured.status)}`
      );
    }

    const execution = asRecord(publishStructured.execution);
    const draftSaved = execution?.draft_saved === true;
    if (!draftSaved) {
      return mapPublishFailed(
        publishStructured,
        'DRAFT_NOT_SAVED',
        'content injection passed but draft was not saved'
      );
    }

    return mapAccepted(publishStructured, payload);
  }

  private async ensureInitialized(): Promise<void> {
    if (this.mcpSessionId) {
      return;
    }
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = (async () => {
      await this.rpcRequest('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: {
          name: 'openclaw-wechat-gateway',
          version: '0.2.0'
        }
      }, false, false);

      if (!this.mcpSessionId) {
        throw createAgentBusinessError('mcp initialize did not return mcp-session-id');
      }

      await this.rpcRequest('notifications/initialized', {}, true, true);
    })().finally(() => {
      this.initPromise = null;
    });

    await this.initPromise;
  }

  private async ensureHealthy(): Promise<void> {
    if (this.healthyChecked) {
      return;
    }
    const healthStructured = await this.callTool('publisher_health', {});
    if (asBoolean(healthStructured.healthy) !== true) {
      throw createAgentUnavailableError(new Error('publisher_health reported unhealthy'));
    }
    this.healthyChecked = true;
  }

  private resetSessionCache(): void {
    this.mcpSessionId = null;
    this.healthyChecked = false;
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await this.rpcRequest(
      'tools/call',
      {
        name,
        arguments: args
      },
      true,
      false
    );
    const result = asRecord(response.result);
    if (!result) {
      throw createAgentBusinessError(`mcp tools/call(${name}) returned invalid result`, response.raw);
    }

    const structured = asRecord(result.structuredContent);
    if (!structured) {
      throw createAgentBusinessError(`mcp tools/call(${name}) missing structuredContent`, response.raw);
    }

    return structured;
  }

  private async rpcRequest(
    method: string,
    params: Record<string, unknown>,
    requireSession: boolean,
    notification: boolean,
    allowSessionRecovery = true
  ): Promise<{ result: unknown; raw: unknown }> {
    if (requireSession && !this.mcpSessionId) {
      throw createAgentBusinessError(`mcp session is required for method ${method}`);
    }

    const requestBody: Record<string, unknown> = {
      jsonrpc: '2.0',
      method,
      params
    };
    if (!notification) {
      requestBody.id = this.rpcSeq++;
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream'
    };
    if (this.mcpSessionId) {
      headers['mcp-session-id'] = this.mcpSessionId;
    }

    let resp: Response;
    try {
      resp = await this.fetchImpl(this.mcpEndpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody)
      });
    } catch (cause) {
      throw createAgentUnavailableError(cause);
    }

    const sessionIdHeader = resp.headers.get('mcp-session-id');
    if (sessionIdHeader && sessionIdHeader.trim()) {
      this.mcpSessionId = sessionIdHeader.trim();
    }

    const contentType = resp.headers.get('content-type') ?? '';
    const text = await resp.text();
    const data = parseResponseBody(text, contentType);

    if (!resp.ok) {
      const canRecover =
        allowSessionRecovery &&
        requireSession &&
        method !== 'notifications/initialized' &&
        isInvalidSessionResponse(resp.status, data);

      if (canRecover) {
        this.resetSessionCache();
        await this.ensureInitialized();
        return this.rpcRequest(method, params, requireSession, notification, false);
      }

      throw createAgentHttpError(resp.status, data);
    }

    if (notification) {
      return { result: null, raw: data };
    }

    const body = asRecord(data);
    if (!body) {
      throw createAgentBusinessError(`mcp method ${method} returned invalid response payload`, data);
    }

    if (body.error !== undefined) {
      const err = asRecord(body.error);
      const message = asString(err?.message) ?? `mcp method ${method} failed`;
      throw createAgentBusinessError(message, body.error);
    }

    return {
      result: (body as JsonRpcResponse).result ?? null,
      raw: data
    };
  }
}
