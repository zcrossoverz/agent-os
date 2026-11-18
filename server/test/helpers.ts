import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, type StartedServer } from '../src/server.js';
import { Core, defaultConfig } from '../src/core/core.js';

export function tmpDir(prefix = 'agentos-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export async function startTestServer(opts: { claudeBin?: string } = {}): Promise<StartedServer & { dataDir: string }> {
  const dataDir = tmpDir();
  const srv = await startServer({
    dataDir,
    port: 0,
    host: '127.0.0.1',
    publicUrl: 'http://127.0.0.1:0',
    embeddedRunner: true,
    insecureNoAuth: true,
    schedulerIntervalMs: 150,
    runnerOfflineAfterSec: 60,
    webDir: '',
    runnerOptions: { heartbeatSec: 1, capacity: 3, claudeBin: opts.claudeBin },
  });
  return Object.assign(srv, { dataDir });
}

/** An in-memory core without HTTP or runner, for service-level tests. */
export function memoryCore(): Core {
  const core = new Core(defaultConfig({ dbFile: ':memory:', dataDir: tmpDir() }));
  return core;
}

export async function waitFor<T>(fn: () => T | undefined | null | false, timeoutMs = 30000, label = 'condition'): Promise<T> {
  const start = Date.now();
  let last: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      const v = fn();
      if (v) return v as T;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${label}${last ? `: ${String(last)}` : ''}`);
}
