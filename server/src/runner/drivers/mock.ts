import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { RunCompletion } from '../../core/types.js';
import { git } from '../git.js';
import type { AgentDriver, DriverContext } from './types.js';
import { slugify } from '../../util/util.js';

/**
 * A deterministic stand-in for an LLM agent. It talks to AgentOS through the same MCP endpoint
 * and permission gate as a real agent and makes real git commits, so the whole orchestration
 * pipeline (planning → assignment → implementation → review → merge) can be exercised in tests
 * and demos without spending subscription usage.
 *
 *   PM:        turns an owner request into tasks (one per line/bullet), assigns them round-robin,
 *              reviews when no reviewer exists, and reports when everything is done.
 *   developer: starts assigned tasks, writes a file on the task branch, commits, submits.
 *   reviewer:  approves submitted work (requests changes once if the task title contains "[strict]").
 */
export class MockDriver implements AgentDriver {
  readonly provider = 'mock';

  async run(ctx: DriverContext): Promise<RunCompletion> {
    const a = ctx.assignment;
    const transport = new StreamableHTTPClientTransport(new URL(a.mcp.url), { requestInit: { headers: { Authorization: `Bearer ${a.mcp.token}` } } });
    const client = new Client({ name: 'agentos-mock-agent', version: '0.1.0' });
    const started = Date.now();
    let turns = 0;
    const call = async (name: string, args: Record<string, unknown> = {}): Promise<any> => {
      turns++;
      ctx.emit('tool_use', { name: `mcp__agentos__${name}`, input: JSON.stringify(args).slice(0, 2000) });
      const res: any = await client.callTool({ name, arguments: args });
      const text = (res.content ?? []).map((c: any) => c.text ?? '').join('\n');
      ctx.emit('tool_result', { name, isError: !!res.isError, content: text.slice(0, 2000) });
      if (res.isError) throw new Error(text);
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    };
    const gate = async (tool_name: string, input: Record<string, unknown>) => JSON.parse((await client.callTool({ name: 'permission_gate', arguments: { tool_name, input } }) as any).content[0].text);

    try {
      await client.connect(transport);
      ctx.emit('init', { sessionId: `mock-${a.agent!.slug}`, model: 'mock', apiKeySource: 'none', mcp: 'connected' });
      const summary = a.agent!.isPm ? await this.pm(ctx, call) : a.agent!.toolProfile === 'readonly' || /review/i.test(a.agent!.role) ? await this.reviewer(ctx, call) : await this.developer(ctx, call, gate);
      ctx.emit('assistant_text', { text: summary });
      return { status: 'succeeded', resultText: summary, sessionId: `mock-${a.agent!.slug}-${a.run.sessionKey ?? 'main'}`, usage: { numTurns: turns, durationMs: Date.now() - started, model: 'mock' } };
    } catch (e) {
      return { status: 'failed', errorKind: 'crash', errorDetail: String((e as Error)?.message ?? e), usage: { numTurns: turns, durationMs: Date.now() - started, model: 'mock' } };
    } finally {
      await client.close().catch(() => {});
    }
  }

  private async pm(ctx: DriverContext, call: (n: string, a?: any) => Promise<any>): Promise<string> {
    const notes: string[] = [];
    const overview = await call('get_project_overview');
    const team = (overview.team as any[]).filter((m) => !m.pm);
    const devs = team.filter((m) => !/review/i.test(m.role));
    const reviewer = team.find((m) => /review/i.test(m.role));

    // Reviews that fall to the PM.
    for (const key of overview.reviews_for_you as string[]) {
      await call('review_task', { task: key, verdict: 'approve', comments: 'Reviewed by the PM: scope matches the acceptance criteria.' });
      notes.push(`approved ${key}`);
    }

    // New owner request → plan.
    const ownerRequest = extractOwnerMessage(ctx.prompt);
    if (ownerRequest) {
      const items = ownerRequest
        .split('\n')
        .map((l) => l.replace(/^\s*([-*•]|\d+[.)])\s*/, '').trim())
        .filter((l) => l.length > 3 && !/^(please|thanks)/i.test(l));
      const titles = items.length > 1 ? items.slice(0, 8) : [`Implement: ${ownerRequest.slice(0, 80)}`];
      const created: string[] = [];
      for (const [i, title] of titles.entries()) {
        const dev = devs.length ? devs[i % devs.length] : undefined;
        const t = await call('create_task', {
          title,
          description: `Requested by the owner: "${ownerRequest.slice(0, 500)}"`,
          acceptance_criteria: `- ${title} is implemented on the task branch\n- Changes are committed with the task key in the message`,
          assignee: dev?.handle,
          reviewer: reviewer?.handle,
          priority: 2,
        });
        created.push(`${t.key} → ${dev?.handle ?? 'unassigned'}`);
      }
      await call('write_doc', { slug: 'plan', title: 'Plan', body: `# Plan\n\nObjective: ${ownerRequest}\n\n${created.map((c) => `- ${c}`).join('\n')}\n` });
      return `Plan ready. I created ${created.length} task(s): ${created.join(', ')}. I'll report back when they're done.`;
    }

