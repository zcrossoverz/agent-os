import type { Core } from '../core/core.js';
import { toRun } from '../core/mappers.js';
import type { Agent, InboxItem, Run, RunAssignment, RunCompletion, RunnerEvent, Runner, Task } from '../core/types.js';
import { badRequest, log, newId, newToken, notFound, nowIso, sha256, truncate } from '../util/util.js';
import { buildSystemPrompt } from '../orchestrator/prompts.js';

export interface CreateAgentRunInput {
  agent: Agent;
  trigger: Run['trigger'];
  items: InboxItem[];
  focusTask: Task | null;
  sessionKey: string;
  prompt: string;
  recovery: string;
  ownerReplyConversationId: string | null;
}

export class RunService {
  constructor(private core: Core) {}
  private get db() {
    return this.core.db;
  }

  list(filter: { projectId?: string; agentId?: string; status?: string[]; limit?: number } = {}): Run[] {
    const where: string[] = [];
    const params: any[] = [];
    if (filter.projectId) {
      where.push('project_id = ?');
      params.push(filter.projectId);
    }
    if (filter.agentId) {
      where.push('agent_id = ?');
      params.push(filter.agentId);
    }
    if (filter.status?.length) {
      where.push(`status IN (${filter.status.map(() => '?').join(',')})`);
      params.push(...filter.status);
    }
    return this.db
      .all(`SELECT * FROM runs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY queued_at DESC LIMIT ?`, ...params, Math.min(filter.limit ?? 100, 500))
      .map(toRun);
  }

  get(id: string): Run {
    const r = this.db.get('SELECT * FROM runs WHERE id = ?', id);
    if (!r) throw notFound('Run');
    return toRun(r);
  }

  events(runId: string, afterSeq = 0, limit = 2000): RunnerEvent[] {
    return this.db
      .all('SELECT seq, ts, type, data FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?', runId, afterSeq, limit)
      .map((r) => ({ seq: r.seq, ts: r.ts, type: r.type, data: JSON.parse(r.data) }));
  }

  activeRunFor(agentId: string): Run | undefined {
    const r = this.db.get("SELECT * FROM runs WHERE agent_id = ? AND status IN ('queued','running') LIMIT 1", agentId);
    return r ? toRun(r) : undefined;
  }

  runsInLastHour(agentId: string): number {
    const since = new Date(Date.now() - 3600_000).toISOString();
    return this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM runs WHERE agent_id = ? AND kind = 'agent' AND queued_at > ?", agentId, since)!.n;
  }

  activeInProject(projectId: string): number {
    return this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM runs WHERE project_id = ? AND kind = 'agent' AND status IN ('queued','running')", projectId)!.n;
  }

  // ---------------------------------------------------------------- creation

  createAgentRun(input: CreateAgentRunInput): Run {
    const { agent } = input;
    const account = this.core.accounts.get(agent.account_id!);
    const session = this.db.get('SELECT * FROM sessions WHERE agent_id = ? AND session_key = ?', agent.id, input.sessionKey);
    const id = newId('run');
    return this.db.tx(() => {
      this.db.insert('runs', {
        id,
        project_id: agent.project_id,
        kind: 'agent',
        agent_id: agent.id,
        account_id: account.id,
        runner_id: account.runner_id,
        status: 'queued',
        trigger: input.trigger,
        focus_task_id: input.focusTask?.id ?? null,
        session_key: input.sessionKey,
        resume_session_id: session?.provider_session_id ?? null,
        prompt: input.prompt,
        payload: JSON.stringify({ recovery: input.recovery, inbox: input.items.map((i) => i.id) }),
        owner_reply_conversation_id: input.ownerReplyConversationId,
        queued_at: nowIso(),
      });
      this.core.messaging.markDelivered(
        input.items.map((i) => i.id),
        id,
      );
      if (input.trigger === 'continue' && input.focusTask) {
        this.db.run('UPDATE tasks SET continue_requested = 0, auto_continues = auto_continues + 1 WHERE id = ?', input.focusTask.id);
      }
      this.core.agents.setStatus(agent.id, 'queued', input.focusTask ? `${input.focusTask.key}` : null);
      const why = input.trigger === 'continue' ? `continue ${input.focusTask?.key}` : `${input.items.length} inbox item(s)`;
      this.core.activity(agent.project_id, 'system', 'run.queued', `${agent.name} woken (${why})`, { type: 'run', id }, { agent: agent.id });
      this.core.bus.change({ topic: 'runs', projectId: agent.project_id, id });
      return this.get(id);
    });
  }

