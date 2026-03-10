import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const REQUEST_ID_HEADER = 'x-request-id';
const MAX_REQUEST_ID_LENGTH = 128;
const SAFE_REQUEST_ID_PATTERN = /^[A-Za-z0-9\-._:/]+$/;

function sanitizeRequestId(input: string | undefined): string | null {
  if (!input) {
    return null;
  }

  const normalized = input.trim();
  if (!normalized) {
    return null;
  }

  if (normalized.length > MAX_REQUEST_ID_LENGTH) {
    return null;
  }

  if (!SAFE_REQUEST_ID_PATTERN.test(normalized)) {
    return null;
  }

  return normalized;
}

export function requestId(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header(REQUEST_ID_HEADER);
  const requestIdValue = sanitizeRequestId(incoming) ?? crypto.randomUUID();

  req.headers[REQUEST_ID_HEADER] = requestIdValue;
  res.locals.requestId = requestIdValue;
  res.setHeader(REQUEST_ID_HEADER, requestIdValue);
  next();
}
