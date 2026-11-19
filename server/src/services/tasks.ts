import type { Core } from '../core/core.js';
import { toTask } from '../core/mappers.js';
import { OPEN_STATUSES, TASK_STATUSES, type Agent, type Project, type Task, type TaskStatus } from '../core/types.js';
import { badRequest, forbidden, newId, notFound, nowIso, slugify, truncate } from '../util/util.js';

export interface CreateTaskInput {
  title: string;
  description?: string;
  acceptance_criteria?: string;
  kind?: Task['kind'];
  parent?: string | null; // id or key
  priority?: number;
  status?: TaskStatus;
  assignee?: string | null; // agent id/slug
  reviewer?: string | null;
  depends_on?: string[]; // ids or keys
}

export type TaskPatch = Partial<Omit<CreateTaskInput, 'kind'>> & { kind?: Task['kind']; blocked_reason?: string | null; sort_order?: number };

const PRIORITY_LABEL = ['urgent', 'high', 'normal', 'low'];

export class TaskService {
  constructor(private core: Core) {}
  private get db() {
    return this.core.db;
  }

  // ---------------------------------------------------------------- queries

  list(projectId: string, filter: { status?: TaskStatus[]; assigneeId?: string; parentId?: string; includeClosed?: boolean } = {}): Task[] {
    const where = ['project_id = ?'];
    const params: any[] = [projectId];
    if (filter.status?.length) {
      where.push(`status IN (${filter.status.map(() => '?').join(',')})`);
      params.push(...filter.status);
    } else if (filter.includeClosed === false) {
      where.push(`status IN (${OPEN_STATUSES.map(() => '?').join(',')})`);
      params.push(...OPEN_STATUSES);
    }
    if (filter.assigneeId) {
      where.push('assignee_id = ?');
      params.push(filter.assigneeId);
    }
    if (filter.parentId) {
      where.push('parent_id = ?');
      params.push(filter.parentId);
    }
    const tasks = this.db.all(`SELECT * FROM tasks WHERE ${where.join(' AND ')} ORDER BY priority, sort_order, number`, ...params).map(toTask);
    const deps = this.db.all('SELECT d.task_id, d.depends_on_id FROM task_deps d JOIN tasks t ON t.id = d.task_id WHERE t.project_id = ?', projectId);
    const map = new Map<string, string[]>();
    for (const d of deps) map.set(d.task_id, [...(map.get(d.task_id) ?? []), d.depends_on_id]);
    return tasks.map((t) => ({ ...t, depends_on: map.get(t.id) ?? [] }));
  }

  find(id: string | null | undefined): Task | undefined {
    if (!id) return undefined;
    const r = this.db.get('SELECT * FROM tasks WHERE id = ?', id);
    return r ? this.withDeps(toTask(r)) : undefined;
  }

  get(id: string): Task {
    const t = this.find(id);
    if (!t) throw notFound('Task');
    return t;
  }

