import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { MIGRATIONS } from './schema.js';

export type Row = Record<string, any>;
export type Param = SQLInputValue | boolean | undefined;

function norm(params: Param[]): SQLInputValue[] {
  return params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p));
}

/**
 * Thin synchronous wrapper around node:sqlite. The control plane is a single process, so a
 * synchronous embedded DB with WAL gives us simple transactional semantics without a server.
 * All access goes through services, so swapping in Postgres later only touches this layer.
 */
export class Db {
  readonly raw: DatabaseSync;
  private txDepth = 0;

  constructor(file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.raw = new DatabaseSync(file);
    this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  private migrate() {
    this.raw.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    const applied = new Set(this.all('SELECT version FROM schema_migrations').map((r) => r.version as number));
    for (const m of MIGRATIONS) {
      if (applied.has(m.version)) continue;
      this.tx(() => {
        this.raw.exec(m.sql);
        this.run('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', m.version, new Date().toISOString());
      });
    }
  }

  all<T = Row>(sql: string, ...params: Param[]): T[] {
    return this.raw.prepare(sql).all(...norm(params)) as T[];
  }

  get<T = Row>(sql: string, ...params: Param[]): T | undefined {
    return this.raw.prepare(sql).get(...norm(params)) as T | undefined;
  }

  run(sql: string, ...params: Param[]): { changes: number } {
    const r = this.raw.prepare(sql).run(...norm(params));
    return { changes: Number(r.changes) };
  }

  /** Insert a row from an object; keys are trusted column names. */
  insert(table: string, row: Record<string, Param>): void {
    const keys = Object.keys(row);
    const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`;
    this.run(sql, ...keys.map((k) => row[k]));
  }

  /** Update columns of a row by id; keys are trusted column names. */
  update(table: string, id: string, patch: Record<string, Param>, idCol = 'id'): number {
    const keys = Object.keys(patch).filter((k) => patch[k] !== undefined);
    if (!keys.length) return 0;
    const sql = `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE ${idCol} = ?`;
    return this.run(sql, ...keys.map((k) => patch[k]), id).changes;
  }

  /** Nested-safe transaction (uses savepoints for inner calls). */
  tx<T>(fn: () => T): T {
    const sp = `sp_${this.txDepth}`;
    if (this.txDepth === 0) this.raw.exec('BEGIN IMMEDIATE');
    else this.raw.exec(`SAVEPOINT ${sp}`);
    this.txDepth++;
    try {
      const out = fn();
      this.txDepth--;
      if (this.txDepth === 0) this.raw.exec('COMMIT');
      else this.raw.exec(`RELEASE ${sp}`);
      return out;
    } catch (e) {
      this.txDepth--;
      if (this.txDepth === 0) this.raw.exec('ROLLBACK');
      else this.raw.exec(`ROLLBACK TO ${sp}; RELEASE ${sp}`);
      throw e;
    }
  }

  close() {
    this.raw.close();
  }
}
