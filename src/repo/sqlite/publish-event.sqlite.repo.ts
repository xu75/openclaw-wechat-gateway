import type { PublishEvent } from '../../contracts/domain.js';
import type { PublishEventRepo } from '../publish-event.repo.js';
import type { SqliteDatabase, SqliteTx, SqliteWriteOptions } from './client.js';
import { resolveDb } from './client.js';
import { mapSqliteConstraintError } from './errors.js';

type PublishEventRow = PublishEvent;

const INSERT_EVENT_SQL = `
  INSERT INTO publish_events (
    id,
    task_id,
    from_status,
    to_status,
    reason,
    created_at
  ) VALUES (
    @id,
    @task_id,
    @from_status,
    @to_status,
    @reason,
    @created_at
  )
`;

export class SqlitePublishEventRepo implements PublishEventRepo {
  constructor(private readonly db: SqliteDatabase) {}

  async append(event: PublishEvent, options?: SqliteWriteOptions): Promise<void> {
    this.appendSync(event, options);
  }

  appendInTx(event: PublishEvent, tx: SqliteTx): void {
    this.appendSync(event, { tx });
  }

  appendSync(event: PublishEvent, options?: SqliteWriteOptions): void {
    const conn = this.pickDb(options);
    try {
      conn.prepare(INSERT_EVENT_SQL).run(event);
    } catch (error) {
      throw mapSqliteConstraintError(error);
    }
  }

  async listByTaskId(taskId: string, options?: SqliteWriteOptions): Promise<PublishEvent[]> {
    return this.listByTaskIdSync(taskId, options);
  }

  listByTaskIdSync(taskId: string, options?: SqliteWriteOptions): PublishEvent[] {
    const conn = this.pickDb(options);
    const rows = conn
      .prepare(
        `SELECT id, task_id, from_status, to_status, reason, created_at
        FROM publish_events
        WHERE task_id = ?
        ORDER BY created_at ASC, id ASC`
      )
      .all(taskId) as PublishEventRow[];
    return rows.map(mapPublishEventRow);
  }

  private pickDb(options?: SqliteWriteOptions): SqliteDatabase {
    return resolveDb(options, this.db);
  }
}

function mapPublishEventRow(row: PublishEventRow): PublishEvent {
  return {
    ...row
  };
}
