import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { tmpDir } from '../helpers.js';

export interface FireRecord {
  routine: string;
  auth?: string;
  version?: string;
  text: string;
  sessionId: string;
}

export type AgentBehaviour = (s: SimSession) => Promise<void>;

/**
 * Stand-in for Claude Code on the web. The fire endpoint behaves like
 * POST https://api.anthropic.com/v1/claude_code/routines/{trig}/fire, then "runs a cloud session":
 * a scripted agent that reaches AgentOS exactly as a real session would — through the repo's
 * .mcp.json (X-AgentOS-Session: $CLAUDE_CODE_REMOTE_SESSION_ID) with the environment's network
 * secret supplying Authorization — and works on a fresh clone of the GitHub repository.
 */
export class FakeClaudeCloud {
  private server!: http.Server;
  url = '';
  fires: FireRecord[] = [];
  errors: string[] = [];
  /** routine id -> { token, network secret (AgentOS token) } */
  routines = new Map<string, { token: string; networkSecret: string }>();
  respondWith: { status: number; headers?: Record<string, string>; body?: unknown } | null = null;
  /** When false, fired sessions never contact AgentOS (to test the watchdog). */
  sessionsActive = true;
  private n = 0;

  constructor(
    private agentosUrl: () => string,
    private githubBare: string,
    private behaviour: AgentBehaviour,
  ) {}

