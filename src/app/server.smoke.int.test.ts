import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server as HttpServer } from 'node:http';

function nowIso(): string {
  return new Date().toISOString();
}

test('smoke: publish -> waiting_login -> confirm-login -> published', async () => {
  const signingSecret = 'smoke-secret';
  const taskId = `task-smoke-${Date.now()}`;
  const idempotencyKey = `idem-${taskId}`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-smoke-'));
  const dbPath = path.join(tempDir, 'gateway.db');
  let gateway: HttpServer | null = null;

  const mcpSessionId = 'mcp-session-smoke';
  const toolCalls: string[] = [];
  const publishCalls: Array<{ title: string; content_html: string }> = [];
  let loggedIn = false;

  const agent = createHttpServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/mcp') {
      res.statusCode = 404;
      res.end();
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      id?: number;
      method?: string;
      params?: {
        name?: string;
        arguments?: Record<string, unknown>;
      };
    };

    res.setHeader('content-type', 'application/json');

    if (body.method === 'initialize') {
      res.setHeader('mcp-session-id', mcpSessionId);
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: body.id ?? 1,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            serverInfo: {
              name: 'wechat-unofficial-publisher-agent',
              version: '2.5.0'
            }
          }
        })
      );
      return;
    }

    if (body.method === 'notifications/initialized') {
      res.statusCode = 204;
      res.end();
      return;
    }

    if (req.headers['mcp-session-id'] !== mcpSessionId) {
      res.statusCode = 400;
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: body.id ?? null,
          error: {
            code: -32000,
            message: 'missing mcp-session-id'
          }
        })
      );
      return;
    }

    if (body.method !== 'tools/call') {
      res.statusCode = 400;
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: body.id ?? null,
          error: {
            code: -32601,
            message: 'unsupported method'
          }
        })
      );
      return;
    }

    const toolName = body.params?.name;
    const toolArgs = body.params?.arguments ?? {};
    toolCalls.push(toolName ?? 'unknown');

    const waitingLoginStructured = {
      status: 'waiting_login',
      message: 'login required',
      session: {
        session_id: `sess-${taskId}`,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        qr: {
          available: true,
          format: 'data_url',
          data: 'data:image/png;base64,BASE64PNG',
          captured_at: nowIso(),
          expires_at: new Date(Date.now() + 60_000).toISOString()
        }
      },
      qr: {
        available: true,
        format: 'data_url',
        data: 'data:image/png;base64,BASE64PNG',
        captured_at: nowIso(),
        expires_at: new Date(Date.now() + 60_000).toISOString()
      },
      browser: {
        endpoint: null,
        connected: true,
        logged_in: false,
        current_url: null,
        last_checked_at: nowIso()
      },
      error: {
        code: 'BROWSER_LOGIN_REQUIRED',
        message: 'wechat login required; manual scan is needed',
        retryable: true
      }
    };

    let structuredContent: Record<string, unknown>;
    if (toolName === 'publisher_health') {
      structuredContent = {
        tool: 'publisher_health',
        service_status: 'healthy',
        healthy: true,
        version: '2.5.0',
        timestamp: nowIso(),
        browser: {
          endpoint: null,
          connected: true,
          logged_in: loggedIn,
          current_url: null,
          last_checked_at: nowIso()
        }
      };
    } else if (toolName === 'publisher_login_status') {
      if (loggedIn) {
        structuredContent = {
          tool: 'publisher_login_status',
          status: 'accepted',
          logged_in: true,
          message: 'already logged in',
          session: null,
          browser: {
            endpoint: null,
            connected: true,
            logged_in: true,
            current_url: 'https://mp.weixin.qq.com/',
            last_checked_at: nowIso()
          },
          qr: null
        };
      } else {
        structuredContent = {
          tool: 'publisher_login_status',
          logged_in: false,
          ...waitingLoginStructured
        };
      }
    } else if (toolName === 'publisher_login_qr_get') {
      loggedIn = true;
      structuredContent = {
        tool: 'publisher_login_qr_get',
        ...waitingLoginStructured
      };
    } else if (toolName === 'publisher_publish') {
      publishCalls.push({
        title: String(toolArgs.title ?? ''),
        content_html: String(toolArgs.content_html ?? '')
      });
      structuredContent = {
        tool: 'publisher_publish',
        status: 'accepted',
        request_id: `req-${taskId}`,
        message: 'draft saved',
        accepted_at: nowIso(),
        session: null,
        browser: {
          endpoint: null,
          connected: true,
          logged_in: true,
          current_url: `https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&task=${taskId}`,
          last_checked_at: nowIso()
        },
        execution: {
          mode: 'selectors_applied',
          title_injected: true,
          body_injected: true,
          image_inserted: false,
          link_inserted: false,
          submit_triggered: false,
          draft_save_triggered: true,
          draft_saved: true,
          draft_save_reason: null,
          cover_from_content_applied: false,
          cover_from_content_reason: null,
          editor_verified: true,
          content_verified: true,
          content_length: Number(toolArgs.content_html ? String(toolArgs.content_html).length : 0),
          current_url: `https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&task=${taskId}`
        },
        error: null
      };
    } else {
      res.statusCode = 200;
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: body.id ?? null,
          error: {
            code: -32601,
            message: `unknown tool: ${String(toolName)}`
          }
        })
      );
      return;
    }

    res.statusCode = 200;
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: body.id ?? null,
        result: {
          content: [
            {
              type: 'text',
              text: 'ok'
            }
          ],
          structuredContent
        }
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

    assert.equal(publishCalls.length, 1);
    assert.match(publishCalls[0]?.content_html ?? '', /<h1>hello<\/h1>/i);
    assert.doesNotMatch(publishCalls[0]?.content_html ?? '', /<script/i);
    assert.deepEqual(toolCalls, [
      'publisher_health',
      'publisher_login_status',
      'publisher_login_qr_get',
      'publisher_login_status',
      'publisher_publish'
    ]);
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
