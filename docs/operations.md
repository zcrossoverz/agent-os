# Operations: deploy, connect accounts, run

## Deployment options

### A. One VPS (simplest)

The control plane, dashboard and an **embedded runner** run in one process. Your Claude accounts sign in on the VPS.

**Docker:**

```bash
cd deploy
# edit docker-compose.yml: AGENTOS_PUBLIC_URL (and optionally AGENTOS_OWNER_PASSWORD)
docker compose up -d --build
docker compose logs agentos | grep "Initial dashboard password"
```

Put TLS in front (`deploy/Caddyfile`). The compose file binds port 4600 to localhost only.

**systemd (no Docker):**

```bash
sudo useradd --system --create-home agentos
sudo mkdir -p /opt/agentos /var/lib/agentos && sudo chown agentos: /opt/agentos /var/lib/agentos
sudo -u agentos git clone <this repo> /opt/agentos && cd /opt/agentos
sudo -u agentos npm ci && sudo -u agentos npm run build
sudo npm install -g @anthropic-ai/claude-code        # the unmodified Claude Code CLI
sudo cp deploy/agentos-server.service /etc/systemd/system/ && sudo systemctl enable --now agentos-server
journalctl -u agentos-server | grep "Initial dashboard password"
```

### B. Hybrid: control plane on a VPS, runners on your machines

Use this when you'd rather keep subscription logins on your own computer, or need its tools.

1. Start the server without `--embedded-runner` (or keep it for other projects).
2. In the dashboard: **Accounts & runners → Register runner**. Copy the one-time command.
3. On your machine (Node 22+, git, Claude Code CLI, a checkout of AgentOS with `npm ci && npm run build`):
   ```bash
   node server/dist/cli.js runner --server https://agentos.example.com --token aor_…
   ```
   or install `deploy/agentos-runner.service` with the token in `/etc/agentos/runner.env`.
4. Add accounts with that runner selected, and sign them in **on that machine**.

The runner only makes outbound HTTPS requests (heartbeat, long-poll, events), so it works behind NAT. Agents reach the MCP endpoint through the same URL the runner uses.

## Connecting your Claude subscriptions

One AgentOS **account** = one Claude subscription login = one `CLAUDE_CONFIG_DIR` on a runner.

1. **Add account** (provider *Claude Code*). Leave the config directory empty to get a dedicated directory under the runner's data dir, or point it at an existing `CLAUDE_CONFIG_DIR` to reuse a login.
2. **Sign-in instructions** shows the exact command. Run it on the runner machine as the user that runs AgentOS:
   ```bash
   CLAUDE_CONFIG_DIR='/var/lib/agentos/runner/accounts/acc_…/claude' claude auth login --claudeai
   # or: node server/dist/cli.js login '~runner/accounts/acc_…/claude' --data-dir /var/lib/agentos/runner
   # Docker: docker compose exec agentos node /app/server/dist/cli.js login '<dir>' --data-dir /data/runner
   ```
   This is Anthropic's own login flow. Pick the **Claude subscription**, not Console/API.
3. The runner checks `claude auth status --json` every few minutes (and before each run). The account becomes **Ready** once it sees a subscription login with no API key source.

Headless alternative: `claude setup-token` creates a one-year subscription token. Save it on the runner as `<config dir>/agentos-oauth-token` (mode 600). The runner passes it as `CLAUDE_CODE_OAUTH_TOKEN` to that account's runs only. It never reaches the control plane.

For two Max accounts, add two accounts and sign each into its own directory. They stay fully independent: separate logins, separate usage windows, separate session histories.

### Account states

| State | Meaning | What to do |
|---|---|---|
| Checking… | Not checked yet | Wait for the runner heartbeat |
| Ready | Subscription login confirmed | — |
| Sign-in required | Not logged in or the token expired | Run the sign-in command, then **Re-check** |
| Usage limit | The 5-hour or weekly window is exhausted | Nothing. Runs resume after the reset time shown |
| Billing guard | An API credential was detected | Remove `ANTHROPIC_API_KEY` / `apiKeyHelper` / profiles on the runner, then **Re-check** |

## Day-to-day

- **Talk to the PM** from the project overview or Chat. Give objectives, not instructions for each agent.
- **Watch "Needs your attention"** on the Overview: approvals, agents' questions, blocked tasks, account problems.
- **Supervised mode** is a good default for new projects: you approve plans and every merge. Switch to **Autonomous** when you trust the setup.
- **Pause** stops new runs immediately. Messages wait in inboxes and nothing is lost.
- **Nudge** wakes an agent for a check-in. **Reset context** forgets the provider sessions. Project state stays, and the next run rebuilds context.
- **Runs → Why it ran** shows the exact wake-up message an agent received. The log shows every tool call.

## Data, backups, upgrades

- Everything lives in the data directory (`AGENTOS_DATA_DIR`, Docker volume `/data`):
  - `agentos.db` (+ `-wal`): projects, tasks, messages, decisions, runs. Back it up with `sqlite3 agentos.db ".backup backup.db"` or by copying while stopped.
  - `runner/repos`, `runner/worktrees`: the agents' git repositories. Push them to a remote if you need off-site copies.
  - `runner/accounts/*/claude`: **Claude credentials**. Treat them as secrets and exclude them from shared backups.
- Upgrades: `git pull && npm ci && npm run build`, then restart. Database migrations apply automatically on start.
- Logs go to stdout/stderr (journald or `docker logs`). `AGENTOS_LOG_LEVEL=debug` adds detail.

## Security checklist

- [ ] TLS reverse proxy in front, server bound to `127.0.0.1`
- [ ] Strong owner password (`AGENTOS_NEW_PASSWORD=… agentos set-password`)
- [ ] No `ANTHROPIC_API_KEY` in the runner's environment (the guard strips it, but don't rely on that alone)
- [ ] Data directory readable only by the `agentos` user
- [ ] Runner tokens rotated if a machine is lost (**Accounts & runners**, or delete the runner)
- [ ] For projects with sensitive code: dedicated runner per project under its own OS user

## Troubleshooting

| Symptom | Check |
|---|---|
| Agent stays **Waiting** | Its status line says why: no account, account not ready, runner offline, throttled, or project paused |
| Agent in **Needs attention** | Runs → the failed run's error. Fix the cause (sign-in, billing), then **Resume** on the Agents page |
| Runner offline | The runner process is running, `--server` URL is reachable, token is valid |
| "AgentOS tools missing" warning in a run | The runner can't reach `<server>/mcp`. Check proxies (`NO_PROXY` gets the server host automatically) |
| Merge conflict | The task goes back to its author with the conflicting files. They rebase and resubmit. **Retry merge** is in the task drawer |
