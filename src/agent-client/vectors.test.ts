import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { classifyAgentHttpFailure } from './errors.js';
import { buildSigningText, signAgentRequest } from './sign.js';
import { createReviewToken } from './token.js';

test('sign vector is reproducible', () => {
  const method = 'POST';
  const path = '/publish';
  const timestamp = '1700000000';
  const body = JSON.stringify({
    task_id: 'task-123',
    idempotency_key: 'idem-456',
    title: 'Hello',
    content: 'World',
    review_approved: true,
    review_approval_token: 'token',
    preferred_channel: 'browser'
  });

  const signed = signAgentRequest({
    secret: 'secret-xyz',
    method,
    path,
    timestamp,
    body
  });

  assert.equal(
    signed.bodySha256,
    '5ac892aa93969f2e441eacc93110b5cd52c48a034f8f2a5c44292b9d64c820ae'
  );
  assert.equal(
    signed.signingText,
    buildSigningText(method, path, timestamp, signed.bodySha256)
  );
  assert.equal(
    signed.signature,
    'f5b62f48aef911afaa9f55c9f5ce3863dc469e7dfadea6d79dc4b802c083f681'
  );
});

test('review token vector is reproducible and HS256 verifiable', () => {
  const token = createReviewToken({
    secret: 'review-secret',
    issuer: 'ecs-review',
    ttlSeconds: 600,
    taskId: 'task-123',
    idempotencyKey: 'idem-456',
    title: 'Hello',
    content: '<p>World</p>',
    preferredChannel: 'browser',
    nowSeconds: 1700000000
  });

  assert.equal(
    token,
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJlY3MtcmV2aWV3IiwidGFza19pZCI6InRhc2stMTIzIiwiY29udGVudF9oYXNoIjoiNTBmNjAxMTNmYWNmYWRhNjUzOTAxOWNjM2Y3YjA2YTNlMDVmYzFkODAwYzk1MjA3Y2I4Nzc1OWQyMzU0OTY1MSIsImlhdCI6MTcwMDAwMDAwMCwiZXhwIjoxNzAwMDAwNjAwLCJyZXZpZXdfYXBwcm92ZWQiOnRydWUsImlkZW1wb3RlbmN5X2tleSI6ImlkZW0tNDU2In0.x4_NIYEYGBzZLYesEOuAHhhApyb2ogg92qwFAbDyF3o'
  );

  const parts = token.split('.');
  assert.equal(parts.length, 3);

  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];
  assert.equal(headerB64, 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
  assert.equal(
    signatureB64,
    Buffer.from(createHmac('sha256', 'review-secret').update(`${headerB64}.${payloadB64}`).digest())
      .toString('base64')
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
  );
});

test('http error mapping vectors are classified clearly', () => {
  assert.equal(
    classifyAgentHttpFailure(401, { error_code: 'INVALID_SIGNATURE' }),
    'AGENT_SIGNATURE_ERROR'
  );
  assert.equal(
    classifyAgentHttpFailure(503, { error_code: 'UPSTREAM_BUSY' }),
    'AGENT_UNAVAILABLE'
  );
  assert.equal(
    classifyAgentHttpFailure(422, { error_code: 'CONTENT_INVALID' }),
    'AGENT_BUSINESS_ERROR'
  );
});
