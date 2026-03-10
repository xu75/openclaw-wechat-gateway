import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentPublishRequest, AgentPublishResponse } from '../../contracts/agent.js';
import type { PublishAuditLog, PublishEvent, PublishTask } from '../../contracts/domain.js';
import type { AuditLogRepo } from '../../repo/audit-log.repo.js';
import type { PublishEventRepo } from '../../repo/publish-event.repo.js';
import type { PublishTaskRepo } from '../../repo/publish-task.repo.js';
import type { AlertType } from '../../notifier/alert.types.js';
import { AgentClientError } from '../../agent-client/errors.js';
import { AppError } from '../../api/middleware/error-handler.js';
import { PublishOrchestrator } from './publish-orchestrator.js';

test('createAndPublish runs init -> pipeline -> publish and reaches published', async () => {
  const fixture = createFixture({
    agentResponses: [
      {
        status: 'accepted',
        channel: 'browser',
        publish_url: 'https://mp.weixin.qq.com/mock',
        task_id: 'task-1',
        idempotency_key: 'idem-1'
      }
    ]
  });

  const task = await fixture.orchestrator.createAndPublish({
    task_id: 'task-1',
    idempotency_key: 'idem-1',
    title: 'Hello',
    content: '# Hello',
    content_format: 'markdown',
    preferred_channel: 'browser'
  });

  assert.equal(task.status, 'published');
  assert.equal(fixture.agent.calls.length, 1);
  assert.equal(fixture.agent.calls[0]?.content, '<article># Hello</article>');
  assert.deepEqual(
    fixture.events.events.map((evt) => `${evt.from_status ?? 'null'}->${evt.to_status}`),
    ['null->approved', 'approved->publishing', 'publishing->published']
  );
});

test('waiting_login includes qr payload fields for caller', async () => {
  const fixture = createFixture({
    agentResponses: [
      {
        status: 'waiting_login',
        channel: 'browser',
        login_session_id: 'sess-qr-1',
        login_session_expires_at: '2026-01-01T00:20:00.000Z',
        login_qr_mime: 'image/png',
        login_qr_png_base64: 'BASE64PNG'
      }
    ]
  });

  const task = await fixture.orchestrator.createAndPublish({
    task_id: 'task-qr',
    idempotency_key: 'idem-qr',
    title: 'Need QR',
    content: '<p>Need QR</p>',
    content_format: 'html',
    preferred_channel: 'browser'
  });

  assert.equal(task.status, 'waiting_login');
  assert.equal(task.login_qr_mime, 'image/png');
  assert.equal(task.login_qr_png_base64, 'BASE64PNG');
  assert.ok(task.login_session_expires_at);
});

test('getTask handles waiting_login timeout to manual_intervention without polling publish', async () => {
  const fixture = createFixture({
    waitingLoginTimeoutSeconds: 30,
    agentResponses: [
      {
        status: 'waiting_login',
        channel: 'browser',
        login_session_id: 'sess-1',
        login_session_expires_at: '2026-01-01T00:20:00.000Z',
        login_qr_mime: 'image/png',
        login_qr_png_base64: 'AAA'
      }
    ]
  });

  const created = await fixture.orchestrator.createAndPublish({
    task_id: 'task-timeout',
    idempotency_key: 'idem-timeout',
    title: 'Need login',
    content: '<p>Need login</p>',
    content_format: 'html',
    preferred_channel: 'browser'
  });

  assert.equal(created.status, 'waiting_login');
  fixture.advanceSeconds(31);

  const task = await fixture.orchestrator.getTask('task-timeout');
  assert.equal(task.status, 'manual_intervention');
  assert.equal(task.error_code, 'WAITING_LOGIN_TIMEOUT');
  assert.equal(fixture.agent.calls.length, 1);
});

