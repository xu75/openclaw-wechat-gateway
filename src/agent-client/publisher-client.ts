import {
  type AgentPublishRequest,
  type AgentPublishResponse
} from '../contracts/agent.js';
import { DEFAULT_AGENT_BASE_URL } from '../config/constants.js';
import { parseAgentPublishResponse } from './agent-response.js';
import { createAgentBusinessError, createAgentHttpError, createAgentUnavailableError } from './errors.js';
import { signAgentRequest } from './sign.js';

export interface PublisherClientOptions {
  baseUrl?: string;
  signingSecret: string;
  nowSeconds?: () => number;
  fetchImpl?: typeof fetch;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function parseResponseBody(text: string, contentType: string): unknown {
  if (!text.trim()) {
    return null;
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

export class PublisherClient {
  private readonly baseUrl: string;

  private readonly nowSeconds: () => number;

  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: PublisherClientOptions) {
    const rawBaseUrl = options.baseUrl ?? process.env.AGENT_BASE_URL ?? DEFAULT_AGENT_BASE_URL;
    this.baseUrl = normalizeBaseUrl(rawBaseUrl.trim() || DEFAULT_AGENT_BASE_URL);
    this.nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async publish(payload: AgentPublishRequest): Promise<AgentPublishResponse> {
    const method = 'POST';
    const apiPath = '/publish';
    const timestamp = String(this.nowSeconds());
    const body = JSON.stringify(payload);
    const { signature } = signAgentRequest({
      secret: this.options.signingSecret,
      method,
      path: apiPath,
      timestamp,
      body
    });

    let resp: Response;
    try {
      resp = await this.fetchImpl(`${this.baseUrl}${apiPath}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-Timestamp': timestamp,
          'X-Signature': signature
        },
        body
      });
    } catch (cause) {
      throw createAgentUnavailableError(cause);
    }

    const contentType = resp.headers.get('content-type') ?? '';
    const text = await resp.text();
    const data = parseResponseBody(text, contentType);

    if (!resp.ok) {
      throw createAgentHttpError(resp.status, data);
    }

    try {
      return parseAgentPublishResponse(data);
    } catch {
      throw createAgentBusinessError('agent returned invalid response payload', {
        error_code: 'AGENT_INVALID_RESPONSE',
        response: data
      });
    }
  }
}
