import { useState } from 'react';
import { CheckCircle2, AlertTriangle, GitBranch } from 'lucide-react';
import { api, useAction } from '../../lib/api';
import { useRunners } from '../../lib/queries';
import { useProjectCtx } from './ProjectLayout';
import { Field, SectionTitle } from '../../components/ui';

export function SettingsPage() {
  const { project, agents } = useProjectCtx();
  const runners = useRunners();
  const [f, setF] = useState({
    name: project.name,
    description: project.description,
    repo_url: project.repo_url ?? '',
    base_branch: project.base_branch,
    runner_id: project.runner_id ?? '',
    coordination_mode: project.coordination_mode,
    merge_policy: project.merge_policy,
    push_on_merge: project.push_on_merge,
    pm_agent_id: project.pm_agent_id ?? '',
    workspace_mode: project.workspace_mode,
    github_token: '',
    limits: { ...project.limits },
  });
  const { github_token, ...rest } = f;
  const save = useAction(
    () => api('PATCH', `/api/projects/${project.id}`, { ...rest, repo_url: f.repo_url || null, runner_id: f.runner_id || null, pm_agent_id: f.pm_agent_id || null, ...(github_token ? { github_token } : {}) }),
    { success: 'Settings saved', onSuccess: () => setF((x) => ({ ...x, github_token: '' })) },
  );
  const [ghResult, setGhResult] = useState<{ ok: boolean; text: string } | null>(null);
  const check = useAction(() => api<{ ok: boolean; detail: string }>('POST', `/api/projects/${project.id}/github/check`), { onSuccess: (r) => setGhResult({ ok: r.ok, text: r.detail }) });
  const setup = useAction(() => api<{ results: { path: string; status: string; detail?: string }[] }>('POST', `/api/projects/${project.id}/github/setup`), {
    onSuccess: (r) =>
      setGhResult({
        ok: r.results.every((x) => x.status === 'created' || x.status === 'unchanged'),
        text: r.results.map((x) => `${x.path}: ${x.status === 'differs' ? 'exists with other content; merge the AgentOS entries by hand (see the account setup guide)' : x.status}${x.detail ? ` (${x.detail})` : ''}`).join(' · '),
      }),
  });
  const lim = (k: keyof typeof f.limits, v: number | boolean) => setF({ ...f, limits: { ...f.limits, [k]: v } });

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-6 py-6">
      <section className="card space-y-4 p-5">
        <SectionTitle>General</SectionTitle>
        <Field label="Name">
          <input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <Field label="Description">
          <textarea className="input min-h-20" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Project Manager">
            <select className="input" value={f.pm_agent_id} onChange={(e) => setF({ ...f, pm_agent_id: e.target.value })}>
              <option value="">None</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.role})
                </option>
              ))}
            </select>
          </Field>
          <Field label="Coordination" hint="PM-led: only the PM plans and assigns. Collaborative: agents may assign each other, and the PM supervises.">
            <select className="input" value={f.coordination_mode} onChange={(e) => setF({ ...f, coordination_mode: e.target.value as any })}>
              <option value="pm_led">PM-led</option>
              <option value="collaborative">Collaborative</option>
            </select>
          </Field>
        </div>
      </section>

      <section className="card space-y-4 p-5">
        <SectionTitle>Workspace</SectionTitle>
        <div className="grid gap-3 sm:grid-cols-2">
          {(
            [
              ['github', 'GitHub repository', 'Agents run as Claude Code on the web sessions that clone the repo and push task branches. AgentOS merges reviewed branches on GitHub. Use this for cloud agents.'],
              ['runner', 'Runner (local git)', 'Agents run the Claude Code CLI on a runner (your VPS or machine) in local git worktrees. AgentOS merges in the runner clone.'],
            ] as const
          ).map(([v, label, hint]) => (
            <label key={v} className={`cursor-pointer rounded-xl border p-3 text-sm ${f.workspace_mode === v ? 'border-indigo-500 bg-indigo-50/50 dark:bg-indigo-400/[0.07]' : 'border-zinc-200 dark:border-white/[0.06]'}`}>
              <input type="radio" className="mr-2" checked={f.workspace_mode === v} onChange={() => setF({ ...f, workspace_mode: v })} />
              <span className="font-medium">{label}</span>
              <p className="mt-1 text-xs text-zinc-500">{hint}</p>
            </label>
          ))}
        </div>
        {f.workspace_mode === 'github' && (
          <div className="space-y-3 rounded-xl border border-zinc-200 p-4 dark:border-white/[0.06]">
            <Field label="GitHub repository" hint="https://github.com/owner/repo">
              <input className="input font-mono text-xs" value={f.repo_url} onChange={(e) => setF({ ...f, repo_url: e.target.value })} placeholder="https://github.com/owner/repo" />
            </Field>
            <Field label="GitHub token" hint={project.has_github_token ? 'A token is stored (encrypted). Enter a new one to replace it.' : 'Fine-grained personal access token with Contents: read & write on this repository. Used to merge reviewed branches and check pushes. Stored encrypted.'}>
              <input type="password" className="input font-mono text-xs" value={f.github_token} onChange={(e) => setF({ ...f, github_token: e.target.value })} placeholder={project.has_github_token ? '•••••••• (stored)' : 'github_pat_…'} autoComplete="off" />
            </Field>
            <div className="flex flex-wrap items-center gap-2">
              <button className="btn btn-sm" disabled={!project.has_github_token || check.isPending} onClick={() => check.mutate()} title={project.has_github_token ? '' : 'Save a token first'}>
                <GitBranch className="size-3.5" /> Check access
              </button>
              <button className="btn btn-sm" disabled={!project.has_github_token || setup.isPending} onClick={() => setup.mutate()} title="Commit .mcp.json and .claude/settings.json to the base branch">
                Set up repository
              </button>
              <span className="text-xs text-zinc-500">Save settings first if you changed the repository or token.</span>
            </div>
            {ghResult && (
              <div className={`flex items-start gap-2 rounded-lg px-3 py-2 text-xs ${ghResult.ok ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-400/[0.07] dark:text-emerald-300' : 'bg-amber-50 text-amber-800 dark:bg-amber-400/[0.07] dark:text-amber-300'}`}>
                {ghResult.ok ? <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" /> : <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />}
                {ghResult.text}
              </div>
            )}
          </div>
        )}
      </section>

      <section className="card space-y-4 p-5">
        <SectionTitle>Repository</SectionTitle>
        <div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
          <Field label={f.workspace_mode === 'github' ? 'Repository' : 'Clone from'} hint={f.workspace_mode === 'github' ? 'Set in Workspace above.' : 'Changing this does not move an existing clone on the runner.'}>
            <input className="input font-mono text-xs" value={f.repo_url} disabled={f.workspace_mode === 'github'} onChange={(e) => setF({ ...f, repo_url: e.target.value })} />
          </Field>
          <Field label="Base branch">
            <input className="input" value={f.base_branch} onChange={(e) => setF({ ...f, base_branch: e.target.value })} />
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          {f.workspace_mode === 'runner' && <Field label="Runner (where the repository lives)">
            <select className="input" value={f.runner_id} onChange={(e) => setF({ ...f, runner_id: e.target.value })}>
              {runners.data?.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </Field>}
          <Field label="Merging" hint="Supervised projects always ask before merging.">
            <select className="input" value={f.merge_policy} onChange={(e) => setF({ ...f, merge_policy: e.target.value as any })}>
              <option value="auto">Merge automatically after review</option>
              <option value="owner_approval">Ask me before every merge</option>
            </select>
          </Field>
        </div>
        {f.workspace_mode === 'runner' && <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={f.push_on_merge} onChange={(e) => setF({ ...f, push_on_merge: e.target.checked })} /> Push the base branch to <code className="kbd">origin</code> after each merge
        </label>}
      </section>

      <section className="card space-y-4 p-5">
        <SectionTitle>Guardrails</SectionTitle>
        <p className="text-xs text-zinc-500">These keep agents from looping, duplicating work or burning through your subscription's usage.</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Max consecutive agent messages per conversation" hint="After this, agent messages stop waking each other until you reply.">
            <input type="number" className="input" min={2} max={100} value={f.limits.maxAgentStreak} onChange={(e) => lim('maxAgentStreak', Number(e.target.value))} />
          </Field>
          <Field label="Max runs per agent per hour">
            <input type="number" className="input" min={1} max={120} value={f.limits.maxRunsPerAgentHour} onChange={(e) => lim('maxRunsPerAgentHour', Number(e.target.value))} />
          </Field>
          <Field label="Max automatic continuations of one task" hint="Then the PM is asked to split or re-scope it.">
            <input type="number" className="input" min={0} max={50} value={f.limits.maxAutoContinues} onChange={(e) => lim('maxAutoContinues', Number(e.target.value))} />
          </Field>
          <Field label="Max concurrent runs in this project">
            <input type="number" className="input" min={1} max={32} value={f.limits.maxConcurrentRuns} onChange={(e) => lim('maxConcurrentRuns', Number(e.target.value))} />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={f.limits.requireReview} onChange={(e) => lim('requireReview', e.target.checked)} /> Require review before merge
        </label>
      </section>

      <div className="flex justify-end">
        <button className="btn btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>
          Save settings
        </button>
      </div>
    </div>
  );
}
