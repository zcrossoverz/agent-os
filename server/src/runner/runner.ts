import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { AuthSnapshot, RunAssignment, RunCompletion, RunnerEvent, RunnerHeartbeat } from '../core/types.js';
import { log, nowIso, sleep } from '../util/util.js';
import { buildChildEnv, preflightAuth, readLocalOauthToken } from './billing-guard.js';
import { agentIdentity, GitError, Workspaces } from './git.js';
import { ClaudeCodeDriver } from './drivers/claude-code.js';
import { MockDriver } from './drivers/mock.js';
import type { AgentDriver } from './drivers/types.js';

export interface RunnerOptions {
  serverUrl: string;
  token: string;
  dataDir: string;
  claudeBin?: string;
  /** Max parallel runs on this runner (accounts additionally limit their own concurrency). */
  capacity?: number;
  heartbeatSec?: number;
  authCheckSec?: number;
}

interface AccountInfo {
  id: string;
  name: string;
  provider: string;
  configDir: string | null;
}

/**
 * A runner executes runs for the accounts that live on its machine. It only makes outbound HTTP
 * calls to the control plane (heartbeat, long-poll claim, event upload, completion), so it can run
 * on the VPS next to the server or on a laptop behind NAT. Provider credentials never leave it.
 */
export class Runner {
  private stopped = false;
  private active = new Map<string, AbortController>();
  private accounts: AccountInfo[] = [];
  private authCache = new Map<string, { at: number; snap: AuthSnapshot }>();
  private workspaces: Workspaces;
  private drivers: Record<string, AgentDriver>;
  private claudeBin: string;
  private loops: Promise<void>[] = [];

  constructor(private opts: RunnerOptions) {
    this.workspaces = new Workspaces(opts.dataDir);
    this.claudeBin = opts.claudeBin ?? process.env.AGENTOS_CLAUDE_BIN ?? 'claude';
    this.drivers = {
      'claude-code': new ClaudeCodeDriver({ claudeBin: this.claudeBin, runtimeDir: path.join(opts.dataDir, 'runtime') }),
      mock: new MockDriver(),
    };
    fs.mkdirSync(opts.dataDir, { recursive: true });
  }

  /** Resolve an account's config dir; "~runner/..." is relative to this runner's data dir. */
  resolveConfigDir(dir: string | null): string | null {
    if (!dir) return null;
    const resolved = dir.startsWith('~runner/') ? path.join(this.opts.dataDir, dir.slice('~runner/'.length)) : dir.startsWith('~/') ? path.join(os.homedir(), dir.slice(2)) : dir;
    fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
    return resolved;
  }

