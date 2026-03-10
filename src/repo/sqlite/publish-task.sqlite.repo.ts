import type { PublishTask } from '../../contracts/domain.js';
import type { PublishTaskRepo } from '../publish-task.repo.js';
import type { SqliteDatabase, SqliteTx, SqliteWriteOptions } from './client.js';
import { resolveDb } from './client.js';
import { mapSqliteConstraintError, RepoNotFoundError } from './errors.js';

type PublishTaskRow = PublishTask;

const INSERT_TASK_SQL = `
  INSERT INTO publish_tasks (
    task_id,
    idempotency_key,
    status,
    channel,
    title,
    content_format,
    content_hash,
    content_html,
    login_session_id,
    login_session_expires_at,
    login_qr_mime,
    login_qr_png_base64,
    publish_url,
    error_code,
    error_message,
    retry_count,
    created_at,
    updated_at
  ) VALUES (
    @task_id,
    @idempotency_key,
    @status,
    @channel,
    @title,
    @content_format,
    @content_hash,
    @content_html,
    @login_session_id,
    @login_session_expires_at,
    @login_qr_mime,
    @login_qr_png_base64,
    @publish_url,
    @error_code,
    @error_message,
    @retry_count,
    @created_at,
    @updated_at
  )
`;

const UPDATABLE_TASK_FIELDS: ReadonlyArray<keyof PublishTask> = [
  'status',
  'channel',
  'title',
  'content_format',
  'content_hash',
  'content_html',
  'login_session_id',
  'login_session_expires_at',
  'login_qr_mime',
  'login_qr_png_base64',
  'publish_url',
  'error_code',
  'error_message',
  'retry_count'
];

export class SqlitePublishTaskRepo implements PublishTaskRepo {
  private readonly now: () => Date;

  constructor(private readonly db: SqliteDatabase, now: () => Date = () => new Date()) {
    this.now = now;
  }

  async findByTaskId(taskId: string, options?: SqliteWriteOptions): Promise<PublishTask | null> {
    return this.findByTaskIdSync(taskId, options);
  }

  findByTaskIdSync(taskId: string, options?: SqliteWriteOptions): PublishTask | null {
    const conn = this.pickDb(options);
    const row = conn
      .prepare(
        `SELECT
          task_id, idempotency_key, status, channel, title, content_format, content_hash, content_html,
          login_session_id, login_session_expires_at, login_qr_mime, login_qr_png_base64,
          publish_url, error_code, error_message, retry_count, created_at, updated_at
        FROM publish_tasks
        WHERE task_id = ?`
      )
      .get(taskId) as PublishTaskRow | undefined;
    return row ? mapPublishTaskRow(row) : null;
  }

  async findByIdempotencyKey(idempotencyKey: string, options?: SqliteWriteOptions): Promise<PublishTask | null> {
    return this.findByIdempotencyKeySync(idempotencyKey, options);
  }

  findByIdempotencyKeySync(idempotencyKey: string, options?: SqliteWriteOptions): PublishTask | null {
    const conn = this.pickDb(options);
    const row = conn
      .prepare(
        `SELECT
          task_id, idempotency_key, status, channel, title, content_format, content_hash, content_html,
          login_session_id, login_session_expires_at, login_qr_mime, login_qr_png_base64,
          publish_url, error_code, error_message, retry_count, created_at, updated_at
        FROM publish_tasks
        WHERE idempotency_key = ?`
      )
      .get(idempotencyKey) as PublishTaskRow | undefined;
    return row ? mapPublishTaskRow(row) : null;
  }

  async create(task: PublishTask, options?: SqliteWriteOptions): Promise<void> {
    this.createSync(task, options);
  }

  createInTx(task: PublishTask, tx: SqliteTx): void {
    this.createSync(task, { tx });
  }

  createSync(task: PublishTask, options?: SqliteWriteOptions): void {
    const conn = this.pickDb(options);
    try {
      conn.prepare(INSERT_TASK_SQL).run(task);
    } catch (error) {
      throw mapSqliteConstraintError(error);
    }
  }

  async update(taskId: string, patch: Partial<PublishTask>, options?: SqliteWriteOptions): Promise<PublishTask> {
    return this.updateSync(taskId, patch, options);
  }

  updateInTx(taskId: string, patch: Partial<PublishTask>, tx: SqliteTx): PublishTask {
    return this.updateSync(taskId, patch, { tx });
  }

  updateSync(taskId: string, patch: Partial<PublishTask>, options?: SqliteWriteOptions): PublishTask {
    const conn = this.pickDb(options);
    const params: Record<string, unknown> = { task_id: taskId };
    const updates: string[] = [];

    for (const field of UPDATABLE_TASK_FIELDS) {
      const value = patch[field];
      if (value === undefined) {
        continue;
      }
      params[field] = value;
      updates.push(`${field} = @${field}`);
    }

    const nowIso = this.now().toISOString();
    params.updated_at = nowIso;
    updates.push('updated_at = @updated_at');

    const sql = `UPDATE publish_tasks SET ${updates.join(', ')} WHERE task_id = @task_id`;

    try {
      const result = conn.prepare(sql).run(params);
      if (result.changes === 0) {
        throw new RepoNotFoundError(`publish task not found: ${taskId}`);
      }
      const updated = this.findByTaskIdSync(taskId, options);
      if (!updated) {
        throw new RepoNotFoundError(`publish task not found after update: ${taskId}`);
      }
      return updated;
    } catch (error) {
      if (error instanceof RepoNotFoundError) {
        throw error;
      }
      throw mapSqliteConstraintError(error);
    }
  }

  private pickDb(options?: SqliteWriteOptions): SqliteDatabase {
    return resolveDb(options, this.db);
  }
}

function mapPublishTaskRow(row: PublishTaskRow): PublishTask {
  return {
    ...row,
    retry_count: Number(row.retry_count)
  };
}
