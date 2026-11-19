import { useState } from 'react';
import { KeyRound, Plus, Server, ShieldCheck, Trash2, RotateCcw, Terminal, Cloud, Settings2 } from 'lucide-react';
import { api, useAction } from '../lib/api';
import { useAccounts, useMeta, useRunners } from '../lib/queries';
import type { Account, Runner } from '../lib/types';
import { ACCOUNT_STATUS } from '../lib/format';
import { Badge, CopyButton, Empty, Field, Loading, Modal, RelTime, SectionTitle } from '../components/ui';
import { CloudSetupModal, RoutineTriggerModal } from '../components/CloudSetup';

function resolveDir(acc: Account, runner?: Runner) {
  if (!acc.config_dir) return null;
  const dataDir = runner?.info?.dataDir as string | undefined;
  return acc.config_dir.startsWith('~runner/') && dataDir ? `${dataDir}/${acc.config_dir.slice(8)}` : acc.config_dir;
}

function UsageBars({ acc }: { acc: Account }) {
  const w = acc.usage?.windows ?? {};
  const entries = Object.entries(w);
  if (!entries.length) return <div className="text-xs text-zinc-400">No usage data yet (reported after the first run).</div>;
  return (
    <div className="space-y-1.5">
      {entries.map(([name, win]) => {
        const pct = Math.round((win.utilization ?? 0) * 100);
        return (
          <div key={name} className="text-xs">
            <div className="flex justify-between text-zinc-500">
              <span>{name.replace('_', '-')} window</span>
              <span>
                {pct}% {win.resetsAt ? <>· resets <RelTime iso={new Date(win.resetsAt * 1000).toISOString()} /></> : null}
              </span>
            </div>
            <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
              <div className={pct >= 90 ? 'h-full bg-red-500' : pct >= 70 ? 'h-full bg-amber-500' : 'h-full bg-emerald-500'} style={{ width: `${Math.min(100, pct)}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function AccountsPage() {
  const accounts = useAccounts();
  const runners = useRunners();
  const [adding, setAdding] = useState(false);
  const [addingRunner, setAddingRunner] = useState(false);
  const [loginFor, setLoginFor] = useState<Account | null>(null);
  const [cloudGuide, setCloudGuide] = useState<{ account: Account; token?: string | null } | null>(null);
  const [triggerFor, setTriggerFor] = useState<Account | null>(null);
  const reset = useAction((id: string) => api('POST', `/api/accounts/${id}/reset-status`), { success: 'Status reset; the runner will re-check it' });
  const remove = useAction((id: string) => api('DELETE', `/api/accounts/${id}`), { success: 'Account removed' });
  const removeRunner = useAction((id: string) => api('DELETE', `/api/runners/${id}`), { success: 'Runner removed' });
  const runnerById = (id: string | null) => runners.data?.find((r) => r.id === id);

  if (accounts.isLoading || runners.isLoading) return <Loading />;

  return (
    <div className="mx-auto max-w-6xl px-6 py-6">
      <div className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold">Accounts & runners</h1>
          <p className="text-sm text-zinc-500">Coding-agent subscriptions and the machines they run on.</p>
        </div>
        <button className="btn btn-primary" onClick={() => setAdding(true)}>
          <Plus className="size-4" /> Add account
        </button>
      </div>

      <div className="card mb-6 flex gap-3 border-indigo-200 bg-indigo-50/60 p-4 text-sm dark:border-indigo-900 dark:bg-indigo-950/30">
        <ShieldCheck className="mt-0.5 size-5 shrink-0 text-indigo-600 dark:text-indigo-400" />
        <div className="space-y-1 text-zinc-700 dark:text-zinc-300">
          <p>
            <b>Subscription-only by design.</b> Each Claude account signs in on its runner through Anthropic's own login flow. AgentOS never sees or stores your credentials, and it runs the unmodified Claude Code CLI.
          </p>
          <p className="text-zinc-600 dark:text-zinc-400">
            The billing guard strips API keys from the agent environment, ignores repository settings, checks <code className="kbd">claude auth status</code> before running, and stops any run that reports an API key source. "API-equivalent cost" figures on runs are estimates the CLI reports. They are not charges.
          </p>
        </div>
      </div>

      <SectionTitle>Accounts</SectionTitle>
      {accounts.data!.length === 0 ? (
        <div className="card mb-8">
          <Empty icon={<KeyRound className="size-8" />} title="No accounts yet" action={<button className="btn btn-primary" onClick={() => setAdding(true)}>Add account</button>}>
            Add one entry per Claude subscription (for example your two Max accounts). Agents are bound to accounts. Several agents can share one account.
          </Empty>
        </div>
      ) : (
        <div className="mb-8 grid gap-4 md:grid-cols-2">
          {accounts.data!.map((acc) => {
            const st = ACCOUNT_STATUS[acc.status] ?? ACCOUNT_STATUS.unknown;
            const runner = runnerById(acc.runner_id);
            return (
              <div key={acc.id} className="card p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">{acc.name}</span>
                      <Badge tone={acc.provider === 'mock' ? 'zinc' : acc.provider === 'claude-cloud' ? 'violet' : 'indigo'}>
                        {acc.provider === 'claude-code' ? 'Claude Code · runner' : acc.provider === 'claude-cloud' ? 'Claude Code on the web' : 'Mock (testing)'}
                      </Badge>
                    </div>
                    <div className="mt-0.5 truncate text-xs text-zinc-500">
                      {acc.provider === 'claude-cloud' ? (
                        <>
                          <Cloud className="mr-1 inline size-3" />
                          Cloud sessions via routine {acc.fire_url?.match(/trig_[A-Za-z0-9]+/)?.[0] ?? '(not set)'} · max {acc.max_concurrent_runs} concurrent
                        </>
                      ) : (
                        <>
                          Runner: {runner ? `${runner.name} (${runner.status})` : 'none'} · max {acc.max_concurrent_runs} concurrent run(s)
                        </>
                      )}
                    </div>
                  </div>
                  <span className={`rounded-md px-1.5 py-0.5 text-[11px] font-medium ${st.cls}`}>{st.label}</span>
                </div>
                {(acc.status_detail || acc.auth?.problem) && acc.status !== 'ready' && <div className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/50 dark:text-amber-300">{acc.status_detail ?? acc.auth?.problem}</div>}
                {acc.provider === 'claude-code' && (
                  <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
                    <div>
                      <div className="text-zinc-500">Sign-in</div>
                      <div>{acc.auth?.loggedIn ? `Signed in (${acc.auth.authMethod})` : acc.auth?.checkedAt ? 'Not signed in' : 'Not checked yet'}</div>
                      <div className="text-zinc-500">Key source: {acc.auth?.apiKeySource ?? 'none'}</div>
                    </div>
                    <div>
                      <UsageBars acc={acc} />
                    </div>
                  </div>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  {acc.provider === 'claude-code' && (
                    <button className="btn btn-sm" onClick={() => setLoginFor(acc)}>
                      <Terminal className="size-3.5" /> Sign-in instructions
                    </button>
                  )}
                  {acc.provider === 'claude-cloud' && (
                    <>
                      <button className="btn btn-sm" onClick={() => setCloudGuide({ account: acc })}>
                        <Cloud className="size-3.5" /> Setup guide
                      </button>
                      <button className="btn btn-sm" onClick={() => setTriggerFor(acc)}>
                        <Settings2 className="size-3.5" /> Routine trigger
                      </button>
                    </>
                  )}
                  <button className="btn btn-sm" onClick={() => reset.mutate(acc.id)}>
                    <RotateCcw className="size-3.5" /> Re-check
                  </button>
                  <button className="btn btn-ghost btn-sm ml-auto text-red-600" onClick={() => confirm(`Remove account ${acc.name}?`) && remove.mutate(acc.id)}>
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <SectionTitle
        action={
          <button className="btn btn-sm" onClick={() => setAddingRunner(true)}>
            <Plus className="size-3.5" /> Register runner
          </button>
        }
      >
        Runners
      </SectionTitle>
      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-left text-xs text-zinc-500 dark:bg-zinc-900/60">
            <tr>
              <th className="px-4 py-2 font-medium">Runner</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium">Host</th>
              <th className="px-4 py-2 font-medium">Claude Code</th>
              <th className="px-4 py-2 font-medium">Last seen</th>
              <th />
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {runners.data!.map((r) => (
              <tr key={r.id}>
                <td className="px-4 py-2">
                  <div className="flex items-center gap-2 font-medium">
                    <Server className="size-4 text-zinc-400" /> {r.name}
                  </div>
                  <div className="text-[11px] text-zinc-500">{r.id}</div>
                </td>
                <td className="px-4 py-2">
                  <Badge tone={r.status === 'online' ? 'emerald' : 'zinc'}>{r.status}</Badge>
                </td>
                <td className="px-4 py-2 text-xs text-zinc-600 dark:text-zinc-400">{(r.info?.hostname as string) ?? '—'}<div className="text-zinc-400">{r.info?.platform as string}</div></td>
                <td className="px-4 py-2 text-xs">{(r.info?.claudeVersion as string) ?? <span className="text-amber-600">not found</span>}</td>
                <td className="px-4 py-2 text-xs text-zinc-500"><RelTime iso={r.last_seen_at} /></td>
                <td className="px-4 py-2 text-right">
                  {r.id !== 'rnr_local' && (
                    <button className="btn btn-ghost btn-sm text-red-600" onClick={() => confirm(`Remove runner ${r.name}?`) && removeRunner.mutate(r.id)}>
                      <Trash2 className="size-3.5" />
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {runners.data!.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-sm text-zinc-500">
                  No runners. Start the server with <code className="kbd">--embedded-runner</code> or register a remote runner.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <AddAccountModal open={adding} onClose={() => setAdding(false)} runners={runners.data!} onCloudCreated={(account, token) => setCloudGuide({ account, token })} />
      {cloudGuide && <CloudSetupModal account={cloudGuide.account} token={cloudGuide.token} onClose={() => setCloudGuide(null)} />}
      {triggerFor && <RoutineTriggerModal account={triggerFor} onClose={() => setTriggerFor(null)} />}
      <AddRunnerModal open={addingRunner} onClose={() => setAddingRunner(false)} />
      {loginFor && <LoginModal acc={loginFor} runner={runnerById(loginFor.runner_id)} onClose={() => setLoginFor(null)} />}
    </div>
  );
}

function AddAccountModal({ open, onClose, runners, onCloudCreated }: { open: boolean; onClose: () => void; runners: Runner[]; onCloudCreated: (a: Account, token: string) => void }) {
  const blank = { name: '', provider: 'claude-cloud', runner_id: '', config_dir: '', max_concurrent_runs: 2, fire_url: '', fire_token: '' };
  const [form, setForm] = useState(blank);
  const cloud = form.provider === 'claude-cloud';
  const create = useAction(
    () =>
      api('POST', '/api/accounts', {
        name: form.name,
        provider: form.provider,
        max_concurrent_runs: form.max_concurrent_runs,
        ...(cloud ? { fire_url: form.fire_url, fire_token: form.fire_token } : { runner_id: form.runner_id || null, config_dir: form.config_dir || null }),
      }),
    {
      success: cloud ? 'Cloud account added. Finish the setup on claude.ai' : 'Account added. The runner will check its sign-in shortly',
      onSuccess: (r: any) => {
        setForm(blank);
        onClose();
        if (r.cloud_token) onCloudCreated(r, r.cloud_token);
      },
    },
  );
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add account"
      width="max-w-xl"
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!form.name || create.isPending} onClick={() => create.mutate()}>
            Add account
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Name" hint="e.g. “Max account A”">
          <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus />
        </Field>
        <Field label="How its agents run">
          <select className="input" value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value, max_concurrent_runs: e.target.value === 'claude-cloud' ? 2 : 1 })}>
            <option value="claude-cloud">Claude Code on the web: cloud sessions on your GitHub repo</option>
            <option value="claude-code">Claude Code CLI on a runner (VPS or your machine)</option>
            <option value="mock">Mock agent (testing, no usage)</option>
          </select>
        </Field>
        {cloud ? (
          <>
            <div className="rounded-lg bg-zinc-50 p-3 text-xs text-zinc-600 dark:bg-zinc-800/50 dark:text-zinc-400">
              Leave the routine fields empty on first setup. Creating the account gives you the AgentOS token that the routine's cloud environment needs. The setup guide opens next. Once the routine exists, add its Fire URL and token with “Routine trigger”.
            </div>
            <Field label="Routine Fire URL (optional now)">
              <input className="input font-mono text-xs" value={form.fire_url} onChange={(e) => setForm({ ...form, fire_url: e.target.value })} placeholder="https://api.anthropic.com/v1/claude_code/routines/trig_…/fire" />
            </Field>
            <Field label="Routine trigger token" hint="Scoped to firing this one routine. Stored encrypted.">
              <input type="password" className="input font-mono text-xs" value={form.fire_token} onChange={(e) => setForm({ ...form, fire_token: e.target.value })} placeholder="sk-ant-oat01-…" autoComplete="off" />
            </Field>
          </>
        ) : (
          <>
            <Field label="Runner" hint="The machine where this account signs in and its agents run.">
              <select className="input" value={form.runner_id} onChange={(e) => setForm({ ...form, runner_id: e.target.value })}>
                <option value="">Default ({runners[0]?.name ?? 'none'})</option>
                {runners.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name} ({r.status})
                  </option>
                ))}
              </select>
            </Field>
            {form.provider === 'claude-code' && (
              <Field label="Config directory (optional)" hint="CLAUDE_CONFIG_DIR on the runner. Leave empty for a dedicated directory inside the runner's data dir.">
                <input className="input font-mono text-xs" placeholder="~runner/accounts/<id>/claude" value={form.config_dir} onChange={(e) => setForm({ ...form, config_dir: e.target.value })} />
              </Field>
            )}
          </>
        )}
        <Field label="Max concurrent runs" hint={cloud ? 'How many cloud sessions of this account may work at once.' : '1 keeps usage predictable on a subscription.'}>
          <input type="number" min={1} max={8} className="input w-24" value={form.max_concurrent_runs} onChange={(e) => setForm({ ...form, max_concurrent_runs: Number(e.target.value) })} />
        </Field>
      </div>
    </Modal>
  );
}

function LoginModal({ acc, runner, onClose }: { acc: Account; runner?: Runner; onClose: () => void }) {
  const dir = resolveDir(acc, runner) ?? acc.config_dir ?? '';
  const cmd = `CLAUDE_CONFIG_DIR='${dir}' claude auth login --claudeai`;
  return (
    <Modal open onClose={onClose} title={`Sign in: ${acc.name}`} width="max-w-2xl">
      <div className="space-y-4 text-sm">
        <p>
          Run this <b>on the runner machine{runner ? ` (${runner.name}${runner.info?.hostname ? ` · ${runner.info.hostname}` : ''})` : ''}</b>, as the user that runs AgentOS. It opens Anthropic's own sign-in flow. Choose your Claude subscription, not Console/API billing.
        </p>
        <div className="flex items-start gap-2">
          <pre className="flex-1 overflow-x-auto rounded-lg bg-zinc-900 p-3 font-mono text-xs text-zinc-100">{cmd}</pre>
          <CopyButton text={cmd} />
        </div>
        <p className="text-zinc-500">
          Equivalent wrapper: <code className="kbd">agentos login '{acc.config_dir}'</code>. To sign in a second account, use its own directory. Each directory keeps its own login, so your two subscriptions stay independent.
        </p>
        <details className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
          <summary className="cursor-pointer font-medium">Headless alternative: long-lived token</summary>
          <p className="mt-2 text-zinc-600 dark:text-zinc-400">
            On any machine, run <code className="kbd">claude setup-token</code> (requires a subscription). Save the printed token on the runner in <code className="kbd">{dir}/agentos-oauth-token</code> (mode 600). The runner reads it locally. It is never sent to the control plane.
          </p>
        </details>
        <p className="text-xs text-zinc-500">After signing in, click “Re-check”. The status turns <b>Ready</b> once the runner confirms a subscription login with no API key in use.</p>
      </div>
    </Modal>
  );
}

function AddRunnerModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState('');
  const [created, setCreated] = useState<{ token: string; runner: Runner } | null>(null);
  const meta = useMeta();
  const create = useAction(() => api('POST', '/api/runners', { name }), { onSuccess: (r: any) => setCreated(r) });
  const close = () => {
    setCreated(null);
    setName('');
    onClose();
  };
  const cmd = created ? `npx agentos runner --server ${meta.data?.publicUrl ?? window.location.origin} --token ${created.token}` : '';
  return (
    <Modal open={open} onClose={close} title="Register a runner" width="max-w-2xl">
      {!created ? (
        <div className="space-y-3">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">A runner is a machine that executes agents for the accounts signed in on it, such as a laptop or a second server. It only makes outbound connections to this control plane.</p>
          <Field label="Runner name">
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. workstation" autoFocus />
          </Field>
          <div className="flex justify-end">
            <button className="btn btn-primary" disabled={!name || create.isPending} onClick={() => create.mutate()}>
              Create token
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-3 text-sm">
          <p>
            Runner <b>{created.runner.name}</b> registered. Copy its token now: it is shown only once.
          </p>
          <div className="flex items-start gap-2">
            <pre className="flex-1 overflow-x-auto rounded-lg bg-zinc-900 p-3 font-mono text-xs whitespace-pre-wrap text-zinc-100">{cmd}</pre>
            <CopyButton text={cmd} />
          </div>
          <p className="text-zinc-500">Run it from a checkout of AgentOS on that machine (Node 22+, git and the Claude Code CLI installed). Then add accounts with this runner selected and sign them in there.</p>
          <div className="flex justify-end">
            <button className="btn" onClick={close}>
              Done
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