test('confirmLogin retries publish only once', async () => {
  const fixture = createFixture({
    agentResponses: [
      {
        status: 'waiting_login',
        channel: 'browser',
        login_session_id: 'sess-2',
        login_session_expires_at: '2026-01-01T00:20:00.000Z'
      },
      {
        status: 'waiting_login',
        channel: 'browser',
        login_session_id: 'sess-3',
        login_session_expires_at: '2026-01-01T00:20:00.000Z'
      }
    ]
  });

  await fixture.orchestrator.createAndPublish({
    task_id: 'task-retry-once',
    idempotency_key: 'idem-retry-once',
    title: 'retry',
    content: 'retry',
    content_format: 'html',
    preferred_channel: 'browser'
  });

  const afterConfirm = await fixture.orchestrator.confirmLogin('task-retry-once');
  assert.equal(afterConfirm.status, 'waiting_login');
  assert.equal(afterConfirm.retry_count, 1);
  assert.equal(fixture.agent.calls.length, 2);

  await assert.rejects(
    () => fixture.orchestrator.confirmLogin('task-retry-once'),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'STATUS_CONFLICT');
      return true;
    }
  );
});

test('createAndPublish throws explicit IDEMPOTENCY_CONFLICT when task_id conflicts', async () => {
  const fixture = createFixture({
    agentResponses: [
      {
        status: 'accepted',
        channel: 'browser',
        publish_url: 'https://mp.weixin.qq.com/ok',
        task_id: 'task-conflict-1',
        idempotency_key: 'idem-conflict-1'
      }
    ]
  });

  await fixture.orchestrator.createAndPublish({
    task_id: 'task-conflict-1',
    idempotency_key: 'idem-conflict-1',
    title: 'ok',
    content: 'ok',
    content_format: 'html',
    preferred_channel: 'browser'
  });

  await assert.rejects(
    () =>
      fixture.orchestrator.createAndPublish({
        task_id: 'task-conflict-1',
        idempotency_key: 'idem-conflict-other',
        title: 'dup',
        content: 'dup',
        content_format: 'html',
        preferred_channel: 'browser'
      }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'IDEMPOTENCY_CONFLICT');
      return true;
    }
  );
});

test('confirmLogin on expired waiting_login moves to manual_intervention then throws timeout', async () => {
  const fixture = createFixture({
    waitingLoginTimeoutSeconds: 10,
    agentResponses: [
      {
        status: 'waiting_login',
        channel: 'browser',
        login_session_id: 'sess-4',
        login_session_expires_at: '2026-01-01T00:20:00.000Z'
      }
    ]
  });

  await fixture.orchestrator.createAndPublish({
    task_id: 'task-expired',
    idempotency_key: 'idem-expired',
    title: 'expired',
    content: 'expired',
    content_format: 'html',
    preferred_channel: 'browser'
  });

  fixture.advanceSeconds(11);
  await assert.rejects(
    () => fixture.orchestrator.confirmLogin('task-expired'),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'WAITING_LOGIN_TIMEOUT');
      return true;
    }
  );

  const task = await fixture.orchestrator.getTask('task-expired');
  assert.equal(task.status, 'manual_intervention');
});

test('signature errors are mapped to AGENT_SIGNATURE_ERROR and trigger signature_anomaly alert', async () => {
  const fixture = createFixture({
    agentErrors: [
      new AgentClientError('invalid signature', {
        code: 'AGENT_SIGNATURE_ERROR',
        status: 401,
        body: {
          error_code: 'INVALID_SIGNATURE',
          error_message: 'signature mismatch'
        }
      })
    ]
  });

  const task = await fixture.orchestrator.createAndPublish({
    task_id: 'task-signature',
    idempotency_key: 'idem-signature',
    title: 'Signature',
    content: '<p>Signature</p>',
    content_format: 'html',
    preferred_channel: 'browser'
  });

  assert.equal(task.status, 'manual_intervention');
  assert.equal(task.error_code, 'AGENT_SIGNATURE_ERROR');
  assert.ok(
    fixture.notifier.sent.some((item) => item.type === 'signature_anomaly' && item.payload.task_id === 'task-signature')
  );
});

type FixtureOptions = {
  waitingLoginTimeoutSeconds?: number;
  agentResponses?: AgentPublishResponse[];
  agentErrors?: Array<unknown>;
};

