import type { PublishAuditLog, PublishEvent, PublishTask } from '../contracts/domain.js';

export interface PublishTaskRepo {
  findByTaskId(taskId: string): Promise<PublishTask | null>;
  findByIdempotencyKey(idempotencyKey: string): Promise<PublishTask | null>;
  create(task: PublishTask): Promise<void>;
  update(taskId: string, patch: Partial<PublishTask>): Promise<PublishTask>;
  compareAndUpdate(input: PublishTaskCompareAndUpdateInput): Promise<PublishTask | null>;
}

export interface PublishTaskCompareAndUpdateExpected {
  status?: PublishTask['status'];
  retry_count?: number;
}

export interface PublishTaskCompareAndUpdateInput {
  taskId: string;
  expected: PublishTaskCompareAndUpdateExpected;
  patch: Partial<PublishTask>;
}

export interface PublishTaskTransitionAtomicInput {
  taskId: string;
  patch: Partial<PublishTask>;
  event: PublishEvent;
  audit: PublishAuditLog;
}

export interface PublishTaskTransitionAtomicCasInput extends PublishTaskTransitionAtomicInput {
  expected: PublishTaskCompareAndUpdateExpected;
}

export interface PublishTaskTransitionAtomicRepo {
  applyStatusTransition(input: PublishTaskTransitionAtomicInput): Promise<PublishTask>;
  applyStatusTransitionWithCas(input: PublishTaskTransitionAtomicCasInput): Promise<PublishTask | null>;
}

export { SqlitePublishTaskRepo } from './sqlite/publish-task.sqlite.repo.js';
