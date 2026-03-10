export type PublishTaskStatus =
  | 'approved'
  | 'publishing'
  | 'waiting_login'
  | 'published'
  | 'publish_failed'
  | 'manual_intervention';

export interface PublishTask {
  task_id: string;
  idempotency_key: string;
  status: PublishTaskStatus;
  channel: 'browser' | 'official';
  title: string;
  content_format: 'markdown' | 'html';
  content_hash: string;
  content_html: string;
  login_session_id: string | null;
  login_session_expires_at: string | null;
  login_qr_mime: string | null;
  login_qr_png_base64: string | null;
  publish_url: string | null;
  error_code: string | null;
  error_message: string | null;
  retry_count: number;
  created_at: string;
  updated_at: string;
}

export interface PublishEvent {
  id: string;
  task_id: string;
  from_status: PublishTaskStatus | null;
  to_status: PublishTaskStatus;
  reason: string;
  created_at: string;
}

export interface PublishAuditLog {
  id: string;
  task_id: string;
  stage: string;
  trigger: string;
  payload_json: string;
  created_at: string;
}
