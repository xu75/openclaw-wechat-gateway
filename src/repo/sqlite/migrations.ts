import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openSqlite } from './client.js';

function migrationsDir(): string {
  const thisFile = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(thisFile), '../../../migrations');
}

function defaultDbPath(): string {
  return path.resolve(process.cwd(), process.env.DB_PATH ?? './data/gateway.db');
}

function discoverMigrations(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^\d+_.*\.sql$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

export function runMigrations(dbPath = defaultDbPath()): void {
  const db = openSqlite(dbPath);

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      )
    `);

    const dir = migrationsDir();
    const files = discoverMigrations(dir);
    for (const fileName of files) {
      const alreadyApplied = db.prepare('SELECT 1 FROM schema_migrations WHERE version = ? LIMIT 1').get(fileName);
      if (alreadyApplied) {
        continue;
      }

      const sql = fs.readFileSync(path.join(dir, fileName), 'utf8');
      const tx = db.transaction(() => {
        db.exec(sql);
        db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)').run(
          fileName,
          new Date().toISOString()
        );
      });
      tx();
    }
  } finally {
    db.close();
  }
}

const directRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (directRun) {
  runMigrations();
  console.log(`[migrate] done: ${defaultDbPath()}`);
}
