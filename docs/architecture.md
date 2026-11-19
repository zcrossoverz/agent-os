# Architecture

AgentOS is a **control plane** for coding agents. It doesn't contain an agent. It runs existing coding-agent CLIs (today: Claude Code), gives them a shared, persistent workspace (tasks, messages, docs, approvals), and decides when each one should work.

## Components

| Component | Where | Responsibility |
|---|---|---|
| **Control plane** (`server/src/http`, `services`, `orchestrator`) | VPS | REST API and SSE for the dashboard, scheduler, MCP endpoint for agents, runner protocol, SQLite database |
| **Runner** (`server/src/runner`) | VPS and/or your machines | Executes runs for the accounts signed in on that machine: git worktrees, billing guard, provider drivers. Outbound HTTP only. |
| **Cloud worker** (`orchestrator/cloud.ts`) | control plane | Cloud mode: fires account routines to start Claude Code on the web sessions, merges through the GitHub API, watches quiet sessions ([cloud.md](cloud.md)) |
| **Drivers** (`runner/drivers`) | inside a runner | `claude-code` (unmodified CLI, headless) and `mock` (deterministic scripted agent for tests and demos). Codex and Gemini are planned as additional drivers. |
| **Dashboard** (`web/`) | served by the control plane | React SPA, live through SSE |

Single binary entry point: `agentos server [--embedded-runner]`, `agentos runner --server … --token …`, `agentos login <config-dir>`.

## Source of truth

Everything that matters lives in AgentOS's database (`server/src/db/schema.ts`), not in agent conversations:

- `projects`, `agents`, `accounts`, `runners`
- `tasks` and `task_deps`: epics, tasks and subtasks, status, assignee and reviewer, branch, merge state
- `conversations`, `messages`: direct (owner↔agent, agent↔agent), team channel, per-task threads
- `inbox`: what each agent still has to look at
- `runs`, `run_events`, `sessions`: every working session of an agent, its full event log, and the provider session to resume
- `approvals`, `grants`, `decisions`, `docs`, `commits`, `activity`

Agent sessions are a cache. A run resumes the agent's previous Claude session for the same context key when it can. When it can't (new runner, lost session, reset), it starts fresh with a **context-recovery preamble** built from the database: project, team, brief, recent decisions, the focus task and its thread, and for the PM the recent owner conversation and open tasks.

## Execution model: event-driven runs

Agents don't run continuously. Something lands in an agent's **inbox**: a message, an assignment, a review request, an approval decision, an unblocked task, a merge problem or a nudge. Each item is marked *wake* or *FYI*. Every second (and on every change), the scheduler (`orchestrator/scheduler.ts`) looks for agents that:

1. have wake-worthy inbox items or an explicit continuation request,
2. have no active run,
3. belong to a project that isn't paused and is under its concurrent-run limit,
4. are bound to an account that is ready (signed in, not rate-limited, not billing-blocked, runner online, below its concurrency),
5. are under their hourly run budget.

For such an agent it creates a **run**: it picks one **focus task** (changes requested > merge problem > assignment > unblocked > review), attaches the related inbox items, chooses a **session key** (`main` for the PM, `task:<id>` for task work), and renders the **wake prompt**. The wake prompt tells the agent why it was woken and what to look at, and it's stored on the run, so "why did the agent do this?" always has an answer.

A runner claims the run (long-poll), prepares the agent's worktree (switching to the task branch), runs the driver, streams normalized events back, and completes the run with a result, usage, rate-limit info and a git report. On completion the control plane:

- consumes the inbox items, or hands them back on failure (up to 3 attempts),
- stores the provider session for that context key,
- updates account health (usage windows, rate-limit pause until reset, auth required, billing blocked),
- records commits, attributed by the agent's git identity,
- posts the agent's final answer to the owner if the owner's direct message triggered the run (unless the agent already replied),
- flags continuation when the agent ran out of turns or time.

Side effects run after the run itself is finalized, so a failing side effect can never leave a run stuck.

## How agents coordinate: MCP tools

Each run gets an HTTP MCP server (`/mcp`) authenticated with a **per-run bearer token**, which is valid only while the run is active. The tools (`server/src/mcp/tools.ts`):

