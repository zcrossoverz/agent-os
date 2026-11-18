import { useState } from 'react';
import clsx from 'clsx';
import { ShieldCheck } from 'lucide-react';
import { useApprovals, useDecisions } from '../../lib/queries';
import { useProjectCtx } from './ProjectLayout';
import { ApprovalCard } from '../../components/ApprovalCard';
import { Empty, Loading, Markdown, RelTime, SectionTitle } from '../../components/ui';

export function ApprovalsPage() {
  const { project, agent } = useProjectCtx();
  const [tab, setTab] = useState<'pending' | 'history' | 'decisions'>('pending');
  const pending = useApprovals(project.id, 'pending');
  const all = useApprovals(project.id);
  const decisions = useDecisions(project.id);
  const history = (all.data ?? []).filter((a) => a.status !== 'pending');

  return (
    <div className="mx-auto max-w-4xl px-6 py-6">
      <div className="mb-4 flex gap-1 rounded-lg bg-zinc-100 p-1 text-sm dark:bg-zinc-800/60">
        {(
          [
            ['pending', `Pending (${pending.data?.length ?? 0})`],
            ['history', 'History'],
            ['decisions', 'Decision log'],
          ] as const
        ).map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} className={clsx('flex-1 rounded-md px-3 py-1.5 font-medium transition', tab === k ? 'bg-white shadow-xs dark:bg-zinc-700' : 'text-zinc-500')}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'pending' &&
        (pending.isLoading ? (
          <Loading />
        ) : pending.data?.length ? (
          <div className="space-y-3">
            {pending.data.map((a) => (
              <ApprovalCard key={a.id} a={a} agentName={agent(a.agent_id)?.name} />
            ))}
          </div>
        ) : (
          <div className="card">
            <Empty icon={<ShieldCheck className="size-8" />} title="Nothing to approve">
              Agents ask here before architectural, security, destructive or production-impacting actions. Merges and plans land here when your policy requires it.
            </Empty>
          </div>
        ))}
      {tab === 'history' && (
        <div className="space-y-3">
          {history.map((a) => (
            <ApprovalCard key={a.id} a={a} compact agentName={agent(a.agent_id)?.name} />
          ))}
          {!history.length && <div className="card px-4 py-6 text-center text-sm text-zinc-500">No decided approvals yet.</div>}
        </div>
      )}
      {tab === 'decisions' && (
        <div className="space-y-3">
          <SectionTitle>Decisions recorded by you and the agents</SectionTitle>
          {decisions.data?.map((d) => (
            <div key={d.id} className="card p-4">
              <div className="flex items-center justify-between gap-2">
                <div className="font-medium">{d.title}</div>
                <span className={clsx('rounded-md px-1.5 py-0.5 text-[11px]', d.status === 'accepted' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300' : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800')}>{d.status}</span>
              </div>
              <div className="mt-0.5 text-xs text-zinc-500">
                {d.decided_by === 'owner' ? 'You' : (agent(d.decided_by.slice(6))?.name ?? d.decided_by)} · <RelTime iso={d.created_at} />
              </div>
              <Markdown className="mt-2">{d.decision}</Markdown>
              {d.context && (
                <details className="mt-2 text-sm">
                  <summary className="cursor-pointer text-xs text-zinc-500">Context</summary>
                  <Markdown>{d.context}</Markdown>
                </details>
              )}
            </div>
          ))}
          {!decisions.data?.length && <div className="card px-4 py-6 text-center text-sm text-zinc-500">No decisions recorded yet.</div>}
        </div>
      )}
    </div>
  );
}
