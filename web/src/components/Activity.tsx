import clsx from 'clsx';
import { Bot, User, Cog, Server } from 'lucide-react';
import type { ActivityEntry } from '../lib/types';
import { RelTime } from './ui';

const TONE: Record<string, string> = {
  task: 'text-sky-600 dark:text-sky-400',
  run: 'text-emerald-600 dark:text-emerald-400',
  approval: 'text-amber-600 dark:text-amber-400',
  guard: 'text-red-600 dark:text-red-400',
  message: 'text-indigo-600 dark:text-indigo-400',
  decision: 'text-violet-600 dark:text-violet-400',
};

export function ActivityList({ items, agentName, dense, onTask }: { items: ActivityEntry[]; agentName?: (id: string) => string | undefined; dense?: boolean; onTask?: (id: string) => void }) {
  if (!items.length) return <div className="px-4 py-6 text-center text-sm text-zinc-500">No activity yet.</div>;
  return (
    <ol className="divide-y divide-zinc-100 dark:divide-white/[0.05]">
      {items.map((e) => {
        const kind = e.type.split('.')[0];
        const failed = /failed|guard|rejected/.test(e.type);
        const Icon = e.actor === 'owner' ? User : e.actor.startsWith('agent:') ? Bot : e.actor.startsWith('runner:') ? Server : Cog;
        const who = e.actor === 'owner' ? 'You' : e.actor.startsWith('agent:') ? (agentName?.(e.actor.slice(6)) ?? 'Agent') : e.actor.startsWith('runner:') ? 'Runner' : 'AgentOS';
        const clickable = onTask && e.subject_type === 'task' && e.subject_id;
        return (
          <li key={e.id} className={clsx('flex items-start gap-2.5', dense ? 'px-3 py-1.5' : 'px-4 py-2')}>
            <Icon className={clsx('mt-0.5 size-3.5 shrink-0', failed ? 'text-red-500' : (TONE[kind] ?? 'text-zinc-400'))} />
            <div className="min-w-0 flex-1 text-sm">
              <button disabled={!clickable} onClick={() => clickable && onTask!(e.subject_id!)} className={clsx('text-left text-zinc-700 dark:text-zinc-300', clickable && 'hover:underline')}>
                {e.summary.replace(/^Owner /, 'You ')}
              </button>
              <div className="text-[11px] text-zinc-400">
                {who} · <RelTime iso={e.created_at} />
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
