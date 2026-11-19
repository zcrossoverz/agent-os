#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { startServer } from './server.js';
import { Runner } from './runner/runner.js';
import { Core, defaultConfig } from './core/core.js';
import { OwnerAuth } from './http/auth.js';
import { seedDemo } from './seed.js';
import { buildChildEnv } from './runner/billing-guard.js';
import { cliCommand } from './runner/cli-command.js';

const HELP = `AgentOS — orchestration layer for teams of AI coding agents

Usage:
  agentos server [options]          Start the control plane (API, MCP endpoint, scheduler, dashboard)
      --host <host>                 Bind address (default 127.0.0.1, env AGENTOS_HOST)
      --port <port>                 Port (default 4600, env AGENTOS_PORT)
      --data-dir <dir>              Data directory (default ./.agentos, env AGENTOS_DATA_DIR)
      --public-url <url>            URL runners/agents use to reach this server (env AGENTOS_PUBLIC_URL)
      --embedded-runner             Also run a local runner in this process (single-machine setup)
      --claude-bin <path>           Claude Code CLI for the embedded runner (default "claude")
      --seed-demo                   Create a demo project with mock agents on first start

  agentos runner --server <url> --token <token> [--data-dir <dir>] [--capacity N] [--claude-bin <path>]
                                    Start a remote runner (credentials for its accounts stay on this machine)

  agentos login <config-dir> [--data-dir <runner-data-dir>]
                                    Sign a Claude subscription account in on this machine, using Anthropic's
                                    own login flow, into the given CLAUDE_CONFIG_DIR ("~runner/…" paths are
                                    resolved against the runner data dir)

  agentos set-password [--data-dir <dir>]   Set the dashboard owner password (reads AGENTOS_NEW_PASSWORD or prompts)
`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      host: { type: 'string' },
      port: { type: 'string' },
      'data-dir': { type: 'string' },
      'public-url': { type: 'string' },
      'embedded-runner': { type: 'boolean' },
      'claude-bin': { type: 'string' },
      'seed-demo': { type: 'boolean' },
      'no-auth': { type: 'boolean' },
      server: { type: 'string' },
      token: { type: 'string' },
      capacity: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (!cmd || values.help || cmd === 'help') {
    process.stdout.write(HELP);
    return;
  }

  if (cmd === 'server') {
    const port = values.port ? Number(values.port) : undefined;
    const srv = await startServer({
      host: values.host,
      port,
      dataDir: values['data-dir'] ? path.resolve(values['data-dir']) : undefined,
      publicUrl: values['public-url'] ?? process.env.AGENTOS_PUBLIC_URL ?? (port ? `http://127.0.0.1:${port}` : undefined),
      embeddedRunner: !!values['embedded-runner'] || process.env.AGENTOS_EMBEDDED_RUNNER === '1',
      insecureNoAuth: !!values['no-auth'],
      runnerOptions: { claudeBin: values['claude-bin'], capacity: values.capacity ? Number(values.capacity) : undefined },
    });
    if (srv.generatedPassword) {
      process.stdout.write(`\n  Initial dashboard password: ${srv.generatedPassword}\n  (change it with: agentos set-password)\n\n`);
    }
    if (values['seed-demo'] && srv.core.projects.list().length === 0) {
      const p = seedDemo(srv.core);
      process.stdout.write(`  Seeded demo project "${p.name}" with mock agents.\n`);
    }
    const shutdown = async () => {
      await srv.close();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return;
  }

  if (cmd === 'runner') {
    const server = values.server ?? process.env.AGENTOS_SERVER_URL;
    const token = values.token ?? process.env.AGENTOS_RUNNER_TOKEN;
    if (!server || !token) throw new Error('runner needs --server and --token (or AGENTOS_SERVER_URL / AGENTOS_RUNNER_TOKEN)');
    const runner = new Runner({
      serverUrl: server,
      token,
      dataDir: path.resolve(values['data-dir'] ?? process.env.AGENTOS_RUNNER_DATA_DIR ?? path.join(os.homedir(), '.agentos-runner')),
      claudeBin: values['claude-bin'],
      capacity: values.capacity ? Number(values.capacity) : undefined,
    });
    await runner.start();
    const shutdown = async () => {
      await runner.stop();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return;
  }

  if (cmd === 'login') {
    const dir = positionals[0];
    if (!dir) throw new Error('usage: agentos login <config-dir>');
    const runnerData = path.resolve(values['data-dir'] ?? process.env.AGENTOS_RUNNER_DATA_DIR ?? path.join(process.env.AGENTOS_DATA_DIR ?? '.agentos', 'runner'));
    const r = new Runner({ serverUrl: 'http://unused', token: 'unused', dataDir: runnerData, claudeBin: values['claude-bin'] });
    const configDir = r.resolveConfigDir(dir)!;
    process.stdout.write(`Signing in with Anthropic's own login flow into CLAUDE_CONFIG_DIR=${configDir}\nChoose your Claude subscription (not Console/API billing).\n\n`);
    const env = buildChildEnv({ configDir });
    const cmd = cliCommand(values['claude-bin'] ?? 'claude', ['auth', 'login', '--claudeai']);
    const child = spawn(cmd.file, cmd.args, { stdio: 'inherit', env });
    child.on('exit', (code) => process.exit(code ?? 0));
    return;
  }

  if (cmd === 'set-password') {
    const config = defaultConfig({ dataDir: values['data-dir'] ? path.resolve(values['data-dir']) : undefined });
    const core = new Core(config);
    const pw = process.env.AGENTOS_NEW_PASSWORD ?? positionals[0];
    if (!pw) throw new Error('Provide the new password via AGENTOS_NEW_PASSWORD (preferred) or as an argument');
    new OwnerAuth(core).setPassword(pw);
    core.close();
    process.stdout.write('Owner password updated. Existing sessions were signed out.\n');
    return;
  }

  process.stdout.write(HELP);
  process.exitCode = 1;
}

main().catch((e) => {
  process.stderr.write(`Error: ${(e as Error).message}\n`);
  process.exit(1);
});