function createFixture(options: FixtureOptions = {}): {
  orchestrator: PublishOrchestrator;
  events: InMemoryPublishEventRepo;
  audits: InMemoryAuditLogRepo;
  agent: FakeAgentClient;
  notifier: FakeNotifier;
  advanceSeconds: (seconds: number) => void;
} {
  let now = new Date('2026-01-01T00:00:00.000Z');
  const tasks = new InMemoryPublishTaskRepo(() => now);
  const events = new InMemoryPublishEventRepo();
  const audits = new InMemoryAuditLogRepo();
  const agent = new FakeAgentClient(options.agentResponses ?? [], options.agentErrors ?? []);
  const notifier = new FakeNotifier();

  const orchestrator = new PublishOrchestrator({
    repo: {
      tasks,
      events,
      audits
    },
    agentClient: agent,
    contentPipeline: {
      run: async ({ content }) => ({
        content_html: `<article>${content}</article>`,
        replaced_count: 0,
        failed_images: []
      })
    },
    notifier,
    reviewTokenFactory: {
      create: ({ taskId, idempotencyKey }) => `token:${taskId}:${idempotencyKey}`
    },
    waitingLoginTimeoutSeconds: options.waitingLoginTimeoutSeconds ?? 600,
    now: () => now,
    idFactory: (() => {
      let id = 0;
      return () => `id-${++id}`;
    })()
  });

  return {
    orchestrator,
    events,
    audits,
    agent,
    notifier,
    advanceSeconds: (seconds: number) => {
      now = new Date(now.getTime() + seconds * 1000);
    }
  };
}

class InMemoryPublishTaskRepo implements PublishTaskRepo {
  private readonly tasks = new Map<string, PublishTask>();

  constructor(private readonly now: () => Date) {}

  async findByTaskId(taskId: string): Promise<PublishTask | null> {
    return this.tasks.get(taskId) ?? null;
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<PublishTask | null> {
    for (const task of this.tasks.values()) {
      if (task.idempotency_key === idempotencyKey) {
        return task;
      }
    }
    return null;
  }

  async create(task: PublishTask): Promise<void> {
    this.tasks.set(task.task_id, task);
  }

  async update(taskId: string, patch: Partial<PublishTask>): Promise<PublishTask> {
    const current = this.tasks.get(taskId);
    if (!current) {
      throw new Error(`missing task: ${taskId}`);
    }
    const next: PublishTask = {
      ...current,
      ...patch,
      updated_at: this.now().toISOString()
    };
    this.tasks.set(taskId, next);
    return next;
  }
}

class InMemoryPublishEventRepo implements PublishEventRepo {
  readonly events: PublishEvent[] = [];

  async append(event: PublishEvent): Promise<void> {
    this.events.push(event);
  }

  async listByTaskId(taskId: string): Promise<PublishEvent[]> {
    return this.events.filter((event) => event.task_id === taskId);
  }
}

class InMemoryAuditLogRepo implements AuditLogRepo {
  readonly logs: PublishAuditLog[] = [];

  async append(log: PublishAuditLog): Promise<void> {
    this.logs.push(log);
  }

  async listByTaskId(taskId: string): Promise<PublishAuditLog[]> {
    return this.logs.filter((log) => log.task_id === taskId);
  }
}

class FakeAgentClient {
  readonly calls: AgentPublishRequest[] = [];
  private readonly responseQueue: AgentPublishResponse[];
  private readonly errorQueue: unknown[];

  constructor(responses: AgentPublishResponse[], errors: unknown[]) {
    this.responseQueue = [...responses];
    this.errorQueue = [...errors];
  }

  async publish(payload: AgentPublishRequest): Promise<AgentPublishResponse> {
    this.calls.push(payload);

    if (this.errorQueue.length > 0) {
      const nextError = this.errorQueue.shift();
      throw nextError;
    }

    const nextResponse = this.responseQueue.shift();
    if (!nextResponse) {
      throw new AgentClientError('missing test response', {
        code: 'AGENT_UNAVAILABLE',
        status: 502
      });
    }
    return nextResponse;
  }
}

class FakeNotifier {
  readonly sent: Array<{ type: AlertType; payload: Record<string, unknown> }> = [];

  async send(type: AlertType, payload: Record<string, unknown>): Promise<void> {
    this.sent.push({ type, payload });
  }
}
