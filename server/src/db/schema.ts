/**
 * Database schema. AgentOS's database — not any agent's conversation history — is the source of
 * truth for projects, tasks, messages, decisions, approvals and execution history.
 * Migrations are append-only.
 */
export const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE runners (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'offline',          -- online | offline
  last_seen_at TEXT,
  info TEXT NOT NULL DEFAULT '{}',                 -- version, platform, claude version, data dir
  created_at TEXT NOT NULL
);

-- A provider account (e.g. one Claude Max subscription) whose credentials live ON a runner.
-- AgentOS never stores provider credentials: only the runner-local config directory path.
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider TEXT NOT NULL,                          -- claude-code | mock | (codex | gemini later)
  runner_id TEXT REFERENCES runners(id) ON DELETE SET NULL,
  config_dir TEXT,                                 -- runner-local CLAUDE_CONFIG_DIR
  billing TEXT NOT NULL DEFAULT 'subscription',    -- subscription (enforced by the billing guard)
  status TEXT NOT NULL DEFAULT 'unknown',          -- unknown | ready | auth_required | rate_limited | billing_blocked | error
  status_detail TEXT,
  rate_limited_until TEXT,
  max_concurrent_runs INTEGER NOT NULL DEFAULT 1,
  usage TEXT NOT NULL DEFAULT '{}',                -- latest rate-limit windows reported by the provider
  auth TEXT NOT NULL DEFAULT '{}',                 -- latest auth status reported by the runner (no secrets)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,                        -- short task-key prefix, e.g. AOS
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  repo_url TEXT,                                   -- git URL or runner-local path to clone from (optional)
  base_branch TEXT NOT NULL DEFAULT 'main',
  runner_id TEXT REFERENCES runners(id) ON DELETE SET NULL,
  pm_agent_id TEXT,
  coordination_mode TEXT NOT NULL DEFAULT 'pm_led', -- pm_led | collaborative
  autonomy TEXT NOT NULL DEFAULT 'autonomous',     -- paused | supervised | autonomous
  merge_policy TEXT NOT NULL DEFAULT 'auto',       -- auto | owner_approval
  push_on_merge INTEGER NOT NULL DEFAULT 0,
  limits TEXT NOT NULL DEFAULT '{}',               -- loop/throughput guard overrides
  task_seq INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  role TEXT NOT NULL,                              -- free text: "Project Manager", "Backend Developer", ...
  is_pm INTEGER NOT NULL DEFAULT 0,
  account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  model TEXT,
  effort TEXT,
  instructions TEXT NOT NULL DEFAULT '',           -- role-specific instructions appended to the system prompt
  tool_profile TEXT NOT NULL DEFAULT 'standard',   -- standard | readonly
  max_turns INTEGER NOT NULL DEFAULT 80,
  enabled INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'idle',             -- idle | queued | running | waiting | error
  status_detail TEXT,
  last_run_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, slug)
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  key TEXT NOT NULL,
  parent_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'task',               -- epic | task | subtask
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  acceptance_criteria TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'todo',             -- backlog | todo | in_progress | in_review | blocked | done | cancelled
  priority INTEGER NOT NULL DEFAULT 2,             -- 0 urgent, 1 high, 2 normal, 3 low
  assignee_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  reviewer_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  branch TEXT,
  merge_state TEXT,                                -- null | pending_approval | queued | merged | conflict | failed
  blocked_reason TEXT,
  continue_requested INTEGER NOT NULL DEFAULT 0,
  auto_continues INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,                        -- owner | agent:<id> | system
  sort_order REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (project_id, number)
);
CREATE INDEX idx_tasks_project ON tasks(project_id, status);
CREATE INDEX idx_tasks_assignee ON tasks(assignee_id, status);

CREATE TABLE task_deps (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, depends_on_id)
);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                              -- direct | team | task
  participant_key TEXT NOT NULL,                   -- 'team' | 'task:<id>' | sorted participants for direct conversations
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  agent_streak INTEGER NOT NULL DEFAULT 0,         -- consecutive agent messages since the owner last spoke
  loop_guard_tripped INTEGER NOT NULL DEFAULT 0,
  last_message_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, participant_key)
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_type TEXT NOT NULL,                       -- owner | agent | system
  sender_id TEXT,                                  -- agent id when sender_type = agent
  body TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'chat',               -- chat | fyi | report | system
  expects_reply INTEGER NOT NULL DEFAULT 1,
  run_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_messages_conv ON messages(conversation_id, created_at);

-- What each agent still has to look at. Runs consume inbox items; failed runs give them back.
CREATE TABLE inbox (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  type TEXT NOT NULL,                              -- message | task_assigned | review_requested | changes_requested | approval_decided | task_unblocked | merge_result | nudge
  ref_id TEXT,
  task_id TEXT,
  summary TEXT NOT NULL,
  wake INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending',          -- pending | delivered | done
  run_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_inbox_agent ON inbox(agent_id, status);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'agent',              -- agent | merge
  agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  runner_id TEXT REFERENCES runners(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'queued',           -- queued | running | succeeded | failed | cancelled
  trigger TEXT NOT NULL,                           -- inbox | continue | manual | merge
  focus_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  session_key TEXT,
  resume_session_id TEXT,
  provider_session_id TEXT,
  prompt TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL DEFAULT '{}',
  result_text TEXT,
  error_kind TEXT,                                 -- rate_limit | auth | billing_guard | timeout | max_turns | crash | cancelled | runner_lost | git
  error_detail TEXT,
  usage TEXT NOT NULL DEFAULT '{}',
  git TEXT NOT NULL DEFAULT '{}',
  token_hash TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  owner_reply_conversation_id TEXT,
  queued_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX idx_runs_status ON runs(status, runner_id);
CREATE INDEX idx_runs_agent ON runs(agent_id, queued_at);
CREATE INDEX idx_runs_project ON runs(project_id, queued_at);

CREATE TABLE run_events (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE sessions (
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  session_key TEXT NOT NULL,
  provider_session_id TEXT NOT NULL,
  runner_id TEXT,
  run_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, session_key)
);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  number INTEGER NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  run_id TEXT,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,                              -- decision | architecture | security | destructive | production | permission | merge | plan | other
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',          -- pending | approved | rejected | cancelled
  decision_note TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX idx_approvals_status ON approvals(status, project_id);

-- One-off permissions granted by approving a gated tool call.
CREATE TABLE grants (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  approval_id TEXT REFERENCES approvals(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  match TEXT NOT NULL,
  uses_left INTEGER NOT NULL DEFAULT 1,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE decisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '',
  decision TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'accepted',         -- accepted | rejected | superseded
  decided_by TEXT NOT NULL,                        -- owner | agent:<id>
  approval_id TEXT,
  task_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE docs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  updated_by TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, slug)
);

CREATE TABLE commits (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sha TEXT NOT NULL,
  branch TEXT,
  message TEXT NOT NULL,
  author TEXT,
  agent_id TEXT,
  run_id TEXT,
  task_id TEXT,
  committed_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, sha)
);

CREATE TABLE activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT,
  actor TEXT NOT NULL,                             -- owner | agent:<id> | system | runner:<id>
  type TEXT NOT NULL,
  summary TEXT NOT NULL,
  subject_type TEXT,
  subject_id TEXT,
  data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_activity_project ON activity(project_id, id);
`,
  },
];
