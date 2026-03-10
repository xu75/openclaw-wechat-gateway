import type { AlertEvent, AlertPayload, AlertSeverity, AlertType } from './alert.types.js';

const DEFAULT_SERVICE = 'openclaw-wechat-gateway';
const DEFAULT_WEBHOOK_TIMEOUT_MS = 4000;

const DEFAULT_STAGE_BY_TYPE: Record<AlertType, string> = {
  publish_failed: 'publish',
  manual_intervention: 'manual_intervention',
  signature_anomaly: 'signature_verification'
};

const DEFAULT_STATUS_BY_TYPE: Record<AlertType, string> = {
  publish_failed: 'failed',
  manual_intervention: 'manual_intervention_required',
  signature_anomaly: 'anomaly'
};

const DEFAULT_SEVERITY_BY_TYPE: Record<AlertType, AlertSeverity> = {
  publish_failed: 'critical',
  manual_intervention: 'warning',
  signature_anomaly: 'critical'
};

export interface AlertNotifierOptions {
  webhook?: string;
  service?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class AlertNotifier {
  private readonly webhook: string;
  private readonly service: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(webhookOrOptions: string | AlertNotifierOptions = {}) {
    const options: AlertNotifierOptions =
      typeof webhookOrOptions === 'string' ? { webhook: webhookOrOptions } : webhookOrOptions;

    this.webhook = firstNonEmpty(options.webhook, process.env.ALERT_WEBHOOK) ?? '';
    this.service = firstNonEmpty(options.service, process.env.SERVICE_NAME) ?? DEFAULT_SERVICE;
    this.timeoutMs = asPositiveInt(options.timeoutMs, DEFAULT_WEBHOOK_TIMEOUT_MS);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async send(type: AlertType, payload: Record<string, unknown>): Promise<void> {
    const event = this.buildAlertEvent(type, payload);
    console.error(JSON.stringify(event));

    if (!this.webhook) {
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(this.webhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(event),
        signal: controller.signal
      });

      if (response.ok) {
        return;
      }

      const body = await safeReadText(response);
      console.error(
        JSON.stringify({
          event_type: 'alert_delivery_error',
          service: this.service,
          transport: 'webhook',
          occurred_at: new Date().toISOString(),
          request_id: event.request_id,
          task_id: event.task_id,
          stage: event.stage,
          status: 'failed',
          error_code: 'ALERT_WEBHOOK_HTTP_ERROR',
          alert_type: event.type,
          webhook_status: response.status,
          webhook_body: body
        })
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          event_type: 'alert_delivery_error',
          service: this.service,
          transport: 'webhook',
          occurred_at: new Date().toISOString(),
          request_id: event.request_id,
          task_id: event.task_id,
          stage: event.stage,
          status: 'failed',
          error_code: 'ALERT_WEBHOOK_REQUEST_FAILED',
          alert_type: event.type,
          error_message: error instanceof Error ? error.message : String(error)
        })
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async alert(type: AlertType, payload: Record<string, unknown>): Promise<void> {
    await this.send(type, payload);
  }

  private buildAlertEvent(type: AlertType, payload: Record<string, unknown>): AlertEvent {
    const normalizedPayload = normalizePayload(payload);
    const stage = asNonEmptyString(normalizedPayload.stage) ?? DEFAULT_STAGE_BY_TYPE[type];
    const status = asNonEmptyString(normalizedPayload.status) ?? DEFAULT_STATUS_BY_TYPE[type];
    const requestId = asNonEmptyString(normalizedPayload.request_id);
    const taskId = asNonEmptyString(normalizedPayload.task_id);
    const errorCode = asNonEmptyString(normalizedPayload.error_code);

    const event: AlertEvent = {
      event_type: 'alert',
      type,
      severity: DEFAULT_SEVERITY_BY_TYPE[type],
      service: this.service,
      occurred_at: new Date().toISOString(),
      stage,
      status,
      payload: normalizedPayload
    };

    if (requestId) {
      event.request_id = requestId;
    }
    if (taskId) {
      event.task_id = taskId;
    }
    if (errorCode) {
      event.error_code = errorCode;
    }

    return event;
  }
}

function normalizePayload(payload: Record<string, unknown>): AlertPayload {
  const normalized: AlertPayload = {};
  for (const [key, value] of Object.entries(payload)) {
    normalized[key] = value;
  }
  const requestId = asNonEmptyString(payload.request_id) ?? asNonEmptyString(payload.requestId);
  const taskId = asNonEmptyString(payload.task_id) ?? asNonEmptyString(payload.taskId);
  const stage = asNonEmptyString(payload.stage);
  const status = asNonEmptyString(payload.status);
  const errorCode = asNonEmptyString(payload.error_code) ?? asNonEmptyString(payload.errorCode);

  if (requestId) {
    normalized.request_id = requestId;
  }
  if (taskId) {
    normalized.task_id = taskId;
  }
  if (stage) {
    normalized.stage = stage;
  }
  if (status) {
    normalized.status = status;
  }
  if (errorCode) {
    normalized.error_code = errorCode;
  }

  return normalized;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function asPositiveInt(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const normalized = asNonEmptyString(value);
    if (normalized) {
      return normalized;
    }
  }
  return undefined;
}

async function safeReadText(response: Response): Promise<string | undefined> {
  try {
    const text = await response.text();
    return text.trim() ? text : undefined;
  } catch {
    return undefined;
  }
}
