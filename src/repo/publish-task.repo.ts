import type { PublishTask } from '../contracts/domain.js';

export interface PublishTaskRepo {
  findByTaskId(taskId: string): Promise<PublishTask | null>;
  findByIdempotencyKey(idempotencyKey: string): Promise<PublishTask | null>;
  create(task: PublishTask): Promise<void>;
  update(taskId: string, patch: Partial<PublishTask>): Promise<PublishTask>;
}

export { SqlitePublishTaskRepo } from './sqlite/publish-task.sqlite.repo.js';
