import type { PublishAuditLog, PublishEvent, PublishTask } from '../../contracts/domain.js';
import type {
  PublishTaskTransitionAtomicCasInput,
  PublishTaskTransitionAtomicInput,
  PublishTaskTransitionAtomicRepo
} from '../publish-task.repo.js';
import type { SqliteDatabase } from './client.js';
import { withSqliteTransaction } from './client.js';
import { SqliteAuditLogRepo } from './audit-log.sqlite.repo.js';
import { SqlitePublishEventRepo } from './publish-event.sqlite.repo.js';
import { SqlitePublishTaskRepo } from './publish-task.sqlite.repo.js';

export function updateTaskAndAppendEventAtomic(input: {
  db: SqliteDatabase;
  tasks: SqlitePublishTaskRepo;
  events: SqlitePublishEventRepo;
  taskId: string;
  patch: Partial<PublishTask>;
  event: PublishEvent;
}): PublishTask {
  return withSqliteTransaction(input.db, (tx) => {
    const updated = input.tasks.updateInTx(input.taskId, input.patch, tx);
    input.events.appendInTx(input.event, tx);
    return updated;
  });
}

export function updateTaskAndAppendEventAndAuditAtomic(input: {
  db: SqliteDatabase;
  tasks: SqlitePublishTaskRepo;
  events: SqlitePublishEventRepo;
  audits: SqliteAuditLogRepo;
  taskId: string;
  patch: Partial<PublishTask>;
  event: PublishEvent;
  audit: PublishAuditLog;
}): PublishTask {
  return withSqliteTransaction(input.db, (tx) => {
    const updated = input.tasks.updateInTx(input.taskId, input.patch, tx);
    input.events.appendInTx(input.event, tx);
    input.audits.appendInTx(input.audit, tx);
    return updated;
  });
}

export class SqlitePublishTaskTransitionAtomicRepo implements PublishTaskTransitionAtomicRepo {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly tasks: SqlitePublishTaskRepo,
    private readonly events: SqlitePublishEventRepo,
    private readonly audits: SqliteAuditLogRepo
  ) {}

  async applyStatusTransition(input: PublishTaskTransitionAtomicInput): Promise<PublishTask> {
    return updateTaskAndAppendEventAndAuditAtomic({
      db: this.db,
      tasks: this.tasks,
      events: this.events,
      audits: this.audits,
      taskId: input.taskId,
      patch: input.patch,
      event: input.event,
      audit: input.audit
    });
  }

  async applyStatusTransitionWithCas(input: PublishTaskTransitionAtomicCasInput): Promise<PublishTask | null> {
    return withSqliteTransaction(this.db, (tx) => {
      const updated = this.tasks.compareAndUpdateInTx(
        {
          taskId: input.taskId,
          expected: input.expected,
          patch: input.patch
        },
        tx
      );
      if (!updated) {
        return null;
      }
      this.events.appendInTx(input.event, tx);
      this.audits.appendInTx(input.audit, tx);
      return updated;
    });
  }
}
