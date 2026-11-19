import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z, ZodError } from 'zod';
import type { Change, Core } from '../core/core.js';
import { TASK_STATUSES, type Run, type RunCompletion, type RunnerEvent, type RunnerHeartbeat } from '../core/types.js';
import { buildMcpServer, type McpAccess, type McpContext } from '../mcp/tools.js';
import { OwnerAuth, SESSION_COOKIE, SESSION_MAX_AGE, parseCookies } from './auth.js';
import { HttpError, badRequest, forbidden, log, sleep, truncate } from '../util/util.js';
import { ROLE_PRESETS } from '../services/agents.js';
import { APPROVAL_KINDS } from '../services/approvals.js';
import { ROUTINE_PROMPT, cloudRepoFiles, isPubliclyReachable, publicHost } from '../orchestrator/cloud.js';

export const VERSION = '0.1.0';

function parse<T>(schema: z.ZodType<T>, data: unknown): T {
  return schema.parse(data ?? {});
}

const bearer = (req: FastifyRequest) => {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7).trim() : undefined;
};

export async function buildApp(core: Core, auth: OwnerAuth): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 5 * 1024 * 1024, trustProxy: true });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message, code: err.code });
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '), code: 'validation' });
    }
    const status = (err as any).statusCode;
    if (status && status < 500) return reply.status(status).send({ error: (err as Error).message, code: 'bad_request' });
    log('error', `HTTP ${req.method} ${req.url} failed`, { error: String((err as Error)?.stack ?? err) });
    return reply.status(500).send({ error: 'Internal error', code: 'internal' });
  });

  // ---------------------------------------------------------------- dashboard auth

  const isOwner = (req: FastifyRequest) => core.config.insecureNoAuth || auth.verifySession(parseCookies(req.headers.cookie)[SESSION_COOKIE]);

  app.addHook('onRequest', async (req, reply) => {
    const url = req.url.split('?')[0];
    if (!url.startsWith('/api/')) return;
    if (url.startsWith('/api/auth/') || url.startsWith('/api/runner/') || url === '/api/health') return;
    if (!isOwner(req)) return reply.status(401).send({ error: 'Sign in required', code: 'unauthorized' });
    // CSRF: browsers cannot send this custom header cross-site without CORS preflight (which we never allow).
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-agentos'] !== '1') {
      return reply.status(403).send({ error: 'Missing X-AgentOS header', code: 'csrf' });
    }
  });

  app.get('/api/health', async () => ({ ok: true, version: VERSION }));

  app.get('/api/auth/me', async (req) => ({ authenticated: isOwner(req), version: VERSION, noAuth: core.config.insecureNoAuth }));

  const loginAttempts = new Map<string, { n: number; until: number }>();
  app.post('/api/auth/login', async (req, reply) => {
    const ip = req.ip;
    const att = loginAttempts.get(ip);
    if (att && att.until > Date.now()) return reply.status(429).send({ error: 'Too many attempts; try again later', code: 'rate_limited' });
    const { password } = parse(z.object({ password: z.string().min(1) }), req.body);
    if (!auth.verifyPassword(password)) {
      const n = (att?.n ?? 0) + 1;
      loginAttempts.set(ip, { n, until: n >= 5 ? Date.now() + 60_000 : 0 });
      await sleep(400);
      return reply.status(401).send({ error: 'Wrong password', code: 'unauthorized' });
    }
    loginAttempts.delete(ip);
    const secure = req.protocol === 'https';
    reply.header('set-cookie', `${SESSION_COOKIE}=${encodeURIComponent(auth.issueSession())}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MAX_AGE}${secure ? '; Secure' : ''}`);
    return { ok: true };
  });

  app.post('/api/auth/logout', async (_req, reply) => {
    reply.header('set-cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    return { ok: true };
  });

  // ---------------------------------------------------------------- live updates (SSE)

  app.get('/api/stream', (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write(': connected\n\n');
    let queue: Change[] = [];
    let flushTimer: NodeJS.Timeout | null = null;
    const flush = () => {
      flushTimer = null;
      if (!queue.length) return;
      const batch = queue;
      queue = [];
      res.write(`data: ${JSON.stringify(batch)}\n\n`);
    };
    const onChange = (c: Change) => {
      queue.push({ topic: c.topic, projectId: c.projectId, id: c.id });
      if (!flushTimer) flushTimer = setTimeout(flush, 150);
    };
    core.bus.on('change', onChange);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.raw.on('close', () => {
      core.bus.off('change', onChange);
      clearInterval(ping);
      if (flushTimer) clearTimeout(flushTimer);
    });
  });

  // ---------------------------------------------------------------- overview & meta

  app.get('/api/meta', async () => ({
    version: VERSION,
    publicUrl: core.config.publicUrl,
    rolePresets: ROLE_PRESETS,
    approvalKinds: APPROVAL_KINDS,
    taskStatuses: TASK_STATUSES,
  }));

  app.get('/api/overview', async () => {
    const projects = core.projects.list().map((p) => ({
      ...p,
      stats: core.projects.stats(p.id),
      agents: core.agents.list(p.id).map((a) => ({ id: a.id, name: a.name, slug: a.slug, role: a.role, is_pm: a.is_pm, status: a.status, status_detail: a.status_detail, enabled: a.enabled })),
    }));
    const blocked = core.db.all("SELECT * FROM tasks WHERE status = 'blocked' ORDER BY updated_at DESC LIMIT 50");
    const errors = core.agents.list().filter((a) => a.status === 'error' || (a.status === 'waiting' && a.status_detail));
    return {
      projects,
      attention: {
        approvals: core.approvals.list({ status: 'pending' }),
        unanswered: core.messaging.unansweredForOwner(),
        blocked,
        agents: errors,
        accounts: core.accounts.list().filter((a) => !['ready', 'unknown'].includes(a.status) || (a.provider !== 'mock' && a.status === 'unknown')),
        runners: core.runners.list().filter((r) => r.status !== 'online'),
      },
      recentActivity: core.listActivity(null, { limit: 30 }),
    };
  });

  // ---------------------------------------------------------------- runners & accounts

  app.get('/api/runners', async () => core.runners.list());
  app.post('/api/runners', async (req) => {
    const { name } = parse(z.object({ name: z.string().min(1).max(60) }), req.body);
    return core.runners.create(name);
  });
  app.post('/api/runners/:id/rotate-token', async (req) => ({ token: core.runners.rotateToken((req.params as any).id) }));
  app.delete('/api/runners/:id', async (req) => {
    core.runners.remove((req.params as any).id);
    return { ok: true };
  });

  app.get('/api/accounts', async () => core.accounts.list());
  const accountSchema = z.object({
    name: z.string().min(1).max(80),
    provider: z.enum(['claude-code', 'claude-cloud', 'mock']),
    runner_id: z.string().nullable().optional(),
    config_dir: z.string().max(500).nullable().optional(),
    max_concurrent_runs: z.number().int().min(1).max(8).optional(),
    fire_url: z.string().max(500).nullable().optional(),
    fire_token: z.string().max(500).nullable().optional(),
  });
  app.post('/api/accounts', async (req) => core.accounts.create(parse(accountSchema, req.body)));
  app.patch('/api/accounts/:id', async (req) => core.accounts.update((req.params as any).id, parse(accountSchema.partial().omit({ provider: true }), req.body) as any));
  app.delete('/api/accounts/:id', async (req) => {
    core.accounts.remove((req.params as any).id);
    return { ok: true };
  });
  app.post('/api/accounts/:id/rotate-cloud-token', async (req) => ({ token: core.accounts.rotateCloudToken((req.params as any).id) }));

  // Everything the owner needs to connect Claude Code on the web to AgentOS (no secrets).
  app.get('/api/cloud/setup', async () => ({
    publicUrl: core.config.publicUrl,
    host: publicHost(core.config.publicUrl),
    reachable: isPubliclyReachable(core.config.publicUrl),
    routinePrompt: ROUTINE_PROMPT,
    files: cloudRepoFiles(core.config.publicUrl),
  }));

  app.post('/api/accounts/:id/reset-status', async (req) => {
    const acc = core.accounts.get((req.params as any).id);
    core.accounts.setStatus(acc.id, acc.provider === 'mock' ? 'ready' : 'unknown', 'Reset by owner');
    return core.accounts.get(acc.id);
  });

  // ---------------------------------------------------------------- projects

  const projectSchema = z.object({
    name: z.string().min(1).max(100),
    key: z.string().max(10).optional(),
    description: z.string().max(20000).optional(),
    repo_url: z.string().max(1000).nullable().optional(),
    base_branch: z.string().max(100).optional(),
    runner_id: z.string().nullable().optional(),
    coordination_mode: z.enum(['pm_led', 'collaborative']).optional(),
    autonomy: z.enum(['paused', 'supervised', 'autonomous']).optional(),
    merge_policy: z.enum(['auto', 'owner_approval']).optional(),
    push_on_merge: z.boolean().optional(),
    workspace_mode: z.enum(['runner', 'github']).optional(),
    github_token: z.string().max(500).nullable().optional(),
    limits: z
      .object({
        maxAgentStreak: z.number().int().min(2).max(100),
        maxRunsPerAgentHour: z.number().int().min(1).max(120),
        maxAutoContinues: z.number().int().min(0).max(50),
        maxConcurrentRuns: z.number().int().min(1).max(32),
        requireReview: z.boolean(),
      })
      .partial()
      .optional(),
  });

  app.get('/api/projects', async () => core.projects.list().map((p) => ({ ...p, stats: core.projects.stats(p.id) })));
  app.post('/api/projects', async (req) => core.projects.create(parse(projectSchema, req.body)));
  app.get('/api/projects/:id', async (req) => {
    const p = core.projects.get((req.params as any).id);
    return { ...p, stats: core.projects.stats(p.id) };
  });
  app.patch('/api/projects/:id', async (req) => {
    const body = parse(projectSchema.partial().extend({ pm_agent_id: z.string().nullable().optional(), archived: z.boolean().optional() }), req.body);
    return core.projects.update((req.params as any).id, body);
  });

  app.post('/api/projects/:id/github/check', async (req) => core.github.checkAccess(core.projects.get((req.params as any).id)));
  app.post('/api/projects/:id/github/setup', async (req) => {
    const p = core.projects.get((req.params as any).id);
    const results = await core.github.ensureFiles(p, cloudRepoFiles(core.config.publicUrl), 'Connect cloud agents to AgentOS (MCP config)');
    core.activity(p.id, 'owner', 'project.github_setup', `AgentOS repository setup: ${results.map((r) => `${r.path} ${r.status}`).join(', ')}`, { type: 'project', id: p.id });
    return { results, files: cloudRepoFiles(core.config.publicUrl) };
  });

  // ---------------------------------------------------------------- agents

  const agentSchema = z.object({
    name: z.string().min(1).max(60),
    role: z.string().min(1).max(80),
    slug: z.string().max(24).optional(),
    is_pm: z.boolean().optional(),
    account_id: z.string().nullable().optional(),
    model: z.string().max(80).nullable().optional(),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).nullable().optional(),
    instructions: z.string().max(20000).optional(),
    tool_profile: z.enum(['standard', 'readonly']).optional(),
    max_turns: z.number().int().min(1).max(500).optional(),
  });

  app.get('/api/projects/:id/agents', async (req) => {
    const p = core.projects.get((req.params as any).id);
    const inbox = core.messaging.inboxCounts(p.id);
    return core.agents.list(p.id).map((a) => ({ ...a, inbox: inbox[a.id] ?? { pending: 0, wake: 0 }, active_run: core.runs.activeRunFor(a.id)?.id ?? null }));
  });
  app.post('/api/projects/:id/agents', async (req) => core.agents.create(core.projects.get((req.params as any).id).id, parse(agentSchema, req.body)));
  app.get('/api/agents/:id', async (req) => {
    const a = core.agents.get((req.params as any).id);
    return { ...a, sessions: core.agents.sessions(a.id), inbox: core.messaging.pendingInbox(a.id), runs: core.runs.list({ agentId: a.id, limit: 20 }) };
  });
  app.patch('/api/agents/:id', async (req) => core.agents.update((req.params as any).id, parse(agentSchema.partial().extend({ enabled: z.boolean().optional() }), req.body)));
  app.post('/api/agents/:id/reset-session', async (req) => {
    core.agents.resetSessions((req.params as any).id);
    return { ok: true };
  });
  app.post('/api/agents/:id/resume', async (req) => {
    const a = core.agents.get((req.params as any).id);
    core.agents.setStatus(a.id, 'idle', null);
    core.bus.kick();
    return core.agents.get(a.id);
  });
  app.post('/api/agents/:id/wake', async (req) => {
    const a = core.agents.get((req.params as any).id);
    const { note } = parse(z.object({ note: z.string().max(2000).optional() }), req.body);
    core.messaging.enqueue(a.project_id, a.id, 'nudge', { refId: `nudge:${Date.now()}`, summary: note?.trim() ? `Owner check-in: ${note.trim()}` : 'Owner asked you to check in: review your assignments and the board, make progress, and report anything noteworthy.', wake: true });
    core.activity(a.project_id, 'owner', 'agent.nudged', `Owner nudged ${a.name}`, { type: 'agent', id: a.id });
    return { ok: true };
  });

  // ---------------------------------------------------------------- tasks

  const taskSchema = z.object({
    title: z.string().min(1).max(300),
    description: z.string().max(50000).optional(),
    acceptance_criteria: z.string().max(20000).optional(),
    kind: z.enum(['epic', 'task', 'subtask']).optional(),
    parent: z.string().nullable().optional(),
    priority: z.number().int().min(0).max(3).optional(),
    status: z.enum(['backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled']).optional(),
    assignee: z.string().nullable().optional(),
    reviewer: z.string().nullable().optional(),
    depends_on: z.array(z.string()).optional(),
    blocked_reason: z.string().max(2000).nullable().optional(),
    sort_order: z.number().optional(),
  });

  app.get('/api/projects/:id/tasks', async (req) => core.tasks.list(core.projects.get((req.params as any).id).id));
  app.post('/api/projects/:id/tasks', async (req) => core.tasks.create(core.projects.get((req.params as any).id).id, parse(taskSchema, req.body) as any, 'owner'));
  app.get('/api/tasks/:id', async (req) => {
    const t = core.tasks.get((req.params as any).id);
    const conv = core.messaging.taskConversation(t.id);
    return {
      ...t,
      conversation_id: conv.id,
      subtasks: core.tasks.list(t.project_id, { parentId: t.id }),
      dependents: core.tasks.dependents(t.id).map((d) => ({ id: d.id, key: d.key, title: d.title, status: d.status })),
      commits: core.db.all('SELECT * FROM commits WHERE task_id = ? ORDER BY created_at DESC LIMIT 50', t.id),
      runs: core.db.all("SELECT id, kind, agent_id, status, trigger, error_kind, queued_at, finished_at FROM runs WHERE focus_task_id = ? ORDER BY queued_at DESC LIMIT 30", t.id),
      approvals: core.approvals.list({ projectId: t.project_id }).filter((a) => a.task_id === t.id),
      activity: core.listActivity(t.project_id, { subjectId: t.id, limit: 50 }),
    };
  });
  app.patch('/api/tasks/:id', async (req) => {
    const body = parse(taskSchema.partial(), req.body);
    const id = (req.params as any).id;
    if (body.status === 'in_review') throw badRequest('Move a task to review by submitting it (agents) or use the review buttons');
    return core.tasks.update(id, body as any, 'owner');
  });
  app.post('/api/tasks/:id/comments', async (req) => {
    const { body } = parse(z.object({ body: z.string().min(1).max(20000) }), req.body);
    return core.tasks.comment((req.params as any).id, body, 'owner');
  });
  app.post('/api/tasks/:id/review', async (req) => {
    const { verdict, comments } = parse(z.object({ verdict: z.enum(['approve', 'request_changes']), comments: z.string().max(20000).default('') }), req.body);
    return core.tasks.review((req.params as any).id, verdict, comments, 'owner');
  });
  app.post('/api/tasks/:id/merge', async (req) => {
    const t = core.tasks.get((req.params as any).id);
    if (!t.branch) throw badRequest('Task has no branch to merge');
    core.tasks.requestMerge(t, 'owner');
    return core.tasks.get(t.id);
  });

  // ---------------------------------------------------------------- conversations & messages

  app.get('/api/projects/:id/conversations', async (req) => core.messaging.listConversations(core.projects.get((req.params as any).id).id));
  app.get('/api/conversations/:id/messages', async (req) => {
    const q = req.query as any;
    return core.messaging.messages((req.params as any).id, { limit: q.limit ? Number(q.limit) : 200, before: q.before });
  });
  app.post('/api/projects/:id/messages', async (req) => {
    const p = core.projects.get((req.params as any).id);
    const body = parse(
      z.object({
        to: z.union([z.object({ type: z.literal('agent'), agentId: z.string() }), z.object({ type: z.literal('team') }), z.object({ type: z.literal('task'), taskId: z.string() }), z.object({ type: z.literal('conversation'), conversationId: z.string() })]),
        body: z.string().min(1).max(20000),
      }),
      req.body,
    );
    if (body.to.type === 'conversation') {
      const c = core.messaging.getConversation(body.to.conversationId);
      if (c.kind === 'direct' && !core.messaging.participants(c).includes('owner')) throw forbidden('You can read agent-to-agent conversations, but post in the team channel, a task thread, or a direct conversation with an agent.');
    }
    return core.messaging.send({ projectId: p.id, from: 'owner', to: body.to as any, body: body.body, expectsReply: true });
  });
  app.post('/api/projects/:id/direct/:agentId', async (req) => {
    const p = core.projects.get((req.params as any).id);
    return core.messaging.directConversation(p.id, 'owner', core.agents.get((req.params as any).agentId).id);
  });

  // ---------------------------------------------------------------- approvals, decisions, docs

  app.get('/api/approvals', async (req) => {
    const q = req.query as any;
    return core.approvals.list({ projectId: q.project, status: q.status });
  });
  app.post('/api/approvals/:id/decide', async (req) => {
    const { decision, note } = parse(z.object({ decision: z.enum(['approved', 'rejected']), note: z.string().max(5000).nullable().optional() }), req.body);
    return core.approvals.decide((req.params as any).id, decision, note ?? null, 'owner');
  });

  app.get('/api/projects/:id/decisions', async (req) => core.knowledge.listDecisions(core.projects.get((req.params as any).id).id));
  app.post('/api/projects/:id/decisions', async (req) => {
    const p = core.projects.get((req.params as any).id);
    const d = parse(z.object({ title: z.string().min(1).max(300), context: z.string().max(20000).default(''), decision: z.string().min(1).max(20000) }), req.body);
    return core.knowledge.recordDecision(p.id, d, 'owner');
  });

  app.get('/api/projects/:id/docs', async (req) => core.knowledge.listDocs(core.projects.get((req.params as any).id).id));
  app.get('/api/projects/:id/docs/:slug', async (req) => core.knowledge.getDoc(core.projects.get((req.params as any).id).id, (req.params as any).slug));
  app.put('/api/projects/:id/docs/:slug', async (req) => {
    const p = core.projects.get((req.params as any).id);
    const { title, body } = parse(z.object({ title: z.string().min(1).max(200), body: z.string().max(200000) }), req.body);
    return core.knowledge.upsertDoc(p.id, (req.params as any).slug, title, body, 'owner');
  });
  app.delete('/api/projects/:id/docs/:slug', async (req) => {
    const p = core.projects.get((req.params as any).id);
    core.knowledge.deleteDoc(p.id, (req.params as any).slug, 'owner');
    return { ok: true };
  });

  // ---------------------------------------------------------------- runs, activity, git

  app.get('/api/projects/:id/runs', async (req) => {
    const q = req.query as any;
    return core.runs.list({ projectId: core.projects.get((req.params as any).id).id, agentId: q.agent, limit: q.limit ? Number(q.limit) : 100 });
  });
  app.get('/api/runs/:id', async (req) => {
    const r = core.runs.get((req.params as any).id);
    return { ...r, inbox: core.messaging.inboxForRun(r.id) };
  });
  app.get('/api/runs/:id/events', async (req) => core.runs.events((req.params as any).id, Number((req.query as any).after ?? 0)));
  app.post('/api/runs/:id/cancel', async (req) => core.runs.cancel((req.params as any).id, 'owner'));

  app.get('/api/projects/:id/activity', async (req) => {
    const q = req.query as any;
    return core.listActivity(core.projects.get((req.params as any).id).id, { limit: q.limit ? Number(q.limit) : 100, before: q.before ? Number(q.before) : undefined });
  });
  app.get('/api/activity', async (req) => core.listActivity(null, { limit: Number((req.query as any).limit ?? 100) }));

  app.get('/api/projects/:id/git', async (req) => {
    const p = core.projects.get((req.params as any).id);
    const tasks = core.tasks.list(p.id).filter((t) => t.branch);
    return {
      base_branch: p.base_branch,
      repo_url: p.repo_url,
      branches: tasks.map((t) => ({ branch: t.branch, task: { id: t.id, key: t.key, title: t.title, status: t.status, merge_state: t.merge_state }, assignee_id: t.assignee_id })),
      commits: core.runs.commits(p.id),
      merges: core.runs.list({ projectId: p.id, limit: 50 }).filter((r) => r.kind === 'merge'),
    };
  });

  // ---------------------------------------------------------------- runner protocol

  const runnerAuth = (req: FastifyRequest) => {
    const r = core.runners.authenticate(bearer(req));
    if (!r) throw new HttpError(401, 'Invalid runner token', 'unauthorized');
    return r;
  };

  app.post('/api/runner/v1/heartbeat', async (req) => {
    const runner = runnerAuth(req);
    const hb = req.body as RunnerHeartbeat;
    core.runners.heartbeat(runner, hb);
    const accounts = core.accounts
      .list()
      .filter((a) => a.runner_id === runner.id)
      .map((a) => ({ id: a.id, name: a.name, provider: a.provider, configDir: a.config_dir }));
    const cancel = (hb.activeRunIds ?? []).filter((id) => core.runs.isCancelRequested(id));
    return { runnerId: runner.id, accounts, cancel };
  });

  // Long-poll for work: returns a run assignment or 204 after ~20s.
  app.post('/api/runner/v1/claim', async (req, reply) => {
    const runner = runnerAuth(req);
    core.runners.touch(runner.id);
    const maxParallel = Number((req.body as any)?.capacity ?? 1);
    if (maxParallel <= 0) return reply.status(204).send();
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const a = core.runs.claim(runner);
      if (a) return a;
      await new Promise<void>((resolve) => {
        const t = setTimeout(done, 1000);
        function done() {
          clearTimeout(t);
          core.bus.off('change', onChange);
          resolve();
        }
        const onChange = (c: Change) => c.topic === 'runs' && done();
        core.bus.on('change', onChange);
      });
      if (req.raw.destroyed) return;
    }
    return reply.status(204).send();
  });

  app.post('/api/runner/v1/runs/:id/events', async (req) => {
    const runner = runnerAuth(req);
    const { events } = req.body as { events: RunnerEvent[] };
    return core.runs.appendEvents((req.params as any).id, runner.id, Array.isArray(events) ? events.slice(0, 1000) : []);
  });

  app.post('/api/runner/v1/runs/:id/complete', async (req) => {
    const runner = runnerAuth(req);
    const r = core.runs.complete((req.params as any).id, req.body as RunCompletion, runner.id);
    return { ok: true, status: r.status };
  });

  // ---------------------------------------------------------------- MCP endpoint for agents

  const mcpHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    const token = bearer(req);
    const ctxFor = (r: Run): McpContext => ({ core, run: r, agent: core.agents.get(r.agent_id!), project: core.projects.get(r.project_id) });
    let access: McpAccess;
    const runnerRun = core.runs.verifyToken(token);
    if (runnerRun) {
      if (runnerRun.kind !== 'agent' || !runnerRun.agent_id) return reply.status(401).send({ error: 'Invalid run token' });
      const fixed = ctxFor(runnerRun);
      access = { mode: 'runner', resolve: () => fixed };
    } else {
      // Claude Code on the web: the account's AgentOS token arrives through the cloud environment's
      // network secret; the session identifies itself with X-AgentOS-Session.
      const account = core.accounts.byCloudToken(token);
      if (!account) return reply.status(401).send({ error: 'Invalid or expired AgentOS token' });
      const session = typeof req.headers['x-agentos-session'] === 'string' ? (req.headers['x-agentos-session'] as string) : undefined;
      access = {
        mode: 'cloud',
        resolve: () => {
          const r = core.runs.findCloudRun(account.id, session);
          if (!r) throw new HttpError(400, 'No active AgentOS run for this session. Call start_run with the run code from your routine payload first. If you have none, or start_run fails, stop: there is nothing to do.');
          return ctxFor(r);
        },
        bind: (code) => ctxFor(core.runs.bindCloudSession(account.id, code, session)),
        onCall: (c, tool, args, ok, text) => {
          core.runs.touch(c.run.id);
          core.runs.recordEvent(c.run.id, 'tool_use', { name: `mcp__agentos__${tool}`, input: truncate(JSON.stringify(args ?? {}), 4000) });
          core.runs.recordEvent(c.run.id, 'tool_result', { name: tool, isError: !ok, content: truncate(text, 4000) });
        },
      };
    }
    const server = buildMcpServer(core, access);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    reply.raw.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  };
  app.post('/mcp', mcpHandler);
  app.get('/mcp', async (_req, reply) => reply.status(405).send({ error: 'Stateless MCP endpoint: use POST' }));
  app.delete('/mcp', async (_req, reply) => reply.status(405).send({ error: 'Stateless MCP endpoint' }));

  // ---------------------------------------------------------------- dashboard (static SPA)

  if (core.config.webDir && fs.existsSync(path.join(core.config.webDir, 'index.html'))) {
    await app.register(fastifyStatic, { root: core.config.webDir, prefix: '/', wildcard: true });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/mcp')) return reply.status(404).send({ error: 'Not found' });
      return reply.type('text/html').sendFile('index.html');
    });
  }

  return app;
}
