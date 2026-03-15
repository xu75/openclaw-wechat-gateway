import { createHash, createHmac } from 'node:crypto';

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
  title: string;
  content: string;
  preferredChannel: 'browser' | 'official';
  thumbMediaId?: string;
  author?: string;
  digest?: string;
  contentSourceUrl?: string;
  nowSeconds?: number;
}

function computePublishContentHash(input: ReviewTokenInput): string {
  const payload = JSON.stringify({
    task_id: input.taskId,
    title: input.title,
    content: input.content,
    preferred_channel: input.preferredChannel || 'official',
    thumb_media_id: input.thumbMediaId || '',
    author: input.author || '',
    digest: input.digest || '',
    content_source_url: input.contentSourceUrl || ''
  });

  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

export function createReviewToken(input: ReviewTokenInput): string {
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    iss: input.issuer ?? 'ecs-review',
    task_id: input.taskId,
    content_hash: computePublishContentHash(input),
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
