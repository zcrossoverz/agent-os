import { describe, expect, it, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ClaudeCodeDriver, classifyResult } from '../src/runner/drivers/claude-code.js';
import { buildChildEnv, evaluateAuthStatus, initEventIsSafe, preflightAuth } from '../src/runner/billing-guard.js';
import type { RunAssignment, RunnerEvent } from '../src/core/types.js';
import { tmpDir } from './helpers.js';

const FAKE = path.resolve(__dirname, 'fixtures/fake-claude.mjs');

function assignment(over: Partial<RunAssignment['run']> = {}): RunAssignment {
  return {
    run: { id: 'run_test', kind: 'agent', prompt: 'WAKE PROMPT', sessionKey: 'main', resumeSessionId: null, maxTurns: 10, timeoutSec: 30, ...over },
    project: { id: 'prj_x', key: 'TST', slug: 'test', repoUrl: null, baseBranch: 'main', pushOnMerge: false },
    agent: { id: 'agt_x', name: 'Tess', slug: 'tess', role: 'Tester', isPm: false, model: 'sonnet', effort: null, toolProfile: 'standard', systemPrompt: 'SYSTEM PROMPT' },
    account: { id: 'acc_x', provider: 'claude-code', configDir: '/tmp/cfg' },
    mcp: { url: 'http://127.0.0.1:9/mcp', token: 'aot_SECRET_RUN_TOKEN' },
  };
}

async function runFake(scenario: string, over: Partial<RunAssignment['run']> = {}, extraEnv: Record<string, string> = {}) {
  const events: RunnerEvent[] = [];
  const runtimeDir = tmpDir('agentos-rt-');
  const driver = new ClaudeCodeDriver({ claudeBin: FAKE, runtimeDir });
  const env = buildChildEnv({ configDir: '/tmp/cfg', extra: { FAKE_CLAUDE_SCENARIO: scenario, ...extraEnv } });
  const ac = new AbortController();
  const started = Date.now();
  const res = await driver.run({
    assignment: assignment(over),
    workspace: tmpDir('agentos-ws-'),
    env,
    prompt: 'WAKE PROMPT',
    recovery: 'RECOVERY CONTEXT',
    emit: (type, data) => events.push({ seq: events.length + 1, ts: '', type, data }),
    signal: ac.signal,
    timeoutSec: over.timeoutSec ?? 30,
  });
  return { res, events, ms: Date.now() - started, runtimeDir };
}

beforeAll(() => fs.chmodSync(FAKE, 0o755));

