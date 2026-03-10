import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export type SqliteDatabase = InstanceType<typeof Database>;
export interface SqliteTx {
  readonly db: SqliteDatabase;
}

export interface SqliteWriteOptions {
  tx?: SqliteTx;
}

function defaultDbPath(): string {
  return path.resolve(process.cwd(), process.env.DB_PATH ?? './data/gateway.db');
}

export function openSqlite(dbPath = defaultDbPath()): SqliteDatabase {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  return db;
}

export function withSqliteTransaction<T>(db: SqliteDatabase, work: (tx: SqliteTx) => T): T {
  const transaction = db.transaction((runner: (tx: SqliteTx) => T) => {
    const result = runner({ db });
    if (typeof (result as { then?: unknown } | null)?.then === 'function') {
      throw new Error('withSqliteTransaction callback must be synchronous');
    }
    return result;
  });
  return transaction(work);
}

export function resolveDb(options: SqliteWriteOptions | undefined, db: SqliteDatabase): SqliteDatabase {
  return options?.tx?.db ?? db;
}
