import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { RunCompletion, RunErrorKind, RunUsage, UsageSnapshot } from '../../core/types.js';
import { initEventIsSafe } from '../billing-guard.js';
import { cliCommand } from '../cli-command.js';
import type { AgentDriver, DriverContext } from './types.js';
import { newToken, truncate } from '../../util/util.js';

export interface ClaudeDriverOptions {
  claudeBin: string;
  /** Directory for per-run temp files (MCP config with the run token). Not inside any worktree. */
  runtimeDir: string;
}

type Classified = { status: RunCompletion['status']; errorKind?: RunErrorKind | 'session_missing'; errorDetail?: string };

/** Map a stream-json `result` event (plus stderr) to a run outcome. Exported for tests. */
export function classifyResult(result: Record<string, any> | null, stderrTail: string, lastRateLimit: UsageSnapshot | null): Classified {
  const text = `${result?.result ?? ''}\n${stderrTail}`;
  if (/no conversation found|session.{0,40}not found|could not find session/i.test(text) && (!result || result.is_error)) {
    return { status: 'failed', errorKind: 'session_missing', errorDetail: truncate(text.trim(), 500) };
  }
  if (!result) return { status: 'failed', errorKind: 'crash', errorDetail: truncate(stderrTail.trim() || 'Claude Code exited without a result', 2000) };
  if (result.subtype === 'success' && !result.is_error) return { status: 'succeeded' };
  if (result.subtype === 'error_max_turns' || /max[_ ]turns/i.test(String(result.terminal_reason ?? ''))) {
    return { status: 'failed', errorKind: 'max_turns', errorDetail: `Reached the turn limit after ${result.num_turns ?? '?'} turns` };
  }
  const code = Number(result.api_error_status ?? 0);
  if (code === 429 || lastRateLimit?.status === 'rejected' || /usage limit|rate.?limit|limit reached|too many requests/i.test(text)) {
    return { status: 'failed', errorKind: 'rate_limit', errorDetail: truncate(String(result.result ?? 'Usage limit reached'), 500) };
  }
  if (code === 401 || code === 403 || /invalid (api key|bearer)|authenticat|not logged in|please run \/login|oauth|token (has )?expired|credential/i.test(text)) {
    return { status: 'failed', errorKind: 'auth', errorDetail: truncate(String(result.result ?? 'Authentication failed'), 500) };
  }
  return { status: 'failed', errorKind: 'crash', errorDetail: truncate(String(result.result ?? stderrTail ?? 'Run failed'), 2000) };
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c: any) => (c?.type === 'text' ? c.text : c?.type ? `[${c.type}]` : '')).join('\n');
  return '';
}

/** Runs one agent turn-sequence with the unmodified Claude Code CLI in headless mode. */
export class ClaudeCodeDriver implements AgentDriver {
  readonly provider = 'claude-code';

  constructor(private opts: ClaudeDriverOptions) {}

  async run(ctx: DriverContext): Promise<RunCompletion> {
    const resume = ctx.assignment.run.resumeSessionId;
    const first = await this.attempt(ctx, resume, resume ? ctx.prompt : `${ctx.recovery}\n\n---\n\n${ctx.prompt}`);
    if (first.errorKind === ('session_missing' as RunErrorKind) && resume) {
      ctx.emit('warning', { message: `Previous session ${resume} is unavailable on this runner; starting a fresh session with recovered context.` });
      return this.attempt(ctx, null, `${ctx.recovery}\n\n---\n\n${ctx.prompt}`);
    }
    if (first.errorKind === ('session_missing' as RunErrorKind)) return { ...first, errorKind: 'crash' };
    return first;
  }

