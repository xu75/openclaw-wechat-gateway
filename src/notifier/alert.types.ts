export const ALERT_TYPES = ['publish_failed', 'manual_intervention', 'signature_anomaly'] as const;

export type AlertType = (typeof ALERT_TYPES)[number];

export type AlertSeverity = 'warning' | 'critical';

export interface AlertPayload extends Record<string, unknown> {
  request_id?: string;
  task_id?: string;
  stage?: string;
  status?: string;
  error_code?: string;
}

export interface AlertEvent {
  event_type: 'alert';
  type: AlertType;
  severity: AlertSeverity;
  service: string;
  occurred_at: string;
  request_id?: string;
  task_id?: string;
  stage: string;
  status: string;
  error_code?: string;
  payload: AlertPayload;
}
