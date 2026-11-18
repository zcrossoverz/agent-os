import type { Core } from '../core/core.js';
import type { Agent, InboxItem, Project, Task } from '../core/types.js';
import { log } from '../util/util.js';
import { buildWakePrompt } from './prompts.js';

/** Inbox types that are about doing work on a task, in the order an agent should handle them. */
const FOCUS_ORDER = ['changes_requested', 'merge_result', 'task_assigned', 'task_unblocked', 'review_requested', 'approval_decided', 'message', 'nudge'];

/**
 * Decides who runs next. Agents are event-driven: a run is created only when an agent has
 * something actionable (wake-worthy inbox items, or an explicit continuation), its account has
 * capacity, and the loop/throughput guards allow it. Everything else waits in the inbox.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private pending = false;
  private running = false;
  private escalated = new Set<string>();

  constructor(private core: Core) {}

  start() {
    this.timer = setInterval(() => this.tick(), this.core.config.schedulerIntervalMs);
    this.core.bus.on('kick', this.onKick);
    this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.core.bus.off('kick', this.onKick);
  }

  private onKick = () => {
    if (this.pending) return;
    this.pending = true;
    setTimeout(() => {
      this.pending = false;
      this.tick();
    }, 50);
  };

  tick() {
    if (this.running) return;
    this.running = true;
    try {
      this.core.accounts.releaseExpiredLimits();
      this.core.runners.sweepOffline();
      this.core.runs.sweepTimeouts();
      for (const project of this.core.projects.list()) this.scheduleProject(project);
    } catch (e) {
      log('error', 'scheduler tick failed', { error: String((e as Error)?.stack ?? e) });
    } finally {
      this.running = false;
    }
  }

  private scheduleProject(project: Project) {
    if (project.autonomy === 'paused') {
      for (const a of this.core.agents.list(project.id)) {
        if (a.status === 'waiting' || a.status === 'idle') {
          const hasWork = this.core.messaging.pendingInbox(a.id, true).length > 0;
          this.core.agents.setStatus(a.id, hasWork ? 'waiting' : 'idle', hasWork ? 'Project is paused' : null);
        }
      }
      return;
    }
    const agents = this.core.agents.list(project.id).filter((a) => a.enabled);
    // The PM goes first so planning happens before execution when both have work.
    agents.sort((a, b) => Number(b.is_pm) - Number(a.is_pm));
    for (const agent of agents) {
      if (this.core.runs.activeInProject(project.id) >= project.limits.maxConcurrentRuns) return;
      this.scheduleAgent(project, agent);
    }
  }

  private scheduleAgent(project: Project, agent: Agent) {
    if (this.core.runs.activeRunFor(agent.id)) return;
    const wakeItems = this.core.messaging.pendingInbox(agent.id, true);
    const continuation = wakeItems.length ? null : this.continuationTask(project, agent);
    if (!wakeItems.length && !continuation) {
      if (agent.status === 'waiting' || agent.status === 'queued' || agent.status === 'running') this.core.agents.setStatus(agent.id, 'idle');
      return;
    }
    if (agent.status === 'error') return; // needs owner attention (auth/billing/config); owner re-enables via "retry"

    const account = this.core.accounts.find(agent.account_id);
    if (!account) {
      this.core.agents.setStatus(agent.id, 'waiting', 'No account assigned');
      return;
    }
    const avail = this.core.accounts.availability(account);
    if (!avail.ok) {
      this.core.agents.setStatus(agent.id, 'waiting', avail.reason ?? 'account unavailable');
      return;
    }
    if (this.core.runs.runsInLastHour(agent.id) >= project.limits.maxRunsPerAgentHour) {
      this.core.agents.setStatus(agent.id, 'waiting', `Throttled: ${project.limits.maxRunsPerAgentHour} runs in the last hour`);
      return;
    }

    let focus: Task | null = continuation;
    let items: InboxItem[] = [];
    let trigger: 'inbox' | 'continue' = 'continue';
    if (wakeItems.length) {
      trigger = 'inbox';
      focus = this.pickFocus(agent, wakeItems);
      // One task per run keeps each provider session focused; other tasks' items wait for the next run.
      items = this.core.messaging.pendingInbox(agent.id).filter((i) => !i.task_id || !focus || i.task_id === focus.id || i.type === 'message');
    }

    const branch = focus && focus.assignee_id === agent.id && ['todo', 'in_progress', 'blocked'].includes(focus.status) ? (focus.branch ?? this.core.tasks.branchName(focus)) : null;
    const sessionKey = agent.is_pm || !focus ? 'main' : `task:${focus.id}`;
    const { prompt, recovery } = buildWakePrompt(this.core, { agent, project, items, focusTask: focus, trigger, branch });

    // If the owner wrote to this agent directly, the run's final answer is posted back to them.
    let ownerReply: string | null = null;
    for (const i of items) {
      if (i.type !== 'message' || !i.ref_id) continue;
      const m = this.core.messaging.getMessage(i.ref_id);
      if (m?.sender_type !== 'owner') continue;
      const conv = this.core.messaging.getConversation(m.conversation_id);
      if (conv.kind === 'direct' && this.core.messaging.participants(conv).includes(agent.id)) ownerReply = conv.id;
    }

    this.core.runs.createAgentRun({ agent, trigger, items, focusTask: focus, sessionKey, prompt, recovery, ownerReplyConversationId: ownerReply });
  }

  private pickFocus(agent: Agent, items: InboxItem[]): Task | null {
    const sorted = [...items].sort((a, b) => FOCUS_ORDER.indexOf(a.type) - FOCUS_ORDER.indexOf(b.type));
    for (const it of sorted) {
      if (!it.task_id) continue;
      const t = this.core.tasks.find(it.task_id);
      if (t && !['done', 'cancelled'].includes(t.status)) return t;
    }
    return null;
  }

  /** An in-progress task whose assignee asked to continue (or ran out of turns), within limits. */
  private continuationTask(project: Project, agent: Agent): Task | null {
    const tasks = this.core.tasks.list(project.id, { assigneeId: agent.id, status: ['in_progress'] }).filter((t) => t.continue_requested);
    for (const t of tasks) {
      if (t.auto_continues < project.limits.maxAutoContinues) return t;
      if (!this.escalated.has(t.id)) {
        // Too many continuations without the task moving: stop and escalate instead of burning usage.
        this.escalated.add(t.id);
        this.core.db.update('tasks', t.id, { continue_requested: false });
        this.core.activity(project.id, 'system', 'guard.continuations', `${t.key} hit the continuation limit (${project.limits.maxAutoContinues}); escalated`, { type: 'task', id: t.id });
        const pm = this.core.agents.pm(project.id);
        const note = `${agent.name} has continued ${t.key} "${t.title}" ${t.auto_continues} times without finishing. Check whether the task should be split, re-scoped or reassigned.`;
        if (pm && pm.id !== agent.id) this.core.messaging.enqueue(project.id, pm.id, 'nudge', { refId: `${t.id}:contlimit`, taskId: t.id, summary: note, wake: true });
        else this.core.messaging.send({ projectId: project.id, from: 'system', to: { type: 'task', taskId: t.id }, body: note, kind: 'system', expectsReply: false });
      }
    }
    return null;
  }
}
