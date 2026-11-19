# Cloud mode: agents as Claude Code on the web sessions

In cloud mode every agent runs as a **Claude Code on the web** session (claude.ai/code) on its own Claude account, working on the project's **GitHub repository**. No machine of yours runs agents. AgentOS on a VPS is the hub: it plans with the PM, decides who works next, starts the sessions, receives every coordination call, and merges reviewed branches on GitHub.

## How it works

```
 AgentOS (your VPS, public HTTPS)                          claude.ai (Anthropic cloud), per account
 ├ scheduler: "Linus has CLD-2"                            ┌───────────────────────────────────────┐
 ├ POST …/routines/trig_A/fire  ── {text: "run code"} ──►  │ routine "AgentOS" (repo + environment)│
 │      ◄── {claude_code_session_id, url} ─────────────── │   → new cloud session, fresh repo clone│
 │                                                         │   .mcp.json → https://agentos…/mcp     │
 ├ /mcp  ◄── start_run(run code) ──────────────────────────│   header X-AgentOS-Session: $SESSION   │
 │       ── briefing: role, rules, context, assignment ──► │   Authorization: network secret (proxy)│
 │       ◄── start_task / send_message / submit … ─────────│   git push origin task/cld-2-…  ──► GitHub
 │       ◄── finish_run(summary) ──────────────────────────│                                        │
 └ GitHub API: compare (push check), merges (after review) ◄──────────────────────────── GitHub repo
```

1. **Dispatch.** When an agent has work, AgentOS calls its account's routine API trigger (`POST https://api.anthropic.com/v1/claude_code/routines/trig_…/fire`). The payload carries only the **run code**, because Claude Code wraps fire text as untrusted data. The response gives the new session's ID and URL, which the dashboard links to.
2. **Check-in.** The session clones the repository. The repo's `.mcp.json` connects it to AgentOS and sends `X-AgentOS-Session: ${CLAUDE_CODE_REMOTE_SESSION_ID}`. Anthropic's agent proxy adds `Authorization: Bearer <AgentOS token>` from the cloud environment's **network secret**, so the session never sees the token. The routine's prompt tells Claude to call `start_run(run code)`. AgentOS binds the session to the run and returns the full briefing: role, standing instructions, project context and assignment.
3. **Work.** The agent uses the same AgentOS tools as runner agents: tasks, messages, reviews, approvals and docs. It works on the task branch and pushes it to GitHub. `submit_for_review` checks on GitHub that the branch really has commits. That matters because a cloud session's disk is temporary.
4. **Finish.** `finish_run(summary)` completes the run. If the owner had written to that agent, the summary is posted to them as the reply. A session that goes quiet (default 30 min without AgentOS calls) is failed with a diagnosis, and its work is retried.
5. **Merge.** After review, AgentOS merges the branch into the base branch with the GitHub "merge a branch" API (`POST /repos/{owner}/{repo}/merges`). A conflict sends the task back to its author.

Every wake-up is a **fresh session**. Continuity comes from AgentOS's database (briefing and recovered context) and from GitHub (branches), not from chat history.

| Setup guide in the dashboard | Cloud runs with session links and the AgentOS tool-call log |
|---|---|
| ![Cloud setup guide](screenshots/cloud-setup.png) | ![Cloud runs](screenshots/cloud-runs.png) |

## One-time setup

You need: AgentOS deployed on a VPS with a **public HTTPS domain** ([operations.md](operations.md)), with `AGENTOS_PUBLIC_URL=https://your-domain`, plus a GitHub repository.

### In AgentOS

1. **Accounts & runners → Add account → "Claude Code on the web"** for each Claude account (e.g. Max A, Max B). Leave the routine fields empty. AgentOS shows the account's **AgentOS token** once, together with a step-by-step guide.
2. **New project → GitHub repository workspace.** Enter the repository URL and a **fine-grained GitHub token** with *Contents: read and write* on that repository (used for merges and push checks, stored encrypted).
3. **Project Settings → Set up repository.** This commits `.mcp.json` and `.claude/settings.json` to the base branch. Neither file contains a secret.

