import fs from 'node:fs';
import path from 'node:path';
import { env } from '../config/env.js';

export type Dialect = 'postgres' | 'sqlite';
export type Param = string | number | null;

/**
 * Thin dialect-agnostic data access layer.
 *
 * The application targets Azure Database for PostgreSQL (§12.3). SQLite is
 * supported as a zero-dependency local/dev store so the app runs without a
 * database server. All SQL in this codebase is written to be valid on both:
 *   - `?` placeholders (rewritten to `$n` for pg)
 *   - TEXT for ids/enums/timestamps (ISO-8601 strings)
 *   - INTEGER 0/1 for booleans
 *   - DOUBLE PRECISION for real numbers
 */
export interface Db {
  readonly dialect: Dialect;
  all<T = Record<string, unknown>>(sql: string, params?: Param[]): Promise<T[]>;
  get<T = Record<string, unknown>>(sql: string, params?: Param[]): Promise<T | undefined>;
  run(sql: string, params?: Param[]): Promise<void>;
  exec(sql: string): Promise<void>;
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

function toPgSql(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

class SqliteDb implements Db {
  readonly dialect: Dialect = 'sqlite';
  // better-sqlite3 is synchronous; the async surface keeps callers dialect-agnostic.
  constructor(private readonly handle: any, private readonly inTx = false) {}

  async all<T>(sql: string, params: Param[] = []): Promise<T[]> {
    return this.handle.prepare(sql).all(...params) as T[];
  }
  async get<T>(sql: string, params: Param[] = []): Promise<T | undefined> {
    return this.handle.prepare(sql).get(...params) as T | undefined;
  }
  async run(sql: string, params: Param[] = []): Promise<void> {
    this.handle.prepare(sql).run(...params);
  }
  async exec(sql: string): Promise<void> {
    this.handle.exec(sql);
  }
  async tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    if (this.inTx) return fn(this);
    this.handle.exec('BEGIN');
    try {
      const result = await fn(new SqliteDb(this.handle, true));
      this.handle.exec('COMMIT');
      return result;
    } catch (err) {
      this.handle.exec('ROLLBACK');
      throw err;
    }
  }
  async close(): Promise<void> {
    if (!this.inTx) this.handle.close();
  }
}

class PostgresDb implements Db {
  readonly dialect: Dialect = 'postgres';
  constructor(private readonly client: any, private readonly isPool: boolean) {}

  async all<T>(sql: string, params: Param[] = []): Promise<T[]> {
    const res = await this.client.query(toPgSql(sql), params);
    return res.rows as T[];
  }
  async get<T>(sql: string, params: Param[] = []): Promise<T | undefined> {
    const rows = await this.all<T>(sql, params);
    return rows[0];
  }
  async run(sql: string, params: Param[] = []): Promise<void> {
    await this.client.query(toPgSql(sql), params);
  }
  async exec(sql: string): Promise<void> {
    await this.client.query(sql);
  }
  async tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    if (!this.isPool) return fn(this);
    const conn = await this.client.connect();
    try {
      await conn.query('BEGIN');
      const result = await fn(new PostgresDb(conn, false));
      await conn.query('COMMIT');
      return result;
    } catch (err) {
      await conn.query('ROLLBACK');
      throw err;
    } finally {
      conn.release();
    }
  }
  async close(): Promise<void> {
    if (this.isPool) await this.client.end();
  }
}

export async function createDb(options?: { driver?: Dialect; sqliteFile?: string; url?: string }): Promise<Db> {
  const driver = options?.driver ?? env.db.driver;

  if (driver === 'postgres') {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({
      connectionString: options?.url ?? env.db.url,
      ssl: env.db.ssl ? { rejectUnauthorized: false } : undefined,
      max: 10,
    });
    return new PostgresDb(pool, true);
  }

  const file = options?.sqliteFile ?? env.db.sqliteFile;
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const { default: Database } = await import('better-sqlite3');
  const handle = new Database(file);
  handle.pragma('journal_mode = WAL');
  handle.pragma('foreign_keys = ON');
  return new SqliteDb(handle);
}

let singleton: Db | null = null;

export async function getDb(): Promise<Db> {
  if (!singleton) singleton = await createDb();
  return singleton;
}

export async function closeDb(): Promise<void> {
  if (singleton) {
    await singleton.close();
    singleton = null;
  }
}

/** Portable "insert or replace by primary key" for the small config tables. */
export function upsert(table: string, columns: string[], conflictColumns: string[]): string {
  const cols = columns.join(', ');
  const placeholders = columns.map(() => '?').join(', ');
  const updates = columns
    .filter((c) => !conflictColumns.includes(c))
    .map((c) => `${c} = excluded.${c}`)
    .join(', ');
  const doUpdate = updates ? `DO UPDATE SET ${updates}` : 'DO NOTHING';
  return `INSERT INTO ${table} (${cols}) VALUES (${placeholders}) ON CONFLICT (${conflictColumns.join(', ')}) ${doUpdate}`;
}
