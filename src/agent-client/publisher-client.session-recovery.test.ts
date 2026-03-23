import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentPublishRequest } from '../contracts/agent.js';
import { PublisherClient } from './publisher-client.js';

function sseJson(payload: unknown): string {
  return `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
}

function jsonRpcResult(id: number, result: unknown): string {
  return sseJson({
    jsonrpc: '2.0',
    id,
    result
  });
}

test('publisher client auto-recovers on invalid mcp session 400 once', async () => {
  let step = 0;
  const seenSessionIds: Array<string | null> = [];

  const fetchImpl: typeof fetch = async (_input, init) => {
    const headers = new Headers(init?.headers);
    const sid = headers.get('mcp-session-id');
    seenSessionIds.push(sid);
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      id?: number;
      method: string;
      params?: Record<string, unknown>;
    };

    step += 1;

    if (step === 1) {
      assert.equal(body.method, 'initialize');
      return new Response(
        jsonRpcResult(Number(body.id), {
          protocolVersion: '2024-11-05',
          capabilities: {},
          serverInfo: { name: 'agent', version: '0.1.0' }
        }),
        {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
            'mcp-session-id': 'sid-1'
          }
        }
      );
    }

    if (step === 2) {
      assert.equal(body.method, 'notifications/initialized');
      assert.equal(sid, 'sid-1');
      return new Response('', { status: 202, headers: { 'content-type': 'text/plain' } });
    }

    if (step === 3) {
      assert.equal(body.method, 'tools/call');
      assert.equal(body.params?.name, 'publisher_health');
      assert.equal(sid, 'sid-1');
      return new Response(
        jsonRpcResult(Number(body.id), {
          structuredContent: { status: 'accepted', healthy: true }
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } }
      );
    }

    if (step === 4) {
      assert.equal(body.method, 'tools/call');
      assert.equal(body.params?.name, 'publisher_login_status');
      assert.equal(sid, 'sid-1');
      return new Response(
        jsonRpcResult(Number(body.id), {
          structuredContent: { status: 'accepted', logged_in: true }
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } }
      );
    }

    if (step === 5) {
      assert.equal(body.method, 'tools/call');
      assert.equal(body.params?.name, 'publisher_publish');
      assert.equal(sid, 'sid-1');
      return new Response(
        jsonRpcResult(Number(body.id), {
          structuredContent: {
            status: 'accepted',
            execution: {
              draft_saved: true,
              current_url: 'https://example.com/editor'
            }
          }
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } }
      );
    }

    if (step === 6) {
      assert.equal(body.method, 'tools/call');
      assert.equal(body.params?.name, 'publisher_login_status');
      assert.equal(sid, 'sid-1');
      return new Response(
        JSON.stringify({
          error: {
            code: -32000,
            message: 'No valid session ID provided'
          }
        }),
        { status: 400, headers: { 'content-type': 'application/json' } }
      );
    }

    if (step === 7) {
      assert.equal(body.method, 'initialize');
      assert.equal(sid, null);
      return new Response(
        jsonRpcResult(Number(body.id), {
          protocolVersion: '2024-11-05',
          capabilities: {},
          serverInfo: { name: 'agent', version: '0.1.0' }
        }),
        {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
            'mcp-session-id': 'sid-2'
          }
        }
      );
    }

    if (step === 8) {
      assert.equal(body.method, 'notifications/initialized');
      assert.equal(sid, 'sid-2');
      return new Response('', { status: 202, headers: { 'content-type': 'text/plain' } });
    }

    if (step === 9) {
      assert.equal(body.method, 'tools/call');
      assert.equal(body.params?.name, 'publisher_login_status');
      assert.equal(sid, 'sid-2');
      return new Response(
        jsonRpcResult(Number(body.id), {
          structuredContent: { status: 'accepted', logged_in: true }
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } }
      );
    }

    if (step === 10) {
      assert.equal(body.method, 'tools/call');
      assert.equal(body.params?.name, 'publisher_publish');
      assert.equal(sid, 'sid-2');
      return new Response(
        jsonRpcResult(Number(body.id), {
          structuredContent: {
            status: 'accepted',
            execution: {
              draft_saved: true,
              current_url: 'https://example.com/editor/2'
            }
          }
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } }
      );
    }

    throw new Error(`unexpected call step ${step} (${body.method})`);
  };

  const client = new PublisherClient({
    baseUrl: 'http://agent.local',
    signingSecret: 'unused',
    fetchImpl
  });

  const payload: AgentPublishRequest = {
    task_id: 'task-123',
    idempotency_key: 'idem-123',
    title: 'title',
    content: '<p>content</p>',
    review_approved: true,
    review_approval_token: 'token',
    preferred_channel: 'browser'
  };

  const first = await client.publish(payload);
  assert.equal(first.status, 'accepted');
  assert.equal(first.publish_url, 'https://example.com/editor');

  const second = await client.publish(payload);
  assert.equal(second.status, 'accepted');
  assert.equal(second.publish_url, 'https://example.com/editor/2');
  assert.equal(step, 10);
  assert.equal(seenSessionIds.includes('sid-1'), true);
  assert.equal(seenSessionIds.includes('sid-2'), true);
});