| Area | Tools |
|---|---|
| Orientation | `get_project_overview`, `list_tasks`, `get_task` |
| Planning (PM / collaborative) | `create_task`, `update_task`, `assign_task` |
| Doing | `start_task`, `checkpoint`, `submit_for_review`, `block_task`, `comment_on_task` |
| Reviewing | `review_task` (approve / request_changes) |
| Talking | `send_message` (to owner, pm, @handle, team, or a task thread), `read_messages` |
| Governance | `request_approval`, `record_decision` |
| Knowledge | `list_docs`, `read_doc`, `write_doc` |
| Internal | `permission_gate` (Claude Code's `--permission-prompt-tool`) |

Authorization is enforced server-side by role and mode. In a PM-led project only the PM (or the owner) assigns work. Other agents create subtasks of their own task or unassigned backlog proposals. Reviewers can't review their own work. Supervised projects park agent-created work in the backlog until the owner approves the plan.

The agents' standing instructions ("operating manual", `orchestrator/prompts.ts`) are appended to Claude Code's default system prompt. They cover communication etiquette, mandatory escalation, git rules and the task lifecycle.

## Guardrails against runaway behaviour

| Risk | Mechanism |
|---|---|
| Agents ping-ponging | Per-conversation agent streak. After *N* consecutive agent messages without owner input, agent messages stop waking recipients and a notice is posted. FYIs never wake anyone. @mentions in private conversations don't wake third parties. |
| Endless "continue" loops | Continuation only on explicit `checkpoint(continue=true)` or running out of turns or time, capped at *N* per task. Then the PM (or the owner) is asked to split or re-scope the task. |
| Burning subscription usage | Max runs per agent per hour, per-account concurrency (default 1), per-project concurrency, usage-window tracking, auto-pause on limit, global pause. |
| Duplicate work | Single assignee per task, one active run per agent, one focus task per run, dedup of identical pending inbox items and approvals, board visible to every agent. |
| Conflicting code changes | Worktree per agent, branch per task, merges serialized by AgentOS in the main clone. A conflict sends the task back to its author to rebase. |
| Dangerous actions | Mandatory `request_approval` for architecture, security, destructive and production work, plus the **permission gate**: risky Bash commands, edits outside the worktree, edits to Claude settings and credential access are denied and turned into owner approvals. An approved command gets a single-use grant. |

## Git strategy

```
<runner data>/repos/<project>             main clone, base branch checked out, merges happen here
<runner data>/worktrees/<project>/<agent> agent worktree (scratch branch agent/<slug>, or a task branch)
```

- The task branch is `task/<key>-<slug>`, created from the base branch when work starts. Agents commit with their own identity (`<Name> (AgentOS) <slug@agents.agentos.local>`).
- Before switching branches, leftovers are auto-committed as WIP, so nothing an agent wrote is lost.
- Approved work is merged with `--no-ff` into the base branch, either automatically or after owner approval, depending on the merge policy and autonomy. It can optionally be pushed to `origin`.
- All agents of a project share one runner (one repository). Spreading a project over several runners requires a shared remote (roadmap).

## Billing guard and credentials

See [feasibility.md](feasibility.md#the-billing-trap-critical-requirement). In short: an allow-listed child environment, `--setting-sources user`, preflight `claude auth status --json`, and a runtime tripwire on `apiKeySource`. `--bare` is never used. Subscription credentials stay in Claude Code's own credential file inside the account's `CLAUDE_CONFIG_DIR` on the runner. The control plane stores only that path and the status the runner reports. Agents are denied `Read`/`Edit` of the config and runtime directories, and the permission gate stops shell commands that touch credentials.

## Security model

- **Dashboard:** a single owner password (scrypt), an HMAC-signed `HttpOnly; SameSite=Strict` session cookie, CSRF header on mutations, and a login rate limit. Bind to localhost and put TLS in front (Caddy example in `deploy/`).
- **Runners:** per-runner tokens (hashed at rest), outbound-only connections, and a runner only sees runs for its own accounts.
- **Agents:** a per-run MCP token, a role-scoped tool surface, and the permission gate. Agents share the runner's OS user. For strong isolation between agents or accounts, run separate runners under separate OS users or containers (roadmap: per-agent sandboxing).

## Extending to other providers

A provider is a runner driver (`AgentDriver.run(ctx) → RunCompletion`) that must:

1. execute the CLI headless in the given worktree with the given environment,
2. connect it to the AgentOS MCP endpoint (Codex CLI and Gemini CLI both support MCP),
3. normalize its event stream into `init / assistant_text / tool_use / tool_result / rate_limit / result`,
4. classify failures (`auth`, `rate_limit`, `max_turns`, …),
5. implement the provider's equivalent of the billing guard.

The control plane, prompts and dashboard stay unchanged.
