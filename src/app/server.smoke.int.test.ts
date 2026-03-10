import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server as HttpServer } from 'node:http';

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function hmacSha256Hex(secret: string, input: string): string {
  return createHmac('sha256', secret).update(input, 'utf8').digest('hex');
}

test('smoke: publish -> waiting_login -> confirm-login -> published', async () => {
  const signingSecret = 'smoke-secret';
  const taskId = `task-smoke-${Date.now()}`;
  const idempotencyKey = `idem-${taskId}`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-smoke-'));
  const dbPath = path.join(tempDir, 'gateway.db');
  let gateway: HttpServer | null = null;

  const agentCalls: Array<{ task_id: string; content: string }> = [];
  const agentCallCounter = new Map<string, number>();

  const agent = createHttpServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/publish') {
      res.statusCode = 404;
      res.end();
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const body = Buffer.concat(chunks).toString('utf8');

    const timestamp = req.headers['x-timestamp'];
    const signature = req.headers['x-signature'];
    assert.equal(typeof timestamp, 'string');
    assert.equal(typeof signature, 'string');

    const bodySha = sha256Hex(body);
    const signingText = `POST\n/publish\n${timestamp}\n${bodySha}`;
    const expectedSignature = hmacSha256Hex(signingSecret, signingText);
    if (signature !== expectedSignature) {
      res.statusCode = 401;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error_code: 'INVALID_SIGNATURE', error_message: 'bad signature' }));
      return;
    }

    const payload = JSON.parse(body) as {
      task_id: string;
      idempotency_key: string;
      content: string;
      preferred_channel: 'browser' | 'official';
    };

    agentCalls.push({ task_id: payload.task_id, content: payload.content });
    const callCount = (agentCallCounter.get(payload.task_id) ?? 0) + 1;
    agentCallCounter.set(payload.task_id, callCount);

    res.setHeader('content-type', 'application/json');
    if (callCount === 1) {
      res.end(
        JSON.stringify({
          status: 'waiting_login',
          channel: payload.preferred_channel,
          login_session_id: `sess-${payload.task_id}`,
          login_session_expires_at: new Date(Date.now() + 60_000).toISOString(),
          login_qr_mime: 'image/png',
          login_qr_png_base64: 'BASE64PNG',
          error_code: 'BROWSER_LOGIN_REQUIRED',
          error_message: 'login required'
        })
      );
      return;
    }

    res.end(
      JSON.stringify({
        status: 'accepted',
        channel: payload.preferred_channel,
        publish_url: `https://mp.weixin.qq.com/${payload.task_id}`,
        task_id: payload.task_id,
        idempotency_key: payload.idempotency_key
      })
    );
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
    const requestId = `req-${randomUUID()}`;

    const publishResp = await fetch(`${base}/wechat/publish`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-request-id': requestId
      },
      body: JSON.stringify({
        task_id: taskId,
        idempotency_key: idempotencyKey,
        title: 'Smoke',
        content: '# hello\n\n<script>alert(1)</script>\n\n![img](https://example.com/a.png)',
        content_format: 'markdown',
        preferred_channel: 'browser'
      })
    });
    assert.equal(publishResp.status, 200);
    assert.equal(publishResp.headers.get('x-request-id'), requestId);
    const publishBody = (await publishResp.json()) as {
      ok: true;
      data: {
        status: string;
        login_qr_mime: string | null;
        login_qr_png_base64: string | null;
        login_session_expires_at: string | null;
      };
    };
    assert.equal(publishBody.ok, true);
    assert.equal(publishBody.data.status, 'waiting_login');
    assert.equal(publishBody.data.login_qr_mime, 'image/png');
    assert.equal(publishBody.data.login_qr_png_base64, 'BASE64PNG');
    assert.ok(publishBody.data.login_session_expires_at);

    const confirmResp = await fetch(`${base}/wechat/publish/${taskId}/confirm-login`, {
      method: 'POST',
      headers: {
        'x-request-id': requestId,
        'content-type': 'application/json'
      }
    });
    assert.equal(confirmResp.status, 200);
    assert.equal(confirmResp.headers.get('x-request-id'), requestId);
    const confirmBody = (await confirmResp.json()) as { ok: true; data: { status: string } };
    assert.equal(confirmBody.ok, true);
    assert.equal(confirmBody.data.status, 'published');

    const taskResp = await fetch(`${base}/wechat/publish/${taskId}`, {
      headers: {
        'x-request-id': requestId
      }
    });
    assert.equal(taskResp.status, 200);
    assert.equal(taskResp.headers.get('x-request-id'), requestId);
    const taskBody = (await taskResp.json()) as { ok: true; data: { status: string; publish_url: string | null } };
    assert.equal(taskBody.data.status, 'published');
    assert.ok(taskBody.data.publish_url);

    assert.equal(agentCalls.length, 2);
    assert.match(agentCalls[0]?.content ?? '', /<h1>hello<\/h1>/i);
    assert.doesNotMatch(agentCalls[0]?.content ?? '', /<script/i);

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
