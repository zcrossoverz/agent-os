import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Core, defaultConfig, type ServerConfig } from './core/core.js';
import { buildApp } from './http/app.js';
import { OwnerAuth } from './http/auth.js';
import { Scheduler } from './orchestrator/scheduler.js';
import { Runner } from './runner/runner.js';
import { LOCAL_RUNNER_ID } from './services/runners.js';
import { log } from './util/util.js';

export interface StartedServer {
  core: Core;
  url: string;
  close: () => Promise<void>;
  runner: Runner | null;
  generatedPassword: string | null;
}

function findWebDir(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const c of [path.resolve(here, '../../web/dist'), path.resolve(here, '../web'), path.resolve(process.cwd(), 'web/dist')]) {
    if (fs.existsSync(path.join(c, 'index.html'))) return c;
  }
  return null;
}

/** Boot the control plane (API + MCP + scheduler) and, optionally, an embedded local runner. */
export async function startServer(overrides: Partial<ServerConfig> & { runnerOptions?: { claudeBin?: string; capacity?: number; heartbeatSec?: number } } = {}): Promise<StartedServer> {
  const { runnerOptions, ...cfg } = overrides;
  const config = defaultConfig(cfg);
  if (config.webDir === null) config.webDir = findWebDir();
  const core = new Core(config);
  const auth = new OwnerAuth(core);
  const generatedPassword = config.insecureNoAuth ? null : auth.ensurePassword(process.env.AGENTOS_OWNER_PASSWORD);

  let localToken: string | null = null;
  if (config.embeddedRunner) localToken = core.runners.ensureLocal();

  const app = await buildApp(core, auth);
  await app.listen({ host: config.host, port: config.port });
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : config.port;
  if (config.port === 0) {
    // Ephemeral port (tests): fix up URLs that depend on it.
    if (config.publicUrl.endsWith(':0')) config.publicUrl = `http://127.0.0.1:${port}`;
  }
  const url = `http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${port}`;

  const scheduler = new Scheduler(core);
  scheduler.start();

  let runner: Runner | null = null;
  if (localToken) {
    runner = new Runner({ serverUrl: `http://127.0.0.1:${port}`, token: localToken, dataDir: path.join(config.dataDir, 'runner'), ...runnerOptions });
    await runner.start();
  }

  log('info', `AgentOS control plane listening on ${url} (public URL ${config.publicUrl})${config.webDir ? '' : ' — dashboard not built (run npm run build -w web)'}`);
  if (runner) log('info', `Embedded runner ${LOCAL_RUNNER_ID} started`);

  return {
    core,
    url,
    runner,
    generatedPassword,
    close: async () => {
      scheduler.stop();
      if (runner) await runner.stop();
      await app.close();
      core.close();
    },
  };
}
