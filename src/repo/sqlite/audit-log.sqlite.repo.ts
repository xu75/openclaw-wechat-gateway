import type { PublishAuditLog } from '../../contracts/domain.js';
import type { AuditLogRepo } from '../audit-log.repo.js';
import type { SqliteDatabase, SqliteTx, SqliteWriteOptions } from './client.js';
import { resolveDb } from './client.js';
import { mapSqliteConstraintError } from './errors.js';

type PublishAuditLogRow = PublishAuditLog;

const INSERT_AUDIT_SQL = `
  INSERT INTO publish_audit_logs (
    id,
    task_id,
    stage,
    trigger,
    payload_json,
    created_at
  ) VALUES (
    @id,
    @task_id,
    @stage,
    @trigger,
    @payload_json,
    @created_at
  )
`;

// Strategy: fail-closed. audit append failures are surfaced to caller so upper layers can decide
// whether to interrupt current flow or apply compensation according to business criticality.
export class SqliteAuditLogRepo implements AuditLogRepo {
  constructor(private readonly db: SqliteDatabase) {}

  async append(log: PublishAuditLog, options?: SqliteWriteOptions): Promise<void> {
    this.appendSync(log, options);
  }

  appendInTx(log: PublishAuditLog, tx: SqliteTx): void {
    this.appendSync(log, { tx });
  }

  appendSync(log: PublishAuditLog, options?: SqliteWriteOptions): void {
    const conn = this.pickDb(options);
    try {
      conn.prepare(INSERT_AUDIT_SQL).run(log);
    } catch (error) {
      throw mapSqliteConstraintError(error);
    }
  }

  async listByTaskId(taskId: string, options?: SqliteWriteOptions): Promise<PublishAuditLog[]> {
    return this.listByTaskIdSync(taskId, options);
  }

  listByTaskIdSync(taskId: string, options?: SqliteWriteOptions): PublishAuditLog[] {
    const conn = this.pickDb(options);
    const rows = conn
      .prepare(
        `SELECT id, task_id, stage, trigger, payload_json, created_at
        FROM publish_audit_logs
        WHERE task_id = ?
        ORDER BY created_at ASC, id ASC`
      )
      .all(taskId) as PublishAuditLogRow[];
    return rows.map(mapPublishAuditLogRow);
  }

  private pickDb(options?: SqliteWriteOptions): SqliteDatabase {
    return resolveDb(options, this.db);
  }
}

function mapPublishAuditLogRow(row: PublishAuditLogRow): PublishAuditLog {
  return {
    ...row
  };
}
