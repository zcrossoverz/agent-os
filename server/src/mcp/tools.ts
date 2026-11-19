import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Core } from '../core/core.js';
import type { Agent, Project, Run, Task } from '../core/types.js';
import { evaluatePermission } from '../orchestrator/policy.js';
import { buildSystemPrompt } from '../orchestrator/prompts.js';
import type { MessageTarget } from '../services/messaging.js';
import { badRequest, truncate } from '../util/util.js';

export interface McpContext {
  core: Core;
  run: Run;
  agent: Agent;
  project: Project;
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

const ok = (data: unknown): ToolResult => ({ content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 1) }] });

const taskRef = z.string().describe('Task key like "ABC-12" (or its id)');

/** Build the per-request MCP server exposing AgentOS to one agent's run. */
/**
 * How a request reaches its run. Runner runs carry a per-run token, so the context is known up
 * front. Cloud runs (Claude Code on the web) authenticate with their account's AgentOS token
 * (injected by the cloud environment's network secret) and identify their session with the
 * X-AgentOS-Session header; their context is resolved per call, after start_run binds it.
 */
export interface McpAccess {
  mode: 'runner' | 'cloud';
  resolve(): McpContext;
  bind?(runCode: string): McpContext;
  onCall?(ctx: McpContext, tool: string, args: unknown, ok: boolean, text: string): void;
}