  enqueueMerge(task: Task): Run | undefined {
    const project = this.core.projects.get(task.project_id);
    const existing = this.db.get("SELECT * FROM runs WHERE kind = 'merge' AND focus_task_id = ? AND status IN ('queued','running')", task.id);
    if (existing) return toRun(existing);
    if (project.workspace_mode === 'github') {
      // Executed by the control plane itself through the GitHub API (orchestrator/cloud.ts).
      const id = newId('run');
      this.db.insert('runs', { id, project_id: project.id, kind: 'merge', runner_id: null, status: 'queued', trigger: 'merge', focus_task_id: task.id, prompt: `Merge ${task.branch} into ${project.base_branch} (GitHub)`, queued_at: nowIso() });
      this.core.activity(project.id, 'system', 'run.merge_queued', `Merge of ${task.key} queued (GitHub)`, { type: 'run', id });
      this.core.bus.change({ topic: 'runs', projectId: project.id, id });
      this.core.bus.kick();
      return this.get(id);
    }
    if (!project.runner_id) {
      this.core.tasks.onMergeResult(task.id, 'failed', 'Project has no runner to perform the merge');
      return undefined;
    }
    const id = newId('run');
    this.db.insert('runs', {
      id,
      project_id: project.id,
      kind: 'merge',
      runner_id: project.runner_id,
      status: 'queued',
      trigger: 'merge',
      focus_task_id: task.id,
      prompt: `Merge ${task.branch} into ${project.base_branch}`,
      queued_at: nowIso(),
    });
    this.core.activity(project.id, 'system', 'run.merge_queued', `Merge of ${task.key} queued`, { type: 'run', id });
    this.core.bus.change({ topic: 'runs', projectId: project.id, id });
    return this.get(id);
  }

  // ---------------------------------------------------------------- runner protocol

  /** Hands the next runnable job for this runner to it, or nothing. */
  claim(runner: Runner): RunAssignment | null {
    return this.db.tx(() => {
      const row = this.db.get("SELECT * FROM runs WHERE status = 'queued' AND runner_id = ? ORDER BY CASE kind WHEN 'merge' THEN 0 ELSE 1 END, queued_at LIMIT 1", runner.id);
      if (!row) return null;
      const run = toRun(row);
      const token = `aot_${newToken(24)}`;
      this.db.update('runs', run.id, { status: 'running', started_at: nowIso(), token_hash: sha256(token) });
      const project = this.core.projects.get(run.project_id);
      const base: RunAssignment = {
        run: {
          id: run.id,
          kind: run.kind,
          prompt: run.prompt,
          sessionKey: run.session_key,
          resumeSessionId: run.resume_session_id,
          maxTurns: 80,
          timeoutSec: this.core.config.runTimeoutSec,
        },
        project: { id: project.id, key: project.key, slug: project.slug, repoUrl: project.repo_url, baseBranch: project.base_branch, pushOnMerge: project.push_on_merge },
        mcp: { url: `${this.core.config.publicUrl.replace(/\/$/, '')}/mcp`, token },
      };
      if (run.kind === 'merge') {
        const t = this.core.tasks.get(run.focus_task_id!);
        base.merge = { taskKey: t.key, taskTitle: t.title, branch: t.branch ?? this.core.tasks.branchName(t) };
        this.core.activity(project.id, `runner:${runner.id}`, 'run.started', `Merging ${t.key}`, { type: 'run', id: run.id });
      } else {
        const agent = this.core.agents.get(run.agent_id!);
        const account = this.core.accounts.get(run.account_id!);
        const focus = this.core.tasks.find(run.focus_task_id);
        base.run.maxTurns = agent.max_turns;
        base.agent = {
          id: agent.id,
          name: agent.name,
          slug: agent.slug,
          role: agent.role,
          isPm: agent.is_pm,
          model: agent.model,
          effort: agent.effort,
          toolProfile: agent.tool_profile,
          systemPrompt: buildSystemPrompt(this.core, agent, project),
        };
        base.account = { id: account.id, provider: account.provider, configDir: account.config_dir };
        (base as any).recovery = run.payload.recovery ?? '';
        // The assignee works on the task branch; reviewers inspect it from their own worktree.
        if (focus && focus.assignee_id === agent.id && ['in_progress', 'todo', 'blocked'].includes(focus.status)) {
          base.branch = focus.branch ?? this.core.tasks.branchName(focus);
        }
        this.core.agents.setStatus(agent.id, 'running', focus ? focus.key : null);
        this.db.update('agents', agent.id, { last_run_at: nowIso() });
        this.core.activity(project.id, `runner:${runner.id}`, 'run.started', `${agent.name} started working${focus ? ` on ${focus.key}` : ''}`, { type: 'run', id: run.id }, { agent: agent.id });
      }
      this.core.bus.change({ topic: 'runs', projectId: project.id, id: run.id });
      return base;
    });
  }

