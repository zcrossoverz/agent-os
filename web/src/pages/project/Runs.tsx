import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import clsx from 'clsx';
import { Wrench, CornerDownRight, AlertTriangle, Info, GitMerge, Square, Bot, ExternalLink, Cloud } from 'lucide-react';
import { api, useAction } from '../../lib/api';
import { useRun, useRunEvents, useRuns } from '../../lib/queries';
import type { Run, RunEvent } from '../../lib/types';
import { useProjectCtx } from './ProjectLayout';
import { Avatar, Badge, Empty, Loading, Markdown, RelTime } from '../../components/ui';
import { fmtDate, humanDuration } from '../../lib/format';

const STATUS_TONE: Record<string, any> = { queued: 'sky', running: 'emerald', succeeded: 'zinc', failed: 'red', cancelled: 'zinc' };

export function RunsPage() {
  const { project, agent } = useProjectCtx();
  const { runId } = useParams();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const runs = useRuns(project.id);
  const agentFilter = params.get('agent');
  const list = (runs.data ?? []).filter((r) => !agentFilter || r.agent_id === agentFilter);

  useEffect(() => {
    if (!runId && list.length) nav(`/p/${project.slug}/runs/${list[0].id}${agentFilter ? `?agent=${agentFilter}` : ''}`, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, list.length]);

  if (runs.isLoading) return <Loading />;
  if (!list.length)
    return (
      <Empty icon={<Bot className="size-8" />} title="No runs yet">
        A run is one working session of an agent. Runs start automatically when an agent has something to do.
      </Empty>
    );

  return (
    <div className="flex h-full min-h-0">
      <div className="w-80 shrink-0 overflow-y-auto border-r border-zinc-200 scrollbar-thin dark:border-white/[0.06]">
        {agentFilter && (
          <div className="flex items-center justify-between border-b border-zinc-200 px-3 py-2 text-xs dark:border-white/[0.06]">
            Runs of {agent(agentFilter)?.name}
            <button className="text-indigo-600" onClick={() => nav(`/p/${project.slug}/runs`)}>
              Show all
            </button>
          </div>
        )}
        {list.map((r) => {
          const a = agent(r.agent_id);
          return (
            <button
              key={r.id}
              onClick={() => nav(`/p/${project.slug}/runs/${r.id}${agentFilter ? `?agent=${agentFilter}` : ''}`)}
              className={clsx('flex w-full items-start gap-2.5 border-b border-zinc-100 px-3 py-2.5 text-left dark:border-white/[0.05]', r.id === runId ? 'bg-indigo-50/70 dark:bg-indigo-400/[0.07]' : 'hover:bg-zinc-50 dark:hover:bg-white/[0.03]')}
            >
              {r.kind === 'merge' ? <GitMerge className="mt-0.5 size-6 text-zinc-400" /> : <Avatar name={a?.name ?? '?'} seed={a?.id} size="sm" />}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-sm">
                  <span className="truncate font-medium">{r.kind === 'merge' ? 'Merge' : (a?.name ?? 'Agent')}</span>
                  <Badge tone={STATUS_TONE[r.status]}>{r.status}</Badge>
                </div>
                <div className="truncate text-xs text-zinc-500">
                  {r.session_url && <Cloud className="mr-1 inline size-3" />}
                  {r.trigger} · <RelTime iso={r.queued_at} />
                  {r.error_kind ? ` · ${r.error_kind}` : ''}
                </div>
              </div>
            </button>
          );
        })}
      </div>
      <div className="min-w-0 flex-1 overflow-y-auto scrollbar-thin">{runId && <RunDetail id={runId} />}</div>
    </div>
  );
}

function RunDetail({ id }: { id: string }) {
  const { agent, openTask } = useProjectCtx();
  const run = useRun(id);
  const events = useRunEvents(id);
  const [tab, setTab] = useState<'log' | 'prompt' | 'git'>('log');
  const cancel = useAction(() => api('POST', `/api/runs/${id}/cancel`), { success: 'Cancellation requested' });
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (run.data?.status === 'running') endRef.current?.scrollIntoView({ block: 'end' });
  }, [events.data?.length, run.data?.status]);
  if (!run.data) return <Loading />;
  const r = run.data;
  const a = agent(r.agent_id);
  const dur = r.started_at ? ((r.finished_at ? new Date(r.finished_at).getTime() : Date.now()) - new Date(r.started_at).getTime()) / 1000 : null;

  return (
    <div className="px-6 py-5">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold">{r.kind === 'merge' ? 'Merge run' : `${a?.name ?? 'Agent'} · ${a?.role ?? ''}`}</h2>
            <Badge tone={STATUS_TONE[r.status]}>{r.status}</Badge>
            {r.error_kind && <Badge tone="red">{r.error_kind}</Badge>}
          </div>
          <div className="mt-0.5 text-xs text-zinc-500">
            {r.id} · queued {fmtDate(r.queued_at)}
            {dur != null && ` · ${humanDuration(dur)}`}
            {r.focus_task_id && (
              <>
                {' · '}
                <button className="text-indigo-600 hover:underline" onClick={() => openTask(r.focus_task_id!)}>
                  focus task
                </button>
              </>
            )}
            {r.provider_session_id && ` · session ${r.provider_session_id.replace(/^(session_|cse_)/, '').slice(0, 10)}${r.resume_session_id ? ' (resumed)' : ''}`}
          </div>
        </div>
        {r.session_url && (
          <a className="btn btn-sm" href={r.session_url} target="_blank" rel="noreferrer" title="Watch or steer this Claude Code on the web session">
            <Cloud className="size-3.5" /> Open cloud session <ExternalLink className="size-3" />
          </a>
        )}
        {(r.status === 'running' || r.status === 'queued') && !r.session_url && (
          <button className="btn btn-sm" onClick={() => cancel.mutate()}>
            <Square className="size-3.5" /> Cancel
          </button>
        )}
      </div>

      {r.error_detail && <div className="mt-3 rounded-lg bg-red-50 px-3 py-2 font-mono text-xs whitespace-pre-wrap text-red-800 dark:bg-red-400/[0.07] dark:text-red-300">{r.error_detail}</div>}

      {r.kind === 'agent' && r.session_url && (
        <div className="mt-3 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
          <Metric label="Where" value="Claude Code on the web" />
          <Metric label="Duration" value={dur != null ? humanDuration(dur) : '—'} />
          <Metric label="AgentOS calls" value={events.data?.filter((e) => e.type === 'tool_use').length ?? '—'} />
          <Metric label="Billing" value="Subscription" hint="Cloud sessions always use the account's subscription" />
        </div>
      )}
      {r.kind === 'agent' && !r.session_url && (
        <div className="mt-3 grid grid-cols-2 gap-3 text-xs sm:grid-cols-5">
          <Metric label="Turns" value={r.usage.numTurns ?? '—'} />
          <Metric label="Output tokens" value={r.usage.outputTokens?.toLocaleString() ?? '—'} />
          <Metric label="Input (+cache)" value={r.usage.inputTokens != null ? `${(r.usage.inputTokens + (r.usage.cacheReadTokens ?? 0) + (r.usage.cacheCreationTokens ?? 0)).toLocaleString()}` : '—'} />
          <Metric label="Model" value={r.usage.model ?? '—'} />
          <Metric label="API-equivalent" value={r.usage.apiEquivalentUsd != null ? `$${r.usage.apiEquivalentUsd.toFixed(3)}` : '—'} hint="Estimate reported by the CLI. Not billed on a subscription." />
        </div>
      )}

      <div className="mt-4 flex gap-4 border-b border-zinc-200 text-sm dark:border-white/[0.06]">
        {(['log', 'prompt', 'git'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={clsx('-mb-px border-b-2 pb-2 capitalize', tab === t ? 'border-indigo-600 font-medium' : 'border-transparent text-zinc-500')}>
            {t === 'prompt' ? 'Why it ran' : t}
          </button>
        ))}
      </div>

      {tab === 'log' && (
        <div className="mt-3 space-y-1.5">
          {events.data?.map((e) => <EventLine key={e.seq} e={e} />)}
          {events.data?.length === 0 && <div className="py-6 text-center text-sm text-zinc-500">{r.status === 'queued' ? 'Waiting for a runner…' : 'No events.'}</div>}
          {r.result_text && !events.data?.some((e) => e.type === 'assistant_text' && String(e.data.text).trim() === r.result_text!.trim()) && (
            <div className="mt-4 rounded-xl border border-zinc-200 p-4 dark:border-white/[0.06]">
              <div className="mb-1 text-xs font-semibold text-zinc-500 uppercase">Final summary</div>
              <Markdown>{r.result_text}</Markdown>
            </div>
          )}
          <div ref={endRef} />
        </div>
      )}
      {tab === 'prompt' && (
        <div className="mt-3 space-y-3">
          <p className="text-xs text-zinc-500">The wake-up message AgentOS sent to the agent. It shows exactly why the agent ran and what it was asked to look at. A fresh session also received a context-recovery preamble.</p>
          <pre className="overflow-x-auto rounded-lg bg-zinc-100 p-4 font-mono text-xs whitespace-pre-wrap dark:bg-ink-900">{r.prompt}</pre>
          {r.inbox?.length > 0 && (
            <div className="text-xs text-zinc-500">
              Consumed {r.inbox.length} inbox item(s): {r.inbox.map((i: any) => i.type).join(', ')}
            </div>
          )}
        </div>
      )}
      {tab === 'git' && <GitTab r={r} />}
    </div>
  );
}

