#!/usr/bin/env node
// Stand-in for the Claude Code CLI used by driver tests. Behaviour is selected with
// FAKE_CLAUDE_SCENARIO. The "ok" scenario replays a real stream-json transcript captured from
// Claude Code 2.1.327 (claude-stream-mcp.jsonl).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const scenario = process.env.FAKE_CLAUDE_SCENARIO || 'ok';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');

if (args[0] === '--version') {
  console.log('2.1.327 (Claude Code) [fake]');
  process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'status') {
  const mode = process.env.FAKE_CLAUDE_AUTH || 'subscription';
  const base = { loggedIn: true, authMethod: 'oauth_token', apiProvider: 'firstParty', configDirectory: process.env.CLAUDE_CONFIG_DIR };
  if (mode === 'apikey' || process.env.ANTHROPIC_API_KEY) Object.assign(base, { authMethod: 'api_key', apiKeySource: 'ANTHROPIC_API_KEY' });
  if (mode === 'loggedout') Object.assign(base, { loggedIn: false, authMethod: 'none' });
  console.log(JSON.stringify(base, null, 2));
  process.exit(0);
}

let stdin = '';
process.stdin.on('data', (d) => (stdin += d));
process.stdin.on('end', run);

const init = (extra = {}) => out({ type: 'system', subtype: 'init', session_id: 'sess-fake-1', cwd: process.cwd(), model: 'claude-fake', apiKeySource: 'none', permissionMode: 'acceptEdits', mcp_servers: [{ name: 'agentos', status: 'connected' }], claude_code_version: '2.1.327', ...extra });
const result = (extra = {}) => out({ type: 'result', subtype: 'success', is_error: false, session_id: 'sess-fake-1', num_turns: 1, result: 'done', usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0.01, duration_ms: 50, ...extra });

function run() {
  const resumeIdx = args.indexOf('--resume');
  switch (scenario) {
    case 'ok': {
      for (const line of fs.readFileSync(path.join(here, 'claude-stream-mcp.jsonl'), 'utf8').split('\n')) if (line.trim()) process.stdout.write(line + '\n');
      return;
    }
    case 'apikey':
      // Simulates an API-billed session: the driver must kill us right after init.
      init({ apiKeySource: 'ANTHROPIC_API_KEY' });
      setTimeout(() => {
        result({ result: 'should never get here' });
        fs.writeFileSync(process.env.FAKE_CLAUDE_MARKER || '/dev/null', 'survived');
      }, 4000);
      return;
    case 'ratelimit':
      init();
      out({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1900000000, rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 1, resetsAt: 1900000000, status: 'rejected' } } } });
      result({ subtype: 'success', is_error: true, api_error_status: 429, result: 'Claude usage limit reached' });
      return;
    case 'auth':
      init();
      result({ is_error: true, api_error_status: 401, result: 'Invalid bearer token · Please run /login' });
      return;
    case 'maxturns':
      init();
      result({ subtype: 'error_max_turns', is_error: true, num_turns: 80, result: undefined });
      return;
    case 'session_missing':
      if (resumeIdx >= 0) {
        process.stderr.write(`No conversation found with session ID: ${args[resumeIdx + 1]}\n`);
        process.exit(1);
      }
      init();
      result({ result: `fresh:${stdin.slice(0, 40)}` });
      return;
    case 'echo': {
      init();
      const mcpPath = args[args.indexOf('--mcp-config') + 1];
      const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(ANTHROPIC_|CLAUDE_|GIT_AUTHOR|AGENTOS_|NO_PROXY)/.test(k)));
      result({ result: JSON.stringify({ args, env, stdin, mcp: JSON.parse(fs.readFileSync(mcpPath, 'utf8')), mcpPath, cwd: process.cwd() }) });
      return;
    }
    case 'hang':
      init();
      setTimeout(() => {}, 60000);
      return;
  }
}
