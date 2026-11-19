import http from 'node:http';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from '../helpers.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_NAME: 'GitHub', GIT_AUTHOR_EMAIL: 'noreply@github.com', GIT_COMMITTER_NAME: 'GitHub', GIT_COMMITTER_EMAIL: 'noreply@github.com' } }).trim();
const tryGit = (cwd: string, ...args: string[]) => {
  try {
    return { ok: true, out: git(cwd, ...args) };
  } catch (e: any) {
    return { ok: false, out: String(e.stdout ?? '') + String(e.stderr ?? '') };
  }
};

/**
 * A stand-in for GitHub: a bare repository that "cloud sessions" clone and push to, plus the
 * REST endpoints AgentOS uses (repo, compare, merges, contents), implemented with real git.
 */
export class FakeGitHub {
  readonly bare: string;
  private work: string;
  private server!: http.Server;
  url = '';
  requests: { method: string; path: string; auth?: string }[] = [];

  constructor(readonly token: string) {
    const root = tmpDir('fake-gh-');
    this.bare = path.join(root, 'repo.git');
    git(root, 'init', '--bare', '-b', 'main', this.bare);
    const seed = path.join(root, 'seed');
    git(root, 'clone', this.bare, seed);
    fs.writeFileSync(path.join(seed, 'README.md'), '# app\n');
    git(seed, 'add', '.');
    git(seed, 'commit', '-m', 'Initial commit');
    git(seed, 'push', 'origin', 'main');
    this.work = path.join(root, 'work');
    git(root, 'clone', this.bare, this.work);
  }

  async start() {
    this.server = http.createServer(async (req, res) => {
      let body = '';
      for await (const c of req) body += c;
      const send = (status: number, data?: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(data === undefined ? '' : JSON.stringify(data));
      };
      this.requests.push({ method: req.method!, path: req.url!, auth: req.headers.authorization });
      if (req.headers.authorization !== `Bearer ${this.token}`) return send(401, { message: 'Bad credentials' });
      const u = new URL(req.url!, 'http://x');
      const m = u.pathname.match(/^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/);
      if (!m) return send(404, { message: 'Not Found' });
      const rest = m[3] ?? '';
      git(this.work, 'fetch', '--prune', 'origin');
      if (!rest && req.method === 'GET') return send(200, { full_name: `${m[1]}/${m[2]}`, default_branch: 'main', permissions: { push: true } });
      const cmp = rest.match(/^\/compare\/(.+)\.\.\.(.+)$/);
      if (cmp && req.method === 'GET') {
        const [base, head] = [decodeURIComponent(cmp[1]), decodeURIComponent(cmp[2])];
        const r = tryGit(this.work, 'log', '--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%s', `origin/${base}..origin/${head}`);
        if (!r.ok) return send(404, { message: 'Not Found' });
        const commits = r.out
          .split('\n')
          .filter(Boolean)
          .map((l) => {
            const [sha, name, email, date, subject] = l.split('\x1f');
            return { sha, commit: { message: subject, author: { name, email, date } } };
          })
          .reverse();
        return send(200, { status: commits.length ? 'ahead' : 'identical', commits });
      }
      if (rest === '/merges' && req.method === 'POST') {
        const { base, head, commit_message } = JSON.parse(body);
        if (!tryGit(this.work, 'rev-parse', '--verify', `origin/${head}`).ok || !tryGit(this.work, 'rev-parse', '--verify', `origin/${base}`).ok) return send(404, { message: 'Base or head does not exist' });
        git(this.work, 'checkout', '-B', base, `origin/${base}`);
        if (tryGit(this.work, 'merge-base', '--is-ancestor', `origin/${head}`, base).ok) return send(204);
        const merged = tryGit(this.work, 'merge', '--no-ff', '-m', commit_message, `origin/${head}`);
        if (!merged.ok) {
          tryGit(this.work, 'merge', '--abort');
          return send(409, { message: 'Merge conflict' });
        }
        git(this.work, 'push', 'origin', base);
        return send(201, { sha: git(this.work, 'rev-parse', 'HEAD') });
      }
      const contents = rest.match(/^\/contents\/(.+)$/);
      if (contents) {
        const file = decodeURIComponent(contents[1]);
        git(this.work, 'checkout', '-B', 'main', 'origin/main');
        const abs = path.join(this.work, file);
        if (req.method === 'GET') return fs.existsSync(abs) ? send(200, { content: fs.readFileSync(abs).toString('base64') }) : send(404, { message: 'Not Found' });
        if (req.method === 'PUT') {
          const { content, message } = JSON.parse(body);
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, Buffer.from(content, 'base64'));
          git(this.work, 'add', file);
          git(this.work, 'commit', '-m', message);
          git(this.work, 'push', 'origin', 'main');
          return send(201, { content: { path: file } });
        }
      }
      send(404, { message: 'Not Found' });
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as any).port}`;
  }

  stop() {
    this.server?.close();
  }

  /** Files and log on a branch of the "GitHub" repository. */
  show(ref: string, file: string): string | null {
    const r = tryGit(this.bare, 'show', `${ref}:${file}`);
    return r.ok ? r.out : null;
  }
  log(ref: string): string {
    return git(this.bare, 'log', '--oneline', ref);
  }
}
