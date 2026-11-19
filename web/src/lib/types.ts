// Domain types shared by the control plane, the runner protocol and (by copy) the dashboard.

export type Actor = 'owner' | 'system' | `agent:${string}` | `runner:${string}`;

export type TaskStatus = 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'blocked' | 'done' | 'cancelled';
export const TASK_STATUSES: TaskStatus[] = ['backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled'];
export const OPEN_STATUSES: TaskStatus[] = ['backlog', 'todo', 'in_progress', 'in_review', 'blocked'];

export type Autonomy = 'paused' | 'supervised' | 'autonomous';
export type CoordinationMode = 'pm_led' | 'collaborative';
export type MergePolicy = 'auto' | 'owner_approval';

export type AccountStatus = 'unknown' | 'ready' | 'auth_required' | 'rate_limited' | 'billing_blocked' | 'error';
export type Provider = 'claude-code' | 'claude-cloud' | 'mock';
export type WorkspaceMode = 'runner' | 'github';

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type RunErrorKind =
  | 'rate_limit'
  | 'auth'
  | 'billing_guard'
  | 'timeout'
  | 'max_turns'
  | 'crash'
  | 'cancelled'
  | 'runner_lost'
  | 'git'
  | 'config';

export interface ProjectLimits {
  /** Consecutive agent messages in one conversation before agent messages stop waking recipients. */
  maxAgentStreak: number;
  /** Max runs per agent per rolling hour. */
  maxRunsPerAgentHour: number;
  /** Max automatic continuations of one task without other progress. */
  maxAutoContinues: number;
  /** Max simultaneously active runs in the project. */
  maxConcurrentRuns: number;
  /** Whether finished work must be reviewed before merge. */
  requireReview: boolean;
}

export const DEFAULT_LIMITS: ProjectLimits = {
  maxAgentStreak: 12,
  maxRunsPerAgentHour: 12,
  maxAutoContinues: 4,
  maxConcurrentRuns: 4,
  requireReview: true,
};

export interface Project {
  id: string;
  key: string;
  slug: string;
  name: string;
  description: string;
  repo_url: string | null;
  base_branch: string;
  runner_id: string | null;
  pm_agent_id: string | null;
  coordination_mode: CoordinationMode;
  autonomy: Autonomy;
  merge_policy: MergePolicy;
  push_on_merge: boolean;
  workspace_mode: WorkspaceMode;
  has_github_token: boolean;
  limits: ProjectLimits;
  task_seq: number;
  archived: boolean;
  created_at: string;
  updated_at: string;
}

