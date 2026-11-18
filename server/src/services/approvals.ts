import type { Core } from '../core/core.js';
import { toApproval } from '../core/mappers.js';
import type { Approval, ApprovalKind } from '../core/types.js';
import { badRequest, isoAfter, newId, notFound, nowIso, truncate } from '../util/util.js';

export const APPROVAL_KINDS: ApprovalKind[] = ['decision', 'architecture', 'security', 'destructive', 'production', 'permission', 'merge', 'plan', 'other'];

export interface ApprovalRequest {
  projectId: string;
  agentId: string | null;
  runId?: string | null;
  taskId?: string | null;
  kind: ApprovalKind;
  title: string;
  description?: string;
  payload?: Record<string, unknown>;
}

export class ApprovalService {
  constructor(private core: Core) {}
  private get db() {
    return this.core.db;
  }

  list(filter: { projectId?: string; status?: Approval['status'] } = {}): Approval[] {
    const where: string[] = [];
    const params: any[] = [];
    if (filter.projectId) {
      where.push('project_id = ?');
      params.push(filter.projectId);
    }
    if (filter.status) {
      where.push('status = ?');
      params.push(filter.status);
    }
    return this.db.all(`SELECT * FROM approvals ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT 500`, ...params).map(toApproval);
  }

  get(id: string): Approval {
    const r = this.db.get('SELECT * FROM approvals WHERE id = ?', id);
    if (!r) throw notFound('Approval');
    return toApproval(r);
  }

  request(req: ApprovalRequest, actor: string): Approval {
    if (!APPROVAL_KINDS.includes(req.kind)) throw badRequest(`Unknown approval kind ${req.kind}`);
    if (!req.title?.trim()) throw badRequest('Approval title is required');
    const dup = this.db.get("SELECT * FROM approvals WHERE project_id = ? AND status = 'pending' AND title = ? AND COALESCE(agent_id,'') = COALESCE(?, '')", req.projectId, req.title.trim(), req.agentId);
    if (dup) return toApproval(dup);
    const number = (this.db.get<{ n: number }>('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM approvals WHERE project_id = ?', req.projectId)!.n);
    const id = newId('apr');
    this.db.insert('approvals', {
      id,
      number,
      project_id: req.projectId,
      agent_id: req.agentId,
      run_id: req.runId ?? null,
      task_id: req.taskId ?? null,
      kind: req.kind,
      title: req.title.trim(),
      description: req.description ?? '',
      payload: JSON.stringify(req.payload ?? {}),
      created_at: nowIso(),
    });
    this.core.activity(req.projectId, actor, 'approval.requested', `Approval #${number} requested: ${req.title.trim()}`, { type: 'approval', id }, { kind: req.kind });
    this.core.bus.change({ topic: 'approvals', projectId: req.projectId, id });
    return this.get(id);
  }

  decide(id: string, decision: 'approved' | 'rejected', note: string | null, actor = 'owner'): Approval {
    const a = this.get(id);
    if (a.status !== 'pending') throw badRequest(`Approval #${a.number} is already ${a.status}`);
    this.db.tx(() => {
      this.db.update('approvals', id, { status: decision, decision_note: note, decided_at: nowIso() });
      this.applyEffects(a, decision, note);
      this.core.activity(a.project_id, actor, `approval.${decision}`, `Approval #${a.number} ${decision}: ${a.title}${note ? ` — ${truncate(note, 120)}` : ''}`, { type: 'approval', id });
      if (a.agent_id) {
        this.core.messaging.enqueue(a.project_id, a.agent_id, 'approval_decided', {
          refId: a.id,
          taskId: a.task_id,
          summary: `Owner ${decision === 'approved' ? 'APPROVED' : 'REJECTED'} approval #${a.number} "${a.title}"${note ? `. Note: ${note}` : ''}${
            a.kind === 'permission' && decision === 'approved' ? '. You may now run exactly that command once.' : ''
          }`,
          wake: true,
        });
      }
    });
    this.core.bus.change({ topic: 'approvals', projectId: a.project_id, id });
    this.core.bus.kick();
    return this.get(id);
  }