    // Progress check: report when all work is done.
    const open = (await call('list_tasks', {})) as any[];
    const all = (await call('list_tasks', { include_closed: true })) as any[];
    if (all.length && open.length === 0 && /is done/.test(ctx.prompt)) {
      await call('send_message', { to: 'owner', body: `All ${all.length} task(s) are done and merged: ${all.map((t) => t.key).join(', ')}.`, expects_reply: false });
      notes.push('reported completion to owner');
    }
    const messages = extractAgentQuestions(ctx.prompt);
    for (const m of messages) {
      await call('send_message', { to: m.from, body: `PM here: proceed with your best judgement within the task's acceptance criteria; escalate with request_approval if it's architectural.`, expects_reply: false });
      notes.push(`answered ${m.from}`);
    }
    return notes.length ? `Done: ${notes.join('; ')}.` : 'Checked the board; nothing needed my attention.';
  }

  private async developer(ctx: DriverContext, call: (n: string, a?: any) => Promise<any>, gate: (t: string, i: any) => Promise<any>): Promise<string> {
    const a = ctx.assignment;
    const agent = a.agent!;
    const overview = await call('get_project_overview');
    const notes: string[] = [];
    for (const key of overview.reviews_for_you as string[]) {
      await call('review_task', { task: key, verdict: 'approve', comments: `Looks good to me (${agent.name}).` });
      notes.push(`reviewed ${key}`);
    }
    const tasks = (overview.your_tasks as any[]).filter((t) => ['todo', 'in_progress'].includes(t.status));
    const focus = a.branch ? tasks.find((t) => t.branch === a.branch) ?? tasks.find((t) => a.branch!.startsWith(`task/${t.key.toLowerCase()}-`)) : tasks[0];
    if (!focus) {
      for (const q of extractAgentQuestions(ctx.prompt)) await call('send_message', { to: q.from, body: `Noted, thanks.`, expects_reply: false });
      return notes.length ? `Done: ${notes.join('; ')}.` : 'No actionable task for me right now.';
    }
    const started = await call('start_task', { task: focus.key });
    const branch: string = started.branch;
    const cur = (await git(ctx.workspace, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
    if (cur !== branch) {
      const has = (await git(ctx.workspace, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { allowFail: true })).code === 0;
      await git(ctx.workspace, has ? ['checkout', branch] : ['checkout', '-b', branch, a.project.baseBranch]);
    }
    // Ask the permission gate like Claude Code would before running a command.
    const decision = await gate('Bash', { command: 'git add -A && git commit' });
    if (decision.behavior !== 'allow') throw new Error(`gate denied: ${decision.message}`);
    const dir = path.join(ctx.workspace, 'work');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${focus.key.toLowerCase()}-${slugify(focus.title, 30)}.md`);
    const revision = fs.existsSync(file) ? (fs.readFileSync(file, 'utf8').match(/Revision (\d+)/)?.[1] ?? '1') : '0';
    fs.writeFileSync(file, `# ${focus.key}: ${focus.title}\n\nImplemented by ${agent.name} (mock agent).\n\nRevision ${Number(revision) + 1}\n`);
    await git(ctx.workspace, ['add', '-A'], { env: ctx.env });
    await git(ctx.workspace, ['commit', '-m', `${focus.key}: ${focus.title}`], { env: ctx.env });
    await call('submit_for_review', { task: focus.key, summary: `Implemented ${focus.title}. Added ${path.relative(ctx.workspace, file)}. (Mock agent: no tests to run.)` });
    notes.push(`implemented and submitted ${focus.key}`);
    return `Done: ${notes.join('; ')}.`;
  }

  private async reviewer(ctx: DriverContext, call: (n: string, a?: any) => Promise<any>): Promise<string> {
    const overview = await call('get_project_overview');
    const done: string[] = [];
    for (const key of overview.reviews_for_you as string[]) {
      const t = await call('get_task', { task: key });
      const alreadyAsked = (t.thread as any[]).some((m) => /Changes requested/.test(m.body));
      if (/\[strict\]/i.test(t.title) && !alreadyAsked) {
        await call('review_task', { task: key, verdict: 'request_changes', comments: 'Please add a second revision (strict review).' });
        done.push(`requested changes on ${key}`);
      } else {
        await call('review_task', { task: key, verdict: 'approve', comments: `Diff reviewed on ${t.branch}; acceptance criteria met.` });
        done.push(`approved ${key}`);
      }
    }
    return done.length ? `Reviews: ${done.join('; ')}.` : 'No reviews waiting.';
  }
}

function extractOwnerMessage(prompt: string): string | null {
  const m = prompt.match(/\*\*Message from the Owner\*\*[^\n]*\n((?:\s*> ?.*\n?)+)/);
  if (!m) return null;
  return m[1]
    .split('\n')
    .map((l) => l.replace(/^\s*> ?/, ''))
    .join('\n')
    .trim();
}

function extractAgentQuestions(prompt: string): { from: string }[] {
  const out: { from: string }[] = [];
  for (const m of prompt.matchAll(/\*\*Message from [^*]+\*\* \(direct conversation, expects a reply; reply with send_message to="(@[a-z0-9-]+)"\)/g)) out.push({ from: m[1] });
  return out;
}