  /** Identify the run behind an MCP request. Only active runs have valid tokens. */
  verifyToken(token: string | undefined): Run | undefined {
    if (!token) return undefined;
    const r = this.db.get("SELECT * FROM runs WHERE token_hash = ? AND status = 'running'", sha256(token));
    return r ? toRun(r) : undefined;
  }

  appendEvents(runId: string, runnerId: string, events: RunnerEvent[]): { cancel: boolean } {
    const run = this.get(runId);
    if (run.runner_id !== runnerId) throw badRequest('Run belongs to another runner');
    this.db.tx(() => {
      for (const e of events) {
        this.db.run('INSERT OR IGNORE INTO run_events (run_id, seq, ts, type, data) VALUES (?, ?, ?, ?, ?)', runId, e.seq, e.ts, e.type, JSON.stringify(e.data ?? {}));
        if (e.type === 'rate_limit' && run.account_id) this.core.accounts.reportUsage(run.account_id, e.data as any);
        if (e.type === 'init' && typeof e.data.sessionId === 'string') this.db.update('runs', runId, { provider_session_id: e.data.sessionId });
        if (e.type === 'status' && typeof e.data.workspace === 'string') {
          const cur = this.get(runId);
          this.db.update('runs', runId, { payload: JSON.stringify({ ...cur.payload, workspace: e.data.workspace, branch: e.data.branch ?? null }) });
        }
      }
    });
    this.core.runners.touch(runnerId);
    this.core.bus.change({ topic: 'run_events', projectId: run.project_id, id: runId });
    return { cancel: run.cancel_requested || run.status !== 'running' };
  }

  complete(runId: string, c: RunCompletion, runnerId?: string): Run {
    const run = this.get(runId);
    if (runnerId && run.runner_id !== runnerId) throw badRequest('Run belongs to another runner');
    if (!['running', 'queued'].includes(run.status)) return run; // already finalized (e.g. runner_lost then late completion)
    const status = c.status;
    this.db.tx(() => {
      this.db.update('runs', runId, {
        status,
        finished_at: nowIso(),
        result_text: c.resultText ?? null,
        error_kind: c.errorKind ?? null,
        error_detail: c.errorDetail ? truncate(c.errorDetail, 4000) : null,
        usage: JSON.stringify(c.usage ?? {}),
        git: JSON.stringify(c.git ?? {}),
        provider_session_id: c.sessionId ?? run.provider_session_id,
        token_hash: null,
      });
    });
    // Follow-up effects run after the run is finalized: a failing side effect (e.g. posting a reply)
    // must never leave a run stuck in "running" or make the runner retry the completion.
    try {
      this.db.tx(() => (run.kind === 'merge' ? this.completeMerge(run, c) : this.completeAgentRun(run, c)));
    } catch (e) {
      log('error', `Post-completion handling failed for ${runId}`, { error: String((e as Error)?.stack ?? e) });
      this.core.activity(run.project_id, 'system', 'run.followup_failed', `Follow-up for run ${runId} failed: ${(e as Error).message}`, { type: 'run', id: runId });
    }
    this.core.bus.change({ topic: 'runs', projectId: run.project_id, id: runId });
    this.core.bus.kick();
    return this.get(runId);
  }

