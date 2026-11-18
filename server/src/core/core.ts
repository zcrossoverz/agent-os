import { EventEmitter } from 'node:events';
import path from 'node:path';
import { Db } from '../db/db.js';
import { toActivity } from './mappers.js';
import type { ActivityEntry } from './types.js';
import { nowIso } from '../util/util.js';
import { ProjectService } from '../services/projects.js';
import { AccountService } from '../services/accounts.js';
import { RunnerService } from '../services/runners.js';
import { AgentService } from '../services/agents.js';
import { TaskService } from '../services/tasks.js';
import { MessagingService } from '../services/messaging.js';
import { ApprovalService } from '../services/approvals.js';
import { RunService } from '../services/runs.js';
import { KnowledgeService } from '../services/knowledge.js';

export interface ServerConfig {
  dataDir: string;
  dbFile: string;
  host: string;
  port: number;
  /** URL that runners and agents' MCP clients use to reach this control plane. */
  publicUrl: string;
  embeddedRunner: boolean;
  schedulerIntervalMs: number;
  runTimeoutSec: number;
  runnerOfflineAfterSec: number;
  webDir: string | null;
  /** Disable dashboard auth (tests / local-only dev). Never enable on a reachable host. */
  insecureNoAuth: boolean;
}

export function defaultConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  const dataDir = overrides.dataDir ?? process.env.AGENTOS_DATA_DIR ?? path.resolve('.agentos');
  const port = overrides.port ?? Number(process.env.AGENTOS_PORT ?? 4600);
  return {
    dataDir,
    dbFile: path.join(dataDir, 'agentos.db'),
    host: process.env.AGENTOS_HOST ?? '127.0.0.1',
    port,
    publicUrl: process.env.AGENTOS_PUBLIC_URL ?? `http://127.0.0.1:${port}`,
    embeddedRunner: false,
    schedulerIntervalMs: 1000,
    runTimeoutSec: Number(process.env.AGENTOS_RUN_TIMEOUT_SEC ?? 45 * 60),
    runnerOfflineAfterSec: 90,
    webDir: null,
    insecureNoAuth: false,
    ...overrides,
  };
}

export interface Change {
  topic:
    | 'projects'
    | 'agents'
    | 'accounts'
    | 'runners'
    | 'tasks'
    | 'messages'
    | 'conversations'
    | 'approvals'
    | 'runs'
    | 'run_events'
    | 'activity'
    | 'docs'
    | 'decisions'
    | 'commits';
  projectId?: string | null;
  id?: string;
  data?: unknown;
}

/** In-process change bus: drives the dashboard's live updates and nudges the scheduler. */
export class Bus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(1000);
  }
  change(c: Change) {
    this.emit('change', c);
  }
  kick() {
    this.emit('kick');
  }
}

export class Core {
  readonly db: Db;
  readonly bus = new Bus();
  readonly projects: ProjectService;
  readonly accounts: AccountService;
  readonly runners: RunnerService;
  readonly agents: AgentService;
  readonly tasks: TaskService;
  readonly messaging: MessagingService;
  readonly approvals: ApprovalService;
  readonly runs: RunService;
  readonly knowledge: KnowledgeService;

  constructor(readonly config: ServerConfig) {
    this.db = new Db(config.dbFile);
    this.projects = new ProjectService(this);
    this.accounts = new AccountService(this);
    this.runners = new RunnerService(this);
    this.agents = new AgentService(this);
    this.tasks = new TaskService(this);
    this.messaging = new MessagingService(this);
    this.approvals = new ApprovalService(this);
    this.runs = new RunService(this);
    this.knowledge = new KnowledgeService(this);
  }

  activity(
    projectId: string | null,
    actor: string,
    type: string,
    summary: string,
    subject?: { type: string; id: string },
    data: Record<string, unknown> = {},
  ): void {
    this.db.insert('activity', {
      project_id: projectId,
      actor,
      type,
      summary,
      subject_type: subject?.type ?? null,
      subject_id: subject?.id ?? null,
      data: JSON.stringify(data),
      created_at: nowIso(),
    });
    this.bus.change({ topic: 'activity', projectId });
  }

  listActivity(projectId: string | null, opts: { limit?: number; before?: number; subjectId?: string } = {}): ActivityEntry[] {
    const where: string[] = [];
    const params: any[] = [];
    if (projectId) {
      where.push('project_id = ?');
      params.push(projectId);
    }
    if (opts.before) {
      where.push('id < ?');
      params.push(opts.before);
    }
    if (opts.subjectId) {
      where.push('subject_id = ?');
      params.push(opts.subjectId);
    }
    const sql = `SELECT * FROM activity ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
    return this.db.all(sql, ...params, Math.min(opts.limit ?? 100, 500)).map(toActivity);
  }

  getSetting(key: string): string | undefined {
    return this.db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key)?.value;
  }

  setSetting(key: string, value: string) {
    this.db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
  }

  /** Human-readable actor label for prompts and the UI. */
  actorLabel(actor: string): string {
    if (actor === 'owner') return 'Owner';
    if (actor === 'system') return 'AgentOS';
    if (actor.startsWith('agent:')) {
      const a = this.agents.find(actor.slice(6));
      return a ? `${a.name} (${a.role})` : actor;
    }
    return actor;
  }

  close() {
    this.db.close();
  }
}
