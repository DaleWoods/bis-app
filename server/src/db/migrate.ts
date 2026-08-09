import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Db, getDb, closeDb } from './index.js';
import { nowIso } from '../util/time.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Baseline schema plus any incremental files in `migrations/`.
 *
 * A file runs once: `schema_migrations` records what has been applied, which is
 * what makes running this on every boot safe. The statements themselves are not
 * all idempotent - an incremental file uses bare `ALTER TABLE ADD COLUMN`,
 * which fails on a second run - so each file is applied inside a transaction
 * along with the row that records it. Either the whole file lands and is
 * marked, or none of it does and the next boot retries it cleanly. Without that
 * a file that failed half way through could never be applied again: the retry
 * would die on the statement that had already succeeded.
 */
export async function migrate(db: Db): Promise<string[]> {
  const applied: string[] = [];

  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);

  const files: Array<{ name: string; sql: string }> = [];
  const baseline = path.join(here, 'schema.sql');
  if (fs.existsSync(baseline)) {
    files.push({ name: '000_baseline.sql', sql: fs.readFileSync(baseline, 'utf8') });
  }

  const migrationsDir = path.join(here, 'migrations');
  if (fs.existsSync(migrationsDir)) {
    for (const name of fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()) {
      files.push({ name, sql: fs.readFileSync(path.join(migrationsDir, name), 'utf8') });
    }
  }

  for (const file of files) {
    const existing = await db.get<{ name: string }>('SELECT name FROM schema_migrations WHERE name = ?', [file.name]);
    if (existing) continue;
    await db.tx(async (tx) => {
      await tx.exec(file.sql);
      await tx.run('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)', [file.name, nowIso()]);
    });
    applied.push(file.name);
  }

  return applied;
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectRun) {
  const db = await getDb();
  const applied = await migrate(db);
  console.log(applied.length ? `Applied migrations: ${applied.join(', ')}` : 'Schema already up to date.');
  await closeDb();
}
