import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server as HttpServer } from 'node:http';

test('strict image policy: relative/http/data/file image URLs return 422 and do not call agent', async () => {
  const signingSecret = 'smoke-secret';
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-image-policy-'));
  const dbPath = path.join(tempDir, 'gateway.db');
  let gateway: HttpServer | null = null;

  let agentCallCount = 0;
  const agent = createHttpServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/publish') {
      agentCallCount += 1;
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          status: 'accepted',
          channel: 'browser',
          publish_url: 'https://mp.weixin.qq.com/mock',
          task_id: 'unexpected-agent-call',
          idempotency_key: 'unexpected-agent-call'
        })
      );
      return;
    }

    res.statusCode = 404;
    res.end();
  });

  try {
    agent.listen(0, '127.0.0.1');
    await once(agent, 'listening');
    const agentPort = (agent.address() as AddressInfo).port;

    process.env.WECHAT_AGENT_SIGNING_SECRET = signingSecret;
    process.env.WECHAT_AGENT_REVIEW_TOKEN_SECRET = signingSecret;
    process.env.AGENT_BASE_URL = `http://127.0.0.1:${agentPort}`;
    process.env.WAITING_LOGIN_TIMEOUT_SECONDS = '600';
    process.env.DB_PATH = dbPath;
    process.env.PORT = '0';
    process.env.ALERT_WEBHOOK = '';

    const { createServer } = await import('./bootstrap.js');
    const app = createServer();
    gateway = app.listen(0, '127.0.0.1');

    await once(gateway, 'listening');
    const gatewayPort = (gateway.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${gatewayPort}`;

    const cases = [
      { key: 'relative', content: '<p>x</p><img src="./foo.png" />' },
      { key: 'http', content: '<p>x</p><img src="http://example.com/a.png" />' },
      { key: 'data', content: '<p>x</p><img src="data:image/png;base64,AAAA" />' },
      { key: 'file', content: '<p>x</p><img src="file:///tmp/a.png" />' }
    ];

    for (const item of cases) {
      const requestBody = {
        task_id: `task-image-policy-${item.key}`,
        idempotency_key: `idem-image-policy-${item.key}`,
        title: `Image policy ${item.key}`,
        content: item.content,
        content_format: 'html',
        preferred_channel: 'browser'
      };

      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const response = await fetch(`${base}/wechat/publish`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-request-id': `req-image-policy-${item.key}-${attempt}`
          },
          body: JSON.stringify(requestBody)
        });

        assert.equal(response.status, 422);
        const body = (await response.json()) as {
          ok: false;
          error: {
            code: string;
            details?: {
              replaced_count?: number;
              failed_images?: Array<{ source?: string; reason?: string }>;
            };
          };
        };
        assert.equal(body.ok, false);
        assert.equal(body.error.code, 'IMAGE_POLICY_VIOLATION');
        assert.ok(body.error.details);
        assert.equal(typeof body.error.details?.replaced_count, 'number');
        assert.ok((body.error.details?.replaced_count ?? 0) > 0);
        assert.ok(Array.isArray(body.error.details?.failed_images));
        assert.ok((body.error.details?.failed_images?.length ?? 0) > 0);
        assert.ok(body.error.details?.failed_images?.every((img) => typeof img.reason === 'string' && img.reason.length > 0));
      }
    }

    assert.equal(agentCallCount, 0);
  } finally {
    if (gateway) {
      gateway.close();
      await once(gateway, 'close');
    }
    agent.close();
    await once(agent, 'close');
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
