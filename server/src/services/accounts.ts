import path from 'node:path';
import type { Core } from '../core/core.js';
import { toAccount } from '../core/mappers.js';
import type { Account, AccountStatus, AuthSnapshot, Provider, UsageSnapshot } from '../core/types.js';
import { badRequest, newId, newToken, notFound, nowIso, safeEqual, sha256 } from '../util/util.js';

const PROVIDERS: Provider[] = ['claude-code', 'claude-cloud', 'mock'];

/** Providers whose runs execute on a runner (local git worktrees). claude-cloud runs on Anthropic's cloud. */
export const RUNNER_PROVIDERS: Provider[] = ['claude-code', 'mock'];

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

  create(input: {
    name: string;
    provider: Provider;
    runner_id?: string | null;
    config_dir?: string | null;
    max_concurrent_runs?: number;
    fire_url?: string | null;
    fire_token?: string | null;
  }): Account & { cloud_token?: string } {
    if (!input.name?.trim()) throw badRequest('Account name is required');
    if (!PROVIDERS.includes(input.provider)) throw badRequest(`Unsupported provider ${input.provider}`);
    const cloud = input.provider === 'claude-cloud';
    // A cloud account can be created before its routine exists: the routine's environment needs the
    // AgentOS token that creating the account produces. The trigger is added afterwards.
    const hasTrigger = cloud && !!input.fire_url?.trim() && !!input.fire_token?.trim();
    if (cloud && input.fire_url?.trim()) validateFireUrl(input.fire_url);
    const runnerId = cloud ? null : (input.runner_id ?? this.core.runners.defaultRunnerId());
    const id = newId('acc');
    let configDir = cloud ? null : input.config_dir?.trim() || null;
    if (!configDir && input.provider === 'claude-code') {
      // Default: a per-account directory inside the runner's data dir. The runner resolves '~runner/'.
      configDir = path.posix.join('~runner', 'accounts', id, 'claude');
    }
    const cloudToken = cloud ? `aoc_${newToken(24)}` : undefined;
    const now = nowIso();
    this.db.insert('accounts', {
      id,
      name: input.name.trim(),
      provider: input.provider,
      runner_id: runnerId,
      config_dir: configDir,
      status: input.provider === 'mock' || hasTrigger ? 'ready' : cloud ? 'auth_required' : 'unknown',
      status_detail: cloud && !hasTrigger ? 'Routine trigger not set yet: add the Fire URL and token from claude.ai/code/routines' : null,
      max_concurrent_runs: Math.max(1, Math.min(input.max_concurrent_runs ?? (cloud ? 2 : 1), 8)),
      fire_url: cloud && input.fire_url?.trim() ? input.fire_url.trim() : null,
      fire_token_enc: cloud && input.fire_token?.trim() ? this.core.secrets.encrypt(input.fire_token.trim()) : null,
      cloud_token_hash: cloudToken ? sha256(cloudToken) : null,
      created_at: now,
      updated_at: now,
    });
    this.core.activity(null, 'owner', 'account.created', `Account ${input.name} (${input.provider}) added`, { type: 'account', id });
    this.core.bus.change({ topic: 'accounts', id });
    return cloudToken ? { ...this.get(id), cloud_token: cloudToken } : this.get(id);
  }

  update(id: string, patch: Partial<Pick<Account, 'name' | 'runner_id' | 'config_dir' | 'max_concurrent_runs' | 'fire_url'>> & { fire_token?: string | null }): Account {
    const acc = this.get(id);
    const { fire_token, ...rest } = patch;
    const row: Record<string, any> = { ...rest, updated_at: nowIso() };
    if (rest.fire_url !== undefined) {
      if (acc.provider !== 'claude-cloud') throw badRequest('Only cloud accounts have a routine trigger');
      if (rest.fire_url) validateFireUrl(rest.fire_url);
    }
    if (fire_token) {
      if (acc.provider !== 'claude-cloud') throw badRequest('Only cloud accounts have a routine trigger');
      row.fire_token_enc = this.core.secrets.encrypt(fire_token.trim());
    }
    this.db.update('accounts', id, row);
    const after = this.get(id);
    if (after.provider === 'claude-cloud' && after.fire_url && after.has_fire_token && ['auth_required', 'error'].includes(acc.status)) this.setStatus(id, 'ready', 'Routine trigger set');
    this.core.bus.change({ topic: 'accounts', id });
    this.core.bus.kick();
    return this.get(id);
  }

  /** New AgentOS token for a cloud account (to paste into its cloud environment's network secret). */
  rotateCloudToken(id: string): string {
    const acc = this.get(id);
    if (acc.provider !== 'claude-cloud') throw badRequest('Only cloud accounts have an AgentOS token');
    const token = `aoc_${newToken(24)}`;
    this.db.update('accounts', id, { cloud_token_hash: sha256(token), updated_at: nowIso() });
    this.core.activity(null, 'owner', 'account.token_rotated', `AgentOS token for ${acc.name} rotated`, { type: 'account', id });
    this.core.bus.change({ topic: 'accounts', id });
    return token;
  }

  /** The cloud account behind a bearer token sent by a Claude Code on the web session. */
  byCloudToken(token: string | undefined): Account | undefined {
    if (!token?.startsWith('aoc_')) return undefined;
    const h = sha256(token);
    const r = this.db.get('SELECT * FROM accounts WHERE cloud_token_hash = ? AND provider = ?', h, 'claude-cloud');
    return r && safeEqual(r.cloud_token_hash, h) ? toAccount(r) : undefined;
  }

  fireCredentials(id: string): { url: string; token: string } {
    const r = this.db.get<{ fire_url: string | null; fire_token_enc: string | null }>('SELECT fire_url, fire_token_enc FROM accounts WHERE id = ?', id);
    const token = this.core.secrets.decrypt(r?.fire_token_enc ?? null);
    if (!r?.fire_url || !token) throw badRequest('Cloud account has no routine trigger configured');
    return { url: r.fire_url, token };
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

  /**
   * Cloud mode cannot see subscription usage: a cloud session that runs out of usage simply goes
   * quiet, and the watchdog fails it as a timeout. That is the only signal AgentOS gets, so treat a
   * run of silent sessions as "possibly out of usage" and back the account off instead of firing
   * its routine again straight away: 15 minutes after the first, doubling, at most 2 hours.
   * A long session that legitimately went quiet also counts; Re-check clears the back-off.
   */
  noteSilentCloudSession(id: string): { streak: number; until: string } | null {
    const acc = this.find(id);
    if (!acc || acc.provider !== 'claude-cloud') return null;
    const rows = this.db.all<{ error_kind: string | null }>(
      "SELECT error_kind FROM runs WHERE account_id = ? AND kind = 'agent' AND finished_at IS NOT NULL AND status <> 'cancelled' ORDER BY finished_at DESC LIMIT 12",
      id,
    );
    let streak = 0;
    for (const r of rows) {
      if (r.error_kind !== 'timeout') break;
      streak++;
    }
    if (!streak) return null;
    const minutes = Math.min(120, 15 * 2 ** (streak - 1));
    const until = new Date(Date.now() + minutes * 60_000).toISOString();
    const sessions = streak === 1 ? 'A cloud session' : `${streak} cloud sessions in a row`;
    this.setStatus(
      id,
      'rate_limited',
      `Possibly out of usage: ${sessions} went quiet without finishing. Next try ${until.slice(11, 16)} UTC. Check the session on claude.ai, or Re-check to try now.`,
      until,
    );
    return { streak, until };
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
    if (acc.provider !== 'claude-cloud') {
      if (!acc.runner_id) return { ok: false, reason: 'account has no runner' };
      const runner = this.core.runners.find(acc.runner_id);
      if (!runner || runner.status !== 'online') return { ok: false, reason: 'runner offline' };
    }
    const active = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM runs WHERE account_id = ? AND status IN ('queued','running')", acc.id)!.n;
    if (active >= acc.max_concurrent_runs) return { ok: false, reason: 'account at max concurrency' };
    return { ok: true };
  }
}

function validateFireUrl(url: string) {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    throw badRequest('The routine trigger URL is not a valid URL');
  }
  if (!['https:', 'http:'].includes(u.protocol) || !/\/fire\/?$/.test(u.pathname)) {
    throw badRequest('Expected the routine API trigger URL, e.g. https://api.anthropic.com/v1/claude_code/routines/trig_…/fire');
  }
}
