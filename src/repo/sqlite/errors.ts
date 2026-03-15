export class SqliteUniqueConstraintError extends Error {
  readonly code = 'REPO_UNIQUE_CONSTRAINT';
  readonly table: string | null;
  readonly columns: string[];

  constructor(message: string, table: string | null, columns: string[], options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SqliteUniqueConstraintError';
    this.table = table;
    this.columns = columns;
  }
}

export class SqliteForeignKeyConstraintError extends Error {
  readonly code = 'REPO_FOREIGN_KEY_CONSTRAINT';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SqliteForeignKeyConstraintError';
  }
}

export class RepoNotFoundError extends Error {
  readonly code = 'REPO_NOT_FOUND';

  constructor(message: string) {
    super(message);
    this.name = 'RepoNotFoundError';
  }
}

function asSqliteCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') {
    return null;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

function parseUniqueTarget(message: string): { table: string | null; columns: string[] } {
  const matched = /UNIQUE constraint failed:\s*(.+)$/i.exec(message);
  if (!matched?.[1]) {
    return { table: null, columns: [] };
  }

  const parts = matched[1]
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) {
    return { table: null, columns: [] };
  }

  const table = parts[0]?.split('.')[0] ?? null;
  const columns = parts.map((part) => {
    const section = part.split('.');
    return section[section.length - 1] ?? part;
  });
  return { table, columns };
}

export function mapSqliteConstraintError(error: unknown): Error {
  const code = asSqliteCode(error);
  const message = error instanceof Error ? error.message : String(error);

  if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
    const parsed = parseUniqueTarget(message);
    return new SqliteUniqueConstraintError(message, parsed.table, parsed.columns, { cause: error });
  }

  if (code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
    return new SqliteForeignKeyConstraintError(message, { cause: error });
  }

  if (/UNIQUE constraint failed/i.test(message)) {
    const parsed = parseUniqueTarget(message);
    return new SqliteUniqueConstraintError(message, parsed.table, parsed.columns, { cause: error });
  }

  if (/FOREIGN KEY constraint failed/i.test(message)) {
    return new SqliteForeignKeyConstraintError(message, { cause: error });
  }

  return error instanceof Error ? error : new Error(String(error));
}

function asNonEmptyStrings(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

export function isSqliteUniqueConstraintError(error: unknown): error is SqliteUniqueConstraintError {
  if (error instanceof SqliteUniqueConstraintError) {
    return true;
  }
  if (!error || typeof error !== 'object') {
    return false;
  }

  return (error as { code?: unknown }).code === 'REPO_UNIQUE_CONSTRAINT';
}

export function isPublishTaskIdempotencyUniqueConflict(error: unknown): boolean {
  if (!isSqliteUniqueConstraintError(error)) {
    return false;
  }

  const table = (error as { table?: unknown }).table;
  const columns = asNonEmptyStrings((error as { columns?: unknown }).columns);
  if (typeof table === 'string' && table === 'publish_tasks') {
    return true;
  }

  return columns.includes('task_id') || columns.includes('idempotency_key');
}

export function buildIdempotencyConflictDetails(
  error: unknown,
  input?: {
    task_id: string;
    idempotency_key: string;
  }
): Record<string, unknown> {
  const table =
    error && typeof error === 'object' && typeof (error as { table?: unknown }).table === 'string'
      ? ((error as { table?: string }).table ?? null)
      : null;
  const columns =
    error && typeof error === 'object' ? asNonEmptyStrings((error as { columns?: unknown }).columns) : [];

  const details: Record<string, unknown> = {
    conflict_table: table,
    conflict_columns: columns
  };

  if (input?.task_id) {
    details.task_id = input.task_id;
  }
  if (input?.idempotency_key) {
    details.idempotency_key = input.idempotency_key;
  }

  return details;
}
