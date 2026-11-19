import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { AuthSnapshot } from '../core/types.js';
import { cliCommand } from './cli-command.js';

/**
 * Billing guard: keeps subscription-backed agents on the subscription.
 *
 * Claude Code silently prefers API credentials (ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN /
 * apiKeyHelper / cloud-provider vars / profiles) over a subscription login. We therefore:
 *   1. build the child environment from an allow-list, never by copying the runner's env,
 *   2. run with --setting-sources user so repo-level settings can't inject an apiKeyHelper,
 *   3. preflight `claude auth status --json` with that exact environment,
 *   4. kill the run if the stream's init event reports any apiKeySource other than "none".
 * See docs/feasibility.md for the experiments behind this.
 */

const PASS_THROUGH = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LANGUAGE',
  'TERM',
  'TZ',
  'TMPDIR',
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'NO_PROXY',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'REQUESTS_CA_BUNDLE',
  'GIT_SSL_CAINFO',
  'CURL_CA_BUNDLE',
];

/** Variables that must never reach a subscription run, even if someone passes them explicitly. */
export const FORBIDDEN_ENV = /^(ANTHROPIC_|CLAUDE_CODE_USE_|AWS_BEARER_TOKEN_BEDROCK|CLAUDE_CODE_SKIP_.*AUTH|VERTEX_|GOOGLE_APPLICATION_CREDENTIALS$|AZURE_)/;

export function buildChildEnv(opts: { configDir: string | null; extra?: NodeJS.ProcessEnv; noProxyHosts?: string[]; oauthToken?: string | null }): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of PASS_THROUGH) if (process.env[k] !== undefined) env[k] = process.env[k];
  for (const [k, v] of Object.entries(process.env)) if (k.startsWith('LC_') && v !== undefined) env[k] = v;
  if (opts.configDir) env.CLAUDE_CONFIG_DIR = opts.configDir;
  if (opts.oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = opts.oauthToken; // subscription token from `claude setup-token`
  env.DISABLE_AUTOUPDATER = '1';
  for (const [k, v] of Object.entries(opts.extra ?? {})) if (v !== undefined) env[k] = v;
  if (opts.noProxyHosts?.length && (env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY)) {
    const cur = (env.NO_PROXY ?? env.no_proxy ?? '').split(',').filter(Boolean);
    const merged = [...new Set([...opts.noProxyHosts, ...cur])].join(',');
    env.NO_PROXY = merged;
    env.no_proxy = merged;
  }
  for (const k of Object.keys(env)) if (FORBIDDEN_ENV.test(k)) delete env[k];
  return env;
}

/**
 * Optional runner-local subscription token (output of `claude setup-token`), stored by the owner
 * in <configDir>/agentos-oauth-token. It never leaves the runner.
 */
export function readLocalOauthToken(configDir: string | null): string | null {
  if (!configDir) return null;
  const f = path.join(configDir, 'agentos-oauth-token');
  try {
    const t = fs.readFileSync(f, 'utf8').trim();
    return t || null;
  } catch {
    return null;
  }
}

/**
 * Auth methods that mean API billing. Anchored on purpose: the subscription token method is
 * reported as "oauth_token", which must not match "auth_token".
 */
const API_METHODS = /^(api_?key|api_?key_?helper|console\w*|auth_?token|anthropic_auth_token|bedrock|vertex|foundry|profile\w*|federation\w*|oidc\w*)$/i;

export function evaluateAuthStatus(status: Record<string, any>): AuthSnapshot {
  const snap: AuthSnapshot = {
    loggedIn: !!status.loggedIn,
    authMethod: status.authMethod,
    apiKeySource: status.apiKeySource,
    apiProvider: status.apiProvider,
  };
  if (status.apiProvider && status.apiProvider !== 'firstParty') return { ...snap, ok: false, problem: `billing: provider is ${status.apiProvider}, not the Claude subscription` };
  if (status.apiKeySource && status.apiKeySource !== 'none') return { ...snap, ok: false, problem: `billing: API credential detected (${status.apiKeySource})` };
  if (status.authMethod && API_METHODS.test(String(status.authMethod))) return { ...snap, ok: false, problem: `billing: auth method ${status.authMethod} is API-billed` };
  if (!status.loggedIn) return { ...snap, ok: false, problem: 'Not signed in. Run the login command shown in the dashboard on the runner machine.' };
  return { ...snap, ok: true };
}

export function preflightAuth(claudeBin: string, env: NodeJS.ProcessEnv, cwd: string): Promise<AuthSnapshot> {
  return new Promise((resolve) => {
    const cmd = cliCommand(claudeBin, ['auth', 'status', '--json']);
    execFile(cmd.file, cmd.args, { env, cwd, timeout: 30_000 }, (err, stdout, stderr) => {
      try {
        const json = JSON.parse(String(stdout).trim());
        resolve(evaluateAuthStatus(json));
      } catch {
        const msg = String(stderr || stdout || (err as Error)?.message || '').trim();
        if ((err as any)?.code === 'ENOENT') resolve({ ok: false, problem: `Claude Code CLI not found at "${claudeBin}"` });
        else resolve({ ok: false, problem: `Could not read auth status: ${msg.slice(0, 300) || 'unknown error'}` });
      }
    });
  });
}

/** Runtime tripwire for the stream's first event. */
export function initEventIsSafe(init: Record<string, any>): { ok: boolean; reason?: string } {
  const src = init.apiKeySource;
  if (src === undefined || src === null || src === 'none') return { ok: true };
  return { ok: false, reason: `Claude Code reported apiKeySource="${src}" (API billing). The run was stopped before doing work.` };
}
