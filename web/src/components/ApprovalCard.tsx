import { useState } from 'react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { ShieldAlert, GitMerge, ListChecks, Building2, Lock, Rocket, Trash2, HelpCircle, Terminal } from 'lucide-react';
import { api, useAction } from '../lib/api';
import type { Approval } from '../lib/types';
import { Badge, Markdown, RelTime } from './ui';

const KIND: Record<string, { label: string; icon: any; tone: any }> = {
  permission: { label: 'Command', icon: Terminal, tone: 'red' },
  destructive: { label: 'Destructive', icon: Trash2, tone: 'red' },
  production: { label: 'Production', icon: Rocket, tone: 'red' },
  security: { label: 'Security', icon: Lock, tone: 'amber' },
  architecture: { label: 'Architecture', icon: Building2, tone: 'violet' },
  decision: { label: 'Decision', icon: HelpCircle, tone: 'indigo' },
  merge: { label: 'Merge', icon: GitMerge, tone: 'emerald' },
  plan: { label: 'Plan', icon: ListChecks, tone: 'sky' },
  other: { label: 'Other', icon: ShieldAlert, tone: 'zinc' },
};

export function ApprovalCard({ a, agentName, projectSlug, projectName, compact }: { a: Approval; agentName?: string; projectSlug?: string; projectName?: string; compact?: boolean }) {
  const [note, setNote] = useState('');
  const [expanded, setExpanded] = useState(!compact);
  const decide = useAction((decision: 'approved' | 'rejected') => api('POST', `/api/approvals/${a.id}/decide`, { decision, note: note.trim() || null }), {
    success: (r: Approval) => `Approval #${r.number} ${r.status}`,
  });
  const k = KIND[a.kind] ?? KIND.other;
  const Icon = k.icon;
  const pending = a.status === 'pending';
  return (
    <div className={clsx('card p-4', pending && 'border-amber-300/70 dark:border-amber-400/25')}>
      <div className="flex items-start gap-3">
        <div className={clsx('mt-0.5 rounded-lg p-1.5', pending ? 'bg-amber-50 text-amber-600 dark:bg-amber-400/10 dark:text-amber-400 dark:ring-1 dark:ring-inset dark:ring-amber-400/20' : 'bg-zinc-100 text-zinc-500 dark:bg-white/[0.06]')}>
          <Icon className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs font-semibold text-zinc-500">#{a.number}</span>
            <Badge tone={k.tone}>{k.label}</Badge>
            {!pending && <Badge tone={a.status === 'approved' ? 'emerald' : 'zinc'}>{a.status}</Badge>}
            {projectName && projectSlug && (
              <Link to={`/p/${projectSlug}/approvals`} className="text-xs text-zinc-500 hover:underline">
                {projectName}
              </Link>
            )}
            <span className="ml-auto text-xs text-zinc-400">
              <RelTime iso={a.created_at} />
            </span>
          </div>
          <button className="mt-1 text-left text-sm font-medium hover:underline" onClick={() => setExpanded((x) => !x)}>
            {a.title}
          </button>
          <div className="text-xs text-zinc-500">Requested by {agentName ?? (a.agent_id ? 'an agent' : 'AgentOS')}</div>
          {expanded && a.description && <Markdown className="mt-2 rounded-lg bg-zinc-50 p-3 dark:bg-ink-950/60">{a.description}</Markdown>}
          {!pending && a.decision_note && <div className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">Note: {a.decision_note}</div>}
          {pending && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {expanded && <input className="input min-w-48 flex-1" placeholder="Optional note to the agent…" value={note} onChange={(e) => setNote(e.target.value)} />}
              <button className="btn btn-primary btn-sm" disabled={decide.isPending} onClick={() => decide.mutate('approved')}>
                Approve
              </button>
              <button className="btn btn-sm" disabled={decide.isPending} onClick={() => decide.mutate('rejected')}>
                Reject
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
