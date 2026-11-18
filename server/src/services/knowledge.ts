import type { Core } from '../core/core.js';
import { toDecision, toDoc } from '../core/mappers.js';
import type { Decision, Doc } from '../core/types.js';
import { badRequest, newId, notFound, nowIso, slugify, truncate } from '../util/util.js';

/** Shared project knowledge (docs) and the decision log. Both outlive any agent session. */
export class KnowledgeService {
  constructor(private core: Core) {}
  private get db() {
    return this.core.db;
  }

  listDocs(projectId: string): Omit<Doc, 'body'>[] {
    return this.db
      .all('SELECT id, project_id, slug, title, updated_by, version, created_at, updated_at, length(body) AS size FROM docs WHERE project_id = ? ORDER BY slug', projectId)
      .map((r) => r as any);
  }

  getDoc(projectId: string, slug: string): Doc {
    const r = this.db.get('SELECT * FROM docs WHERE project_id = ? AND slug = ?', projectId, slug);
    if (!r) throw notFound(`Doc "${slug}"`);
    return toDoc(r);
  }

  upsertDoc(projectId: string, slugIn: string, title: string, body: string, actor: string): Doc {
    const slug = slugify(slugIn, 60);
    if (!title?.trim()) throw badRequest('Doc title is required');
    if (body.length > 200_000) throw badRequest('Doc too large (max 200k chars)');
    const now = nowIso();
    const existing = this.db.get('SELECT * FROM docs WHERE project_id = ? AND slug = ?', projectId, slug);
    if (existing) {
      this.db.run('UPDATE docs SET title = ?, body = ?, updated_by = ?, version = version + 1, updated_at = ? WHERE id = ?', title.trim(), body, actor, now, existing.id);
    } else {
      this.db.insert('docs', { id: newId('doc'), project_id: projectId, slug, title: title.trim(), body, updated_by: actor, created_at: now, updated_at: now });
    }
    if (actor !== 'system') {
      this.core.activity(projectId, actor, existing ? 'doc.updated' : 'doc.created', `${this.core.actorLabel(actor)} ${existing ? 'updated' : 'created'} doc "${title.trim()}"`, { type: 'doc', id: slug });
    }
    this.core.bus.change({ topic: 'docs', projectId, id: slug });
    return this.getDoc(projectId, slug);
  }

  deleteDoc(projectId: string, slug: string, actor: string) {
    this.db.run('DELETE FROM docs WHERE project_id = ? AND slug = ?', projectId, slug);
    this.core.activity(projectId, actor, 'doc.deleted', `Doc "${slug}" deleted`, { type: 'doc', id: slug });
    this.core.bus.change({ topic: 'docs', projectId, id: slug });
  }

  listDecisions(projectId: string): Decision[] {
    return this.db.all('SELECT * FROM decisions WHERE project_id = ? ORDER BY created_at DESC', projectId).map(toDecision);
  }

  recordDecision(
    projectId: string,
    d: { title: string; context?: string; decision: string; status?: Decision['status']; approvalId?: string | null; taskId?: string | null },
    actor: string,
  ): Decision {
    if (!d.title?.trim() || !d.decision?.trim()) throw badRequest('Decision needs a title and the decision text');
    const id = newId('dec');
    this.db.insert('decisions', {
      id,
      project_id: projectId,
      title: d.title.trim(),
      context: d.context ?? '',
      decision: d.decision.trim(),
      status: d.status ?? 'accepted',
      decided_by: actor,
      approval_id: d.approvalId ?? null,
      task_id: d.taskId ?? null,
      created_at: nowIso(),
    });
    this.core.activity(projectId, actor, 'decision.recorded', `Decision: ${truncate(d.title.trim(), 100)} (${d.status ?? 'accepted'})`, { type: 'decision', id });
    this.core.bus.change({ topic: 'decisions', projectId, id });
    return toDecision(this.db.get('SELECT * FROM decisions WHERE id = ?', id)!);
  }
}
