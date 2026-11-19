import type { Core } from '../core/core.js';
import { toAgent } from '../core/mappers.js';
import type { Agent } from '../core/types.js';
import { badRequest, newId, notFound, nowIso, slugify } from '../util/util.js';

export interface CreateAgentInput {
  name: string;
  role: string;
  slug?: string;
  is_pm?: boolean;
  account_id?: string | null;
  model?: string | null;
  effort?: string | null;
  instructions?: string;
  tool_profile?: 'standard' | 'readonly';
  max_turns?: number;
}

/** Role presets the UI offers; roles are free text, these only seed sensible instructions. */
export const ROLE_PRESETS: Record<string, { role: string; instructions: string; tool_profile: 'standard' | 'readonly' }> = {
  pm: {
    role: 'Project Manager',
    tool_profile: 'standard',
    instructions:
      'You plan and coordinate; you do not implement features yourself unless the owner asks. Turn objectives into epics/tasks with clear acceptance criteria and dependencies, assign them to the best-suited agents, keep the board accurate, unblock people, request reviews, and report meaningful progress to the owner concisely.',
  },
  backend: {
    role: 'Backend Developer',
    tool_profile: 'standard',
    instructions: 'You implement server-side features, APIs, data models and tests. Keep changes focused on your task and covered by tests.',
  },
  frontend: {
    role: 'Frontend Developer',
    tool_profile: 'standard',
    instructions: 'You implement user interfaces and client-side logic. Keep changes focused on your task, accessible, and consistent with the existing UI.',
  },
  architect: {
    role: 'Architect',
    tool_profile: 'standard',
    instructions:
      'You analyse the architecture, write design notes into project docs, identify technical debt and risks, and advise other agents. Significant architectural decisions must be submitted to the owner with request_approval.',
  },
  reviewer: {
    role: 'Code Reviewer',
    tool_profile: 'readonly',
    instructions:
      'You review other agents\' branches for correctness, security, tests and maintainability. Read the diff against the base branch, run the tests, and give a clear verdict with actionable comments. You do not push code.',
  },
  tester: {
    role: 'Tester',
    tool_profile: 'standard',
    instructions: 'You write and run tests, reproduce bugs, and report defects with precise reproduction steps.',
  },
};

export class AgentService {
  constructor(private core: Core) {}
  private get db() {
    return this.core.db;
  }

  list(projectId?: string): Agent[] {
    return (projectId
      ? this.db.all('SELECT * FROM agents WHERE project_id = ? ORDER BY is_pm DESC, created_at', projectId)
      : this.db.all('SELECT * FROM agents ORDER BY project_id, is_pm DESC, created_at')
    ).map(toAgent);
  }

  get(id: string): Agent {
    const a = this.find(id);
    if (!a) throw notFound('Agent');
    return a;
  }

  find(id: string | null | undefined): Agent | undefined {
    if (!id) return undefined;
    const r = this.db.get('SELECT * FROM agents WHERE id = ?', id);
    return r ? toAgent(r) : undefined;
  }

  /** Resolve an agent reference used by other agents: slug, name or id, scoped to a project. */
  resolve(projectId: string, ref: string): Agent | undefined {
    const clean = ref.trim().replace(/^@/, '');
    const r =
      this.db.get('SELECT * FROM agents WHERE project_id = ? AND (id = ? OR slug = ?)', projectId, clean, clean.toLowerCase()) ??
      this.db.get('SELECT * FROM agents WHERE project_id = ? AND lower(name) = lower(?)', projectId, clean);
    return r ? toAgent(r) : undefined;
  }

  pm(projectId: string): Agent | undefined {
    const r = this.db.get('SELECT * FROM agents WHERE project_id = ? AND is_pm = 1 AND enabled = 1 LIMIT 1', projectId);
    return r ? toAgent(r) : undefined;
  }

