import type { Core } from '../core/core.js';
import { toProject } from '../core/mappers.js';
import { DEFAULT_LIMITS, type Autonomy, type CoordinationMode, type MergePolicy, type Project, type ProjectLimits } from '../core/types.js';
import { badRequest, conflict, newId, notFound, nowIso, slugify } from '../util/util.js';

export interface CreateProjectInput {
  name: string;
  key?: string;
  description?: string;
  repo_url?: string | null;
  base_branch?: string;
  runner_id?: string | null;
  coordination_mode?: CoordinationMode;
  autonomy?: Autonomy;
  merge_policy?: MergePolicy;
  push_on_merge?: boolean;
  limits?: Partial<ProjectLimits>;
}

export class ProjectService {
  constructor(private core: Core) {}

  private get db() {
    return this.core.db;
  }

  list(includeArchived = false): Project[] {
    return this.db
      .all(`SELECT * FROM projects ${includeArchived ? '' : 'WHERE archived = 0'} ORDER BY created_at`)
      .map(toProject);
  }

  get(id: string): Project {
    const r = this.db.get('SELECT * FROM projects WHERE id = ? OR slug = ?', id, id);
    if (!r) throw notFound('Project');
    return toProject(r);
  }

  find(id: string): Project | undefined {
    const r = this.db.get('SELECT * FROM projects WHERE id = ?', id);
    return r ? toProject(r) : undefined;
  }

  create(input: CreateProjectInput, actor = 'owner'): Project {
    const name = input.name?.trim();
    if (!name) throw badRequest('Project name is required');
    const slug = this.uniqueSlug(slugify(name, 32));
    const key = (input.key?.trim() || this.deriveKey(name)).toUpperCase();
    if (!/^[A-Z][A-Z0-9]{1,9}$/.test(key)) throw badRequest('Project key must be 2-10 letters/digits, starting with a letter');
    if (this.db.get('SELECT 1 FROM projects WHERE key = ?', key)) throw conflict(`Project key ${key} is already used`);
    const runnerId = input.runner_id ?? this.core.runners.defaultRunnerId();
    const now = nowIso();
    const id = newId('prj');
    this.db.tx(() => {
      this.db.insert('projects', {
        id,
        key,
        slug,
        name,
        description: input.description ?? '',
        repo_url: input.repo_url || null,
        base_branch: input.base_branch || 'main',
        runner_id: runnerId,
        coordination_mode: input.coordination_mode ?? 'pm_led',
        autonomy: input.autonomy ?? 'autonomous',
        merge_policy: input.merge_policy ?? 'auto',
        push_on_merge: input.push_on_merge ?? false,
        limits: JSON.stringify({ ...DEFAULT_LIMITS, ...(input.limits ?? {}) }),
        created_at: now,
        updated_at: now,
      });
      this.core.messaging.teamConversation(id);
      this.core.knowledge.upsertDoc(
        id,
        'brief',
        'Project brief',
        `# ${name}\n\n${input.description || '_No description yet. The Project Manager should refine this brief._'}\n`,
        actor,
      );
    });
    this.core.activity(id, actor, 'project.created', `Project ${name} created`, { type: 'project', id });
    this.core.bus.change({ topic: 'projects', projectId: id, id });
    return this.get(id);
  }

  update(id: string, patch: Partial<CreateProjectInput & { pm_agent_id: string | null; archived: boolean }>, actor = 'owner'): Project {
    const p = this.get(id);
    const row: Record<string, any> = {};
    for (const k of ['name', 'description', 'repo_url', 'base_branch', 'runner_id', 'coordination_mode', 'autonomy', 'merge_policy'] as const) {
      if (patch[k] !== undefined) row[k] = patch[k];
    }
    if (patch.push_on_merge !== undefined) row.push_on_merge = patch.push_on_merge;
    if (patch.archived !== undefined) row.archived = patch.archived;
    if (patch.limits) row.limits = JSON.stringify({ ...p.limits, ...patch.limits });
    if (patch.pm_agent_id !== undefined) {
      if (patch.pm_agent_id) {
        const a = this.core.agents.get(patch.pm_agent_id);
        if (a.project_id !== p.id) throw badRequest('PM must belong to this project');
      }
      row.pm_agent_id = patch.pm_agent_id;
    }
    if (row.autonomy && !['paused', 'supervised', 'autonomous'].includes(row.autonomy)) throw badRequest('Invalid autonomy');
    if (row.coordination_mode && !['pm_led', 'collaborative'].includes(row.coordination_mode)) throw badRequest('Invalid coordination mode');
    if (row.merge_policy && !['auto', 'owner_approval'].includes(row.merge_policy)) throw badRequest('Invalid merge policy');
    row.updated_at = nowIso();
    this.db.tx(() => {
      this.db.update('projects', p.id, row);
      if (patch.pm_agent_id !== undefined) {
        this.db.run('UPDATE agents SET is_pm = CASE WHEN id = ? THEN 1 ELSE 0 END WHERE project_id = ?', patch.pm_agent_id, p.id);
      }
    });
    const changed = Object.keys(row).filter((k) => k !== 'updated_at');
    if (row.autonomy && row.autonomy !== p.autonomy) {
      this.core.activity(p.id, actor, 'project.autonomy', `Autonomy changed from ${p.autonomy} to ${row.autonomy}`, { type: 'project', id: p.id });
    } else if (changed.length) {
      this.core.activity(p.id, actor, 'project.updated', `Project settings updated (${changed.join(', ')})`, { type: 'project', id: p.id });
    }
    this.core.bus.change({ topic: 'projects', projectId: p.id, id: p.id });
    this.core.bus.kick();
    return this.get(p.id);
  }

  nextTaskNumber(projectId: string): { number: number; key: string } {
    this.db.run('UPDATE projects SET task_seq = task_seq + 1 WHERE id = ?', projectId);
    const p = this.get(projectId);
    return { number: p.task_seq, key: `${p.key}-${p.task_seq}` };
  }

  /** Dashboard summary for one project. */
  stats(projectId: string) {
    const counts = Object.fromEntries(
      this.db
        .all<{ status: string; n: number }>('SELECT status, COUNT(*) AS n FROM tasks WHERE project_id = ? GROUP BY status', projectId)
        .map((r) => [r.status, r.n]),
    );
    const pendingApprovals = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM approvals WHERE project_id = ? AND status = 'pending'", projectId)!.n;
    const activeRuns = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM runs WHERE project_id = ? AND status IN ('queued','running')", projectId)!.n;
    const agentsInError = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM agents WHERE project_id = ? AND status = 'error'", projectId)!.n;
    const unansweredOwner = this.core.messaging.unansweredForOwner(projectId).length;
    return { tasks: counts, pendingApprovals, activeRuns, agentsInError, unansweredOwner };
  }

  private uniqueSlug(base: string): string {
    let slug = base;
    for (let i = 2; this.db.get('SELECT 1 FROM projects WHERE slug = ?', slug); i++) slug = `${base}-${i}`;
    return slug;
  }

  private deriveKey(name: string): string {
    const words = name.toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
    let key = words.length >= 2 ? words.map((w) => w[0]).join('').slice(0, 4) : (words[0] ?? 'PRJ').slice(0, 4);
    if (!/^[A-Z]/.test(key)) key = 'P' + key;
    if (key.length < 2) key = (key + 'XX').slice(0, 2);
    let candidate = key;
    for (let i = 2; this.db.get('SELECT 1 FROM projects WHERE key = ?', candidate); i++) candidate = `${key}${i}`;
    return candidate;
  }
}