function GitTab({ r }: { r: Run }) {
  const g = r.git ?? {};
  return (
    <div className="mt-3 space-y-2 text-sm">
      {g.mergeResult && (
        <div>
          Merge result: <Badge tone={g.mergeResult === 'merged' ? 'emerald' : g.mergeResult === 'noop' ? 'zinc' : 'red'}>{g.mergeResult}</Badge> {g.pushed != null && <span className="text-xs text-zinc-500">· pushed: {String(g.pushed)}</span>}
          {g.mergeDetail && <pre className="mt-2 rounded-lg bg-zinc-100 p-3 font-mono text-xs whitespace-pre-wrap dark:bg-ink-900">{g.mergeDetail}</pre>}
        </div>
      )}
      {g.branch && (
        <div className="text-xs text-zinc-600 dark:text-zinc-400">
          Branch <code className="kbd">{g.branch}</code> at <code className="kbd">{g.head?.slice(0, 10)}</code>
          {g.dirty ? ' · uncommitted changes left in the worktree' : ''}
        </div>
      )}
      {g.workspace && <div className="font-mono text-xs text-zinc-500">{g.workspace}</div>}
      <div className="card divide-y divide-zinc-100 dark:divide-white/[0.05]">
        {(g.commits ?? []).map((c) => (
          <div key={c.sha} className="px-3 py-2 text-xs">
            <span className="font-mono text-zinc-500">{c.sha.slice(0, 8)}</span> <span className="text-zinc-400">({c.branch})</span> {c.message}
          </div>
        ))}
        {!g.commits?.length && <div className="px-3 py-3 text-xs text-zinc-500">No commits in this run.</div>}
      </div>
    </div>
  );
}

