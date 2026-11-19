# Feasibility: running a team of agents on Claude subscriptions

Status: **verified by experiment** unless marked otherwise. Experiments were run on 2026-11-18
against Claude Code CLI `2.1.327` in a Linux container. The transcripts are in
`server/test/fixtures/` and the driver tests replay them.

## TL;DR

| Question | Answer |
|---|---|
| Can a program drive Claude Code with a Max subscription and no API billing? | **Yes.** Run the unmodified `claude` CLI in headless mode (`claude -p … --output-format stream-json`), signed in with the subscription. Every run reports which credential it used (`apiKeySource`), so we can check it. |
| Can two independent Max accounts be used side by side? | **Yes, on one machine or on several.** Each account gets its own `CLAUDE_CONFIG_DIR` (the documented way to stay signed in to several accounts). Each directory holds its own login, sessions and settings. |
| Can account A control account B's cloud sessions (claude.ai/code)? | **No supported path.** Cloud-session tooling is scoped to the session owner's account. AgentOS doesn't try. Agents talk to each other through AgentOS, never through each other's sessions. |
| Can AgentOS start Claude Code on the web sessions on each account? | **Yes, with a documented API.** A routine with an API trigger is fired with `POST …/routines/trig_…/fire` and a per-routine token, which returns the new session's ID and URL. Each account gets its own routine, so AgentOS acts as the hub between accounts. See [cloud.md](cloud.md). |
| Can agents talk to each other? | **Yes, through AgentOS.** Each run gets an HTTP MCP server (AgentOS's `/mcp` endpoint) with a per-run bearer token. Claude calls `send_message`, `create_task`, `request_approval`, … and AgentOS records and routes everything. |
| Can AgentOS enforce approvals for dangerous actions? | **Yes.** `--permission-prompt-tool mcp__agentos__permission_gate` sends every non-pre-approved tool call to AgentOS's policy engine. Verified: `rm -rf` was denied and turned into an owner approval. The agent got the explanation and carried on. |
| Can work resume after a crash or limit? | **Yes.** `--resume <session_id>` continues the same conversation (verified). AgentOS also keeps all project state in its own database and rebuilds context into a fresh session when a resume isn't possible. |
| Can we see usage limits? | **Yes.** Subscription runs emit `rate_limit_event` with 5-hour and 7-day utilization and reset times. AgentOS uses them to pause an account before it hits the wall and to resume it after the reset. |

## The billing trap (critical requirement)

Claude Code picks credentials in this documented order, and **the first match wins**:

1. Cloud provider env vars (`CLAUDE_CODE_USE_BEDROCK/VERTEX/FOUNDRY`)
2. `ANTHROPIC_AUTH_TOKEN`
3. `ANTHROPIC_API_KEY`. In `-p` mode it is *always* used when present, with no prompt.
4. `apiKeyHelper` from **any** settings source, including the repository's `.claude/settings.json`
5. `CLAUDE_CODE_OAUTH_TOKEN` (subscription token from `claude setup-token`)
6. Anthropic profiles (`ANTHROPIC_PROFILE`, federation variables)
7. Subscription login from `/login` (stored in `$CLAUDE_CONFIG_DIR/.credentials.json`)

So a subscription run can silently become an API-billed run in three ways: a stray env var on the runner host, a profile on disk, or **a settings file inside the repository being worked on**. An agent could even write that file itself.

Experiments:

| Setup | `claude auth status --json` | `apiKeySource` in the stream's `init` event |
|---|---|---|
| Subscription only | `authMethod: oauth_token` | `none` |
| `ANTHROPIC_API_KEY=…` in env | `authMethod: api_key` | `ANTHROPIC_API_KEY` |
| repo `.claude/settings.json` has `apiKeyHelper` | `authMethod: api_key_helper` | `apiKeyHelper` |
| same repo, but `--setting-sources user` | n/a | `none` |

AgentOS's **billing guard** (implemented in `server/src/runner/billing-guard.ts`) has four layers:

1. **Allow-listed environment.** The child process gets a small, explicit set of env vars (PATH, HOME, locale, proxy/CA vars, `CLAUDE_CONFIG_DIR`). It is not built by deleting things from the runner's environment. `ANTHROPIC_*`, `CLAUDE_CODE_USE_*` and similar variables never reach it.
2. **No repository settings.** Runs use `--setting-sources user` plus AgentOS's own `--settings`. Project-level `.claude/settings*.json` can't inject `apiKeyHelper` or hooks. The permission gate also refuses agent writes to `.claude/settings*.json`.
3. **Preflight.** Before the first run on an account, and again every few minutes, the runner runs `claude auth status --json` with the exact env, cwd and flags of the real run. It refuses if `apiKeySource` is set (anything other than `none`), if `authMethod` is an API method, or if the user isn't logged in.
4. **Runtime tripwire.** The first stream event (`system/init`) carries `apiKeySource`. If it isn't `none`, the runner kills the process right away and marks the account `billing_blocked`. This is defense in depth: the init event is emitted *before* the first model request, but a kill races the request, so layers 1–3 are what actually prevent the charge.

Never use `--bare`. It reads only `ANTHROPIC_API_KEY`/`apiKeyHelper` and ignores OAuth entirely.

`total_cost_usd` appears in every result event, **including subscription runs** (`costBasis: "list"`). It is an API list-price *equivalent*, not a charge. The dashboard labels it "API-equivalent cost (not billed)".

## Terms and credential handling

From Anthropic's Claude Code *Legal and compliance* page (fetched 2026-11-18):

- OAuth (subscription) authentication "is intended exclusively for purchasers of … Pro, Max … plans and is designed to support ordinary use of Claude Code".
- It does **not** "prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code."
- "Developers may not collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow."
- "Advertised usage limits for Pro, Max, and Ultra plans assume ordinary, individual usage of Claude Code and the Agent SDK."
- The Agent SDK docs add that third-party developers may not *offer* claude.ai login in their products.

Design consequences:

- AgentOS runs the **unmodified `claude` binary**. It doesn't embed the Agent SDK with OAuth or call the API with subscription tokens.
- AgentOS **never sees, stores or relays subscription credentials.** You sign in on the runner machine with Anthropic's own flow (`agentos runner login <account>` just runs `claude auth login` with that account's `CLAUDE_CONFIG_DIR` in your terminal). Credentials stay in Claude Code's own credential file on the runner. The control plane only stores the *path* of the config directory and the status the runner reports.
- `claude setup-token` (one-year, inference-only token) is supported as an alternative: you put it in the runner's local env file yourself. It never goes to the control plane.
- **Owner decision required:** whether orchestrated, mostly autonomous use of two personal Max accounts counts as "ordinary, individual usage" is a judgment about Anthropic's terms that AgentOS can't make for you. AgentOS stays within documented mechanisms and gives you the controls you need either way: per-account concurrency (default 1), run caps per hour, quiet hours, a global pause, and usage-aware scheduling. If you need certainty, ask Anthropic. The documented alternative for always-on automation is API-key billing, which AgentOS deliberately doesn't enable by default.