  private async api<T = any>(method: string, p: string, body?: unknown): Promise<{ status: number; data: T }> {
    const res = await fetch(`${this.opts.serverUrl.replace(/\/$/, '')}${p}`, {
      method,
      headers: { authorization: `Bearer ${this.opts.token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (res.status >= 400) throw new Error(`${method} ${p} → ${res.status}: ${typeof data === 'object' ? data?.error : data}`);
    return { status: res.status, data };
  }

  async start() {
    log('info', `Runner starting (server ${this.opts.serverUrl}, data ${this.opts.dataDir})`);
    await this.heartbeat().catch((e) => log('warn', `Initial heartbeat failed: ${e.message}`));
    this.loops.push(this.heartbeatLoop());
    for (let i = 0; i < (this.opts.capacity ?? 2); i++) this.loops.push(this.claimLoop(i));
  }

  async stop() {
    this.stopped = true;
    for (const c of this.active.values()) c.abort();
    await Promise.race([Promise.allSettled(this.loops), sleep(8000)]);
  }

  private async heartbeatLoop() {
    while (!this.stopped) {
      await sleep((this.opts.heartbeatSec ?? 15) * 1000);
      if (this.stopped) break;
      await this.heartbeat().catch((e) => log('warn', `Heartbeat failed: ${e.message}`));
    }
  }

  private async heartbeat() {
    const authChecks: RunnerHeartbeat['accounts'] = [];
    for (const acc of this.accounts) {
      if (acc.provider !== 'claude-code') continue;
      authChecks.push({ id: acc.id, auth: await this.authStatus(acc) });
    }
    const hb: RunnerHeartbeat = { info: this.info(), accounts: authChecks, activeRunIds: [...this.active.keys()] };
    const { data } = await this.api('POST', '/api/runner/v1/heartbeat', hb);
    this.accounts = data.accounts ?? [];
    for (const id of data.cancel ?? []) this.active.get(id)?.abort();
    // New accounts get checked right away instead of waiting for the next heartbeat.
    if (this.accounts.some((a) => a.provider === 'claude-code' && !this.authCache.has(a.id))) setTimeout(() => this.heartbeat().catch(() => {}), 500);
  }

  private claudeVersion: string | null | undefined;
  private info() {
    if (this.claudeVersion === undefined) {
      try {
        this.claudeVersion = execFileSync(this.claudeBin, ['--version'], { timeout: 10_000, env: buildChildEnv({ configDir: null }) }).toString().trim();
      } catch {
        this.claudeVersion = null;
      }
    }
    const claudeVersion = this.claudeVersion;
    return { hostname: os.hostname(), platform: `${os.platform()} ${os.arch()}`, node: process.version, claudeVersion, dataDir: this.opts.dataDir, capacity: this.opts.capacity ?? 2, startedAt: this.startedAt };
  }
  private startedAt = nowIso();

  private async authStatus(acc: AccountInfo, force = false): Promise<AuthSnapshot> {
    const cached = this.authCache.get(acc.id);
    if (!force && cached && Date.now() - cached.at < (this.opts.authCheckSec ?? 300) * 1000) return cached.snap;
    const configDir = this.resolveConfigDir(acc.configDir);
    const env = buildChildEnv({ configDir, oauthToken: readLocalOauthToken(configDir) });
    const neutralCwd = path.join(this.opts.dataDir, 'runtime');
    fs.mkdirSync(neutralCwd, { recursive: true });
    const snap = await preflightAuth(this.claudeBin, env, neutralCwd);
    this.authCache.set(acc.id, { at: Date.now(), snap });
    return snap;
  }

  private async claimLoop(slot: number) {
    while (!this.stopped) {
      try {
        const res = await this.api<RunAssignment>('POST', '/api/runner/v1/claim', { capacity: 1, slot });
        if (res.status === 204 || !res.data) continue;
        await this.execute(res.data);
      } catch (e) {
        if (this.stopped) break;
        log('warn', `Claim loop ${slot}: ${(e as Error).message}`);
        await sleep(3000);
      }
    }
  }

  async execute(a: RunAssignment): Promise<void> {
    const ac = new AbortController();
    this.active.set(a.run.id, ac);
    let seq = 0;
    let buffer: RunnerEvent[] = [];
    let flushing: Promise<void> = Promise.resolve();
    const flush = () => {
      if (!buffer.length) return flushing;
      const batch = buffer;
      buffer = [];
      flushing = flushing
        .then(() => this.api('POST', `/api/runner/v1/runs/${a.run.id}/events`, { events: batch }))
        .then((r) => {
          if (r.data?.cancel) ac.abort();
        })
        .catch((e) => log('warn', `Event upload failed for ${a.run.id}: ${e.message}`));
      return flushing;
    };
    const timer = setInterval(flush, 700);
    const emit = (type: RunnerEvent['type'], data: Record<string, unknown>) => {
      buffer.push({ seq: ++seq, ts: nowIso(), type, data });
      if (buffer.length >= 50) flush();
    };

    let completion: RunCompletion;
    try {
      completion = a.run.kind === 'merge' ? await this.executeMerge(a, emit) : await this.executeAgent(a, emit, ac.signal);
    } catch (e) {
      const err = e as Error;
      completion = { status: 'failed', errorKind: e instanceof GitError ? 'git' : 'crash', errorDetail: err.message };
      emit('stderr', { line: String(err.stack ?? err.message).slice(0, 2000) });
    }
    clearInterval(timer);
    await flush();
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await this.api('POST', `/api/runner/v1/runs/${a.run.id}/complete`, completion);
        break;
      } catch (e) {
        log('warn', `Completing ${a.run.id} failed (attempt ${attempt + 1}): ${(e as Error).message}`);
        await sleep(1000 * 2 ** attempt);
      }
    }
    this.active.delete(a.run.id);
  }

  private async executeMerge(a: RunAssignment, emit: (t: RunnerEvent['type'], d: Record<string, unknown>) => void): Promise<RunCompletion> {
    emit('status', { phase: 'merging', branch: a.merge!.branch, base: a.project.baseBranch });
    const report = await this.workspaces.merge(a.project, a.merge!);
    emit('git', { ...report });
    return { status: report.mergeResult === 'merged' || report.mergeResult === 'noop' ? 'succeeded' : 'failed', errorKind: report.mergeResult === 'conflict' || report.mergeResult === 'failed' ? 'git' : undefined, errorDetail: report.mergeDetail, git: report };
  }

  private async executeAgent(a: RunAssignment, emit: (t: RunnerEvent['type'], d: Record<string, unknown>) => void, signal: AbortSignal): Promise<RunCompletion> {
    const agent = a.agent!;
    const account = a.account!;
    const driver = this.drivers[account.provider];
    if (!driver) return { status: 'failed', errorKind: 'config', errorDetail: `This runner has no driver for provider "${account.provider}"` };

    emit('status', { phase: 'preparing' });
    const repo = await this.workspaces.ensureRepo(a.project);
    const before = await this.workspaces.heads(repo);
    const { workspace, branch } = await this.workspaces.prepareAgent(a.project, agent, a.branch);
    emit('status', { phase: 'workspace', workspace, branch });

    const configDir = this.resolveConfigDir(account.configDir);
    const mcpHost = new URL(a.mcp.url).hostname;
    const env = buildChildEnv({
      configDir,
      oauthToken: account.provider === 'claude-code' ? readLocalOauthToken(configDir) : null,
      noProxyHosts: [mcpHost, 'localhost', '127.0.0.1'],
      extra: { ...agentIdentity(agent.name, agent.slug), AGENTOS_RUN_ID: a.run.id, AGENTOS_AGENT: agent.slug },
    });

    if (account.provider === 'claude-code') {
      // Billing guard layer 3: preflight with the run's exact environment.
      const auth = await this.authStatus({ id: account.id, name: '', provider: account.provider, configDir: account.configDir });
      if (!auth.ok) {
        const billing = auth.problem?.startsWith('billing');
        emit('warning', { message: auth.problem });
        this.authCache.delete(account.id);
        return { status: 'failed', errorKind: billing ? 'billing_guard' : 'auth', errorDetail: auth.problem };
      }
    }

    const completion = await driver.run({
      assignment: a,
      workspace,
      env,
      prompt: a.run.prompt,
      recovery: (a as any).recovery ?? '',
      emit,
      signal,
      timeoutSec: a.run.timeoutSec,
    });
    if (completion.errorKind === 'auth' || completion.errorKind === 'billing_guard') this.authCache.delete(account.id);
    const report = await this.workspaces.report(workspace, repo, before, agentIdentity(agent.name, agent.slug).GIT_AUTHOR_EMAIL);
    emit('git', { branch: report.branch, head: report.head, dirty: report.dirty, commits: report.commits?.length ?? 0 });
    return { ...completion, git: report };
  }
}
