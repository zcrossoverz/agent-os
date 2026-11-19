# Roadmap and progress

## Milestones

| | Milestone | Status |
|---|---|---|
| M0 | **Feasibility**: verify subscription-based headless Claude Code, multi-account isolation, MCP tool channel, permission gate, session resume, usage signals, billing pitfalls, terms | ✅ Done ([feasibility.md](feasibility.md)) |
| M1 | **Core orchestration**: data model, scheduler, inbox and wake model, MCP tools, approvals and permission gate, loop and usage guards, runner protocol, git worktrees and merges, Claude Code and mock drivers, billing guard | ✅ Done |
| M2 | **Dashboard**: overview and attention center, accounts and runners, project overview, board, task drawer, chat, agents, approvals and decision log, runs with live logs, activity, knowledge, git, settings | ✅ Done |
| M3 | **Verification**: unit, e2e (mock agents with real git and MCP), live smoke test with real Claude Code on a subscription, scripted browser walkthrough | ✅ Done ([verification.md](verification.md)) |
| M4 | **Deployment**: Dockerfile, compose, Caddy, systemd units, operations guide | ✅ Written. ⚠️ The Docker image hasn't been built here (no Docker daemon in the dev environment); the systemd units follow the same commands that were tested by hand |
| M5 | **GitHub integration**: push task branches, open PRs per task, PR links on tasks, CI status from checks, merge through PRs instead of locally | ⏳ Next |
| M6 | **Multi-runner projects**: shared remote as the hand-off point between runners, so one project can use accounts on different machines | ⏳ Planned |
| M7 | **More providers**: Codex CLI and Gemini CLI drivers (MCP + headless JSON output), per-provider billing guards | ⏳ Planned |
| M8 | **Stronger isolation**: per-agent OS user or container sandbox, network policy per agent | ⏳ Planned |
| M9 | **Smarter scheduling**: usage-aware account balancing (prefer the account with the most headroom), quiet hours, per-project usage budgets, optional failover of an agent to another account | ⏳ Planned |
| M10 | **Quality of life**: notifications (email/push/Slack) for approvals and questions, search, task templates, burndown, cost/usage reports | ⏳ Planned |

## Known limitations (v0.1)

- **One runner per project.** All agents of a project share one repository on one runner. Agents on different runners need M6.
- **Local merges.** Approved work is merged in the runner's clone. Pushing is optional (`push_on_merge`). There are no PRs yet (M5).
- **Shared OS user.** Agents on a runner share its OS user. The permission gate and Claude Code's permission rules confine them to their worktree, but that isn't a sandbox (M8).
- **Heuristic permission rules.** The Bash risk rules are pattern-based. They catch the common dangerous commands but not obfuscated ones. Keep supervised mode for sensitive repos.
- **Usage-limit result shape is unverified.** Detection relies on `rate_limit_event.status == "rejected"`, HTTP 429 or "usage limit" text. The exact result of a run that hits the wall hasn't been observed yet.
- **`authMethod` for a classic `/login` Max sign-in is unverified.** The test environment reports `oauth_token`. The guard keys on `apiKeySource` and an API-method deny-list, so it doesn't depend on the exact subscription method name.
- **Single owner.** There is one dashboard user. Multi-user teams aren't modelled.
- **SQLite via `node:sqlite`.** This is still flagged experimental in Node 22 (works, prints a warning that we suppress). The DB layer is thin, so Postgres is a contained change if needed.

## Progress log

- **2026-11-18:** Feasibility experiments against Claude Code 2.1.327: headless stream-json, `apiKeySource`, API-key and repo-`apiKeyHelper` traps, `--setting-sources user`, resume, HTTP MCP with bearer header, permission prompt tool. Core server, runner, drivers, scheduler and MCP tools built. E2E with mock agents passing. Live smoke test with real Claude agents (Haiku) passing after fixing three issues it found: mention routing, owner-reply scoping, and completion robustness. Dashboard built and walked through in a headless browser, which found two more issues: static asset serving and repeat reviews of approved tasks.
