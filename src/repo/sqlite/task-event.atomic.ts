import type { PublishEvent, PublishTask } from '../../contracts/domain.js';
import type { SqliteDatabase } from './client.js';
import { withSqliteTransaction } from './client.js';
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
