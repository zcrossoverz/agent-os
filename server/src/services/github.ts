import type { Core } from '../core/core.js';
import type { GitCommitInfo, Project } from '../core/types.js';
import { badRequest, truncate } from '../util/util.js';

export interface RepoRef {
  owner: string;
  repo: string;
}

/** Accepts https://github.com/o/r(.git), git@github.com:o/r(.git) or "o/r". */
export function parseGitHubRepo(url: string | null | undefined): RepoRef | null {
  if (!url) return null;
  const s = url.trim().replace(/\.git$/, '').replace(/\/+$/, '');
  const m = s.match(/^(?:https?:\/\/(?:www\.)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

export type MergeOutcome = { result: 'merged' | 'noop' | 'conflict' | 'failed'; sha?: string; detail: string };

/**
 * GitHub as the shared workspace for cloud agents. Each Claude Code on the web session clones the
 * repository, works on a task branch and pushes it; AgentOS merges reviewed branches with the
 * GitHub "merge a branch" API, so no machine of yours needs a clone.
 */
export class GitHubService {
  constructor(private core: Core) {}

  repo(project: Project): RepoRef {
    const r = parseGitHubRepo(project.repo_url);
    if (!r) throw badRequest('The project repository must be a GitHub repository (https://github.com/owner/repo)');
    return r;
  }

  token(projectId: string): string | null {
    const row = this.core.db.get<{ github_token_enc: string | null }>('SELECT github_token_enc FROM projects WHERE id = ?', projectId);
    return this.core.secrets.decrypt(row?.github_token_enc ?? null);
  }

  private async call(project: Project, method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
    const token = this.token(project.id);
    if (!token) throw badRequest('This project has no GitHub token. Add one in project settings (Contents: read & write on the repository).');
    const res = await fetch(`${this.core.config.githubApiUrl.replace(/\/$/, '')}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'AgentOS',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { status: res.status, data };
  }

  /** Merge `head` into the base branch on GitHub (POST /repos/{o}/{r}/merges). */
  async merge(project: Project, head: string, message: string): Promise<MergeOutcome> {
    const { owner, repo } = this.repo(project);
    const r = await this.call(project, 'POST', `/repos/${owner}/${repo}/merges`, { base: project.base_branch, head, commit_message: message });
    if (r.status === 201) return { result: 'merged', sha: r.data?.sha, detail: `Merged ${head} into ${project.base_branch} on GitHub (${String(r.data?.sha ?? '').slice(0, 10)})` };
    if (r.status === 204) return { result: 'noop', detail: `${head} is already contained in ${project.base_branch}` };
    if (r.status === 409) return { result: 'conflict', detail: `GitHub reported a merge conflict between ${head} and ${project.base_branch}` };
    if (r.status === 404) return { result: 'failed', detail: `GitHub could not find ${project.base_branch} or ${head}. Was the branch pushed?` };
    return { result: 'failed', detail: `GitHub merge failed (${r.status}): ${truncate(typeof r.data === 'object' ? (r.data?.message ?? JSON.stringify(r.data)) : String(r.data), 400)}` };
  }

  /** Confirms the token can read the repository; returns its default branch and push permission. */
  async checkAccess(project: Project): Promise<{ ok: boolean; detail: string; defaultBranch?: string; canPush?: boolean }> {
    const { owner, repo } = this.repo(project);
    const r = await this.call(project, 'GET', `/repos/${owner}/${repo}`);
    if (r.status !== 200) return { ok: false, detail: `GitHub ${r.status}: ${r.data?.message ?? 'cannot read repository'}` };
    const canPush = r.data?.permissions ? !!r.data.permissions.push : undefined;
    return { ok: canPush !== false, defaultBranch: r.data?.default_branch, canPush, detail: canPush === false ? 'The token can read but not write this repository' : `Access to ${owner}/${repo} confirmed` };
  }

  /** Commits on `head` that are not on the base branch. */
  async branchCommits(project: Project, head: string): Promise<GitCommitInfo[] | null> {
    const { owner, repo } = this.repo(project);
    const r = await this.call(project, 'GET', `/repos/${owner}/${repo}/compare/${encodeURIComponent(project.base_branch)}...${encodeURIComponent(head)}`);
    if (r.status !== 200 || !Array.isArray(r.data?.commits)) return null;
    return r.data.commits.map((c: any) => ({
      sha: c.sha,
      branch: head,
      message: String(c.commit?.message ?? '').split('\n')[0],
      author: c.commit?.author ? `${c.commit.author.name} <${c.commit.author.email}>` : undefined,
      committedAt: c.commit?.author?.date,
    }));
  }

  /** Create files that are missing on the base branch; report files that exist with other content. */
  async ensureFiles(project: Project, files: Record<string, string>, message: string): Promise<{ path: string; status: 'created' | 'unchanged' | 'differs' | 'error'; detail?: string }[]> {
    const { owner, repo } = this.repo(project);
    const out: { path: string; status: 'created' | 'unchanged' | 'differs' | 'error'; detail?: string }[] = [];
    for (const [path, content] of Object.entries(files)) {
      const enc = path.split('/').map(encodeURIComponent).join('/');
      const cur = await this.call(project, 'GET', `/repos/${owner}/${repo}/contents/${enc}?ref=${encodeURIComponent(project.base_branch)}`);
      if (cur.status === 200) {
        const existing = Buffer.from(String(cur.data?.content ?? ''), 'base64').toString('utf8');
        out.push({ path, status: existing.trim() === content.trim() ? 'unchanged' : 'differs' });
        continue;
      }
      if (cur.status !== 404) {
        out.push({ path, status: 'error', detail: `GitHub ${cur.status}: ${cur.data?.message ?? ''}` });
        continue;
      }
      const put = await this.call(project, 'PUT', `/repos/${owner}/${repo}/contents/${enc}`, { message, content: Buffer.from(content).toString('base64'), branch: project.base_branch });
      out.push(put.status === 201 || put.status === 200 ? { path, status: 'created' } : { path, status: 'error', detail: `GitHub ${put.status}: ${put.data?.message ?? ''}` });
    }
    return out;
  }
}
