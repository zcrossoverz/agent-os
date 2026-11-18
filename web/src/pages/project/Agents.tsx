import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Crown, Plus, RotateCcw, BellRing, Power, Pencil, Play, MessageSquare } from 'lucide-react';
import { api, useAction } from '../../lib/api';
import { useAccounts, useMeta } from '../../lib/queries';
import type { AgentRow } from '../../lib/types';
import { useProjectCtx } from './ProjectLayout';
import { AgentStatus, Avatar, Badge, Field, Modal, RelTime } from '../../components/ui';
import { ACCOUNT_STATUS } from '../../lib/format';

export function AgentsPage() {
  const { project, agents } = useProjectCtx();
  const accounts = useAccounts();
  const [editing, setEditing] = useState<AgentRow | 'new' | null>(null);
  const [nudging, setNudging] = useState<AgentRow | null>(null);
  const resetSession = useAction((id: string) => api('POST', `/api/agents/${id}/reset-session`), { success: 'Context reset. The next run starts a fresh session with recovered context' });
  const resume = useAction((id: string) => api('POST', `/api/agents/${id}/resume`), { success: 'Agent resumed' });
  const toggle = useAction((a: AgentRow) => api('PATCH', `/api/agents/${a.id}`, { enabled: !a.enabled }));
  const makePm = useAction((a: AgentRow) => api('PATCH', `/api/agents/${a.id}`, { is_pm: true }), { success: 'Project Manager appointed' });
  const accountOf = (id: string | null) => accounts.data?.find((a) => a.id === id);

  return (
    <div className="mx-auto max-w-6xl px-6 py-6">
      <div className="mb-4 flex items-center justify-between">
        <p className="text-sm text-zinc-500">Each agent has its own role, account, git worktree and conversation context. Agents run only when they have something to do.</p>
        <button className="btn btn-primary" onClick={() => setEditing('new')}>
          <Plus className="size-4" /> Add agent
        </button>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {agents.map((a) => {
          const acc = accountOf(a.account_id);
          return (
            <div key={a.id} className={`card p-4 ${a.enabled ? '' : 'opacity-60'}`}>
              <div className="flex items-start gap-3">
                <Avatar name={a.name} seed={a.id} size="lg" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="font-semibold">{a.name}</span>
                    {a.is_pm && <Crown className="size-4 text-amber-500" />}
                    <span className="text-sm text-zinc-500">@{a.slug}</span>
                    {!a.enabled && <Badge>disabled</Badge>}
                    {a.tool_profile === 'readonly' && <Badge tone="sky">read-only</Badge>}
                  </div>
                  <div className="text-sm text-zinc-600 dark:text-zinc-400">{a.role}</div>
                  <div className="mt-1">
                    <AgentStatus status={a.status} detail={a.status_detail} />
                  </div>
                </div>
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
                <dt className="text-zinc-500">Account</dt>
                <dd className="truncate">
                  {acc ? (
                    <span className="flex items-center gap-1.5">
                      {acc.name}
                      <span className={`rounded px-1 ${ACCOUNT_STATUS[acc.status]?.cls}`}>{ACCOUNT_STATUS[acc.status]?.label}</span>
                    </span>
                  ) : (
                    <span className="text-amber-600">none: cannot run</span>
                  )}
                </dd>
                <dt className="text-zinc-500">Model</dt>
                <dd>{a.model ?? 'CLI default'}{a.effort ? ` · ${a.effort}` : ''}</dd>
                <dt className="text-zinc-500">Inbox</dt>
                <dd>
                  {a.inbox.pending} pending{a.inbox.wake ? ` (${a.inbox.wake} actionable)` : ''}
                </dd>
                <dt className="text-zinc-500">Last run</dt>
                <dd>{a.last_run_at ? <RelTime iso={a.last_run_at} /> : 'never'}</dd>
              </dl>
              <div className="mt-3 flex flex-wrap gap-1.5">
                <Link to={`/p/${project.slug}/chat`} className="btn btn-sm">
                  <MessageSquare className="size-3.5" /> Message
                </Link>
                <button className="btn btn-sm" onClick={() => setNudging(a)} title="Wake the agent for a check-in">
                  <BellRing className="size-3.5" /> Nudge
                </button>
                {a.status === 'error' && (
                  <button className="btn btn-sm" onClick={() => resume.mutate(a.id)}>
                    <Play className="size-3.5" /> Resume
                  </button>
                )}
                <Link to={`/p/${project.slug}/runs?agent=${a.id}`} className="btn btn-sm">
                  Runs
                </Link>
                <button className="btn btn-sm" onClick={() => setEditing(a)}>
                  <Pencil className="size-3.5" /> Edit
                </button>
                <span className="ml-auto flex gap-1.5">
                  {!a.is_pm && (
                    <button className="btn btn-ghost btn-sm" onClick={() => confirm(`Make ${a.name} the Project Manager?`) && makePm.mutate(a)} title="Appoint as PM">
                      <Crown className="size-3.5" />
                    </button>
                  )}
                  <button className="btn btn-ghost btn-sm" onClick={() => confirm(`Reset ${a.name}'s conversation context? Project state is kept in AgentOS.`) && resetSession.mutate(a.id)} title="Reset conversation context">
                    <RotateCcw className="size-3.5" />
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={() => toggle.mutate(a)} title={a.enabled ? 'Disable' : 'Enable'}>
                    <Power className="size-3.5" />
                  </button>
                </span>
              </div>
            </div>
          );
        })}
      </div>
      {editing && <AgentModal agent={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {nudging && <NudgeModal agent={nudging} onClose={() => setNudging(null)} />}
    </div>
  );
}

function NudgeModal({ agent, onClose }: { agent: AgentRow; onClose: () => void }) {
  const [note, setNote] = useState('');
  const nudge = useAction(() => api('POST', `/api/agents/${agent.id}/wake`, { note }), { success: `${agent.name} will check in`, onSuccess: onClose });
  return (
    <Modal
      open
      onClose={onClose}
      title={`Nudge ${agent.name}`}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={() => nudge.mutate()}>
            Wake
          </button>
        </>
      }
    >
      <Field label="Note (optional)" hint="Without a note the agent reviews its assignments and the board.">
        <textarea className="input min-h-20" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Prioritise the login bug before the refactor." />
      </Field>
    </Modal>
  );
}

function AgentModal({ agent, onClose }: { agent: AgentRow | null; onClose: () => void }) {
  const { project } = useProjectCtx();
  const accounts = useAccounts();
  const meta = useMeta();
  const presets = meta.data?.rolePresets ?? {};
  const [f, setF] = useState({
    name: agent?.name ?? '',
    role: agent?.role ?? 'Backend Developer',
    account_id: agent?.account_id ?? accounts.data?.[0]?.id ?? '',
    model: agent?.model ?? '',
    effort: agent?.effort ?? '',
    instructions: agent?.instructions ?? presets.backend?.instructions ?? '',
    tool_profile: agent?.tool_profile ?? 'standard',
    max_turns: agent?.max_turns ?? 80,
    is_pm: agent?.is_pm ?? false,
  });
  const save = useAction(
    () => {
      const body = { ...f, account_id: f.account_id || null, model: f.model || null, effort: f.effort || null };
      return agent ? api('PATCH', `/api/agents/${agent.id}`, body) : api('POST', `/api/projects/${project.id}/agents`, body);
    },
    { success: agent ? 'Agent updated' : 'Agent added', onSuccess: onClose },
  );
  return (
    <Modal
      open
      onClose={onClose}
      title={agent ? `Edit ${agent.name}` : 'Add agent'}
      width="max-w-2xl"
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!f.name || !f.role || save.isPending} onClick={() => save.mutate()}>
            Save
          </button>
        </>
      }
    >
      <div className="space-y-3">
        {!agent && (
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(presets).map(([k, p]) => (
              <button key={k} className="btn btn-sm" onClick={() => setF({ ...f, role: p.role, instructions: p.instructions, tool_profile: p.tool_profile as any, is_pm: k === 'pm' })}>
                {p.role}
              </button>
            ))}
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name">
            <input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </Field>
          <Field label="Role" hint="Free text. Roles are not fixed.">
            <input className="input" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} />
          </Field>
          <Field label="Account">
            <select className="input" value={f.account_id} onChange={(e) => setF({ ...f, account_id: e.target.value })}>
              <option value="">None</option>
              {accounts.data?.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Model" hint="Alias (opus, sonnet, haiku) or full name. Empty = CLI default.">
            <input className="input" value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })} placeholder="default" />
          </Field>
          <Field label="Effort">
            <select className="input" value={f.effort} onChange={(e) => setF({ ...f, effort: e.target.value })}>
              <option value="">Default</option>
              {['low', 'medium', 'high', 'xhigh', 'max'].map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </Field>
          <Field label="Max turns per run">
            <input type="number" className="input" value={f.max_turns} min={1} max={500} onChange={(e) => setF({ ...f, max_turns: Number(e.target.value) })} />
          </Field>
          <Field label="Tool profile">
            <select className="input" value={f.tool_profile} onChange={(e) => setF({ ...f, tool_profile: e.target.value as any })}>
              <option value="standard">Standard: edits its worktree</option>
              <option value="readonly">Read-only: reviews, no edits</option>
            </select>
          </Field>
          <label className="mt-6 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={f.is_pm} onChange={(e) => setF({ ...f, is_pm: e.target.checked })} /> Project Manager
          </label>
        </div>
        <Field label="Role instructions" hint="Appended to the agent's system prompt, after AgentOS's operating manual.">
          <textarea className="input min-h-28 text-xs" value={f.instructions} onChange={(e) => setF({ ...f, instructions: e.target.value })} />
        </Field>
      </div>
    </Modal>
  );
}