  async start() {
    this.server = http.createServer(async (req, res) => {
      let body = '';
      for await (const c of req) body += c;
      const m = req.url!.match(/^\/v1\/claude_code\/routines\/([^/]+)\/fire$/);
      const send = (status: number, data: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(data));
      };
      if (!m || req.method !== 'POST') return send(404, { type: 'error', error: { type: 'not_found_error', message: 'no route' } });
      if (this.respondWith) return send(this.respondWith.status, this.respondWith.body ?? {}, this.respondWith.headers);
      const routine = this.routines.get(m[1]);
      if (!routine) return send(404, { type: 'error', error: { type: 'not_found_error', message: 'The routine does not exist.' } });
      if (req.headers.authorization !== `Bearer ${routine.token}`) return send(401, { type: 'error', error: { type: 'authentication_error', message: 'Token does not match this routine.' } });
      if (!req.headers['anthropic-version']) return send(400, { type: 'error', error: { type: 'invalid_request_error', message: 'anthropic-version header is required' } });
      const text = JSON.parse(body || '{}').text ?? '';
      const suffix = `01SIM${String(++this.n).padStart(6, '0')}`;
      const rec: FireRecord = { routine: m[1], auth: req.headers.authorization, version: req.headers['anthropic-version'] as string, text, sessionId: `session_${suffix}` };
      this.fires.push(rec);
      send(200, { type: 'routine_fire', claude_code_session_id: rec.sessionId, claude_code_session_url: `https://claude.ai/code/${rec.sessionId}` });
      if (this.sessionsActive) {
        const s = new SimSession(this.agentosUrl(), routine.networkSecret, `cse_${suffix}`, text, this.githubBare);
        setTimeout(() => {
          this.behaviour(s)
            .catch((e) => this.errors.push(String(e?.stack ?? e)))
            .finally(() => s.close());
        }, 30);
      }
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as any).port}`;
  }

  stop() {
    this.server?.close();
  }
}

export class SimSession {
  private client: Client | null = null;
  readonly runCode: string;
  briefing = '';
  workdir: string | null = null;

  constructor(
    readonly agentosUrl: string,
    readonly networkSecret: string,
    readonly envSessionId: string,
    readonly payload: string,
    readonly githubBare: string,
  ) {
    this.runCode = payload.match(/run_[a-z0-9]+/)?.[0] ?? '';
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean; json?: any }> {
    if (!this.client) {
      const transport = new StreamableHTTPClientTransport(new URL(`${this.agentosUrl}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${this.networkSecret}`, 'X-AgentOS-Session': this.envSessionId } },
      });
      this.client = new Client({ name: 'sim-cloud-session', version: '0' });
      await this.client.connect(transport);
    }
    const r: any = await this.client.callTool({ name, arguments: args });
    const text = (r.content ?? []).map((c: any) => c.text ?? '').join('\n');
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      /* plain text */
    }
    return { text, isError: !!r.isError, json };
  }

  async must(name: string, args: Record<string, unknown> = {}) {
    const r = await this.call(name, args);
    if (r.isError) throw new Error(`${name} failed: ${r.text}`);
    return r.json ?? r.text;
  }

  /** A fresh clone of the GitHub repository, like a cloud session's VM. */
  clone(): string {
    if (this.workdir) return this.workdir;
    const dir = path.join(tmpDir('sim-session-'), 'repo');
    execFileSync('git', ['clone', '-q', this.githubBare, dir], { stdio: ['ignore', 'pipe', 'pipe'] });
    this.workdir = dir;
    return dir;
  }

  git(...args: string[]) {
    return execFileSync('git', args, { cwd: this.clone(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_NAME: 'Sim Agent', GIT_AUTHOR_EMAIL: 'sim@cloud', GIT_COMMITTER_NAME: 'Sim Agent', GIT_COMMITTER_EMAIL: 'sim@cloud' } }).trim();
  }

  write(file: string, content: string) {
    const abs = path.join(this.clone(), file);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }

  async close() {
    await this.client?.close().catch(() => {});
  }
}

/** Scripted team behaviour driven entirely by the start_run briefing and AgentOS tools. */
export const teamBehaviour: AgentBehaviour = async (s) => {
  s.briefing = await s.must('start_run', { run_code: s.runCode });
  const isPm = /Your responsibilities as Project Manager/.test(s.briefing);
  const role = s.briefing.match(/the \*\*([^*]+)\*\* on the software project/)?.[1] ?? '';
  const overview = await s.must('get_project_overview');
  const notes: string[] = [];

  if (isPm) {
    const owner = s.briefing.match(/\*\*Message from the Owner\*\*[^\n]*\n((?:\s*> ?.*\n?)+)/);
    if (owner) {
      const request = owner[1]
        .split('\n')
        .map((l) => l.replace(/^\s*> ?/, '').replace(/^\s*[-*]\s*/, '').trim())
        .filter((l) => l && !/^please/i.test(l));
      const team = (overview.team as any[]).filter((m) => !m.pm);
      const devs = team.filter((m) => !/review/i.test(m.role));
      const reviewer = team.find((m) => /review/i.test(m.role));
      const keys: string[] = [];
      for (const [i, title] of request.entries()) {
        const t = await s.must('create_task', { title, acceptance_criteria: `- ${title} exists on the task branch`, assignee: devs[i % devs.length]?.handle, reviewer: reviewer?.handle });
        keys.push(t.key);
      }
      await s.must('finish_run', { summary: `Plan ready: ${keys.join(', ')} assigned.` });
      return;
    }
    for (const key of overview.reviews_for_you as string[]) await s.must('review_task', { task: key, verdict: 'approve', comments: 'PM review: OK' });
    if (/all planned work is done/.test(s.briefing)) {
      const all = (await s.must('list_tasks', { include_closed: true })) as any[];
      await s.must('send_message', { to: 'owner', body: `All ${all.length} task(s) are merged on GitHub.`, expects_reply: false });
    }
    await s.must('finish_run', { summary: 'Checked the board.' });
    return;
  }

  if (/review/i.test(role)) {
    for (const key of overview.reviews_for_you as string[]) {
      const t = await s.must('get_task', { task: key });
      s.git('fetch', 'origin', t.branch);
      const diff = s.git('diff', '--stat', `origin/main...origin/${t.branch}`);
      await s.must('review_task', { task: key, verdict: 'approve', comments: `Reviewed on GitHub branch ${t.branch}: ${diff.split('\n').pop()}` });
      notes.push(`approved ${key}`);
    }
    await s.must('finish_run', { summary: notes.join('; ') || 'No reviews waiting.' });
    return;
  }

  // Developer: work on the assigned task on a pushed GitHub branch.
  const task = (overview.your_tasks as any[]).find((t) => ['todo', 'in_progress'].includes(t.status));
  if (!task) {
    await s.must('finish_run', { summary: 'Nothing to do.' });
    return;
  }
  const started = await s.must('start_task', { task: task.key });
  const branch = started.branch as string;
  s.git('fetch', 'origin');
  s.git('checkout', '-b', branch, 'origin/main');
  s.write(`features/${task.key.toLowerCase()}.md`, `# ${task.key}: ${task.title}\n\nBuilt in a cloud session.\n`);
  s.git('add', '-A');
  s.git('commit', '-m', `${task.key}: ${task.title}`);
  // Forgetting to push is caught by AgentOS before review.
  const early = await s.call('submit_for_review', { task: task.key, summary: 'done' });
  if (!early.isError || !/no commits/.test(early.text)) throw new Error(`expected submit to be refused before push, got: ${early.text}`);
  s.git('push', '-u', 'origin', branch);
  await s.must('submit_for_review', { task: task.key, summary: `Implemented ${task.title}; pushed ${branch}.` });
  await s.must('finish_run', { summary: `Submitted ${task.key} for review.` });
};
