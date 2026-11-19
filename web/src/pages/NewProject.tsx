import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Trash2 } from 'lucide-react';
import { api, toast } from '../lib/api';
import { useAccounts, useMeta, useRunners } from '../lib/queries';
import { Field } from '../components/ui';

interface AgentDraft {
  name: string;
  preset: string;
  role: string;
  account_id: string;
  is_pm: boolean;
  model: string;
}

const NAMES = ['Ada', 'Linus', 'Grace', 'Rex', 'Margaret', 'Alan', 'Barbara', 'Ken'];

export function NewProjectPage() {
  const nav = useNavigate();
  const accounts = useAccounts();
  const runners = useRunners();
  const meta = useMeta();
  const presets = meta.data?.rolePresets ?? {};
  const [form, setForm] = useState({ name: '', key: '', description: '', repo_url: '', base_branch: 'main', runner_id: '', coordination_mode: 'pm_led', autonomy: 'supervised', merge_policy: 'auto', workspace_mode: 'github', github_token: '' });
  const [team, setTeam] = useState<AgentDraft[]>([
    { name: 'Ada', preset: 'pm', role: 'Project Manager', account_id: '', is_pm: true, model: '' },
    { name: 'Linus', preset: 'backend', role: 'Backend Developer', account_id: '', is_pm: false, model: '' },
    { name: 'Rex', preset: 'reviewer', role: 'Code Reviewer', account_id: '', is_pm: false, model: '' },
  ]);
  const [busy, setBusy] = useState(false);
  const accs = (accounts.data ?? []).filter((a) => (form.workspace_mode === 'github' ? a.provider === 'claude-cloud' : a.provider !== 'claude-cloud'));
  const defaultAcc = (i: number) => accs[i % Math.max(1, accs.length)]?.id ?? '';

  const submit = async () => {
    setBusy(true);
    try {
      const { github_token, ...rest } = form;
      const p = await api('POST', '/api/projects', { ...rest, key: form.key || undefined, repo_url: form.repo_url || null, runner_id: form.runner_id || undefined, ...(github_token ? { github_token } : {}) });
      for (const [i, a] of team.entries()) {
        const preset = presets[a.preset];
        await api('POST', `/api/projects/${p.id}/agents`, {
          name: a.name,
          role: a.role,
          is_pm: a.is_pm,
          account_id: a.account_id || defaultAcc(i) || null,
          model: a.model || null,
          instructions: preset?.instructions ?? '',
          tool_profile: preset?.tool_profile ?? 'standard',
        });
      }
      toast(`Project ${p.name} created`, 'success');
      nav(`/p/${p.slug}/chat`);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl px-6 py-6">
      <h1 className="text-xl font-semibold">New project</h1>
      <p className="mb-6 text-sm text-zinc-500">Set up a workspace, connect a repository and assemble the team. You can change everything later.</p>

      <div className="card mb-6 space-y-4 p-5">
        <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
          <Field label="Project name">
            <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus placeholder="e.g. Billing service" />
          </Field>
          <Field label="Task key" hint="Prefix, e.g. BILL">
            <input className="input uppercase" value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value.toUpperCase() })} placeholder="auto" maxLength={10} />
          </Field>
        </div>
        <Field label="Description / brief" hint="What the project is and what matters. The PM refines this into the project brief.">
          <textarea className="input min-h-24" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </Field>
        <Field label="Where agents work">
          <select className="input" value={form.workspace_mode} onChange={(e) => setForm({ ...form, workspace_mode: e.target.value })}>
            <option value="github">GitHub repository: agents run as Claude Code on the web sessions</option>
            <option value="runner">Runner: agents run the Claude Code CLI on your VPS or machine</option>
          </select>
        </Field>
        {form.workspace_mode === 'github' && (
          <Field label="GitHub token" hint="Fine-grained token with Contents: read & write on the repository (used to merge reviewed branches). Stored encrypted. You can add it later in Settings.">
            <input type="password" className="input font-mono text-xs" value={form.github_token} onChange={(e) => setForm({ ...form, github_token: e.target.value })} placeholder="github_pat_…" autoComplete="off" />
          </Field>
        )}
        <div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
          <Field label={form.workspace_mode === 'github' ? 'GitHub repository' : 'Repository (optional)'} hint={form.workspace_mode === 'github' ? 'https://github.com/owner/repo. The Claude GitHub App must be installed on it for each account.' : 'Git URL or a path on the runner to clone from. Leave empty to start a fresh repository.'}>
            <input className="input font-mono text-xs" value={form.repo_url} onChange={(e) => setForm({ ...form, repo_url: e.target.value })} placeholder="git@github.com:you/repo.git" />
          </Field>
          <Field label="Base branch">
            <input className="input" value={form.base_branch} onChange={(e) => setForm({ ...form, base_branch: e.target.value })} />
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Runner">
            <select className="input" value={form.runner_id} onChange={(e) => setForm({ ...form, runner_id: e.target.value })}>
              <option value="">Default</option>
              {runners.data?.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Coordination">
            <select className="input" value={form.coordination_mode} onChange={(e) => setForm({ ...form, coordination_mode: e.target.value })}>
              <option value="pm_led">PM-led (default)</option>
              <option value="collaborative">Collaborative</option>
            </select>
          </Field>
          <Field label="Autonomy">
            <select className="input" value={form.autonomy} onChange={(e) => setForm({ ...form, autonomy: e.target.value })}>
              <option value="supervised">Supervised: I approve plans and merges</option>
              <option value="autonomous">Autonomous: within guardrails</option>
              <option value="paused">Paused</option>
            </select>
          </Field>
        </div>
      </div>

      <h2 className="mb-2 text-sm font-semibold">Team</h2>
      {accs.length === 0 && (
        <div className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-400/[0.07] dark:text-amber-300">
          {form.workspace_mode === 'github' ? 'No cloud accounts yet. Add your Claude accounts as “Claude Code on the web” under Accounts & runners (you can assign them later).' : 'No runner accounts yet. Add one under Accounts & runners (you can assign it later).'}
        </div>
      )}
      <div className="card mb-6 divide-y divide-zinc-100 dark:divide-white/[0.05]">
        {team.map((a, i) => (
          <div key={i} className="grid items-end gap-3 p-4 sm:grid-cols-[8rem_10rem_1fr_9rem_auto]">
            <Field label="Name">
              <input className="input" value={a.name} onChange={(e) => setTeam(team.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
            </Field>
            <Field label="Preset">
              <select
                className="input"
                value={a.preset}
                onChange={(e) => {
                  const p = presets[e.target.value];
                  setTeam(team.map((x, j) => (j === i ? { ...x, preset: e.target.value, role: p?.role ?? x.role, is_pm: e.target.value === 'pm' } : e.target.value === 'pm' ? { ...x, is_pm: false } : x)));
                }}
              >
                {Object.entries(presets).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v.role}
                  </option>
                ))}
                <option value="custom">Custom…</option>
              </select>
            </Field>
            <Field label="Role">
              <input className="input" value={a.role} onChange={(e) => setTeam(team.map((x, j) => (j === i ? { ...x, role: e.target.value } : x)))} />
            </Field>
            <Field label="Account">
              <select className="input" value={a.account_id || defaultAcc(i)} onChange={(e) => setTeam(team.map((x, j) => (j === i ? { ...x, account_id: e.target.value } : x)))}>
                <option value="">None</option>
                {accs.map((acc) => (
                  <option key={acc.id} value={acc.id}>
                    {acc.name}
                  </option>
                ))}
              </select>
            </Field>
            <button className="btn btn-ghost btn-sm mb-1 text-zinc-400" onClick={() => setTeam(team.filter((_, j) => j !== i))} title="Remove">
              <Trash2 className="size-4" />
            </button>
          </div>
        ))}
        <div className="p-3">
          <button className="btn btn-sm" onClick={() => setTeam([...team, { name: NAMES[team.length % NAMES.length], preset: 'frontend', role: presets.frontend?.role ?? 'Developer', account_id: '', is_pm: false, model: '' }])}>
            <Plus className="size-3.5" /> Add agent
          </button>
        </div>
      </div>

      <div className="flex justify-end gap-2">
        <button className="btn" onClick={() => nav(-1)}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={!form.name || busy} onClick={submit}>
          {busy ? 'Creating…' : 'Create project'}
        </button>
      </div>
    </div>
  );
}
