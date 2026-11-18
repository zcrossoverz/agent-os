import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { seedDemo } from '../src/seed.js';
import { startTestServer, waitFor } from './helpers.js';
import type { StartedServer } from '../src/server.js';

/**
 * Full workflow with mock agents and a real runner, real git and the real MCP endpoint:
 * owner → PM plans → developers implement on task branches → reviewer approves → AgentOS merges.
 */
describe('end-to-end with mock agents', () => {
  let srv: StartedServer & { dataDir: string };

  beforeAll(async () => {
    srv = await startTestServer();
  });
  afterAll(async () => {
    await srv?.close();
  });

  it('plans, implements, reviews and merges work from one owner message', async () => {
    const { core } = srv;
    await waitFor(() => core.runners.find('rnr_local')?.status === 'online', 10000, 'runner online');
    const project = seedDemo(core);
    const pm = core.agents.pm(project.id)!;

    // The owner talks to the PM over HTTP like the dashboard does.
    const res = await fetch(`${srv.url}/api/projects/${project.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-agentos': '1' },
      body: JSON.stringify({ to: { type: 'agent', agentId: pm.id }, body: 'Please build:\n- Product catalog API\n- Shopping cart page' }),
    });
    expect(res.status).toBe(200);

    // PM creates two tasks and assigns them.
    const tasks = await waitFor(() => {
      const t = core.tasks.list(project.id);
      return t.length === 2 ? t : null;
    }, 20000, 'PM to create tasks');
    const linus = core.agents.resolve(project.id, 'linus')!;
    const grace = core.agents.resolve(project.id, 'grace')!;
    const rex = core.agents.resolve(project.id, 'rex')!;
    expect(tasks.map((t) => t.assignee_id).sort()).toEqual([linus.id, grace.id].sort());
    expect(tasks.every((t) => t.reviewer_id === rex.id)).toBe(true);

    // PM's final answer is posted back to the owner.
    const conv = core.messaging.directConversation(project.id, 'owner', pm.id);
    await waitFor(() => core.messaging.messages(conv.id).some((m) => m.sender_type === 'agent' && /Plan ready/.test(m.body)), 10000, 'PM reply');

    // Everything gets implemented, reviewed and merged.
    await waitFor(() => core.tasks.list(project.id).every((t) => t.status === 'done'), 45000, 'all tasks done');
    const done = core.tasks.list(project.id);
    expect(done.every((t) => t.merge_state === 'merged')).toBe(true);
    expect(done.every((t) => t.branch?.startsWith(`task/${t.key.toLowerCase()}-`))).toBe(true);

    // Commits are attributed to the right agents and tasks.
    const commits = core.runs.commits(project.id);
    for (const t of done) {
      const c = commits.find((c: any) => c.task_id === t.id && c.agent_id === t.assignee_id);
      expect(c, `commit for ${t.key}`).toBeTruthy();
    }

    // The base branch really contains the merged work.
    const repo = fs.readdirSync(path.join(srv.dataDir, 'runner', 'repos'))[0];
    const repoDir = path.join(srv.dataDir, 'runner', 'repos', repo);
    const log = execFileSync('git', ['log', '--oneline', 'main'], { cwd: repoDir }).toString();
    for (const t of done) expect(log).toContain(`Merge ${t.key}`);
    const files = execFileSync('git', ['ls-tree', '-r', '--name-only', 'main'], { cwd: repoDir }).toString();
    expect(files.split('\n').filter((f) => f.startsWith('work/')).length).toBe(2);

    // Runs succeeded; inboxes drained; the PM eventually reports completion to the owner.
    const runs = core.runs.list({ projectId: project.id });
    expect(runs.filter((r) => r.status === 'failed')).toEqual([]);
    expect(runs.filter((r) => r.kind === 'merge').length).toBe(2);
    await waitFor(() => core.messaging.messages(conv.id).some((m) => /All 2 task\(s\) are done/.test(m.body)), 20000, 'completion report');
    await waitFor(() => core.agents.list(project.id).every((a) => a.status === 'idle' && core.messaging.pendingInbox(a.id, true).length === 0), 15000, 'team idle');

    // Activity timeline tells the story.
    const types = new Set(core.listActivity(project.id, { limit: 500 }).map((a) => a.type));
    for (const t of ['task.created', 'task.assigned', 'task.submitted', 'task.review_approved', 'task.merged', 'run.succeeded']) expect(types.has(t), t).toBe(true);
  }, 90000);

  it('sends rejected reviews back to the developer and merges after the fix', async () => {
    const { core } = srv;
    const project = core.projects.list()[0];
    const linus = core.agents.resolve(project.id, 'linus')!;
    const rex = core.agents.resolve(project.id, 'rex')!;
    const t = core.tasks.create(project.id, { title: 'Checkout flow [strict]', assignee: linus.slug, reviewer: rex.slug }, 'owner');
    await waitFor(() => core.tasks.get(t.id).status === 'done', 45000, 'strict task done');
    const thread = core.messaging.messages(core.messaging.taskConversation(t.id).id).map((m) => m.body);
    expect(thread.some((b) => /Changes requested/.test(b))).toBe(true);
    expect(thread.filter((b) => /Submitted for review/.test(b)).length).toBe(2);
  }, 60000);
});
