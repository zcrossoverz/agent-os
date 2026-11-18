import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { GitCommitInfo, GitReport, RunAssignment } from '../core/types.js';

export class GitError extends Error {}

export function git(cwd: string, args: string[], opts: { allowFail?: boolean; env?: NodeJS.ProcessEnv } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...opts.env }, maxBuffer: 32 * 1024 * 1024, timeout: 120_000 },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0;
        if (code !== 0 && !opts.allowFail) reject(new GitError(`git ${args.join(' ')} failed (${code}): ${String(stderr || stdout).trim().slice(0, 2000)}`));
        else resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

const SYSTEM_IDENTITY = { GIT_AUTHOR_NAME: 'AgentOS', GIT_AUTHOR_EMAIL: 'agentos@localhost', GIT_COMMITTER_NAME: 'AgentOS', GIT_COMMITTER_EMAIL: 'agentos@localhost' };

export function agentIdentity(name: string, slug: string): NodeJS.ProcessEnv {
  const email = `${slug}@agents.agentos.local`;
  return { GIT_AUTHOR_NAME: `${name} (AgentOS)`, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: `${name} (AgentOS)`, GIT_COMMITTER_EMAIL: email };
}

/**
 * Per-project repository management on a runner.
 *   <data>/repos/<project>            main clone; base branch checked out; merges happen here
 *   <data>/worktrees/<project>/<agent> one worktree per agent, sharing the repository's objects
 * Every agent works on its own branch, so agents never write to the same working tree.
 */
export class Workspaces {
  private locks = new Map<string, Promise<unknown>>();

  constructor(private dataDir: string) {}

  repoDir(p: RunAssignment['project']) {
    return path.join(this.dataDir, 'repos', `${p.slug}-${p.id.slice(-6)}`);
  }

  worktreeDir(p: RunAssignment['project'], agentSlug: string) {
    return path.join(this.dataDir, 'worktrees', `${p.slug}-${p.id.slice(-6)}`, agentSlug);
  }

