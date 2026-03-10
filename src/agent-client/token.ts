import { createHmac } from 'node:crypto';

function toBase64Url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

export interface ReviewTokenInput {
  secret: string;
  issuer?: string;
  ttlSeconds: number;
  taskId: string;
  idempotencyKey: string;
  nowSeconds?: number;
}

export function createReviewToken(input: ReviewTokenInput): string {
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    iss: input.issuer ?? 'ecs-review',
    sub: input.taskId,
    iat: now,
    exp: now + input.ttlSeconds,
    review_approved: true,
    idempotency_key: input.idempotencyKey
  };

  const head = toBase64Url(JSON.stringify(header));
  const body = toBase64Url(JSON.stringify(payload));
  const signature = toBase64Url(createHmac('sha256', input.secret).update(`${head}.${body}`).digest());

  return `${head}.${body}.${signature}`;
}
