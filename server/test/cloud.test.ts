import { afterEach, describe, expect, it } from 'vitest';
import { startServer, type StartedServer } from '../src/server.js';
import { FakeGitHub } from './fakes/fake-github.js';
import { FakeClaudeCloud, SimSession, teamBehaviour } from './fakes/fake-cloud.js';
import { tmpDir, waitFor } from './helpers.js';

/**
 * Cloud mode end to end: agents run as Claude Code on the web sessions (simulated) started through
 * each account's routine API trigger; the GitHub repository is the shared workspace (simulated
 * GitHub API over a real git repository); AgentOS merges reviewed branches through the GitHub API.
 */
interface World {
  srv: StartedServer;
  gh: FakeGitHub;
  cloud: FakeClaudeCloud;
  api: (method: string, path: string, body?: unknown) => Promise<any>;
  project: any;
  pm: any;
  accounts: Record<string, any>;
}

const worlds: World[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) {
    await w.srv.close();
    w.gh.stop();
    w.cloud.stop();
  }
});

async function world(opts: { idleTimeoutSec?: number } = {}): Promise<World> {
  const gh = new FakeGitHub('ghp_test_token');
  await gh.start();
  let srvUrl = '';
  const cloud = new FakeClaudeCloud(() => srvUrl, gh.bare, teamBehaviour);
  await cloud.start();
  const srv = await startServer({
    dataDir: tmpDir(),
    port: 0,
    host: '127.0.0.1',
    publicUrl: 'http://127.0.0.1:0',
    embeddedRunner: false,
    insecureNoAuth: true,
    schedulerIntervalMs: 150,
    webDir: '',
    githubApiUrl: gh.url,
    cloudIdleTimeoutSec: opts.idleTimeoutSec ?? 60,
  });
  srvUrl = srv.url;
  const api = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`${srv.url}${path}`, { method, headers: { 'x-agentos': '1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data: any = await r.json();
    if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(data)}`);
    return data;
  };
  // Two independent subscriptions, each with its own routine (as created on claude.ai/code/routines).
  const accounts: Record<string, any> = {};
  for (const [key, trig] of [
    ['A', 'trig_01AAAA'],
    ['B', 'trig_01BBBB'],
  ] as const) {
    const acc = await api('POST', '/api/accounts', { name: `Max ${key}`, provider: 'claude-cloud', fire_url: `${cloud.url}/v1/claude_code/routines/${trig}/fire`, fire_token: `sk-ant-oat01-${key}` });
    expect(acc.cloud_token).toMatch(/^aoc_/);
    expect(JSON.stringify(acc)).not.toContain(`sk-ant-oat01-${key}`);
    cloud.routines.set(trig, { token: `sk-ant-oat01-${key}`, networkSecret: acc.cloud_token });
    accounts[key] = acc;
  }
  const project = await api('POST', '/api/projects', { name: 'Cloud Shop', key: 'CLD', workspace_mode: 'github', repo_url: 'https://github.com/acme/shop', github_token: 'ghp_test_token', merge_policy: 'auto' });
  expect(project.has_github_token).toBe(true);
  expect(JSON.stringify(project)).not.toContain('ghp_test_token');
  const pm = await api('POST', `/api/projects/${project.id}/agents`, { name: 'Ada', role: 'Project Manager', is_pm: true, account_id: accounts.A.id });
  await api('POST', `/api/projects/${project.id}/agents`, { name: 'Linus', role: 'Backend Developer', account_id: accounts.A.id });
  await api('POST', `/api/projects/${project.id}/agents`, { name: 'Grace', role: 'Frontend Developer', account_id: accounts.B.id });
  await api('POST', `/api/projects/${project.id}/agents`, { name: 'Rex', role: 'Code Reviewer', account_id: accounts.B.id, tool_profile: 'readonly' });
  const w = { srv, gh, cloud, api, project, pm, accounts };
  worlds.push(w);
  return w;
}

describe('cloud mode (Claude Code on the web + GitHub)', () => {
  it('runs the whole team in cloud sessions and merges through GitHub', async () => {
    const { srv, gh, cloud, api, project, pm } = await world();
    const core = srv.core;

    // One-click repository setup commits the MCP config (no secrets) to the GitHub repo.
    const setup = await api('POST', `/api/projects/${project.id}/github/setup`);
    expect(setup.results.map((r: any) => r.status)).toEqual(['created', 'created']);
    expect(gh.show('main', '.mcp.json')).toContain('"X-AgentOS-Session": "${CLAUDE_CODE_REMOTE_SESSION_ID}"');
    expect(gh.show('main', '.claude/settings.json')).toContain('mcp__agentos');
    expect((await api('POST', `/api/projects/${project.id}/github/setup`)).results.map((r: any) => r.status)).toEqual(['unchanged', 'unchanged']);

    await api('POST', `/api/projects/${project.id}/messages`, { to: { type: 'agent', agentId: pm.id }, body: 'Please build:\n- Catalog API\n- Cart page\n- Order emails' });

    // Every task gets implemented in a cloud session, reviewed in another, and merged on GitHub.
    await waitFor(() => {
      const t = core.tasks.list(project.id);
      return t.length === 3 && t.every((x) => x.status === 'done') ? t : null;
    }, 45000, 'all cloud tasks done');
    expect(cloud.errors).toEqual([]);
    const tasks = core.tasks.list(project.id);
    expect(tasks.every((t) => t.merge_state === 'merged')).toBe(true);
    for (const t of tasks) expect(gh.show('main', `features/${t.key.toLowerCase()}.md`)).toContain(t.title);
    expect(gh.log('main')).toContain(`Merge ${tasks[0].key}`);

    // The routines were fired with the right credentials and only an identifier as payload.
    expect(cloud.fires.length).toBeGreaterThanOrEqual(7); // PM plan, 3 devs, ≥1 review, PM report
    for (const f of cloud.fires) {
      expect(f.version).toBe('2026-10-21');
      expect(f.text).toMatch(/AgentOS run code: run_[a-z0-9]+/);
    }
    expect(new Set(cloud.fires.map((f) => f.auth))).toEqual(new Set(['Bearer sk-ant-oat01-A', 'Bearer sk-ant-oat01-B']));

    // Runs link to their cloud sessions and carry a server-side log of AgentOS tool calls.
    const conv0 = core.messaging.directConversation(project.id, 'owner', pm.id);
    await waitFor(() => core.messaging.messages(conv0.id).some((m) => /All 3 task\(s\) are merged on GitHub/.test(m.body)), 15000, 'PM completion report');
    await waitFor(() => core.runs.list({ projectId: project.id, status: ['queued', 'running'] }).length === 0, 15000, 'all runs finished');
    const runs = core.runs.list({ projectId: project.id });
    const agentRuns = runs.filter((r) => r.kind === 'agent');
    expect(agentRuns.filter((r) => r.status !== 'succeeded').map((r) => `${core.agents.find(r.agent_id)?.name} ${r.status} ${r.error_kind} ${r.error_detail} :: ${core.runs.events(r.id).filter((e) => e.type === 'tool_result').map((e) => String(e.data.content).slice(0, 120)).join(' | ')}`)).toEqual([]);
    expect(agentRuns.every((r) => r.session_url?.startsWith('https://claude.ai/code/session_'))).toBe(true);
    const devRun = agentRuns.find((r) => core.runs.events(r.id).some((e) => e.data.name === 'mcp__agentos__submit_for_review'))!;
    const devEvents = core.runs.events(devRun.id);
    expect(devEvents.some((e) => e.type === 'tool_result' && e.data.isError && /no commits/.test(String(e.data.content)))).toBe(true); // push guard
    expect(runs.filter((r) => r.kind === 'merge' && r.status === 'succeeded')).toHaveLength(3);

    // Commits pushed from cloud sessions are attributed to the agent and task.
    for (const t of tasks) {
      expect(core.runs.commits(project.id).some((c: any) => c.task_id === t.id && c.agent_id === t.assignee_id && c.message.startsWith(t.key))).toBe(true);
    }

    // finish_run summaries reach the owner; the PM reports completion.
    const conv = core.messaging.directConversation(project.id, 'owner', pm.id);
    const bodies = core.messaging.messages(conv.id).map((m) => m.body);
    expect(bodies.some((b) => /Plan ready: CLD-1, CLD-2, CLD-3/.test(b))).toBe(true);
    await waitFor(() => core.messaging.messages(conv.id).some((m) => /All 3 task\(s\) are merged on GitHub/.test(m.body)), 15000, 'PM completion report');
  }, 90000);

  it('rejects unknown tokens, unbound sessions and other accounts\' run codes', async () => {
    const { srv, accounts } = await world();
    const bad = new SimSession(srv.url, 'aoc_not_a_real_token', 'cse_x', '', '');
    await expect(bad.call('get_project_overview')).rejects.toThrow();
    const unbound = new SimSession(srv.url, accounts.A.cloud_token, 'cse_01NOSUCHSESSION', '', '');
    const r = await unbound.call('get_project_overview');
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/No active AgentOS run/);
    // Run codes of another account cannot be claimed.
    const runB = srv.core.db.get<{ id: string }>("SELECT id FROM runs LIMIT 1");
    expect(runB).toBeUndefined();
    const claim = await unbound.call('start_run', { run_code: 'run_doesnotexist' });
    expect(claim.isError).toBe(true);
    await unbound.close();
  }, 30000);

  it('fails quiet sessions with a diagnosis and handles routine rate limits', async () => {
    const { srv, cloud, api, project, pm, accounts } = await world({ idleTimeoutSec: 1 });
    const core = srv.core;
    cloud.sessionsActive = false;
    await api('POST', `/api/projects/${project.id}/messages`, { to: { type: 'agent', agentId: pm.id }, body: 'Status?' });
    const failed = await waitFor(() => core.runs.list({ projectId: project.id, status: ['failed'] })[0], 15000, 'watchdog');
    expect(failed.error_kind).toBe('timeout');
    expect(failed.error_detail).toMatch(/never called AgentOS/);
    // The message goes back to the inbox for a retry.
    expect(core.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM inbox WHERE agent_id = ? AND status = 'pending'", pm.id)!.n).toBe(1);

    cloud.respondWith = { status: 429, headers: { 'retry-after': '1800' }, body: { type: 'error', error: { type: 'rate_limit_error', message: 'Hourly fire limit reached' } } };
    const limited = await waitFor(() => core.runs.list({ projectId: project.id, status: ['failed'] }).find((r) => r.error_kind === 'rate_limit'), 15000, 'rate-limited run');
    expect(limited.error_detail).toMatch(/fire limit/i);
    expect(core.accounts.get(accounts.A.id).status).toBe('rate_limited');
  }, 40000);
});
