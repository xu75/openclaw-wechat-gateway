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