function Metric({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white/50 px-3 py-2.5 dark:border-white/[0.06] dark:bg-white/[0.02]" title={hint}>
      <div className="text-zinc-500">{label}</div>
      <div className="truncate font-medium tabular-nums">{value}</div>
    </div>
  );
}

function EventLine({ e }: { e: RunEvent }) {
  const [open, setOpen] = useState(false);
  const d = e.data;
  switch (e.type) {
    case 'assistant_text':
      return (
        <div className="rounded-lg bg-white px-3 py-2 ring-1 ring-zinc-200 dark:bg-ink-900 dark:ring-white/[0.06]">
          <Markdown>{String(d.text)}</Markdown>
        </div>
      );
    case 'tool_use': {
      const name = String(d.name).replace('mcp__agentos__', 'agentos · ');
      return (
        <button onClick={() => setOpen((x) => !x)} className="flex w-full items-start gap-2 text-left text-xs">
          <Wrench className="mt-0.5 size-3.5 shrink-0 text-indigo-500" />
          <span className="font-medium">{name}</span>
          <span className={clsx('min-w-0 flex-1 font-mono text-zinc-500', !open && 'truncate')}>{String(d.input ?? '')}</span>
        </button>
      );
    }
    case 'tool_result':
      return (
        <button onClick={() => setOpen((x) => !x)} className="flex w-full items-start gap-2 pl-5 text-left text-xs">
          <CornerDownRight className={clsx('mt-0.5 size-3.5 shrink-0', d.isError ? 'text-red-500' : 'text-zinc-400')} />
          <span className={clsx('min-w-0 flex-1 font-mono whitespace-pre-wrap', d.isError ? 'text-red-600 dark:text-red-400' : 'text-zinc-500', !open && 'line-clamp-2')}>{String(d.content ?? '') || '(empty)'}</span>
        </button>
      );
    case 'warning':
    case 'stderr':
      return (
        <div className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span className="font-mono whitespace-pre-wrap">{String(d.message ?? d.line ?? '')}</span>
        </div>
      );
    case 'init':
      return (
        <div className="flex items-start gap-2 text-xs text-zinc-500">
          <Info className="mt-0.5 size-3.5 shrink-0" /> Session {String(d.sessionId ?? '').replace(/^(session_|cse_)/, '').slice(0, 10)} · model {String(d.model ?? '?')} · key source <b className={d.apiKeySource === 'none' ? 'text-emerald-600' : 'text-red-600'}>{String(d.apiKeySource ?? 'none')}</b> · AgentOS tools {String(d.mcp)}
        </div>
      );
    case 'rate_limit':
      return (
        <div className="flex items-start gap-2 text-xs text-zinc-500">
          <Info className="mt-0.5 size-3.5 shrink-0" /> Usage: {Object.entries((d.windows as any) ?? {}).map(([k, w]: any) => `${k} ${Math.round((w.utilization ?? 0) * 100)}%`).join(' · ') || String(d.status)}
        </div>
      );
    case 'status':
    case 'git':
      return (
        <div className="flex items-start gap-2 text-xs text-zinc-400">
          <Info className="mt-0.5 size-3.5 shrink-0" />
          <span className="font-mono">
            {e.type}: {Object.entries(d).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(' ')}
          </span>
        </div>
      );
    default:
      return null;
  }
}