  cancel(id: string, actor: string) {
    const a = this.get(id);
    if (a.status !== 'pending') return a;
    this.db.update('approvals', id, { status: 'cancelled', decided_at: nowIso() });
    this.core.activity(a.project_id, actor, 'approval.cancelled', `Approval #${a.number} cancelled`, { type: 'approval', id });
    this.core.bus.change({ topic: 'approvals', projectId: a.project_id, id });
    return this.get(id);
  }

  private applyEffects(a: Approval, decision: 'approved' | 'rejected', note: string | null) {
    switch (a.kind) {
      case 'permission':
        if (decision === 'approved' && a.agent_id && a.payload.tool_name) {
          this.db.insert('grants', {
            id: newId('grt'),
            agent_id: a.agent_id,
            approval_id: a.id,
            tool_name: String(a.payload.tool_name),
            match: String(a.payload.match ?? ''),
            uses_left: 1,
            expires_at: isoAfter(24 * 3600 * 1000),
            created_at: nowIso(),
          });
        }
        break;
      case 'merge': {
        const t = this.core.tasks.find(a.task_id);
        if (!t) break;
        if (decision === 'approved') {
          this.db.update('tasks', t.id, { merge_state: 'queued', updated_at: nowIso() });
          this.core.runs.enqueueMerge(this.core.tasks.get(t.id));
        } else {
          this.db.update('tasks', t.id, { merge_state: null, status: 'in_progress', updated_at: nowIso() });
          if (t.assignee_id) {
            this.core.messaging.enqueue(t.project_id, t.assignee_id, 'changes_requested', {
              refId: `${t.id}:${a.id}`,
              taskId: t.id,
              summary: `The owner declined to merge ${t.key}${note ? `: ${note}` : ''}. Address the feedback and submit_for_review again.`,
              wake: true,
            });
          }
        }
        this.core.bus.change({ topic: 'tasks', projectId: t.project_id, id: t.id });
        break;
      }
      case 'plan': {
        const ids: string[] = Array.isArray(a.payload.task_ids) ? (a.payload.task_ids as string[]) : [];
        if (decision === 'approved') {
          for (const ref of ids) {
            try {
              const t = this.core.tasks.resolve(a.project_id, ref);
              if (t.status === 'backlog') this.core.tasks.update(t.id, { status: 'todo' }, 'owner');
            } catch {
              /* task may have been deleted */
            }
          }
        }
        this.recordDecision(a, decision, note);
        break;
      }
      default:
        this.recordDecision(a, decision, note);
    }
  }

  private recordDecision(a: Approval, decision: 'approved' | 'rejected', note: string | null) {
    this.core.knowledge.recordDecision(
      a.project_id,
      {
        title: a.title,
        context: a.description,
        decision: `${decision === 'approved' ? 'Approved' : 'Rejected'} by owner${note ? `: ${note}` : '.'}`,
        status: decision === 'approved' ? 'accepted' : 'rejected',
        approvalId: a.id,
        taskId: a.task_id,
      },
      'owner',
    );
  }

  /** Consume a one-off grant matching this exact tool call, if the owner approved one. */
  consumeGrant(agentId: string, toolName: string, match: string): boolean {
    const g = this.db.get('SELECT * FROM grants WHERE agent_id = ? AND tool_name = ? AND match = ? AND uses_left > 0 AND expires_at > ? ORDER BY created_at LIMIT 1', agentId, toolName, match, nowIso());
    if (!g) return false;
    this.db.run('UPDATE grants SET uses_left = uses_left - 1 WHERE id = ?', g.id);
    return true;
  }

  pendingCount(projectId?: string): number {
    return projectId
      ? this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending' AND project_id = ?", projectId)!.n
      : this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'")!.n;
  }
}
