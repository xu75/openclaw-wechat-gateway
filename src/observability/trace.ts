import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface TraceContext {
  request_id?: string;
  requestId?: string;
  task_id?: string;
  taskId?: string;
  stage?: string;
  status?: string;
  [key: string]: unknown;
}

const traceStore = new AsyncLocalStorage<TraceContext>();

export function withTrace<T>(context: TraceContext, fn: () => Promise<T> | T): Promise<T> {
  const parent = getTraceContext();
  const next = normalizeTraceContext({
    ...(parent ?? {}),
    ...context
  });
  try {
    return Promise.resolve(traceStore.run(next, fn));
  } catch (error) {
    return Promise.reject(error);
  }
}

export function getTraceContext(): TraceContext | null {
  const ctx = traceStore.getStore();
  if (!ctx) {
    return null;
  }
  return { ...ctx };
}

export function setTraceContext(patch: TraceContext): TraceContext {
  const current = getTraceContext();
  const merged = normalizeTraceContext({
    ...(current ?? {}),
    ...patch
  });
  traceStore.enterWith(merged);
  return merged;
}

export function bindTraceFields(fields: Record<string, unknown> = {}): Record<string, unknown> {
  const trace = getTraceContext();
  if (!trace) {
    return { ...fields };
  }
  return {
    ...trace,
    ...fields
  };
}

function normalizeTraceContext(input: TraceContext): TraceContext {
  const requestId = asNonEmptyString(input.request_id) ?? asNonEmptyString(input.requestId) ?? randomUUID();
  const taskId = asNonEmptyString(input.task_id) ?? asNonEmptyString(input.taskId);

  const normalized: TraceContext = {
    ...input,
    request_id: requestId
  };

  if (taskId) {
    normalized.task_id = taskId;
  }

  delete normalized.requestId;
  delete normalized.taskId;
  return normalized;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}
