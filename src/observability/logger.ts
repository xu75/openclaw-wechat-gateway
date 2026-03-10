import { bindTraceFields } from './trace.js';

const RESERVED_KEYS = new Set([
  'request_id',
  'requestId',
  'task_id',
  'taskId',
  'stage',
  'status',
  'error_code',
  'errorCode'
]);

type LogLevel = 'info' | 'error';

export interface LogFields {
  request_id?: string | undefined;
  requestId?: string | undefined;
  task_id?: string | undefined;
  taskId?: string | undefined;
  stage?: string | undefined;
  status?: string | undefined;
  error_code?: string | undefined;
  errorCode?: string | undefined;
  [key: string]: unknown;
}

export interface Logger {
  info(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(baseFields: LogFields): Logger;
}

export function createLogger(baseFields: LogFields = {}): Logger {
  return {
    info(message: string, fields: LogFields = {}): void {
      writeLog('info', message, mergeFields(baseFields, fields));
    },
    error(message: string, fields: LogFields = {}): void {
      writeLog('error', message, mergeFields(baseFields, fields));
    },
    child(nextBase: LogFields): Logger {
      return createLogger(mergeFields(baseFields, nextBase));
    }
  };
}

const rootLogger = createLogger();

export function logInfo(message: string, fields: LogFields = {}): void {
  rootLogger.info(message, fields);
}

export function logError(message: string, fields: LogFields = {}): void {
  rootLogger.error(message, fields);
}

function writeLog(level: LogLevel, message: string, fields: LogFields): void {
  const merged = bindTraceFields(fields) as LogFields;
  const requestId = asNonEmptyString(merged.request_id) ?? asNonEmptyString(merged.requestId) ?? 'unknown';
  const taskId = asNonEmptyString(merged.task_id) ?? asNonEmptyString(merged.taskId);
  const stage = asNonEmptyString(merged.stage) ?? (level === 'error' ? 'failure' : 'processing');
  const status = asNonEmptyString(merged.status) ?? (level === 'error' ? 'error' : 'ok');
  const errorCode = asNonEmptyString(merged.error_code) ?? asNonEmptyString(merged.errorCode);

  const record: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    message,
    request_id: requestId,
    stage,
    status
  };

  if (taskId) {
    record.task_id = taskId;
  }
  if (errorCode) {
    record.error_code = errorCode;
  }

  for (const [key, value] of Object.entries(merged)) {
    if (RESERVED_KEYS.has(key) || value === undefined) {
      continue;
    }
    record[key] = value;
  }

  if (level === 'error') {
    console.error(JSON.stringify(record));
    return;
  }
  console.log(JSON.stringify(record));
}

function mergeFields(base: LogFields, fields: LogFields): LogFields {
  return {
    ...base,
    ...fields
  };
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}