### On claude.ai, for each account

1. **Connect GitHub** and install the Claude GitHub App on the repository.
2. **Create a cloud environment** (e.g. "AgentOS", Limited network is fine). Open **Network secrets → Add secret** with host = your AgentOS domain, header `Authorization`, prefix `Bearer`, value = that account's AgentOS token.
3. **Create a routine** at claude.ai/code/routines with the repository, that environment, and the prompt from the setup guide. Add an **API trigger** and generate its token.
4. Back in AgentOS, **Routine trigger** on the account: paste the Fire URL and token. The account becomes **Ready**.

Then add agents to the project bound to these accounts (e.g. PM + backend on Max A, frontend + reviewer on Max B) and talk to the PM.

## Security and billing

- **No Claude credentials in AgentOS.** It stores the routine trigger tokens (scoped by Anthropic to firing one routine, "no read access") and the GitHub token, encrypted with AES-256-GCM (`AGENTOS_SECRET_KEY` or `<data>/secret.key`).
- **Session authentication.** The per-account AgentOS token is held by Anthropic's proxy as a network secret and attached only to requests for your AgentOS host. A request is accepted only if its token matches an account *and* its session ID matches a run AgentOS dispatched for that account.
- **Billing.** Cloud sessions always use the account's subscription. Anthropic documents that an API key set in a cloud environment does not override it. Sessions count toward the account's normal usage limits. Routine fires are limited to 30/hour per routine and 100/hour per account. A `429` pauses the account until the window resets.
- **Isolation.** Each session runs in Anthropic's isolated VM with GitHub credentials kept outside it. There is no AgentOS permission gate in cloud sessions, so destructive or production-impacting actions rely on the mandatory-approval instructions, on the deny rules in `.claude/settings.json`, and on GitHub branch protection for the base branch (recommended).

## What is verified

| Claim | How |
|---|---|
| Fire API shape (headers, body, response, errors, limits) | Anthropic's API reference ("Trigger a routine through the API") |
| Cloud sessions load the repo's `.mcp.json` without a prompt; network secrets are attached by the proxy for listed hosts; the GitHub proxy allows pushing any branch | Anthropic's Claude Code docs (cloud sessions, cloud environments, MCP) |
| `${VAR}` in `.mcp.json` headers is expanded and sent on every MCP request; project MCP servers load in headless runs | **Experiment** with Claude Code 2.1.327 against a test MCP server |
| `CLAUDE_CODE_REMOTE_SESSION_ID` (`cse_01…`) matches the session ID the API returns (`session_01…`) once the prefix is removed | Observed inside a real cloud session |
| The full flow (dispatch, check-in, coordination, push check, GitHub merge, watchdog, 429/401 handling, token and session security) | `test/cloud.test.ts`, with a simulated routine API, simulated cloud sessions and a GitHub API over real git |

**Verified live:** routine-fired sessions on real Claude accounts reached a deployed AgentOS over MCP, ran AgentOS tools without an approval prompt (the network secret was attached by the proxy and `.claude/settings.json` pre-allowed `mcp__agentos`), created tasks and finished their runs.

## Troubleshooting

- **"The AgentOS tools aren't connected" / the run never calls `start_run`.** A cloud session clones the repository's **default branch**, and `.mcp.json` must be on that branch when the session starts. **Set up repository** commits it to the project's base branch, so make the base branch the repository's default branch on GitHub (or pick that branch in the routine). Your AgentOS access log shows no `/mcp` requests at all in this case.
- **Requests reach `/mcp` but are rejected.** Check the environment's network secret: host = your AgentOS domain, header `Authorization`, prefix `Bearer`, value = that account's AgentOS token.
- **A run is stuck in "running" after its session died.** Use **Cancel** on the run; cloud runs end immediately and their messages go back to the agent's inbox. Otherwise the watchdog fails it after 30 minutes without AgentOS calls.

Debug any run with **Runs → Open cloud session**.