  private completeMerge(run: Run, c: RunCompletion) {
    const result = c.git?.mergeResult ?? (c.status === 'succeeded' ? 'merged' : 'failed');
    if (c.git?.commits?.length) this.recordCommits(run, c.git.commits, null);
    this.core.tasks.onMergeResult(run.focus_task_id!, result, c.git?.mergeDetail ?? c.errorDetail ?? '');
  }

  private completeAgentRun(run: Run, c: RunCompletion) {
    const agent = this.core.agents.find(run.agent_id);
    if (!agent) return;
    const ok = c.status === 'succeeded';

    // Sessions: remember the provider session for this context key so the next run can resume it.
    if (c.sessionId && run.session_key) {
      this.db.run(
        `INSERT INTO sessions (agent_id, session_key, provider_session_id, runner_id, run_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(agent_id, session_key) DO UPDATE SET provider_session_id = excluded.provider_session_id, runner_id = excluded.runner_id, run_count = run_count + 1, updated_at = excluded.updated_at`,
        agent.id,
        run.session_key,
        c.sessionId,
        run.runner_id,
        nowIso(),
        nowIso(),
      );
    }

    // Inbox: consumed on success; handed back on transient failures.
    if (ok) this.core.messaging.completeInbox(run.id);
    else this.core.messaging.releaseInbox(run.id);

    // Account health.
    if (run.account_id) {
      if (c.rateLimit) this.core.accounts.reportUsage(run.account_id, { ...c.rateLimit, limited: c.errorKind === 'rate_limit' || c.rateLimit.limited });
      else if (c.errorKind === 'rate_limit') this.core.accounts.reportUsage(run.account_id, { limited: true });
      if (c.errorKind === 'auth') this.core.accounts.setStatus(run.account_id, 'auth_required', c.errorDetail ?? 'Authentication failed');
      if (c.errorKind === 'billing_guard') this.core.accounts.setStatus(run.account_id, 'billing_blocked', c.errorDetail ?? 'API credentials detected');
      if (ok) {
        const acc = this.core.accounts.find(run.account_id);
        if (acc && ['unknown', 'error'].includes(acc.status)) this.core.accounts.setStatus(acc.id, 'ready');
      }
    }

    // Git: record commits the agent made.
    if (c.git?.commits?.length) this.recordCommits(run, c.git.commits, agent.id);
    const focus = this.core.tasks.find(run.focus_task_id);
    if (focus && c.git?.branch && focus.assignee_id === agent.id && !focus.branch) {
      this.db.update('tasks', focus.id, { branch: c.git.branch });
    }

    // Continuation: the agent ran out of turns or asked to be woken again to keep going.
    if (focus && focus.assignee_id === agent.id && focus.status === 'in_progress' && (c.errorKind === 'max_turns' || c.errorKind === 'timeout')) {
      this.db.update('tasks', focus.id, { continue_requested: true });
    }

    // Reply to the owner when the owner's message triggered this run and the agent didn't answer explicitly.
    if (ok && run.owner_reply_conversation_id && c.resultText?.trim()) {
      const answered = this.db.get("SELECT 1 FROM messages WHERE conversation_id = ? AND run_id = ? AND sender_type = 'agent'", run.owner_reply_conversation_id, run.id);
      if (!answered) {
        this.core.messaging.send({
          projectId: run.project_id,
          from: { agentId: agent.id },
          to: { type: 'conversation', conversationId: run.owner_reply_conversation_id },
          body: c.resultText.trim(),
          expectsReply: false,
          runId: run.id,
        });
      }
    }
    if (!ok && run.owner_reply_conversation_id && ['auth', 'billing_guard', 'config', 'crash'].includes(c.errorKind ?? '')) {
      this.core.messaging.send({
        projectId: run.project_id,
        from: 'system',
        to: { type: 'conversation', conversationId: run.owner_reply_conversation_id },
        body: `${agent.name} could not process your message: ${c.errorKind} — ${truncate(c.errorDetail ?? '', 300)}`,
        kind: 'system',
        expectsReply: false,
      });
    }

    // Agent status.
    const hardError = ['auth', 'billing_guard', 'config'].includes(c.errorKind ?? '');
    if (hardError) this.core.agents.setStatus(agent.id, 'error', `${c.errorKind}: ${truncate(c.errorDetail ?? '', 200)}`);
    else if (c.errorKind === 'rate_limit') this.core.agents.setStatus(agent.id, 'waiting', 'Account usage limit reached');
    else this.core.agents.setStatus(agent.id, 'idle', null);

    const dur = c.usage?.durationMs ? ` in ${Math.round(c.usage.durationMs / 1000)}s` : '';
    this.core.activity(
      run.project_id,
      `agent:${agent.id}`,
      ok ? 'run.succeeded' : 'run.failed',
      ok ? `${agent.name} finished a run${dur}` : `${agent.name}'s run failed: ${c.errorKind}${c.errorDetail ? ` — ${truncate(c.errorDetail, 140)}` : ''}`,
      { type: 'run', id: run.id },
      { agent: agent.id, errorKind: c.errorKind },
    );
  }

