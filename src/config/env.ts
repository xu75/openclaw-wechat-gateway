import path from 'node:path';
import dotenv from 'dotenv';
import {
  DEFAULT_AGENT_BASE_URL,
  DEFAULT_PORT,
  DEFAULT_REVIEW_TOKEN_ISSUER,
  DEFAULT_REVIEW_TOKEN_TTL_SECONDS,
  DEFAULT_WAITING_LOGIN_TIMEOUT_SECONDS
} from './constants.js';

dotenv.config();

function asPositiveInt(input: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(input ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: asPositiveInt(process.env.PORT, DEFAULT_PORT),
  agentBaseUrl: process.env.AGENT_BASE_URL ?? DEFAULT_AGENT_BASE_URL,
  signingSecret: required('WECHAT_AGENT_SIGNING_SECRET'),
  reviewTokenSecret: process.env.WECHAT_AGENT_REVIEW_TOKEN_SECRET ?? required('WECHAT_AGENT_SIGNING_SECRET'),
  reviewTokenIssuer: process.env.WECHAT_AGENT_REVIEW_TOKEN_ISSUER ?? DEFAULT_REVIEW_TOKEN_ISSUER,
  reviewTokenTtlSeconds: asPositiveInt(
    process.env.WECHAT_AGENT_REVIEW_TOKEN_TTL_SECONDS,
    DEFAULT_REVIEW_TOKEN_TTL_SECONDS
  ),
  waitingLoginTimeoutSeconds: asPositiveInt(
    process.env.WAITING_LOGIN_TIMEOUT_SECONDS,
    DEFAULT_WAITING_LOGIN_TIMEOUT_SECONDS
  ),
  alertWebhook: process.env.ALERT_WEBHOOK ?? '',
  dbPath: path.resolve(process.cwd(), process.env.DB_PATH ?? './data/gateway.db')
};