export interface Agent {
  id: string;
  project_id: string;
  name: string;
  slug: string;
  role: string;
  is_pm: boolean;
  account_id: string | null;
  model: string | null;
  effort: string | null;
  instructions: string;
  tool_profile: 'standard' | 'readonly';
  max_turns: number;
  enabled: boolean;
  status: 'idle' | 'queued' | 'running' | 'waiting' | 'error';
  status_detail: string | null;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Account {
  id: string;
  name: string;
  provider: Provider;
  runner_id: string | null;
  config_dir: string | null;
  billing: 'subscription';
  status: AccountStatus;
  status_detail: string | null;
  rate_limited_until: string | null;
  max_concurrent_runs: number;
  /** claude-cloud: routine API trigger URL (the trigger token itself is never returned). */
  fire_url: string | null;
  has_fire_token: boolean;
  has_cloud_token: boolean;
  usage: UsageSnapshot;
  auth: AuthSnapshot;
  created_at: string;
  updated_at: string;
}

export interface UsageWindow {
  utilization?: number;
  resetsAt?: number;
  status?: string;
}
export interface UsageSnapshot {
  windows?: Record<string, UsageWindow>;
  status?: string;
  rateLimitType?: string;
  resetsAt?: number;
  updatedAt?: string;
}
export interface AuthSnapshot {
  loggedIn?: boolean;
  authMethod?: string;
  apiKeySource?: string;
  apiProvider?: string;
  checkedAt?: string;
  ok?: boolean;
  problem?: string;
}

export interface Runner {
  id: string;
  name: string;
  status: 'online' | 'offline';
  last_seen_at: string | null;
  info: Record<string, unknown>;
  created_at: string;
}

export interface Task {
  id: string;
  project_id: string;
  number: number;
  key: string;
  parent_id: string | null;
  kind: 'epic' | 'task' | 'subtask';
  title: string;
  description: string;
  acceptance_criteria: string;
  status: TaskStatus;
  priority: number;
  assignee_id: string | null;
  reviewer_id: string | null;
  branch: string | null;
  merge_state: string | null;
  blocked_reason: string | null;
  continue_requested: boolean;
  auto_continues: number;
  created_by: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  depends_on?: string[];
}

export interface Conversation {
  id: string;
  project_id: string;
  kind: 'direct' | 'team' | 'task';
  participant_key: string;
  task_id: string | null;
  title: string;
  agent_streak: number;
  loop_guard_tripped: boolean;
  last_message_at: string | null;
  created_at: string;
}

export interface Message {
  id: string;
  project_id: string;
  conversation_id: string;
  sender_type: 'owner' | 'agent' | 'system';
  sender_id: string | null;
  body: string;
  kind: 'chat' | 'fyi' | 'report' | 'system';
  expects_reply: boolean;
  run_id: string | null;
  created_at: string;
}

export type InboxType =
  | 'message'
  | 'task_assigned'
  | 'review_requested'
  | 'changes_requested'
  | 'approval_decided'
  | 'task_unblocked'
  | 'merge_result'
  | 'nudge';

export interface InboxItem {
  id: string;
  project_id: string;
  agent_id: string;
  type: InboxType;
  ref_id: string | null;
  task_id: string | null;
  summary: string;
  wake: boolean;
  status: 'pending' | 'delivered' | 'done';
  run_id: string | null;
  attempts: number;
  created_at: string;
}

export interface Run {
  id: string;
  project_id: string;
  kind: 'agent' | 'merge';
  agent_id: string | null;
  account_id: string | null;
  runner_id: string | null;
  status: RunStatus;
  trigger: 'inbox' | 'continue' | 'manual' | 'merge';
  focus_task_id: string | null;
  session_key: string | null;
  resume_session_id: string | null;
  provider_session_id: string | null;
  prompt: string;
  payload: Record<string, any>;
  result_text: string | null;
  error_kind: RunErrorKind | null;
  error_detail: string | null;
  usage: RunUsage;
  git: GitReport;
  cancel_requested: boolean;
  owner_reply_conversation_id: string | null;
  /** Cloud runs: link to the Claude Code on the web session. */
  session_url: string | null;
  last_activity_at: string | null;
  queued_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface RunUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  numTurns?: number;
  /** API list-price equivalent reported by the CLI. NOT billed on subscription accounts. */
  apiEquivalentUsd?: number;
  durationMs?: number;
  model?: string;
}

export interface GitCommitInfo {
  sha: string;
  branch: string;
  message: string;
  author?: string;
  committedAt?: string;
}
export interface GitReport {
  branch?: string;
  head?: string;
  dirty?: boolean;
  commits?: GitCommitInfo[];
  workspace?: string;
  mergeResult?: 'merged' | 'conflict' | 'failed' | 'noop';
  mergeDetail?: string;
  pushed?: boolean;
}

export type ApprovalKind =
  | 'decision'
  | 'architecture'
  | 'security'
  | 'destructive'
  | 'production'
  | 'permission'
  | 'merge'
  | 'plan'
  | 'other';

export interface Approval {
  id: string;
  number: number;
  project_id: string;
  agent_id: string | null;
  run_id: string | null;
  task_id: string | null;
  kind: ApprovalKind;
  title: string;
  description: string;
  payload: Record<string, any>;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  decision_note: string | null;
  created_at: string;
  decided_at: string | null;
}

export interface Decision {
  id: string;
  project_id: string;
  title: string;
  context: string;
  decision: string;
  status: 'accepted' | 'rejected' | 'superseded';
  decided_by: string;
  approval_id: string | null;
  task_id: string | null;
  created_at: string;
}

export interface Doc {
  id: string;
  project_id: string;
  slug: string;
  title: string;
  body: string;
  updated_by: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface ActivityEntry {
  id: number;
  project_id: string | null;
  actor: string;
  type: string;
  summary: string;
  subject_type: string | null;
  subject_id: string | null;
  data: Record<string, unknown>;
  created_at: string;
}

// ---- UI-side composite shapes returned by the API ----
export interface ProjectStats {
  tasks: Record<string, number>;
  pendingApprovals: number;
  activeRuns: number;
  agentsInError: number;
  unansweredOwner: number;
}
export type ProjectWithStats = Project & { stats: ProjectStats };
export type AgentRow = Agent & { inbox: { pending: number; wake: number }; active_run: string | null };
export interface ConversationRow extends Conversation {
  participants: string[];
  last_message: Message | null;
  message_count: number;
}
export interface CommitRow {
  project_id: string;
  sha: string;
  branch: string | null;
  message: string;
  author: string | null;
  agent_id: string | null;
  run_id: string | null;
  task_id: string | null;
  committed_at: string | null;
  created_at: string;
}
export interface RunEvent {
  seq: number;
  ts: string;
  type: string;
  data: Record<string, any>;
}
export interface UnansweredItem {
  conversation_id: string;
  project_id: string;
  title: string;
  message_id: string;
  body: string;
  agent_id: string;
  created_at: string;
}