  recordCommits(run: Run, commits: NonNullable<RunCompletion['git']>['commits'] & {}, agentId: string | null) {
    const project = this.core.projects.get(run.project_id);
    const keyRe = new RegExp(`\\b${project.key}-(\\d+)\\b`, 'i');
    for (const cm of commits) {
      let taskId = run.focus_task_id;
      const m = cm.message.match(keyRe);
      if (m) taskId = this.db.get<{ id: string }>('SELECT id FROM tasks WHERE project_id = ? AND number = ?', project.id, Number(m[1]))?.id ?? taskId;
      this.db.run(
        'INSERT OR IGNORE INTO commits (project_id, sha, branch, message, author, agent_id, run_id, task_id, committed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        project.id,
        cm.sha,
        cm.branch,
        cm.message,
        cm.author ?? null,
        agentId,
        run.id,
        taskId,
        cm.committedAt ?? null,
        nowIso(),
      );
    }
    this.core.bus.change({ topic: 'commits', projectId: project.id });
  }

  cancel(runId: string, actor: string): Run {
    const run = this.get(runId);
    if (run.status === 'queued') {
      this.complete(runId, { status: 'cancelled', errorKind: 'cancelled', errorDetail: `Cancelled by ${actor}` });
    } else if (run.status === 'running') {
      this.db.update('runs', runId, { cancel_requested: true });
      this.core.activity(run.project_id, actor, 'run.cancel_requested', `Cancellation requested for run ${run.id}`, { type: 'run', id: runId });
      this.core.bus.change({ topic: 'runs', projectId: run.project_id, id: runId });
    }
    return this.get(runId);
  }

  isCancelRequested(runId: string): boolean {
    const r = this.db.get<{ cancel_requested: number; status: string }>('SELECT cancel_requested, status FROM runs WHERE id = ?', runId);
    return !r || r.cancel_requested === 1 || r.status !== 'running';
  }