  create(projectId: string, input: CreateAgentInput, actor = 'owner'): Agent {
    const project = this.core.projects.get(projectId);
    if (!input.name?.trim()) throw badRequest('Agent name is required');
    if (!input.role?.trim()) throw badRequest('Agent role is required');
    const slug = slugify(input.slug || input.name, 24);
    if (this.db.get('SELECT 1 FROM agents WHERE project_id = ? AND slug = ?', projectId, slug)) {
      throw badRequest(`An agent with handle @${slug} already exists in this project`);
    }
    if (['owner', 'team', 'pm', 'system', 'all'].includes(slug)) throw badRequest(`@${slug} is reserved`);
    if (input.account_id) this.checkAccount(project, input.account_id);
    const id = newId('agt');
    const now = nowIso();
    this.db.tx(() => {
      this.db.insert('agents', {
        id,
        project_id: projectId,
        name: input.name.trim(),
        slug,
        role: input.role.trim(),
        is_pm: !!input.is_pm,
        account_id: input.account_id || null,
        model: input.model || null,
        effort: input.effort || null,
        instructions: input.instructions ?? '',
        tool_profile: input.tool_profile ?? 'standard',
        max_turns: input.max_turns ?? 80,
        created_at: now,
        updated_at: now,
      });
      if (input.is_pm) this.core.projects.update(projectId, { pm_agent_id: id }, actor);
    });
    this.core.activity(projectId, actor, 'agent.created', `Agent ${input.name} (${input.role}) joined the team`, { type: 'agent', id });
    this.core.bus.change({ topic: 'agents', projectId, id });
    return this.get(id);
  }

  update(id: string, patch: Partial<CreateAgentInput & { enabled: boolean }>, actor = 'owner'): Agent {
    const a = this.get(id);
    const row: Record<string, any> = {};
    for (const k of ['name', 'role', 'model', 'effort', 'instructions', 'tool_profile', 'max_turns', 'enabled'] as const) {
      if (patch[k] !== undefined) row[k] = patch[k];
    }
    if (patch.account_id !== undefined) {
      if (patch.account_id) this.checkAccount(this.core.projects.get(a.project_id), patch.account_id);
      row.account_id = patch.account_id || null;
    }
    row.updated_at = nowIso();
    this.db.update('agents', id, row);
    if (patch.is_pm === true) this.core.projects.update(a.project_id, { pm_agent_id: id }, actor);
    if (patch.enabled === false) this.core.activity(a.project_id, actor, 'agent.disabled', `Agent ${a.name} was disabled`, { type: 'agent', id });
    if (patch.enabled === true && !a.enabled) this.core.activity(a.project_id, actor, 'agent.enabled', `Agent ${a.name} was enabled`, { type: 'agent', id });
    this.core.bus.change({ topic: 'agents', projectId: a.project_id, id });
    this.core.bus.kick();
    return this.get(id);
  }

  setStatus(id: string, status: Agent['status'], detail: string | null = null) {
    const a = this.find(id);
    if (!a) return;
    if (a.status === status && a.status_detail === detail) return;
    this.db.update('agents', id, { status, status_detail: detail, updated_at: nowIso() });
    this.core.bus.change({ topic: 'agents', projectId: a.project_id, id });
  }

  /** Forget all provider sessions; the next run starts fresh with recovered context. */
  resetSessions(id: string, actor = 'owner') {
    const a = this.get(id);
    this.db.run('DELETE FROM sessions WHERE agent_id = ?', id);
    this.core.activity(a.project_id, actor, 'agent.sessions_reset', `${a.name}'s conversation context was reset`, { type: 'agent', id });
    this.core.bus.change({ topic: 'agents', projectId: a.project_id, id });
  }

  sessions(id: string) {
    return this.db.all('SELECT * FROM sessions WHERE agent_id = ? ORDER BY updated_at DESC', id);
  }

  private checkAccount(project: { runner_id: string | null; workspace_mode: string }, accountId: string) {
    const acc = this.core.accounts.get(accountId);
    if (acc.provider === 'claude-cloud') {
      if (project.workspace_mode !== 'github') {
        throw badRequest('Cloud agents (Claude Code on the web) work on a GitHub repository. Switch the project workspace to GitHub in project settings first.');
      }
      return;
    }
    if (project.workspace_mode === 'github') {
      throw badRequest('This project uses a GitHub workspace, which is worked on by cloud agents. Runner-based accounts work on runner workspaces.');
    }
    if (project.runner_id && acc.runner_id && acc.runner_id !== project.runner_id) {
      throw badRequest(
        "This account lives on a different runner than the project's repository. Agents of a project share git worktrees, so their accounts must be on the project's runner.",
      );
    }
  }
}
