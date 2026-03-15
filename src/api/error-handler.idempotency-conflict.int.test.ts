import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server as HttpServer } from 'node:http';
import express from 'express';
import type { IPublishOrchestrator } from '../domain/services/publish-orchestrator.js';
import { SqliteUniqueConstraintError } from '../repo/sqlite/errors.js';
import { buildWechatPublishRoutes } from './routes/wechat-publish.routes.js';
import { errorHandler } from './middleware/error-handler.js';
import test from 'node:test';

test('sqlite unique conflict is mapped to IDEMPOTENCY_CONFLICT (409)', async () => {
  const app = express();
  app.use(express.json());

  const orchestrator: IPublishOrchestrator = {
    createAndPublish: async () => {
      throw new SqliteUniqueConstraintError(
        'UNIQUE constraint failed: publish_tasks.idempotency_key',
        'publish_tasks',
        ['idempotency_key']
      );
    },
    confirmLogin: async () => {
      throw new Error('not used');
    },
    getTask: async () => {
      throw new Error('not used');
    }
  };

  app.use('/wechat', buildWechatPublishRoutes(orchestrator));
  app.use(errorHandler);

  const server: HttpServer = createHttpServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/wechat/publish`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        task_id: 'task-http-conflict',
        idempotency_key: 'idem-http-conflict',
        title: 'conflict',
        content: 'conflict',
        content_format: 'html',
        preferred_channel: 'browser'
      })
    });

    assert.equal(response.status, 409);
    const body = (await response.json()) as {
      ok: boolean;
      error: {
        code: string;
        details?: {
          conflict_columns?: string[];
          conflict_table?: string;
        };
      };
    };
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'IDEMPOTENCY_CONFLICT');
    assert.equal(body.error.details?.conflict_table, 'publish_tasks');
    assert.ok(Array.isArray(body.error.details?.conflict_columns));
    assert.ok(body.error.details?.conflict_columns?.includes('idempotency_key'));
  } finally {
    server.close();
    await once(server, 'close');
  }
});