  /** Runs the server believes are running on this runner, but the runner no longer has. */
  reconcileRunner(runnerId: string, activeRunIds: string[]) {
    const cutoff = new Date(Date.now() - 60_000).toISOString();
    for (const r of this.db.all("SELECT id FROM runs WHERE runner_id = ? AND status = 'running' AND started_at < ?", runnerId, cutoff)) {
      if (!activeRunIds.includes(r.id)) this.complete(r.id, { status: 'failed', errorKind: 'runner_lost', errorDetail: 'Runner restarted or lost the run' });
    }
  }

  // ---------------------------------------------------------------- cloud runs

  /** The running cloud run of this account whose Claude Code on the web session sent the request. */
  findCloudRun(accountId: string, sessionHeader: string | undefined): Run | undefined {
    const sid = normalizeSessionId(sessionHeader);
    if (!sid) return undefined;
    for (const r of this.db.all("SELECT * FROM runs WHERE account_id = ? AND status = 'running' AND runner_id IS NULL AND kind = 'agent' AND provider_session_id IS NOT NULL", accountId)) {
      if (normalizeSessionId(r.provider_session_id) === sid) return toRun(r);
    }
    return undefined;
  }

  /** Bind a cloud session to a dispatched run (start_run). */
  bindCloudSession(accountId: string, runId: string, sessionHeader: string | undefined): Run {
    const run = this.db.get('SELECT * FROM runs WHERE id = ?', runId.trim());
    if (!run || run.account_id !== accountId) throw badRequest(`Unknown run code "${runId}" for this account`);
    if (run.status !== 'running') throw badRequest(`Run ${runId} is ${run.status}; it is no longer active. Stop working and end the session.`);
    const sid = normalizeSessionId(sessionHeader);
    if (!sid) throw badRequest('AgentOS could not identify this cloud session: the X-AgentOS-Session header is missing. The repository .mcp.json must send X-AgentOS-Session: ${CLAUDE_CODE_REMOTE_SESSION_ID}.');
    const bound = normalizeSessionId(run.provider_session_id);
    if (bound && bound !== sid) throw badRequest(`Run ${runId} belongs to another cloud session`);
    if (!bound) this.db.update('runs', runId, { provider_session_id: sessionHeader!.trim() });
    this.touch(runId);
    return this.get(runId);
  }

  touch(runId: string) {
    this.db.update('runs', runId, { last_activity_at: nowIso() });
  }

  /** Server-side run log entries (cloud runs have no runner streaming events). */
  recordEvent(runId: string, type: RunnerEvent['type'], data: Record<string, unknown>) {
    const run = this.db.get<{ project_id: string }>('SELECT project_id FROM runs WHERE id = ?', runId);
    if (!run) return;
    const seq = (this.db.get<{ n: number }>('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM run_events WHERE run_id = ?', runId)!.n);
    this.db.run('INSERT INTO run_events (run_id, seq, ts, type, data) VALUES (?, ?, ?, ?, ?)', runId, seq, nowIso(), type, JSON.stringify(data));
    this.core.bus.change({ topic: 'run_events', projectId: run.project_id, id: runId });
  }

  /** Safety net for runs whose runner never reported back. Cloud runs are watched by the cloud worker. */
  sweepTimeouts() {
    const cutoff = new Date(Date.now() - (this.core.config.runTimeoutSec + 300) * 1000).toISOString();
    for (const r of this.db.all("SELECT id FROM runs WHERE status = 'running' AND runner_id IS NOT NULL AND started_at < ?", cutoff)) {
      this.complete(r.id, { status: 'failed', errorKind: 'timeout', errorDetail: 'Run exceeded the maximum duration' });
    }
  }

  commits(projectId: string, limit = 200) {
    return this.db.all('SELECT * FROM commits WHERE project_id = ? ORDER BY COALESCE(committed_at, created_at) DESC LIMIT ?', projectId, limit);
  }
}

/** Cloud session ids appear as "session_…" (API) and "cse_…" (inside the session); compare the rest. */
export function normalizeSessionId(id: string | null | undefined): string | null {
  const v = id?.trim();
  if (!v) return null;
  return v.replace(/^(session_|cse_)/, '');
}
