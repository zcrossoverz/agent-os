import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { startTestServer, waitFor } from './helpers.js';
import type { StartedServer } from '../src/server.js';

/**
 * Live smoke test with the real Claude Code CLI on a subscription login. It consumes a small
 * amount of real usage, so it only runs when AGENTOS_REAL_CLAUDE=1.
 *   AGENTOS_REAL_CLAUDE=1 AGENTOS_SMOKE_MODEL=haiku npx vitest run test/real-claude.smoke.test.ts
 */
const enabled = process.env.AGENTOS_REAL_CLAUDE === '1';
const model = process.env.AGENTOS_SMOKE_MODEL || 'haiku';

describe.skipIf(!enabled)('real Claude Code agents', () => {
  let srv: StartedServer & { dataDir: string };
  afterAll(async () => {
    await srv?.close();
  });

  it('PM delegates, a Claude developer implements and commits, review and merge complete', async () => {
    srv = await startTestServer();
    const { core } = srv;
    await waitFor(() => core.runners.find('rnr_local')?.status === 'online', 15000, 'runner online');
    const claudeAcc = core.accounts.create({ name: 'Claude (subscription)', provider: 'claude-code', config_dir: process.env.AGENTOS_SMOKE_CONFIG_DIR ?? '~runner/accounts/smoke/claude' });
    const mockAcc = core.accounts.create({ name: 'Mock reviewer', provider: 'mock' });
    await waitFor(() => core.accounts.get(claudeAcc.id).status === 'ready', 60000, 'Claude account ready (auth preflight)');
    expect(core.accounts.get(claudeAcc.id).auth.ok).toBe(true);

    const project = core.projects.create({ name: 'Smoke', key: 'SMK', description: 'Tiny smoke-test project.' });
    const pm = core.agents.create(project.id, { name: 'Pia', slug: 'pia', role: 'Project Manager', is_pm: true, account_id: claudeAcc.id, model, max_turns: 25 });
    core.agents.create(project.id, { name: 'Dan', slug: 'dan', role: 'Developer', account_id: claudeAcc.id, model, max_turns: 30 });
    core.agents.create(project.id, { name: 'Rex', slug: 'rex', role: 'Code Reviewer', account_id: mockAcc.id, tool_profile: 'readonly' });

    core.messaging.send({
      projectId: project.id,
      from: 'owner',
      to: { type: 'agent', agentId: pm.id },
      body: 'Create exactly one task titled "Add hello.txt" with acceptance criterion "hello.txt at the repo root contains the single line: hello agentos". Assign it to @dan with @rex as reviewer. Do not create any other tasks. Then reply to me with the task key.',
    });

    const task = await waitFor(() => core.tasks.list(project.id)[0], 240000, 'PM to create the task');
    expect(task.assignee_id).toBe(core.agents.resolve(project.id, 'dan')!.id);
    await waitFor(() => core.tasks.get(task.id).status === 'done', 480000, 'task to be implemented, reviewed and merged');

    const repo = fs.readdirSync(path.join(srv.dataDir, 'runner', 'repos'))[0];
    const repoDir = path.join(srv.dataDir, 'runner', 'repos', repo);
    const content = execFileSync('git', ['show', 'main:hello.txt'], { cwd: repoDir }).toString();
    expect(content.trim()).toBe('hello agentos');

    await waitFor(() => core.runs.list({ projectId: project.id, status: ['queued', 'running'] }).length === 0, 240000, 'all runs to finish');
    const runs = core.runs.list({ projectId: project.id });
    expect(runs.filter((r) => r.status !== 'succeeded').map((r) => `${r.id} ${r.status} ${r.error_kind} ${r.error_detail}`)).toEqual([]);
    expect(core.listActivity(project.id, { limit: 500 }).filter((a) => a.type === 'run.followup_failed')).toEqual([]);
    const claudeRuns = runs.filter((r) => r.account_id === claudeAcc.id);
    expect(claudeRuns.length).toBeGreaterThanOrEqual(2);
    for (const r of claudeRuns) {
      const init = core.runs.events(r.id).find((e) => e.type === 'init');
      expect(init?.data.apiKeySource, `run ${r.id} billing`).toBe('none');
      expect(init?.data.mcp, `run ${r.id} mcp`).toBe('connected');
    }
    const conv = core.messaging.directConversation(project.id, 'owner', pm.id);
    expect(core.messaging.messages(conv.id).some((m) => m.sender_type === 'agent' && m.body.includes(task.key))).toBe(true);

    // Print a compact transcript for the record.
    for (const r of runs) {
      const agent = core.agents.find(r.agent_id)?.name ?? 'merge';
      console.log(`--- ${agent} ${r.kind} ${r.status} ${r.error_kind ?? ''} turns=${r.usage.numTurns ?? '-'} api-equivalent=$${r.usage.apiEquivalentUsd?.toFixed(3) ?? '-'} (not billed)`);
      for (const e of core.runs.events(r.id)) if (e.type === 'tool_use') console.log(`   ${e.data.name} ${String(e.data.input).slice(0, 140)}`);
      if (r.result_text) console.log(`   => ${r.result_text.slice(0, 300)}`);
    }
  }, 900000);
});
