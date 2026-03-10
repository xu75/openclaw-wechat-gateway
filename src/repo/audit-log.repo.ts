import type { PublishAuditLog } from '../contracts/domain.js';

export interface AuditLogRepo {
  append(log: PublishAuditLog): Promise<void>;
  listByTaskId(taskId: string): Promise<PublishAuditLog[]>;
}

export { SqliteAuditLogRepo } from './sqlite/audit-log.sqlite.repo.js';