/** Build the per-request MCP server exposing AgentOS to one agent's run. */
export function buildMcpServer(core: Core, access: McpAccess): McpServer {
  // Each HTTP request gets its own server instance and handles one call at a time, so these are
  // simply "the current call's context", assigned before every tool handler runs.
  let run!: Run;
  let agent!: Agent;
  let project!: Project;
  let actor = '';
  const use = (c: McpContext) => {
    run = c.run;
    agent = c.agent;
    project = c.project;
    actor = `agent:${c.agent.id}`;
    return c;
  };
  const s = new McpServer({ name: 'agentos', version: '0.1.0' }, { instructions: 'AgentOS coordination tools: tasks, messages, reviews, approvals and shared docs for your team.' });

  const run$ = <A>(tool: string, fn: (args: A) => unknown, resolveCtx: (args: A) => McpContext = () => access.resolve()) => {
    return async (args: A): Promise<ToolResult> => {
      let c: McpContext | undefined;
      try {
        c = use(resolveCtx(args));
        const out = ok(await fn(args));
        access.onCall?.(c, tool, args, true, out.content[0].text);
        return out;
      } catch (e) {
        const text = `Error: ${e instanceof Error ? e.message : String(e)}`;
        if (c) access.onCall?.(c, tool, args, false, text);
        return { content: [{ type: 'text', text }], isError: true };
      }
    };
  };
  const reg = <A>(tool: string, config: any, fn: (args: A) => unknown): void => {
    s.registerTool(tool, config, run$(tool, fn) as any);
  };

  const summarizeTask = (t: Task) => ({
    key: t.key,
    title: t.title,
    status: t.status,
    priority: ['urgent', 'high', 'normal', 'low'][t.priority],
    kind: t.kind,
    assignee: t.assignee_id ? `@${core.agents.find(t.assignee_id)?.slug}` : null,
    reviewer: t.reviewer_id ? `@${core.agents.find(t.reviewer_id)?.slug}` : null,
    parent: t.parent_id ? core.tasks.find(t.parent_id)?.key : null,
    depends_on: (t.depends_on ?? []).map((id) => core.tasks.find(id)?.key).filter(Boolean),
    branch: t.branch,
    merge_state: t.merge_state,
    blocked_reason: t.blocked_reason,
  });

  const resolveTarget = (to: string): MessageTarget => {
    const v = to.trim();
    if (/^owner$/i.test(v)) return { type: 'owner' };
    if (/^(team|all|everyone)$/i.test(v)) return { type: 'team' };
    if (/^@?pm$/i.test(v)) {
      const pm = core.agents.pm(project.id);
      if (!pm) throw badRequest('This project has no PM');
      if (pm.id === agent.id) throw badRequest('You are the PM');
      return { type: 'agent', agentId: pm.id };
    }
    if (new RegExp(`^${project.key}-\\d+$`, 'i').test(v)) return { type: 'task', taskId: core.tasks.resolve(project.id, v).id };
    const a = core.agents.resolve(project.id, v);
    if (!a) throw badRequest(`Unknown recipient "${to}". Use "owner", "team", "pm", "@handle" or a task key.`);
    if (a.id === agent.id) throw badRequest('You cannot message yourself');
    return { type: 'agent', agentId: a.id };
  };

  reg(
    'get_project_overview',
    { description: 'Project summary: team roster with status, your assignments, board counts, pending approvals, and project settings. Call this first when you need orientation.', inputSchema: {} },
    (() => {
      const tasks = core.tasks.list(project.id);
      const counts: Record<string, number> = {};
      for (const t of tasks) counts[t.status] = (counts[t.status] ?? 0) + 1;
      return {
        project: { name: project.name, key: project.key, description: project.description, base_branch: project.base_branch, coordination_mode: project.coordination_mode, autonomy: project.autonomy, merge_policy: project.merge_policy },
        you: { name: agent.name, handle: `@${agent.slug}`, role: agent.role, is_pm: agent.is_pm },
        team: core.agents
          .list(project.id)
          .filter((a) => a.enabled)
          .map((a) => ({ name: a.name, handle: `@${a.slug}`, role: a.role, pm: a.is_pm, status: a.status, working_on: a.status_detail })),
        board: counts,
        your_tasks: tasks.filter((t) => t.assignee_id === agent.id && !['done', 'cancelled'].includes(t.status)).map(summarizeTask),
        reviews_for_you: tasks.filter((t) => t.status === 'in_review' && t.merge_state == null && core.tasks.reviewerFor(t)?.id === agent.id).map((t) => t.key),
        pending_approvals: core.approvals.list({ projectId: project.id, status: 'pending' }).map((a) => ({ number: a.number, kind: a.kind, title: a.title })),
        docs: core.knowledge.listDocs(project.id).map((d) => d.slug),
      };
    }),
  );

  reg(
    'list_tasks',
    {
      description: 'List tasks on the board. Filter by status and/or assignee ("@handle" or "me"). Closed tasks are excluded unless include_closed is true.',
      inputSchema: {
        status: z.array(z.enum(['backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled'])).optional(),
        assignee: z.string().optional(),
        include_closed: z.boolean().optional(),
      },
    },
    ((a: { status?: any[]; assignee?: string; include_closed?: boolean }) => {
      let assigneeId: string | undefined;
      if (a.assignee) assigneeId = a.assignee === 'me' ? agent.id : core.agents.resolve(project.id, a.assignee)?.id ?? '__none__';
      return core.tasks.list(project.id, { status: a.status, assigneeId, includeClosed: a.include_closed ?? false }).map(summarizeTask);
    }),
  );

  reg(
    'get_task',
    { description: 'Full details of one task: description, acceptance criteria, dependencies, subtasks, branch, recent thread messages and commits.', inputSchema: { task: taskRef } },
    ((a: { task: string }) => {
      const t = core.tasks.resolve(project.id, a.task);
      const conv = core.messaging.taskConversation(t.id);
      return {
        ...summarizeTask(t),
        description: t.description,
        acceptance_criteria: t.acceptance_criteria,
        subtasks: core.tasks.list(project.id, { parentId: t.id }).map((c) => `${c.key} [${c.status}] ${c.title}`),
        thread: core.messaging.messages(conv.id, { limit: 20 }).map((m) => ({ from: m.sender_type === 'agent' ? `@${core.agents.find(m.sender_id)?.slug}` : m.sender_type, at: m.created_at, body: truncate(m.body, 2000) })),
        commits: core.db.all('SELECT sha, branch, message FROM commits WHERE task_id = ? ORDER BY created_at DESC LIMIT 20', t.id),
      };
    }),
  );

  reg(
    'create_task',
    {
      description:
        'Create a task (or epic/subtask). Give a clear title, a description, and testable acceptance criteria. Optionally assign it, set a reviewer, a parent and dependencies. In PM-led projects only the PM assigns; other agents create backlog proposals or subtasks of their own task.',
      inputSchema: {
        title: z.string(),
        description: z.string().optional(),
        acceptance_criteria: z.string().optional(),
        kind: z.enum(['epic', 'task', 'subtask']).optional(),
        parent: z.string().optional().describe('Parent task key'),
        priority: z.number().int().min(0).max(3).optional().describe('0 urgent, 1 high, 2 normal (default), 3 low'),
        assignee: z.string().optional().describe('@handle of the agent who should do it'),
        reviewer: z.string().optional().describe('@handle of the reviewer'),
        depends_on: z.array(z.string()).optional().describe('Task keys that must be done first'),
        status: z.enum(['backlog', 'todo']).optional(),
      },
    },
    ((a: any) => summarizeTask(core.tasks.create(project.id, a, actor))),
  );

  reg(
    'update_task',
    {
      description: 'Edit a task: title, description, acceptance criteria, priority, parent, dependencies, or status (PM/owner can set any status; assignees use the lifecycle tools).',
      inputSchema: {
        task: taskRef,
        title: z.string().optional(),
        description: z.string().optional(),
        acceptance_criteria: z.string().optional(),
        priority: z.number().int().min(0).max(3).optional(),
        parent: z.string().nullable().optional(),
        depends_on: z.array(z.string()).optional(),
        status: z.enum(['backlog', 'todo', 'in_progress', 'blocked', 'done', 'cancelled']).optional(),
      },
    },
    ((a: any) => {
      const t = core.tasks.resolve(project.id, a.task);
      const { task: _t, ...patch } = a;
      return summarizeTask(core.tasks.update(t.id, patch, actor));
    }),
  );

  reg(
    'assign_task',
    { description: 'Assign a task to an agent (and optionally a reviewer). The assignee is notified and woken when the task is actionable.', inputSchema: { task: taskRef, assignee: z.string().describe('@handle'), reviewer: z.string().optional() } },
    ((a: { task: string; assignee: string; reviewer?: string }) => summarizeTask(core.tasks.assign(core.tasks.resolve(project.id, a.task).id, a.assignee, a.reviewer, actor))),
  );

  reg(
    'start_task',
    { description: 'Mark your task in progress. Returns the git branch to work on.', inputSchema: { task: taskRef } },
    ((a: { task: string }) => {
      const t = core.tasks.start(core.tasks.resolve(project.id, a.task).id, actor);
      const instructions =
        project.workspace_mode === 'github'
          ? `Work on branch ${t.branch}: git fetch origin && (git checkout -B ${t.branch} origin/${t.branch} 2>/dev/null || git checkout -b ${t.branch} origin/${project.base_branch}). Commit with the task key, then git push -u origin ${t.branch} before submit_for_review.`
          : `Work on branch ${t.branch}. If your worktree is not on it yet: git checkout ${t.branch} 2>/dev/null || git checkout -b ${t.branch} ${project.base_branch}`;
      return { ...summarizeTask(t), instructions };
    }),
  );

  reg(
    'submit_for_review',
    { description: 'Submit your finished, committed task for review. Summarize what changed, how you tested it, and anything the reviewer should look at.', inputSchema: { task: taskRef, summary: z.string() } },
    (async (a: { task: string; summary: string }) => {
      const task = core.tasks.resolve(project.id, a.task);
      let commits: Awaited<ReturnType<typeof core.github.branchCommits>> = null;
      if (project.workspace_mode === 'github' && core.github.token(project.id)) {
        // Cloud sessions are ephemeral: only work pushed to GitHub survives. Check before review.
        const branch = task.branch ?? core.tasks.branchName(task);
        commits = await core.github.branchCommits(project, branch);
        if (!commits?.length) throw badRequest(`GitHub shows no commits on ${branch} ahead of ${project.base_branch}. Commit your work and run: git push -u origin ${branch}. Then call submit_for_review again.`);
      }
      const t = core.tasks.submitForReview(task.id, a.summary, actor);
      if (commits?.length) core.runs.recordCommits(run, commits, agent.id);
      const reviewer = core.tasks.reviewerFor(t);
      return { ...summarizeTask(t), next: reviewer ? `Review requested from @${reviewer.slug}.` : t.merge_state ? `Merge: ${t.merge_state}.` : 'Waiting for the owner.' };
    }),
  );

  reg(
    'review_task',
    { description: 'Give your review verdict on a task in review. "approve" lets AgentOS merge it; "request_changes" sends it back to the assignee with your comments.', inputSchema: { task: taskRef, verdict: z.enum(['approve', 'request_changes']), comments: z.string() } },
    ((a: { task: string; verdict: 'approve' | 'request_changes'; comments: string }) => summarizeTask(core.tasks.review(core.tasks.resolve(project.id, a.task).id, a.verdict, a.comments, actor))),
  );

  reg(
    'block_task',
    { description: 'Mark your task blocked with a precise reason (what you need, from whom). The PM is notified.', inputSchema: { task: taskRef, reason: z.string() } },
    ((a: { task: string; reason: string }) => summarizeTask(core.tasks.block(core.tasks.resolve(project.id, a.task).id, a.reason, actor))),
  );

  reg(
    'checkpoint',
    { description: 'Save progress notes on your task. With continue=true, AgentOS wakes you again to keep working (use this when stopping before the task is finished).', inputSchema: { task: taskRef, notes: z.string(), continue: z.boolean() } },
    ((a: { task: string; notes: string; continue: boolean }) => summarizeTask(core.tasks.checkpoint(core.tasks.resolve(project.id, a.task).id, a.notes, a.continue, actor))),
  );

  reg(
    'comment_on_task',
    { description: "Post a comment in a task's thread (visible to the assignee, reviewer, PM and owner).", inputSchema: { task: taskRef, body: z.string() } },
    ((a: { task: string; body: string }) => {
      const m = core.tasks.comment(core.tasks.resolve(project.id, a.task).id, a.body, actor);
      return { posted: m.id };
    }),
  );

  reg(
    'send_message',
    {
      description:
        'Send a message through AgentOS. to: "owner" (the human), "pm", "@handle" (a teammate), "team" (everyone; does not wake them unless @mentioned), or a task key (that task\'s thread). Set expects_reply=false for FYIs. Mention @handles to pull someone in.',
      inputSchema: { to: z.string(), body: z.string(), expects_reply: z.boolean().optional() },
    },
    ((a: { to: string; body: string; expects_reply?: boolean }) => {
      const m = core.messaging.send({ projectId: project.id, from: { agentId: agent.id }, to: resolveTarget(a.to), body: a.body, expectsReply: a.expects_reply ?? true, runId: run.id });
      return { delivered: true, message_id: m.id, note: a.expects_reply === false ? 'Delivered as FYI.' : 'Delivered. You will be woken when they reply; do not wait.' };
    }),
  );

  reg(
    'read_messages',
    { description: 'Read recent messages of a conversation: with="owner", "@handle", "team", or a task key.', inputSchema: { with: z.string(), limit: z.number().int().min(1).max(100).optional() } },
    ((a: { with: string; limit?: number }) => {
      const t = resolveTarget(a.with);
      const conv =
        t.type === 'team'
          ? core.messaging.teamConversation(project.id)
          : t.type === 'task'
            ? core.messaging.taskConversation(t.taskId)
            : core.messaging.directConversation(project.id, agent.id, t.type === 'owner' ? 'owner' : (t as any).agentId);
      return core.messaging.messages(conv.id, { limit: a.limit ?? 20 }).map((m) => ({
        from: m.sender_type === 'agent' ? (m.sender_id === agent.id ? 'you' : `@${core.agents.find(m.sender_id)?.slug}`) : m.sender_type,
        at: m.created_at,
        body: truncate(m.body, 4000),
      }));
    }),
  );

  reg(
    'request_approval',
    {
      description:
        "Ask the project owner to approve a decision before you act: architecture, security, destructive or production-impacting changes, or (PM in supervised mode) a plan. Explain the options, your recommendation and its consequences. You'll be woken with the decision; don't wait for it.",
      inputSchema: {
        kind: z.enum(['decision', 'architecture', 'security', 'destructive', 'production', 'plan', 'other']),
        title: z.string(),
        description: z.string(),
        task: z.string().optional(),
        task_keys: z.array(z.string()).optional().describe('For kind="plan": the backlog tasks to release when approved'),
      },
    },
    ((a: { kind: any; title: string; description: string; task?: string; task_keys?: string[] }) => {
      const task = a.task ? core.tasks.resolve(project.id, a.task) : undefined;
      const ap = core.approvals.request(
        { projectId: project.id, agentId: agent.id, runId: run.id, taskId: task?.id ?? null, kind: a.kind, title: a.title, description: a.description, payload: a.task_keys ? { task_ids: a.task_keys } : {} },
        actor,
      );
      return { approval: ap.number, status: ap.status, note: 'Requested. Continue other work or end your turn; you will be woken with the decision.' };
    }),
  );

  reg(
    'record_decision',
    { description: 'Record a technical decision in the project decision log (for decisions within your authority; use request_approval for ones that need the owner).', inputSchema: { title: z.string(), context: z.string(), decision: z.string(), task: z.string().optional() } },
    ((a: { title: string; context: string; decision: string; task?: string }) => {
      const d = core.knowledge.recordDecision(project.id, { title: a.title, context: a.context, decision: a.decision, taskId: a.task ? core.tasks.resolve(project.id, a.task).id : null }, actor);
      return { recorded: d.id };
    }),
  );

  reg('list_docs', { description: 'List shared project docs (brief, plan, design notes, ...).', inputSchema: {} }, (() => core.knowledge.listDocs(project.id)));

  reg(
    'read_doc',
    { description: 'Read a shared project doc by slug.', inputSchema: { slug: z.string() } },
    ((a: { slug: string }) => {
      const d = core.knowledge.getDoc(project.id, a.slug);
      return `# ${d.title} (v${d.version}, updated by ${core.actorLabel(d.updated_by)} at ${d.updated_at})\n\n${d.body}`;
    }),
  );

  reg(
    'write_doc',
    { description: 'Create or replace a shared project doc (markdown). Use it for the brief, the plan, design notes and anything teammates should know. Writes the whole document.', inputSchema: { slug: z.string(), title: z.string(), body: z.string() } },
    ((a: { slug: string; title: string; body: string }) => {
      const d = core.knowledge.upsertDoc(project.id, a.slug, a.title, a.body, actor);
      return { saved: d.slug, version: d.version };
    }),
  );

  if (access.mode === 'runner') {
    // Not for direct use by the agent: Claude Code calls this through --permission-prompt-tool.
    s.registerTool(
      'permission_gate',
      { description: 'Internal: AgentOS permission check for tool calls (invoked automatically by the runtime).', inputSchema: { tool_name: z.string(), input: z.record(z.string(), z.any()), tool_use_id: z.string().optional() } },
      async (a: { tool_name: string; input: Record<string, unknown> }) => {
        const c = use(access.resolve());
        const decision = evaluatePermission(core, core.runs.get(c.run.id), c.agent, a.tool_name, a.input ?? {});
        return { content: [{ type: 'text', text: JSON.stringify(decision) }] };
      },
    );
  }

  if (access.mode === 'cloud') {
    s.registerTool(
      'start_run',
      {
        description:
          'Call this first in every cloud session, with the AgentOS run code from your routine payload (run_…). It returns who you are on the team, your standing instructions, the project context and your assignment for this session.',
        inputSchema: { run_code: z.string().describe('The AgentOS run code, e.g. run_abc123def456') },
      },
      run$(
        'start_run',
        () => {
          core.runs.recordEvent(run.id, 'status', { phase: 'session_bound', session: run.provider_session_id });
          core.activity(project.id, actor, 'run.cloud_started', `${agent.name} checked in from a cloud session`, { type: 'run', id: run.id });
          return [
            `# AgentOS briefing · run ${run.id}`,
            buildSystemPrompt(core, agent, project),
            '---',
            String(run.payload?.recovery ?? ''),
            '---',
            run.prompt,
          ].join('\n\n');
        },
        (a: { run_code: string }) => access.bind!(a.run_code),
      ) as any,
    );

    s.registerTool(
      'finish_run',
      {
        description:
          'Call this when you have finished this session\'s assignment (or cannot continue). The summary is logged; if the owner messaged you, it is posted to them as your reply. After calling it, stop.',
        inputSchema: { summary: z.string().describe('What you did, what is pending, and anything the owner or team should know') },
      },
      run$('finish_run', (a: { summary: string }) => {
        core.runs.complete(run.id, { status: 'succeeded', resultText: a.summary, sessionId: run.provider_session_id ?? undefined });
        return 'Run finished and recorded. Stop now; AgentOS will start a new session when there is more to do.';
      }) as any,
    );
  }

  return s;
}