describe('billing guard', () => {
  it('builds the child env from an allow-list and strips API credentials', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-should-not-leak';
    process.env.CLAUDE_CODE_USE_BEDROCK = '1';
    try {
      const env = buildChildEnv({ configDir: '/x/cfg', extra: { ANTHROPIC_AUTH_TOKEN: 'nope', GIT_AUTHOR_NAME: 'A' } });
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
      expect(env.CLAUDE_CONFIG_DIR).toBe('/x/cfg');
      expect(env.GIT_AUTHOR_NAME).toBe('A');
      expect(env.PATH).toBe(process.env.PATH);
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.CLAUDE_CODE_USE_BEDROCK;
    }
  });

  it('classifies auth status output', () => {
    expect(evaluateAuthStatus({ loggedIn: true, authMethod: 'oauth_token', apiProvider: 'firstParty' }).ok).toBe(true);
    expect(evaluateAuthStatus({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' }).ok).toBe(true);
    expect(evaluateAuthStatus({ loggedIn: true, authMethod: 'api_key', apiKeySource: 'ANTHROPIC_API_KEY' }).problem).toMatch(/^billing/);
    expect(evaluateAuthStatus({ loggedIn: true, authMethod: 'api_key_helper', apiKeySource: 'apiKeyHelper' }).problem).toMatch(/^billing/);
    expect(evaluateAuthStatus({ loggedIn: true, authMethod: 'oauth_token', apiProvider: 'bedrock' }).problem).toMatch(/^billing/);
    expect(evaluateAuthStatus({ loggedIn: false }).problem).toMatch(/Not signed in/);
    expect(initEventIsSafe({ apiKeySource: 'none' }).ok).toBe(true);
    expect(initEventIsSafe({ apiKeySource: 'ANTHROPIC_API_KEY' }).ok).toBe(false);
  });

  it('preflights with `claude auth status --json`', async () => {
    const env = buildChildEnv({ configDir: '/tmp/cfg' });
    expect((await preflightAuth(FAKE, env, process.cwd())).ok).toBe(true);
    expect((await preflightAuth(FAKE, { ...env, FAKE_CLAUDE_AUTH: 'loggedout' }, process.cwd())).ok).toBe(false);
    expect((await preflightAuth(FAKE, { ...env, FAKE_CLAUDE_AUTH: 'apikey' }, process.cwd())).problem).toMatch(/^billing/);
    expect((await preflightAuth('/nonexistent/claude', env, process.cwd())).problem).toMatch(/not found/);
  });
});

describe('Claude Code driver', () => {
  it('parses a real stream-json transcript', async () => {
    const { res, events } = await runFake('ok');
    expect(res.status).toBe('succeeded');
    expect(res.sessionId).toBe(JSON.parse(fs.readFileSync(path.resolve(__dirname, 'fixtures/claude-stream-mcp.jsonl'), 'utf8').split('\n')[0]).session_id);
    const init = events.find((e) => e.type === 'init')!;
    expect(init.data).toMatchObject({ apiKeySource: 'none', mcp: 'connected' });
    expect(events.some((e) => e.type === 'tool_use' && e.data.name === 'mcp__agentos__send_message')).toBe(true);
    expect(events.some((e) => e.type === 'tool_result' && e.data.isError === true)).toBe(true);
    expect(events.some((e) => e.type === 'rate_limit')).toBe(true);
    expect(res.usage?.apiEquivalentUsd).toBeGreaterThan(0);
  });

  it('passes the safety flags, sends the prompt on stdin and keeps the run token out of argv', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-leak-test';
    let out;
    try {
      out = await runFake('echo');
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
    const info = JSON.parse(out.res.resultText!);
    expect(info.args).toEqual(expect.arrayContaining(['-p', '--setting-sources', 'user', '--strict-mcp-config', '--permission-prompt-tool', 'mcp__agentos__permission_gate', '--append-system-prompt', 'SYSTEM PROMPT', '--model', 'sonnet']));
    expect(info.args).not.toContain('--bare');
    expect(info.args.join(' ')).not.toContain('aot_SECRET_RUN_TOKEN');
    expect(info.mcp.mcpServers.agentos.headers.Authorization).toBe('Bearer aot_SECRET_RUN_TOKEN');
    expect(fs.existsSync(info.mcpPath)).toBe(false); // temp config removed after the run
    expect(info.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(info.env.CLAUDE_CONFIG_DIR).toBe('/tmp/cfg');
    expect(info.stdin).toBe('RECOVERY CONTEXT\n\n---\n\nWAKE PROMPT'); // fresh session gets recovered context
  });

  it('resumes sessions without the recovery preamble', async () => {
    const { res } = await runFake('echo', { resumeSessionId: 'sess-123' });
    const info = JSON.parse(res.resultText!);
    expect(info.args).toEqual(expect.arrayContaining(['--resume', 'sess-123']));
    expect(info.stdin).toBe('WAKE PROMPT');
  });

  it('kills an API-billed session immediately (runtime tripwire)', async () => {
    const marker = path.join(tmpDir(), 'marker');
    const { res, ms } = await runFake('apikey', {}, { FAKE_CLAUDE_MARKER: marker });
    expect(res.status).toBe('failed');
    expect(res.errorKind).toBe('billing_guard');
    expect(ms).toBeLessThan(3500);
    await new Promise((r) => setTimeout(r, 500));
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('classifies usage limits, auth failures and turn limits', async () => {
    const rl = await runFake('ratelimit');
    expect(rl.res.errorKind).toBe('rate_limit');
    expect(rl.res.rateLimit).toMatchObject({ status: 'rejected', resetsAt: 1900000000, limited: true });
    expect((await runFake('auth')).res.errorKind).toBe('auth');
    expect((await runFake('maxturns')).res.errorKind).toBe('max_turns');
  });

  it('falls back to a fresh session when the previous one is gone', async () => {
    const { res, events } = await runFake('session_missing', { resumeSessionId: 'lost-session' });
    expect(res.status).toBe('succeeded');
    expect(res.resultText).toMatch(/^fresh:RECOVERY CONTEXT/);
    expect(events.some((e) => e.type === 'warning')).toBe(true);
  });

  it('enforces the run timeout', async () => {
    const { res, ms } = await runFake('hang', { timeoutSec: 1 });
    expect(res.errorKind).toBe('timeout');
    expect(ms).toBeLessThan(8000);
  });

  it('classifyResult handles missing results', () => {
    expect(classifyResult(null, 'segfault', null).errorKind).toBe('crash');
    expect(classifyResult({ subtype: 'success', is_error: false }, '', null).status).toBe('succeeded');
  });
});