  private buildArgs(ctx: DriverContext, resume: string | null, mcpConfigPath: string): string[] {
    const a = ctx.assignment;
    const agent = a.agent!;
    const configDir = ctx.env.CLAUDE_CONFIG_DIR;
    const deny: string[] = [];
    for (const dir of [configDir, this.opts.runtimeDir].filter(Boolean) as string[]) {
      const abs = `//${dir.replace(/^\/+/, '')}`;
      deny.push(`Read(${abs}/**)`, `Edit(${abs}/**)`);
    }
    const settings = { permissions: { deny } };
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      // Billing guard layer 2: ignore repository/local settings (they could set apiKeyHelper or hooks).
      '--setting-sources',
      'user',
      '--settings',
      JSON.stringify(settings),
      '--mcp-config',
      mcpConfigPath,
      '--strict-mcp-config',
      '--permission-prompt-tool',
      'mcp__agentos__permission_gate',
      '--permission-mode',
      'acceptEdits',
      '--allowedTools',
      'mcp__agentos',
      '--append-system-prompt',
      agent.systemPrompt,
      '--max-turns',
      String(a.run.maxTurns),
    ];
    if (agent.toolProfile === 'readonly') args.push('--disallowedTools', 'Edit', 'Write', 'NotebookEdit');
    if (agent.model) args.push('--model', agent.model);
    if (agent.effort) args.push('--effort', agent.effort);
    if (resume) args.push('--resume', resume);
    return args;
  }

  private attempt(ctx: DriverContext, resume: string | null, prompt: string): Promise<RunCompletion & { errorKind?: any }> {
    const a = ctx.assignment;
    fs.mkdirSync(this.opts.runtimeDir, { recursive: true, mode: 0o700 });
    // The MCP config carries the run token, so it goes to a private file instead of argv.
    const mcpConfigPath = path.join(this.opts.runtimeDir, `mcp-${a.run.id}-${newToken(6)}.json`);
    fs.writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: { agentos: { type: 'http', url: a.mcp.url, headers: { Authorization: `Bearer ${a.mcp.token}` } } } }), { mode: 0o600 });

    const args = this.buildArgs(ctx, resume, mcpConfigPath);
    ctx.emit('status', { phase: 'starting', resume: resume ?? null, cli: this.opts.claudeBin });

    return new Promise((resolve) => {
      const cmd = cliCommand(this.opts.claudeBin, args);
      const child = spawn(cmd.file, cmd.args, { cwd: ctx.workspace, env: ctx.env, stdio: ['pipe', 'pipe', 'pipe'] });
      let result: Record<string, any> | null = null;
      let sessionId: string | null = null;
      let model: string | undefined;
      let lastRate: (UsageSnapshot & { limited?: boolean }) | null = null;
      let stderr = '';
      let killedFor: RunErrorKind | null = null;
      let killDetail = '';
      let settled = false;

      const kill = (reason: RunErrorKind, detail: string) => {
        if (killedFor) return;
        killedFor = reason;
        killDetail = detail;
        child.kill('SIGTERM');
        setTimeout(() => child.exitCode === null && child.kill('SIGKILL'), 5000).unref();
      };
      const onAbort = () => kill('cancelled', 'Cancelled');
      ctx.signal.addEventListener('abort', onAbort);
      const timer = setTimeout(() => kill('timeout', `Run exceeded ${ctx.timeoutSec}s`), ctx.timeoutSec * 1000);

      child.on('error', (err: any) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ctx.signal.removeEventListener('abort', onAbort);
        fs.rmSync(mcpConfigPath, { force: true });
        resolve({ status: 'failed', errorKind: 'config', errorDetail: err?.code === 'ENOENT' ? `Claude Code CLI not found ("${this.opts.claudeBin}")` : String(err?.message ?? err) });
      });

      child.stdin.on('error', () => {});
      child.stdin.end(prompt);

      child.stderr.on('data', (d: Buffer) => {
        const s = d.toString();
        stderr = (stderr + s).slice(-8000);
        for (const line of s.split('\n')) if (line.trim() && !/no stdin data received/i.test(line)) ctx.emit('stderr', { line: truncate(line, 1000) });
      });

      const rl = readline.createInterface({ input: child.stdout });
      rl.on('line', (line) => {
        if (!line.trim()) return;
        let ev: any;
        try {
          ev = JSON.parse(line);
        } catch {
          ctx.emit('stderr', { line: truncate(line, 1000) });
          return;
        }
        switch (ev.type) {
          case 'system':
            if (ev.subtype === 'init') {
              sessionId = ev.session_id ?? sessionId;
              model = ev.model;
              const mcp = (ev.mcp_servers ?? []).find((m: any) => m.name === 'agentos');
              ctx.emit('init', { sessionId, model, apiKeySource: ev.apiKeySource, permissionMode: ev.permissionMode, mcp: mcp?.status ?? 'missing', cliVersion: ev.claude_code_version, cwd: ev.cwd });
              // Billing guard layer 4: runtime tripwire.
              const safe = initEventIsSafe(ev);
              if (!safe.ok) kill('billing_guard', safe.reason!);
              else if (mcp && mcp.status !== 'connected') ctx.emit('warning', { message: `AgentOS MCP server status: ${mcp.status}. The agent may be unable to coordinate.` });
            }
            break;
          case 'assistant':
            for (const block of ev.message?.content ?? []) {
              if (block.type === 'text' && block.text?.trim()) ctx.emit('assistant_text', { text: truncate(block.text, 20000) });
              else if (block.type === 'tool_use') ctx.emit('tool_use', { id: block.id, name: block.name, input: truncate(JSON.stringify(block.input ?? {}), 4000) });
            }
            break;
          case 'user':
            for (const block of Array.isArray(ev.message?.content) ? ev.message.content : []) {
              if (block.type === 'tool_result') ctx.emit('tool_result', { id: block.tool_use_id, isError: !!block.is_error, content: truncate(toolResultText(block.content), 4000) });
            }
            break;
          case 'rate_limit_event': {
            const info = ev.rate_limit_info ?? {};
            lastRate = { status: info.status, rateLimitType: info.rateLimitType, resetsAt: info.resetsAt, windows: info.unifiedWindows, limited: info.status === 'rejected' };
            ctx.emit('rate_limit', lastRate as any);
            break;
          }
          case 'result':
            result = ev;
            sessionId = ev.session_id ?? sessionId;
            break;
        }
      });

      child.on('close', (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ctx.signal.removeEventListener('abort', onAbort);
        fs.rmSync(mcpConfigPath, { force: true });
        const usage: RunUsage = {
          inputTokens: result?.usage?.input_tokens,
          outputTokens: result?.usage?.output_tokens,
          cacheReadTokens: result?.usage?.cache_read_input_tokens,
          cacheCreationTokens: result?.usage?.cache_creation_input_tokens,
          numTurns: result?.num_turns,
          apiEquivalentUsd: result?.total_cost_usd,
          durationMs: result?.duration_ms,
          model,
        };
        const base = { sessionId: sessionId ?? undefined, usage, rateLimit: lastRate ?? undefined, resultText: typeof result?.result === 'string' ? result.result : undefined };
        if (killedFor) {
          resolve({ ...base, status: killedFor === 'cancelled' ? 'cancelled' : 'failed', errorKind: killedFor, errorDetail: killDetail });
          return;
        }
        const c = classifyResult(result, stderr + (code && !result ? `\n(exit ${code}${signal ? `, ${signal}` : ''})` : ''), lastRate);
        resolve({ ...base, status: c.status, errorKind: c.errorKind as any, errorDetail: c.errorDetail });
      });
    });
  }
}