  /** Resolve a task reference (id, key like "AOS-12", or "#12") within a project. */
  resolve(projectId: string, ref: string): Task {
    const clean = ref.trim().replace(/^#/, '');
    let r = this.db.get('SELECT * FROM tasks WHERE project_id = ? AND (id = ? OR upper(key) = upper(?))', projectId, clean, clean);
    if (!r && /^\d+$/.test(clean)) r = this.db.get('SELECT * FROM tasks WHERE project_id = ? AND number = ?', projectId, Number(clean));
    if (!r) throw notFound(`Task ${ref}`);
    return this.withDeps(toTask(r));
  }

  private withDeps(t: Task): Task {
    const deps = this.db.all('SELECT depends_on_id FROM task_deps WHERE task_id = ?', t.id).map((r) => r.depends_on_id as string);
    return { ...t, depends_on: deps };
  }

  unmetDeps(t: Task): Task[] {
    return (t.depends_on ?? []).map((id) => this.find(id)).filter((d): d is Task => !!d && d.status !== 'done' && d.status !== 'cancelled');
  }

  dependents(taskId: string): Task[] {
    return this.db.all('SELECT t.* FROM task_deps d JOIN tasks t ON t.id = d.task_id WHERE d.depends_on_id = ?', taskId).map((r) => this.withDeps(toTask(r)));
  }

  branchName(t: Pick<Task, 'key' | 'title'>): string {
    return `task/${t.key.toLowerCase()}-${slugify(t.title, 32)}`;
  }

  // ---------------------------------------------------------------- authorization helpers

  private actorAgent(actor: string): Agent | undefined {
    return actor.startsWith('agent:') ? this.core.agents.get(actor.slice(6)) : undefined;
  }

  private isLead(actor: string, project: Project): boolean {
    if (actor === 'owner' || actor === 'system') return true;
    const a = this.actorAgent(actor);
    return !!a && (a.is_pm || project.coordination_mode === 'collaborative');
  }

  // ---------------------------------------------------------------- mutations

  create(projectId: string, input: CreateTaskInput, actor: string): Task {
    const project = this.core.projects.get(projectId);
    const title = input.title?.trim();
    if (!title) throw badRequest('Task title is required');
    const agent = this.actorAgent(actor);
    const parent = input.parent ? this.resolve(projectId, input.parent) : undefined;
    const lead = this.isLead(actor, project);

    if (agent && !lead) {
      // PM-led project: non-PM agents may break their own task into subtasks, or propose backlog items.
      const ownSubtask = parent && parent.assignee_id === agent.id;
      if (!ownSubtask && (input.assignee || (input.status && input.status !== 'backlog'))) {
        throw forbidden('In a PM-led project only the PM assigns work. Create an unassigned backlog proposal, a subtask of your own task, or message the PM.');
      }
    }

    let status: TaskStatus = input.status ?? 'todo';
    if (!TASK_STATUSES.includes(status) || ['done', 'cancelled', 'in_review'].includes(status)) throw badRequest(`Invalid initial status ${status}`);
    if (agent && !lead && !(parent && parent.assignee_id === agent.id)) status = 'backlog';
    // Supervised projects: agent-created work waits for the owner's go-ahead (plan approval).
    if (agent && project.autonomy === 'supervised' && status === 'todo') status = 'backlog';

    const assignee = input.assignee ? this.mustResolveAgent(projectId, input.assignee) : undefined;
    const reviewer = input.reviewer ? this.mustResolveAgent(projectId, input.reviewer) : undefined;
    const deps = (input.depends_on ?? []).map((d) => this.resolve(projectId, d));
    const priority = Math.max(0, Math.min(3, input.priority ?? 2));

    const task = this.db.tx(() => {
      const { number, key } = this.core.projects.nextTaskNumber(projectId);
      const id = newId('tsk');
      const now = nowIso();
      this.db.insert('tasks', {
        id,
        project_id: projectId,
        number,
        key,
        parent_id: parent?.id ?? null,
        kind: input.kind ?? (parent ? 'subtask' : 'task'),
        title,
        description: input.description ?? '',
        acceptance_criteria: input.acceptance_criteria ?? '',
        status,
        priority,
        assignee_id: assignee?.id ?? null,
        reviewer_id: reviewer?.id ?? null,
        created_by: actor,
        sort_order: number,
        created_at: now,
        updated_at: now,
      });
      for (const d of deps) this.db.insert('task_deps', { task_id: id, depends_on_id: d.id });
      const t = this.get(id);
      this.core.activity(projectId, actor, 'task.created', `${this.core.actorLabel(actor)} created ${key}: ${title}`, { type: 'task', id }, { status });
      if (assignee) {
        this.core.activity(projectId, actor, 'task.assigned', `${key} assigned to ${assignee.name}`, { type: 'task', id }, { assignee: assignee.id });
        this.notifyAssigned(t, assignee, actor);
      }
      return t;
    });
    this.core.bus.change({ topic: 'tasks', projectId, id: task.id });
    return task;
  }

  update(id: string, patch: TaskPatch, actor: string): Task {
    const t = this.get(id);
    const project = this.core.projects.get(t.project_id);
    const agent = this.actorAgent(actor);
    const lead = this.isLead(actor, project);
    if (agent && !lead && t.assignee_id !== agent.id) throw forbidden('Only the PM, the owner or the assignee can edit this task');

    const row: Record<string, any> = {};
    for (const k of ['title', 'description', 'acceptance_criteria', 'kind', 'blocked_reason', 'sort_order'] as const) {
      if (patch[k] !== undefined) row[k] = patch[k];
    }
    if (patch.priority !== undefined) row.priority = Math.max(0, Math.min(3, patch.priority));
    if (patch.parent !== undefined) row.parent_id = patch.parent ? this.resolve(t.project_id, patch.parent).id : null;
    if (row.parent_id === t.id) throw badRequest('A task cannot be its own parent');

    let newStatus: TaskStatus | undefined;
    if (patch.status !== undefined && patch.status !== t.status) {
      if (!TASK_STATUSES.includes(patch.status)) throw badRequest(`Invalid status ${patch.status}`);
      if (agent && !lead && !['in_progress', 'blocked'].includes(patch.status)) {
        throw forbidden('Use submit_for_review / block_task to move your task; only the PM or owner can set other statuses');
      }
      newStatus = patch.status;
      row.status = newStatus;
      if (newStatus === 'done' || newStatus === 'cancelled') row.completed_at = nowIso();
      if (newStatus !== 'blocked') row.blocked_reason = patch.blocked_reason ?? null;
      if (newStatus === 'in_progress' && !t.branch) row.branch = this.branchName(t);
    }

    const out = this.db.tx(() => {
      row.updated_at = nowIso();
      this.db.update('tasks', id, row);
      if (patch.depends_on) {
        if (!lead) throw forbidden('Only the PM or owner can change dependencies');
        const deps = patch.depends_on.map((d) => this.resolve(t.project_id, d));
        if (deps.some((d) => d.id === t.id)) throw badRequest('A task cannot depend on itself');
        this.db.run('DELETE FROM task_deps WHERE task_id = ?', id);
        for (const d of deps) {
          if (this.dependsOn(d.id, id)) throw badRequest(`Dependency cycle: ${d.key} already depends on ${t.key}`);
          this.db.insert('task_deps', { task_id: id, depends_on_id: d.id });
        }
      }
      if (patch.assignee !== undefined || patch.reviewer !== undefined) {
        this.assignInternal(this.get(id), patch.assignee, patch.reviewer, actor);
      }
      const changed = Object.keys(row).filter((k) => k !== 'updated_at');
      if (newStatus) {
        this.core.activity(t.project_id, actor, 'task.status', `${t.key} moved ${t.status} → ${newStatus}`, { type: 'task', id }, { from: t.status, to: newStatus });
        if (newStatus === 'done') this.onDone(this.get(id), actor);
        if (newStatus === 'todo' && t.status === 'backlog') {
          const fresh = this.get(id);
          const assignee = this.core.agents.find(fresh.assignee_id);
          if (assignee) this.notifyAssigned(fresh, assignee, actor);
        }
      } else if (changed.length) {
        this.core.activity(t.project_id, actor, 'task.updated', `${t.key} updated (${changed.join(', ')})`, { type: 'task', id });
      }
      return this.get(id);
    });
    this.core.bus.change({ topic: 'tasks', projectId: t.project_id, id });
    this.core.bus.kick();
    return out;
  }

  assign(id: string, assignee: string | null | undefined, reviewer: string | null | undefined, actor: string): Task {
    const t = this.get(id);
    const project = this.core.projects.get(t.project_id);
    if (!this.isLead(actor, project)) throw forbidden('Only the PM or the owner can assign work in a PM-led project');
    this.db.tx(() => this.assignInternal(t, assignee, reviewer, actor));
    this.core.bus.change({ topic: 'tasks', projectId: t.project_id, id });
    this.core.bus.kick();
    return this.get(id);
  }

  private assignInternal(t: Task, assigneeRef: string | null | undefined, reviewerRef: string | null | undefined, actor: string) {
    const row: Record<string, any> = { updated_at: nowIso() };
    let newAssignee: Agent | undefined;
    if (assigneeRef !== undefined) {
      newAssignee = assigneeRef ? this.mustResolveAgent(t.project_id, assigneeRef) : undefined;
      row.assignee_id = newAssignee?.id ?? null;
    }
    if (reviewerRef !== undefined) {
      const r = reviewerRef ? this.mustResolveAgent(t.project_id, reviewerRef) : undefined;
      if (r && (newAssignee?.id ?? t.assignee_id) === r.id) throw badRequest('Reviewer must differ from the assignee');
      row.reviewer_id = r?.id ?? null;
    }
    this.db.update('tasks', t.id, row);
    if (newAssignee && newAssignee.id !== t.assignee_id) {
      this.core.activity(t.project_id, actor, 'task.assigned', `${t.key} assigned to ${newAssignee.name}`, { type: 'task', id: t.id }, { assignee: newAssignee.id });
      this.notifyAssigned(this.get(t.id), newAssignee, actor);
    } else if (assigneeRef === null && t.assignee_id) {
      this.core.activity(t.project_id, actor, 'task.unassigned', `${t.key} unassigned`, { type: 'task', id: t.id });
    }
  }

  private notifyAssigned(t: Task, assignee: Agent, actor: string) {
    if (['done', 'cancelled'].includes(t.status)) return;
    const unmet = this.unmetDeps(t);
    const actionable = t.status !== 'backlog' && unmet.length === 0;
    const note = t.status === 'backlog' ? ' (in backlog — not started until approved/moved to todo)' : unmet.length ? ` (waiting on ${unmet.map((d) => d.key).join(', ')})` : '';
    this.core.messaging.enqueue(t.project_id, assignee.id, 'task_assigned', {
      refId: t.id,
      taskId: t.id,
      summary: `${this.core.actorLabel(actor)} assigned you ${t.key} "${t.title}" [${PRIORITY_LABEL[t.priority]}]${note}`,
      wake: actionable,
    });
  }

  start(id: string, actor: string): Task {
    const t = this.get(id);
    const agent = this.actorAgent(actor);
    if (agent && t.assignee_id !== agent.id && !agent.is_pm) throw forbidden(`${t.key} is not assigned to you`);
    if (!['todo', 'blocked', 'in_progress', 'backlog'].includes(t.status)) throw badRequest(`${t.key} is ${t.status}; it cannot be started`);
    if (t.status === 'backlog' && agent && !agent.is_pm) throw badRequest(`${t.key} is still in the backlog; ask the PM to schedule it`);
    const unmet = this.unmetDeps(t);
    if (unmet.length) throw badRequest(`${t.key} depends on unfinished tasks: ${unmet.map((d) => `${d.key} (${d.status})`).join(', ')}`);
    if (t.status === 'in_progress' && t.branch) return t;
    return this.update(id, { status: 'in_progress' }, actor);
  }

  submitForReview(id: string, summary: string, actor: string): Task {
    const t = this.get(id);
    const agent = this.actorAgent(actor);
    if (agent && t.assignee_id !== agent.id) throw forbidden(`${t.key} is not assigned to you`);
    if (!['in_progress', 'todo', 'blocked'].includes(t.status)) throw badRequest(`${t.key} is ${t.status}; only in-progress work can be submitted`);
    const project = this.core.projects.get(t.project_id);
    const branch = t.branch ?? this.branchName(t);

    this.db.tx(() => {
      this.db.update('tasks', id, { status: 'in_review', branch, continue_requested: false, auto_continues: 0, merge_state: null, updated_at: nowIso() });
      this.core.activity(t.project_id, actor, 'task.submitted', `${t.key} submitted for review`, { type: 'task', id }, { summary });
      this.core.messaging.send({ projectId: t.project_id, from: agent ? { agentId: agent.id } : 'system', to: { type: 'task', taskId: id }, body: `**Submitted for review** (branch \`${branch}\`)\n\n${summary}`, expectsReply: false, kind: 'report' });
      if (!project.limits.requireReview) {
        this.requestMerge(this.get(id), actor);
        return;
      }
      const reviewer = this.reviewerFor(this.get(id));
      if (reviewer) {
        this.core.messaging.enqueue(t.project_id, reviewer.id, 'review_requested', {
          refId: id,
          taskId: id,
          summary: `${this.core.actorLabel(actor)} requests your review of ${t.key} "${t.title}" on branch ${branch}`,
          wake: true,
        });
      } else {
        // Nobody else can review: the owner reviews via an approval.
        this.core.approvals.request(
          {
            projectId: t.project_id,
            agentId: agent?.id ?? null,
            taskId: id,
            kind: 'merge',
            title: `Review and merge ${t.key}: ${t.title}`,
            description: `No reviewer agent is available. Review branch \`${branch}\` and approve to merge it into \`${project.base_branch}\`.\n\n${summary}`,
          },
          'system',
        );
        this.db.update('tasks', id, { merge_state: 'pending_approval' });
      }
    });
    this.core.bus.change({ topic: 'tasks', projectId: t.project_id, id });
    this.core.bus.kick();
    return this.get(id);
  }

  reviewerFor(t: Task): Agent | undefined {
    const explicit = this.core.agents.find(t.reviewer_id);
    if (explicit?.enabled && explicit.id !== t.assignee_id) return explicit;
    const pm = this.core.agents.pm(t.project_id);
    if (pm && pm.id !== t.assignee_id) return pm;
    return undefined;
  }

  review(id: string, verdict: 'approve' | 'request_changes', comments: string, actor: string): Task {
    const t = this.get(id);
    const agent = this.actorAgent(actor);
    if (t.status !== 'in_review') throw badRequest(`${t.key} is ${t.status}, not in review`);
    if (t.merge_state && !['conflict', 'failed'].includes(t.merge_state)) throw badRequest(`${t.key} was already approved and is waiting to be merged (${t.merge_state.replace('_', ' ')})`);
    if (agent) {
      const allowed = this.reviewerFor(t)?.id === agent.id || agent.is_pm;
      if (!allowed) throw forbidden(`You are not the reviewer of ${t.key}`);
      if (agent.id === t.assignee_id) throw forbidden('You cannot review your own work');
    }
    this.db.tx(() => {
      const verdictText = verdict === 'approve' ? '✅ **Approved**' : '🔁 **Changes requested**';
      this.core.messaging.send({
        projectId: t.project_id,
        from: agent ? { agentId: agent.id } : actor === 'owner' ? 'owner' : 'system',
        to: { type: 'task', taskId: id },
        body: `${verdictText}\n\n${comments || '(no comments)'}`,
        expectsReply: false,
        kind: 'report',
      });
      this.core.activity(t.project_id, actor, verdict === 'approve' ? 'task.review_approved' : 'task.changes_requested', `${t.key} review: ${verdict === 'approve' ? 'approved' : 'changes requested'}`, { type: 'task', id }, { comments: truncate(comments, 500) });
      if (verdict === 'approve') {
        this.requestMerge(t, actor);
      } else {
        this.db.update('tasks', id, { status: 'in_progress', merge_state: null, updated_at: nowIso() });
        if (t.assignee_id) {
          this.core.messaging.enqueue(t.project_id, t.assignee_id, 'changes_requested', {
            refId: id,
            taskId: id,
            summary: `${this.core.actorLabel(actor)} requested changes on ${t.key}: ${truncate(comments.replace(/\s+/g, ' '), 300)}`,
            wake: true,
          });
        }
      }
    });
    this.core.bus.change({ topic: 'tasks', projectId: t.project_id, id });
    this.core.bus.kick();
    return this.get(id);
  }

  /** Approved work gets merged into the base branch — directly or after owner approval. */
  requestMerge(t: Task, actor: string) {
    const project = this.core.projects.get(t.project_id);
    const branch = t.branch ?? this.branchName(t);
    if (project.merge_policy === 'owner_approval' || project.autonomy === 'supervised') {
      if (actor === 'owner') {
        this.db.update('tasks', t.id, { merge_state: 'queued', branch, updated_at: nowIso() });
        this.core.runs.enqueueMerge(this.get(t.id));
        return;
      }
      const existing = this.db.get("SELECT id FROM approvals WHERE task_id = ? AND kind = 'merge' AND status = 'pending'", t.id);
      if (!existing) {
        this.core.approvals.request(
          { projectId: t.project_id, agentId: null, taskId: t.id, kind: 'merge', title: `Merge ${t.key} into ${project.base_branch}`, description: `${t.key} "${t.title}" passed review. Approve to merge branch \`${branch}\` into \`${project.base_branch}\`.` },
          'system',
        );
      }
      this.db.update('tasks', t.id, { merge_state: 'pending_approval', branch, updated_at: nowIso() });
    } else {
      this.db.update('tasks', t.id, { merge_state: 'queued', branch, updated_at: nowIso() });
      this.core.runs.enqueueMerge(this.get(t.id));
    }
  }

  onMergeResult(taskId: string, result: 'merged' | 'conflict' | 'failed' | 'noop', detail: string) {
    const t = this.find(taskId);
    if (!t) return;
    this.db.tx(() => {
      if (result === 'merged' || result === 'noop') {
        this.db.update('tasks', t.id, { merge_state: 'merged', status: 'done', completed_at: nowIso(), updated_at: nowIso() });
        this.core.activity(t.project_id, 'system', 'task.merged', `${t.key} merged into base branch${result === 'noop' ? ' (nothing to merge)' : ''}`, { type: 'task', id: t.id }, { detail });
        this.onDone(this.get(t.id), 'system');
      } else {
        this.db.update('tasks', t.id, { merge_state: result, status: 'in_progress', updated_at: nowIso() });
        this.core.activity(t.project_id, 'system', 'task.merge_failed', `${t.key} could not be merged (${result})`, { type: 'task', id: t.id }, { detail });
        if (t.assignee_id) {
          this.core.messaging.enqueue(t.project_id, t.assignee_id, 'merge_result', {
            refId: `${t.id}:${Date.now()}`,
            taskId: t.id,
            summary: `Merging ${t.key} failed (${result}). Rebase \`${t.branch}\` onto the base branch, resolve conflicts, re-run tests, then submit_for_review again. Details: ${truncate(detail, 400)}`,
            wake: true,
          });
        }
      }
    });
    this.core.bus.change({ topic: 'tasks', projectId: t.project_id, id: t.id });
    this.core.bus.kick();
  }

  block(id: string, reason: string, actor: string): Task {
    const t = this.get(id);
    const agent = this.actorAgent(actor);
    if (agent && t.assignee_id !== agent.id && !agent.is_pm) throw forbidden(`${t.key} is not assigned to you`);
    const out = this.update(id, { status: 'blocked', blocked_reason: reason }, actor);
    const pm = this.core.agents.pm(t.project_id);
    if (pm && pm.id !== agent?.id) {
      this.core.messaging.enqueue(t.project_id, pm.id, 'nudge', { refId: `${t.id}:blocked:${Date.now()}`, taskId: t.id, summary: `${t.key} is blocked: ${truncate(reason, 300)}`, wake: true });
    }
    return out;
  }

  checkpoint(id: string, notes: string, wantsContinue: boolean, actor: string): Task {
    const t = this.get(id);
    const agent = this.actorAgent(actor);
    if (agent && t.assignee_id !== agent.id) throw forbidden(`${t.key} is not assigned to you`);
    this.db.update('tasks', id, { continue_requested: wantsContinue, updated_at: nowIso() });
    if (notes.trim()) {
      this.core.messaging.send({ projectId: t.project_id, from: agent ? { agentId: agent.id } : 'system', to: { type: 'task', taskId: id }, body: `**Progress checkpoint**\n\n${notes}`, expectsReply: false, kind: 'report' });
    }
    this.core.bus.change({ topic: 'tasks', projectId: t.project_id, id });
    return this.get(id);
  }

  comment(id: string, body: string, actor: string) {
    const t = this.get(id);
    const agent = this.actorAgent(actor);
    return this.core.messaging.send({
      projectId: t.project_id,
      from: agent ? { agentId: agent.id } : actor === 'owner' ? 'owner' : 'system',
      to: { type: 'task', taskId: id },
      body,
      expectsReply: actor === 'owner',
    });
  }

  /** Task finished: unblock dependents and tell their assignees. */
  private onDone(t: Task, actor: string) {
    for (const d of this.dependents(t.id)) {
      if (!['todo', 'blocked'].includes(d.status) || !d.assignee_id) continue;
      if (this.unmetDeps(d).length) continue;
      this.core.messaging.enqueue(d.project_id, d.assignee_id, 'task_unblocked', {
        refId: d.id,
        taskId: d.id,
        summary: `${d.key} "${d.title}" is unblocked: its dependency ${t.key} is done`,
        wake: true,
      });
    }
    const pm = this.core.agents.pm(t.project_id);
    if (pm && actor !== `agent:${pm.id}`) {
      // Individual completions are FYIs; the PM is woken when the last open task finishes (a milestone).
      const open = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND status IN ('todo','in_progress','in_review','blocked')", t.project_id)!.n;
      this.core.messaging.enqueue(t.project_id, pm.id, 'nudge', {
        refId: `${t.id}:done`,
        taskId: open === 0 ? null : t.id,
        summary: open === 0 ? `${t.key} "${t.title}" is done, and it was the last open task: all planned work is done` : `${t.key} "${t.title}" is done`,
        wake: open === 0,
      });
    }
  }

  private dependsOn(taskId: string, targetId: string, seen = new Set<string>()): boolean {
    if (taskId === targetId) return true;
    if (seen.has(taskId)) return false;
    seen.add(taskId);
    return this.db.all('SELECT depends_on_id FROM task_deps WHERE task_id = ?', taskId).some((r) => this.dependsOn(r.depends_on_id, targetId, seen));
  }

  private mustResolveAgent(projectId: string, ref: string): Agent {
    const a = ref === 'pm' ? this.core.agents.pm(projectId) : this.core.agents.resolve(projectId, ref);
    if (!a) throw badRequest(`Unknown agent "${ref}"`);
    return a;
  }
}
