import type { PublishEvent } from '../contracts/domain.js';

export interface PublishEventRepo {
  append(event: PublishEvent): Promise<void>;
  listByTaskId(taskId: string): Promise<PublishEvent[]>;
}

export { SqlitePublishEventRepo } from './sqlite/publish-event.sqlite.repo.js';
