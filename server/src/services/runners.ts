import type { Core } from '../core/core.js';
import { toRunner } from '../core/mappers.js';
import type { Runner, RunnerHeartbeat } from '../core/types.js';
import { badRequest, newId, newToken, notFound, nowIso, safeEqual, sha256 } from '../util/util.js';

export const LOCAL_RUNNER_ID = 'rnr_local';

export class RunnerService {
  constructor(private core: Core) {}
  private get db() {
    return this.core.db;
  }

  list(): Runner[] {
    return this.db.all('SELECT * FROM runners ORDER BY created_at').map(toRunner);
  }

  find(id: string): Runner | undefined {
    const r = this.db.get('SELECT * FROM runners WHERE id = ?', id);
    return r ? toRunner(r) : undefined;
  }

  get(id: string): Runner {
    const r = this.find(id);
    if (!r) throw notFound('Runner');
    return r;
  }

  /** Registers a runner and returns its secret token (shown once). */
  create(name: string, id = newId('rnr')): { runner: Runner; token: string } {
    if (!name?.trim()) throw badRequest('Runner name is required');
    const token = `aor_${newToken(24)}`;
    this.db.insert('runners', { id, name: name.trim(), token_hash: sha256(token), created_at: nowIso() });
    this.core.activity(null, 'owner', 'runner.created', `Runner ${name} registered`, { type: 'runner', id });
    this.core.bus.change({ topic: 'runners', id });
    return { runner: this.get(id), token };
  }

  /** The embedded runner gets a fresh token on every server start. */
  ensureLocal(): string {
    const token = `aor_${newToken(24)}`;
    if (this.find(LOCAL_RUNNER_ID)) this.db.update('runners', LOCAL_RUNNER_ID, { token_hash: sha256(token) });
    else this.db.insert('runners', { id: LOCAL_RUNNER_ID, name: 'Local runner', token_hash: sha256(token), created_at: nowIso() });
    return token;
  }

  rotateToken(id: string): string {
    this.get(id);
    const token = `aor_${newToken(24)}`;
    this.db.update('runners', id, { token_hash: sha256(token) });
    return token;
  }

  remove(id: string) {
    this.db.run('DELETE FROM runners WHERE id = ?', id);
    this.core.bus.change({ topic: 'runners', id });
  }

  authenticate(token: string | undefined): Runner | undefined {
    if (!token) return undefined;
    const h = sha256(token);
    const r = this.db.get('SELECT * FROM runners WHERE token_hash = ?', h);
    if (!r || !safeEqual(r.token_hash, h)) return undefined;
    return toRunner(r);
  }

  defaultRunnerId(): string | null {
    const local = this.find(LOCAL_RUNNER_ID);
    if (local) return local.id;
    return this.db.get<{ id: string }>('SELECT id FROM runners ORDER BY created_at LIMIT 1')?.id ?? null;
  }

  heartbeat(runner: Runner, hb: RunnerHeartbeat) {
    const wasOffline = runner.status !== 'online';
    this.db.update('runners', runner.id, { status: 'online', last_seen_at: nowIso(), info: JSON.stringify(hb.info ?? {}) });
    for (const a of hb.accounts ?? []) {
      const acc = this.core.accounts.find(a.id);
      if (acc && acc.runner_id === runner.id) this.core.accounts.reportAuth(a.id, a.auth);
    }
    // Runs this runner thinks are active but we consider finished are told to stop (via claim/events responses).
    this.core.runs.reconcileRunner(runner.id, hb.activeRunIds ?? []);
    if (wasOffline) {
      this.core.activity(null, `runner:${runner.id}`, 'runner.online', `Runner ${runner.name} is online`, { type: 'runner', id: runner.id });
      this.core.bus.change({ topic: 'runners', id: runner.id });
      this.core.bus.kick();
    }
  }

  touch(runnerId: string) {
    this.db.run("UPDATE runners SET last_seen_at = ?, status = 'online' WHERE id = ?", nowIso(), runnerId);
  }

  /** Marks silent runners offline and fails their in-flight runs so work can be retried. */
  sweepOffline() {
    const cutoff = new Date(Date.now() - this.core.config.runnerOfflineAfterSec * 1000).toISOString();
    const stale = this.db.all("SELECT * FROM runners WHERE status = 'online' AND (last_seen_at IS NULL OR last_seen_at < ?)", cutoff);
    for (const r of stale) {
      this.db.update('runners', r.id, { status: 'offline' });
      this.core.activity(null, 'system', 'runner.offline', `Runner ${r.name} went offline`, { type: 'runner', id: r.id });
      this.core.bus.change({ topic: 'runners', id: r.id });
      for (const run of this.db.all("SELECT id FROM runs WHERE runner_id = ? AND status = 'running'", r.id)) {
        this.core.runs.complete(run.id, { status: 'failed', errorKind: 'runner_lost', errorDetail: 'Runner stopped responding' });
      }
    }
  }
}
