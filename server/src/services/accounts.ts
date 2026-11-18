import path from 'node:path';
import type { Core } from '../core/core.js';
import { toAccount } from '../core/mappers.js';
import type { Account, AccountStatus, AuthSnapshot, Provider, UsageSnapshot } from '../core/types.js';
import { badRequest, newId, notFound, nowIso } from '../util/util.js';

const PROVIDERS: Provider[] = ['claude-code', 'mock'];

/** Auth methods that mean API billing. If a runner reports one, the account is blocked. */
export const API_BILLED_AUTH_METHODS = new Set(['api_key', 'api_key_helper', 'apiKeyHelper', 'console', 'auth_token', 'profile', 'federation', 'bedrock', 'vertex', 'foundry']);

export class AccountService {
  constructor(private core: Core) {}
  private get db() {
    return this.core.db;
  }

  list(): Account[] {
    return this.db.all('SELECT * FROM accounts ORDER BY created_at').map(toAccount);
  }

  get(id: string): Account {
    const r = this.db.get('SELECT * FROM accounts WHERE id = ?', id);
    if (!r) throw notFound('Account');
    return toAccount(r);
  }

  find(id: string | null | undefined): Account | undefined {
    if (!id) return undefined;
    const r = this.db.get('SELECT * FROM accounts WHERE id = ?', id);
    return r ? toAccount(r) : undefined;
  }

  create(input: { name: string; provider: Provider; runner_id?: string | null; config_dir?: string | null; max_concurrent_runs?: number }): Account {
    if (!input.name?.trim()) throw badRequest('Account name is required');
    if (!PROVIDERS.includes(input.provider)) throw badRequest(`Unsupported provider ${input.provider}`);
    const runnerId = input.runner_id ?? this.core.runners.defaultRunnerId();
    const id = newId('acc');
    let configDir = input.config_dir?.trim() || null;
    if (!configDir && input.provider === 'claude-code') {
      // Default: a per-account directory inside the runner's data dir. The runner resolves '~runner/'.
      configDir = path.posix.join('~runner', 'accounts', id, 'claude');
    }
    const now = nowIso();
    this.db.insert('accounts', {
      id,
      name: input.name.trim(),
      provider: input.provider,
      runner_id: runnerId,
      config_dir: configDir,
      status: input.provider === 'mock' ? 'ready' : 'unknown',
      max_concurrent_runs: Math.max(1, Math.min(input.max_concurrent_runs ?? 1, 8)),
      created_at: now,
      updated_at: now,
    });
    this.core.activity(null, 'owner', 'account.created', `Account ${input.name} (${input.provider}) added`, { type: 'account', id });
    this.core.bus.change({ topic: 'accounts', id });
    return this.get(id);
  }

  update(id: string, patch: Partial<Pick<Account, 'name' | 'runner_id' | 'config_dir' | 'max_concurrent_runs'>>): Account {
    this.get(id);
    this.db.update('accounts', id, { ...patch, updated_at: nowIso() });
    this.core.bus.change({ topic: 'accounts', id });
    this.core.bus.kick();
    return this.get(id);
  }

  remove(id: string) {
    const inUse = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM agents WHERE account_id = ?', id)!.n;
    if (inUse) throw badRequest('Account is assigned to agents; reassign them first');
    this.db.run('DELETE FROM accounts WHERE id = ?', id);
    this.core.bus.change({ topic: 'accounts', id });
  }

  setStatus(id: string, status: AccountStatus, detail: string | null = null, rateLimitedUntil: string | null = null) {
    const before = this.find(id);
    if (!before) return;
    this.db.update('accounts', id, { status, status_detail: detail, rate_limited_until: rateLimitedUntil, updated_at: nowIso() });
    if (before.status !== status) {
      this.core.activity(null, 'system', 'account.status', `Account ${before.name}: ${before.status} → ${status}${detail ? ` (${detail})` : ''}`, {
        type: 'account',
        id,
      });
    }
    if (status === 'ready' && before.status !== 'ready') {
      // Agents that stopped because of this account's auth/billing problem can work again.
      this.db.run("UPDATE agents SET status = 'idle', status_detail = NULL WHERE account_id = ? AND status IN ('error','waiting')", id);
      this.core.bus.change({ topic: 'agents' });
    }
    this.core.bus.change({ topic: 'accounts', id });
    this.core.bus.kick();
  }

  /** Runner-reported auth status (never contains credentials). */
  reportAuth(id: string, auth: AuthSnapshot) {
    const acc = this.find(id);
    if (!acc || acc.provider === 'mock') return;
    this.db.update('accounts', id, { auth: JSON.stringify({ ...auth, checkedAt: nowIso() }), updated_at: nowIso() });
    if (auth.ok === false) {
      const billing = auth.problem?.startsWith('billing');
      this.setStatus(id, billing ? 'billing_blocked' : 'auth_required', auth.problem ?? 'Not signed in');
    } else if (auth.ok && ['unknown', 'auth_required', 'error'].includes(acc.status)) {
      this.setStatus(id, 'ready', null);
    } else {
      this.core.bus.change({ topic: 'accounts', id });
    }
  }

  reportUsage(id: string, usage: UsageSnapshot & { limited?: boolean }) {
    const acc = this.find(id);
    if (!acc) return;
    this.db.update('accounts', id, { usage: JSON.stringify({ ...acc.usage, ...usage, updatedAt: nowIso() }), updated_at: nowIso() });
    if (usage.limited) {
      const until = usage.resetsAt ? new Date(usage.resetsAt * 1000).toISOString() : new Date(Date.now() + 60 * 60 * 1000).toISOString();
      this.setStatus(id, 'rate_limited', `Usage limit reached (${usage.rateLimitType ?? 'limit'}); resumes ${until}`, until);
    } else {
      this.core.bus.change({ topic: 'accounts', id });
    }
  }

  /** Accounts whose rate limit has expired become ready again. */
  releaseExpiredLimits() {
    const now = nowIso();
    for (const r of this.db.all("SELECT id FROM accounts WHERE status = 'rate_limited' AND rate_limited_until IS NOT NULL AND rate_limited_until <= ?", now)) {
      this.setStatus(r.id, 'ready', 'Usage window reset');
    }
  }

  /** Can this account start another run right now? Returns a reason when it cannot. */
  availability(acc: Account): { ok: boolean; reason?: string } {
    if (acc.status === 'rate_limited') return { ok: false, reason: acc.status_detail ?? 'rate limited' };
    if (acc.status === 'auth_required') return { ok: false, reason: 'account needs sign-in on its runner' };
    if (acc.status === 'billing_blocked') return { ok: false, reason: 'billing guard blocked this account (API credentials detected)' };
    if (!acc.runner_id) return { ok: false, reason: 'account has no runner' };
    const runner = this.core.runners.find(acc.runner_id);
    if (!runner || runner.status !== 'online') return { ok: false, reason: 'runner offline' };
    const active = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM runs WHERE account_id = ? AND status IN ('queued','running')", acc.id)!.n;
    if (active >= acc.max_concurrent_runs) return { ok: false, reason: 'account at max concurrency' };
    return { ok: true };
  }
}
