# Verification

This page records what was actually tested, how, and what it found. Last updated 2026-11-19.

## 1. Feasibility experiments (real Claude Code CLI 2.1.327)

See [feasibility.md](feasibility.md). Verified: headless stream-json output; `apiKeySource: "none"` under subscription auth; `ANTHROPIC_API_KEY` and a repo-level `apiKeyHelper` silently switch to API billing; `--setting-sources user` blocks the repo-level helper; `--resume` keeps the session; HTTP MCP with a bearer header connects; `--permission-prompt-tool` receives risky tool calls and its deny message reaches the agent; `rate_limit_event` reports 5-hour and 7-day utilization.

## 2. Automated tests: `npm test` (31 passing)

| Suite | What it proves |
|---|---|
| `e2e-mock.test.ts` | One owner message → the PM plans 2 tasks → two developers implement on task branches with real git commits → the reviewer approves → AgentOS merges both into `main` → the PM reports completion. All through the real HTTP API, scheduler, runner, MCP endpoint and permission gate. A second case covers a rejected review → fix → resubmit → merge. |
| `claude-driver.test.ts` | The Claude driver parses a **real captured transcript**. It passes the safety flags, sends the prompt on stdin, keeps the run token out of argv and deletes its temp file, strips `ANTHROPIC_API_KEY`, resumes without the recovery preamble, kills an API-billed session in under a second, classifies usage-limit, auth and max-turn failures, falls back to a fresh session when the old one is gone, and enforces timeouts. Billing-guard env and auth-status evaluation are tested here too. |
| `orchestration.test.ts` | Wake rules (owner, FYI, team, @mentions; no wake for mentions in private conversations), the loop guard, PM-only assignment vs. collaborative mode, dependency gating and unblocking, cycle detection, review routing and changes-requested, merge-approval policy (including no re-review of approved work), supervised plan approval and decision log, one focus task per run, paused projects, rate-limited accounts, hourly throttling, inbox hand-back on failure, owner reply and session resume, billing-blocked accounts and recovery, the continuation limit with escalation, and the permission gate's allow/deny/grant behaviour and worktree confinement. |

## 3. Live smoke test with real Claude Code agents

`AGENTOS_REAL_CLAUDE=1 npx vitest run test/real-claude.smoke.test.ts` (model: Haiku, to keep usage small). Two Claude agents (PM *Pia*, developer *Dan*) on a subscription login, plus a mock reviewer. The owner asked the PM to create one task, *"Add hello.txt"*, for @dan with @rex as reviewer. Observed (≈17 s, all runs `apiKeySource: none`, AgentOS MCP `connected`):

```
--- Pia (PM)          succeeded  turns=5  API-equivalent $0.004 (not billed)
   mcp__agentos__list_tasks {"include_closed":true}
   mcp__agentos__create_task {"title":"Add hello.txt","acceptance_criteria":"hello.txt at the repo root contains…","assignee":"@dan","reviewer":"@rex"}
   mcp__agentos__send_message {"to":"owner","body":"Created SMK-1 \"Add hello.txt\", assigned to @dan with @rex as reviewer…"}
--- Dan (developer)   succeeded  turns=6  API-equivalent $0.004 (not billed)
   Bash  printf 'hello agentos\n' > hello.txt            (allowed by the permission gate)
   mcp__agentos__start_task {"task":"SMK-1"}
   Bash  git add hello.txt && git commit -m "SMK-1: add hello.txt …"
   mcp__agentos__submit_for_review {"task":"SMK-1","summary":"Added hello.txt …"}
--- Rex (mock reviewer) succeeded: review_task approve
--- merge              succeeded: main now contains hello.txt = "hello agentos"
```

The first live run surfaced three real bugs, now fixed and covered by regression tests:

1. The owner wrote to the PM "assign it to @dan". The @mention woke Dan, whose answer was then routed into the owner↔PM conversation and rejected. Mentions in private conversations no longer wake third parties.
2. Owner replies are posted only into conversations the agent belongs to.
3. A failing post-completion side effect made the runner retry the completion five times and left runs stuck in `running`. Completion is now finalized first, and side effects are isolated.

## 4. Dashboard walkthrough (headless Chromium, Playwright)

The scripted walkthrough covered sign-in (wrong password rejected), overview, project overview, settings (merge policy → owner approval), chatting with the PM, watching the board fill, approving merges from the approvals page, the task drawer, runs (log and "why it ran"), agents, activity, knowledge, git, and accounts. It found and fixed:

- rebuilt dashboard assets weren't served (static plugin only knew files present at start-up),
- a crash in the chat thread effect, and a request for `/api/projects//agents` before the project loaded,
- a reviewer re-approving a task that was already approved and waiting for merge approval,
- unset CLI flags overriding config defaults (server failed to start without `--data-dir`).

Screenshots: [overview](screenshots/overview.png), [chat with the PM](screenshots/chat.png), [board](screenshots/board.png), [approvals](screenshots/approvals.png), [task detail](screenshots/task.png), [runs](screenshots/runs.png).

## 5. Not verified yet

- Building the Docker image (no Docker daemon in the development environment).
- A classic `/login` Max sign-in on a fresh machine (the test environment signs in through a host-managed OAuth token). The guard is written not to depend on the exact method name.
- The exact output of a run that hits the subscription usage limit.
- Long, multi-hour autonomous sessions with Opus-class models on a real codebase.