  /** Serialize operations that touch a project's shared refs (worktree creation, merges). */
  private withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(
      key,
      next.catch(() => {}),
    );
    return next;
  }

  async ensureRepo(p: RunAssignment['project']): Promise<string> {
    const dir = this.repoDir(p);
    return this.withLock(dir, async () => {
      if (!fs.existsSync(path.join(dir, '.git'))) {
        fs.mkdirSync(path.dirname(dir), { recursive: true });
        if (p.repoUrl) {
          await git(path.dirname(dir), ['clone', p.repoUrl, dir]);
        } else {
          fs.mkdirSync(dir, { recursive: true });
          await git(dir, ['init', '-b', p.baseBranch]);
          fs.writeFileSync(path.join(dir, 'README.md'), `# ${p.slug}\n\nRepository created by AgentOS for project ${p.key}.\n`);
          await git(dir, ['add', 'README.md']);
          await git(dir, ['commit', '-m', 'Initial commit (AgentOS)'], { env: SYSTEM_IDENTITY });
        }
      }
      // Make sure the base branch exists locally and is checked out in the main clone.
      const hasBase = (await git(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${p.baseBranch}`], { allowFail: true })).code === 0;
      if (!hasBase) {
        const remote = (await git(dir, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${p.baseBranch}`], { allowFail: true })).code === 0;
        if (remote) await git(dir, ['branch', p.baseBranch, `origin/${p.baseBranch}`]);
        else {
          const head = (await git(dir, ['rev-parse', '--verify', '--quiet', 'HEAD'], { allowFail: true })).code === 0;
          if (!head) await git(dir, ['commit', '--allow-empty', '-m', 'Initial commit (AgentOS)'], { env: SYSTEM_IDENTITY });
          await git(dir, ['branch', p.baseBranch]);
        }
      }
      const current = (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true })).stdout.trim();
      if (current !== p.baseBranch) await git(dir, ['checkout', p.baseBranch]);
      return dir;
    });
  }

  /** Prepare an agent's worktree, optionally switching it to a task branch. */
  async prepareAgent(p: RunAssignment['project'], agent: { slug: string; name: string }, branch: string | null | undefined): Promise<{ workspace: string; branch: string }> {
    const repo = await this.ensureRepo(p);
    const wt = this.worktreeDir(p, agent.slug);
    const scratch = `agent/${agent.slug}`;
    await this.withLock(repo, async () => {
      await git(repo, ['worktree', 'prune'], { allowFail: true });
      if (!fs.existsSync(path.join(wt, '.git'))) {
        fs.mkdirSync(path.dirname(wt), { recursive: true });
        const exists = (await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${scratch}`], { allowFail: true })).code === 0;
        await git(repo, exists ? ['worktree', 'add', wt, scratch] : ['worktree', 'add', '-b', scratch, wt, p.baseBranch]);
      }
    });
    const target = branch || null;
    const current = (await git(wt, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true })).stdout.trim();
    if (target && current !== target) {
      await this.autosave(wt, agent, current);
      await this.withLock(repo, async () => {
        const exists = (await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${target}`], { allowFail: true })).code === 0;
        if (exists) {
          const r = await git(wt, ['checkout', target], { allowFail: true });
          if (r.code !== 0) throw new GitError(`Cannot check out ${target}: ${r.stderr.trim()}`);
        } else {
          await git(wt, ['checkout', '-b', target, p.baseBranch]);
        }
      });
    }
    const now = (await git(wt, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true })).stdout.trim();
    return { workspace: wt, branch: now };
  }

  /** Commit leftovers before switching branches so nothing an agent wrote is ever lost. */
  private async autosave(wt: string, agent: { slug: string; name: string }, branch: string) {
    const status = (await git(wt, ['status', '--porcelain'], { allowFail: true })).stdout.trim();
    if (!status || branch === 'HEAD') return;
    await git(wt, ['add', '-A']);
    await git(wt, ['commit', '-m', `WIP: autosave by AgentOS before switching branches`, '--no-verify'], { env: agentIdentity(agent.name, agent.slug) });
  }

  async heads(repo: string): Promise<Map<string, string>> {
    const out = (await git(repo, ['for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads'], { allowFail: true })).stdout;
    const m = new Map<string, string>();
    for (const line of out.split('\n')) {
      const [name, sha] = line.trim().split(' ');
      if (name && sha) m.set(name, sha);
    }
    return m;
  }

  /** Commits that appeared on any branch since `before`. */
  async newCommits(repo: string, before: Map<string, string>): Promise<GitCommitInfo[]> {
    const after = await this.heads(repo);
    const exclude = [...new Set(before.values())];
    const seen = new Set<string>();
    const out: GitCommitInfo[] = [];
    for (const [branch, sha] of after) {
      if (before.get(branch) === sha) continue;
      const args = ['log', '--format=%H%x1f%an <%ae>%x1f%aI%x1f%s', '-n', '200', sha, ...exclude.map((e) => `^${e}`)];
      const res = await git(repo, args, { allowFail: true });
      for (const line of res.stdout.split('\n')) {
        const [h, author, date, subject] = line.split('\x1f');
        if (!h || seen.has(h)) continue;
        seen.add(h);
        out.push({ sha: h, branch, author, committedAt: date, message: subject ?? '' });
      }
    }
    return out;
  }

  /**
   * Git state after a run. Agents run concurrently and share one repository, so only commits
   * authored with this agent's identity are attributed to the run.
   */
  async report(workspace: string, repo: string, before: Map<string, string>, authorEmail?: string): Promise<GitReport> {
    const branch = (await git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true })).stdout.trim();
    const head = (await git(workspace, ['rev-parse', 'HEAD'], { allowFail: true })).stdout.trim();
    const dirty = (await git(workspace, ['status', '--porcelain'], { allowFail: true })).stdout.trim().length > 0;
    let commits = await this.newCommits(repo, before);
    if (authorEmail) commits = commits.filter((c) => c.author?.includes(`<${authorEmail}>`));
    return { branch, head, dirty, workspace, commits };
  }

  /** Merge an approved task branch into the base branch (in the main clone). */
  async merge(p: RunAssignment['project'], m: NonNullable<RunAssignment['merge']>): Promise<GitReport> {
    const repo = await this.ensureRepo(p);
    return this.withLock(repo, async () => {
      const before = await this.heads(repo);
      const exists = (await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${m.branch}`], { allowFail: true })).code === 0;
      if (!exists) return { mergeResult: 'failed', mergeDetail: `Branch ${m.branch} does not exist (did the agent commit its work?)` } as GitReport;
      await git(repo, ['checkout', p.baseBranch]);
      const dirty = (await git(repo, ['status', '--porcelain'], { allowFail: true })).stdout.trim();
      if (dirty) await git(repo, ['reset', '--hard', 'HEAD']); // main clone is AgentOS-owned; it must stay clean
      const merged = (await git(repo, ['merge-base', '--is-ancestor', m.branch, p.baseBranch], { allowFail: true })).code === 0;
      if (merged) return { mergeResult: 'noop', mergeDetail: `${m.branch} is already contained in ${p.baseBranch}` } as GitReport;
      const res = await git(repo, ['merge', '--no-ff', '-m', `Merge ${m.taskKey}: ${m.taskTitle}\n\nBranch: ${m.branch}`, m.branch], { allowFail: true, env: SYSTEM_IDENTITY });
      if (res.code !== 0) {
        const conflicts = (await git(repo, ['diff', '--name-only', '--diff-filter=U'], { allowFail: true })).stdout.trim();
        await git(repo, ['merge', '--abort'], { allowFail: true });
        return {
          mergeResult: conflicts ? 'conflict' : 'failed',
          mergeDetail: conflicts ? `Conflicting files:\n${conflicts}` : (res.stderr || res.stdout).trim().slice(0, 2000),
        } as GitReport;
      }
      const report: GitReport = { mergeResult: 'merged', mergeDetail: `Merged ${m.branch} into ${p.baseBranch}`, branch: p.baseBranch, commits: await this.newCommits(repo, before) };
      report.head = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();
      if (p.pushOnMerge) {
        const hasOrigin = (await git(repo, ['remote', 'get-url', 'origin'], { allowFail: true })).code === 0;
        if (hasOrigin) {
          const push = await git(repo, ['push', 'origin', p.baseBranch], { allowFail: true });
          report.pushed = push.code === 0;
          if (push.code !== 0) report.mergeDetail += `\nPush failed: ${push.stderr.trim().slice(0, 500)}`;
        }
      }
      return report;
    });
  }
}