## Other verified details

- **Headless invocation:** `claude -p <prompt> --output-format stream-json --verbose` emits JSONL. Event types seen: `system/init`, `assistant` (text / tool_use blocks), `user` (tool_result blocks), `rate_limit_event`, `system/thinking_tokens`, `result`.
- **Result event:** `subtype`, `is_error`, `api_error_status` (e.g. `401`), `result` (final text), `session_id`, `num_turns`, `usage`, `total_cost_usd`, `permission_denials[]`, `terminal_reason`.
- **MCP over HTTP:** `--mcp-config '{"mcpServers":{"agentos":{"type":"http","url":…,"headers":{"Authorization":"Bearer …"}}}}'` with `--strict-mcp-config` works. The init event reports `mcp_servers: [{name:"agentos", status:"connected"}]`. MCP tools are *deferred*: Claude loads them through `ToolSearch` on first use. That is transparent but costs one extra tool call.
- **Permission gate contract:** input `{tool_name, input, tool_use_id}`. The output text is JSON, either `{"behavior":"allow","updatedInput":…}` or `{"behavior":"deny","message":…}`. Read-only Bash (`pwd`, `ls`) was auto-allowed without consulting the gate.
- **Stdin:** pass `< /dev/null` (spawn with `stdin: 'ignore'`), or the CLI waits 3 s for piped input.
- **Session IDs:** `--session-id <uuid>` pre-assigns an ID. `--resume <id>` keeps the same ID.

## Not yet verified (needs your hardware or accounts)

- `authMethod` for a classic `/login` Max sign-in. The test container signs in through a host-managed OAuth token and reports `oauth_token`. The guard therefore keys on `apiKeySource` (must be absent or `none`) and on a deny-list of API methods, rather than an allow-list of subscription method names.
- The exact shape of a run that *hits* the usage limit. The parser treats `rate_limit_event.status == "rejected"`, `api_error_status == 429` or a "usage limit" result text as rate-limited, and uses the event's `resetsAt` for the pause.
- Codex CLI and Gemini CLI drivers. The driver interface is designed for them (`codex exec --json`, `gemini -p`) but they aren't implemented or tested.
