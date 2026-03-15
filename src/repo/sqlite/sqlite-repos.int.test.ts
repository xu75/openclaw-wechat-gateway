import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { PublishTask } from '../../contracts/domain.js';
import { openSqlite, withSqliteTransaction } from './client.js';
import { SqliteUniqueConstraintError } from './errors.js';
import { runMigrations } from './migrations.js';
import { SqliteAuditLogRepo } from './audit-log.sqlite.repo.js';
import { SqlitePublishEventRepo } from './publish-event.sqlite.repo.js';
import { SqlitePublishTaskRepo } from './publish-task.sqlite.repo.js';
import {
  SqlitePublishTaskTransitionAtomicRepo,
  updateTaskAndAppendEventAndAuditAtomic
} from './task-event.atomic.js';

test('runMigrations is repeatable and idempotent', () => {
  const { dbPath, cleanup } = createTempDbPath();
  try {
    runMigrations(dbPath);
    runMigrations(dbPath);

    const db = openSqlite(dbPath);
    try {
      const tables = db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'publish_%' ORDER BY name ASC`)
        .all() as Array<{ name: string }>;
      assert.deepEqual(
        tables.map((row) => row.name),
        ['publish_audit_logs', 'publish_events', 'publish_tasks']
      );

      const migrationCount = db.prepare(`SELECT COUNT(*) AS count FROM schema_migrations WHERE version = ?`).get(
        '001_init.sql'
      ) as { count: number };
      assert.equal(migrationCount.count, 1);
    } finally {
      db.close();
    }
  } finally {
    cleanup();
  }
});

test('sqlite repos support create/find/update/listByTaskId', async () => {
  const { dbPath, cleanup } = createTempDbPath();
  try {
    runMigrations(dbPath);
    const db = openSqlite(dbPath);
    try {
      const tasks = new SqlitePublishTaskRepo(db, () => new Date('2026-03-08T09:30:00.000Z'));
      const events = new SqlitePublishEventRepo(db);
      const audits = new SqliteAuditLogRepo(db);
      const task = makeTask({
        task_id: 'task-basic',
        idempotency_key: 'idem-basic'
      });

      await tasks.create(task);
      const found = await tasks.findByTaskId(task.task_id);
      assert.ok(found);
      assert.equal(found.idempotency_key, task.idempotency_key);

      const foundByIdempotency = await tasks.findByIdempotencyKey(task.idempotency_key);
      assert.ok(foundByIdempotency);
      assert.equal(foundByIdempotency.task_id, task.task_id);

      const updated = await tasks.update(task.task_id, {
        status: 'waiting_login',
        error_code: 'LOGIN_REQUIRED',
        error_message: 'scan qrcode'
      });
      assert.equal(updated.status, 'waiting_login');
      assert.equal(updated.error_code, 'LOGIN_REQUIRED');

      await events.append({
        id: 'evt-basic-1',
        task_id: task.task_id,
        from_status: 'approved',
        to_status: 'waiting_login',
        reason: 'agent_waiting_login',
        created_at: '2026-03-08T09:30:01.000Z'
      });
      await audits.append({
        id: 'audit-basic-1',
        task_id: task.task_id,
        stage: 'status_transition',
        trigger: 'agent_waiting_login',
        payload_json: JSON.stringify({ to: 'waiting_login' }),
        created_at: '2026-03-08T09:30:01.100Z'
      });

      const eventList = await events.listByTaskId(task.task_id);
      const auditList = await audits.listByTaskId(task.task_id);

      assert.equal(eventList.length, 1);
      assert.equal(auditList.length, 1);
      assert.equal(eventList[0]?.task_id, task.task_id);
      assert.equal(auditList[0]?.task_id, task.task_id);
    } finally {
      db.close();
    }
  } finally {
    cleanup();
  }
});

test('unique constraint conflict is surfaced as identifiable error', async () => {
  const { dbPath, cleanup } = createTempDbPath();
  try {
    runMigrations(dbPath);
    const db = openSqlite(dbPath);
    try {
      const tasks = new SqlitePublishTaskRepo(db);
      await tasks.create(
        makeTask({
          task_id: 'task-unique-1',
          idempotency_key: 'idem-unique-same'
        })
      );

      await assert.rejects(
        () =>
          tasks.create(
            makeTask({
              task_id: 'task-unique-2',
              idempotency_key: 'idem-unique-same'
            })
          ),
        (error: unknown) => {
          assert.ok(error instanceof SqliteUniqueConstraintError);
          assert.ok(error.columns.includes('idempotency_key'));
          return true;
        }
      );
    } finally {
      db.close();
    }
  } finally {
    cleanup();
  }
});

test('task update + event append + audit append can commit in the same transaction', async () => {
  const { dbPath, cleanup } = createTempDbPath();
  try {
    runMigrations(dbPath);
    const db = openSqlite(dbPath);
    try {
      const tasks = new SqlitePublishTaskRepo(db);
      const events = new SqlitePublishEventRepo(db);
      const audits = new SqliteAuditLogRepo(db);
      const task = makeTask({
        task_id: 'task-tx',
        idempotency_key: 'idem-tx'
      });
      await tasks.create(task);

      updateTaskAndAppendEventAndAuditAtomic({
        db,
        tasks,
        events,
        audits,
        taskId: task.task_id,
        patch: { status: 'publishing' },
        event: {
          id: 'evt-tx-1',
          task_id: task.task_id,
          from_status: 'approved',
          to_status: 'publishing',
          reason: 'tx_commit',
          created_at: '2026-03-08T09:30:02.000Z'
        },
        audit: {
          id: 'audit-tx-1',
          task_id: task.task_id,
          stage: 'status_transition',
          trigger: 'tx_commit',
          payload_json: JSON.stringify({ to: 'publishing' }),
          created_at: '2026-03-08T09:30:02.001Z'
        }
      });

      const afterCommit = await tasks.findByTaskId(task.task_id);
      const eventsAfterCommit = await events.listByTaskId(task.task_id);
      const auditsAfterCommit = await audits.listByTaskId(task.task_id);
      assert.equal(afterCommit?.status, 'publishing');
      assert.equal(eventsAfterCommit.length, 1);
      assert.equal(auditsAfterCommit.length, 1);

      assert.throws(
        () =>
          withSqliteTransaction(db, (tx) => {
            tasks.updateInTx(task.task_id, { status: 'published' }, tx);
            events.appendInTx(
              {
                id: 'evt-tx-1',
                task_id: task.task_id,
                from_status: 'publishing',
                to_status: 'published',
                reason: 'tx_should_rollback',
                created_at: '2026-03-08T09:30:03.000Z'
              },
              tx
            );
            audits.appendInTx(
              {
                id: 'audit-tx-2',
                task_id: task.task_id,
                stage: 'status_transition',
                trigger: 'tx_should_rollback',
                payload_json: JSON.stringify({ to: 'published' }),
                created_at: '2026-03-08T09:30:03.001Z'
              },
              tx
            );
          }),
        SqliteUniqueConstraintError
      );

      const afterRollback = await tasks.findByTaskId(task.task_id);
      const eventsAfterRollback = await events.listByTaskId(task.task_id);
      const auditsAfterRollback = await audits.listByTaskId(task.task_id);
      assert.equal(afterRollback?.status, 'publishing');
      assert.equal(eventsAfterRollback.length, 1);
      assert.equal(auditsAfterRollback.length, 1);
    } finally {
      db.close();
    }
  } finally {
    cleanup();
  }
});

test('atomic status transition rolls back task when event insert fails', async () => {
  const { dbPath, cleanup } = createTempDbPath();
  try {
    runMigrations(dbPath);
    const db = openSqlite(dbPath);
    try {
      const tasks = new SqlitePublishTaskRepo(db);
      const events = new SqlitePublishEventRepo(db);
      const audits = new SqliteAuditLogRepo(db);
      const atomic = new SqlitePublishTaskTransitionAtomicRepo(db, tasks, events, audits);
      const task = makeTask({
        task_id: 'task-event-fail',
        idempotency_key: 'idem-event-fail'
      });
      await tasks.create(task);
      await events.append({
        id: 'evt-dup',
        task_id: task.task_id,
        from_status: null,
        to_status: 'approved',
        reason: 'seed',
        created_at: '2026-03-08T09:30:04.000Z'
      });

      await assert.rejects(
        () =>
          atomic.applyStatusTransition({
            taskId: task.task_id,
            patch: { status: 'publishing' },
            event: {
              id: 'evt-dup',
              task_id: task.task_id,
              from_status: 'approved',
              to_status: 'publishing',
              reason: 'event_conflict',
              created_at: '2026-03-08T09:30:05.000Z'
            },
            audit: {
              id: 'audit-event-fail',
              task_id: task.task_id,
              stage: 'status_transition',
              trigger: 'event_conflict',
              payload_json: JSON.stringify({ to: 'publishing' }),
              created_at: '2026-03-08T09:30:05.001Z'
            }
          }),
        SqliteUniqueConstraintError
      );

      const afterRollback = await tasks.findByTaskId(task.task_id);
      const eventsAfterRollback = await events.listByTaskId(task.task_id);
      const auditsAfterRollback = await audits.listByTaskId(task.task_id);
      assert.equal(afterRollback?.status, 'approved');
      assert.equal(eventsAfterRollback.length, 1);
      assert.equal(auditsAfterRollback.length, 0);
    } finally {
      db.close();
    }
  } finally {
    cleanup();
  }
});

test('atomic status transition rolls back task and event when audit insert fails', async () => {
  const { dbPath, cleanup } = createTempDbPath();
  try {
    runMigrations(dbPath);
    const db = openSqlite(dbPath);
    try {
      const tasks = new SqlitePublishTaskRepo(db);
      const events = new SqlitePublishEventRepo(db);
      const audits = new SqliteAuditLogRepo(db);
      const atomic = new SqlitePublishTaskTransitionAtomicRepo(db, tasks, events, audits);
      const task = makeTask({
        task_id: 'task-audit-fail',
        idempotency_key: 'idem-audit-fail'
      });
      await tasks.create(task);
      await audits.append({
        id: 'audit-dup',
        task_id: task.task_id,
        stage: 'status_transition',
        trigger: 'seed',
        payload_json: JSON.stringify({ to: 'approved' }),
        created_at: '2026-03-08T09:30:06.000Z'
      });

      await assert.rejects(
        () =>
          atomic.applyStatusTransition({
            taskId: task.task_id,
            patch: { status: 'publishing' },
            event: {
              id: 'evt-audit-fail',
              task_id: task.task_id,
              from_status: 'approved',
              to_status: 'publishing',
              reason: 'audit_conflict',
              created_at: '2026-03-08T09:30:07.000Z'
            },
            audit: {
              id: 'audit-dup',
              task_id: task.task_id,
              stage: 'status_transition',
              trigger: 'audit_conflict',
              payload_json: JSON.stringify({ to: 'publishing' }),
              created_at: '2026-03-08T09:30:07.001Z'
            }
          }),
        SqliteUniqueConstraintError
      );

      const afterRollback = await tasks.findByTaskId(task.task_id);
      const eventsAfterRollback = await events.listByTaskId(task.task_id);
      const auditsAfterRollback = await audits.listByTaskId(task.task_id);
      assert.equal(afterRollback?.status, 'approved');
      assert.equal(eventsAfterRollback.length, 0);
      assert.equal(auditsAfterRollback.length, 1);
    } finally {
      db.close();
    }
  } finally {
    cleanup();
  }
});

test('compareAndUpdate enforces CAS for waiting_login retry once under concurrency', async () => {
  const { dbPath, cleanup } = createTempDbPath();
  try {
    runMigrations(dbPath);
    const db = openSqlite(dbPath);
    try {
      const tasks = new SqlitePublishTaskRepo(db);
      const task = makeTask({
        task_id: 'task-cas',
        idempotency_key: 'idem-cas'
      });
      await tasks.create({
        ...task,
        status: 'waiting_login'
      });

      const [left, right] = await Promise.all([
        tasks.compareAndUpdate({
          taskId: task.task_id,
          expected: {
            status: 'waiting_login',
            retry_count: 0
          },
          patch: {
            status: 'publishing',
            retry_count: 1
          }
        }),
        tasks.compareAndUpdate({
          taskId: task.task_id,
          expected: {
            status: 'waiting_login',
            retry_count: 0
          },
          patch: {
            status: 'publishing',
            retry_count: 1
          }
        })
      ]);

      const success = [left, right].filter((item) => item !== null);
      const conflict = [left, right].filter((item) => item === null);
      assert.equal(success.length, 1);
      assert.equal(conflict.length, 1);

      const finalTask = await tasks.findByTaskId(task.task_id);
      assert.equal(finalTask?.retry_count, 1);
      assert.equal(finalTask?.status, 'publishing');
    } finally {
      db.close();
    }
  } finally {
    cleanup();
  }
});

function makeTask(override: Pick<PublishTask, 'task_id' | 'idempotency_key'>): PublishTask {
  const now = '2026-03-08T09:30:00.000Z';
  return {
    task_id: override.task_id,
    idempotency_key: override.idempotency_key,
    status: 'approved',
    channel: 'browser',
    title: 'hello',
    content_format: 'html',
    content_hash: 'hash',
    content_html: '<p>hello</p>',
    login_session_id: null,
    login_session_expires_at: null,
    login_qr_mime: null,
    login_qr_png_base64: null,
    publish_url: null,
    error_code: null,
    error_message: null,
    retry_count: 0,
    created_at: now,
    updated_at: now
  };
}

function createTempDbPath(): { dbPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-sqlite-'));
  const dbPath = path.join(dir, 'gateway.db');
  return {
    dbPath,
    cleanup: () => {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}
