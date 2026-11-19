import { GitBranch, GitCommit, GitMerge } from 'lucide-react';
import { useGit } from '../../lib/queries';
import { useProjectCtx } from './ProjectLayout';
import { Avatar, Badge, Loading, RelTime, SectionTitle, StatusChip } from '../../components/ui';

export function GitPage() {
  const { project, agent, openTask } = useProjectCtx();
  const git = useGit(project.id);
  if (!git.data) return <Loading />;
  const g = git.data;
  return (
    <div className="mx-auto max-w-6xl space-y-6 px-6 py-6">
      <div className="card flex flex-wrap items-center gap-x-6 gap-y-1 px-4 py-3 text-sm">
        <span>
          Base branch <code className="kbd">{g.base_branch}</code>
        </span>
        <span className="text-zinc-500">Repository: {g.repo_url ?? 'created by AgentOS on the runner'}</span>
        <span className="text-zinc-500">Each agent works in its own worktree on per-task branches. AgentOS merges reviewed work into the base branch.</span>
      </div>
      <section>
        <SectionTitle>Task branches</SectionTitle>
        <div className="card divide-y divide-zinc-100 dark:divide-white/[0.05]">
          {g.branches.map((b) => {
            const a = agent(b.assignee_id);
            return (
              <button key={b.branch} onClick={() => openTask(b.task.id)} className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-zinc-50 dark:hover:bg-white/[0.04]">
                <GitBranch className="size-4 shrink-0 text-zinc-400" />
                <code className="min-w-0 flex-1 truncate font-mono text-xs">{b.branch}</code>
                <span className="w-16 text-xs text-zinc-500">{b.task.key}</span>
                {a && <Avatar name={a.name} seed={a.id} size="xs" />}
                <StatusChip status={b.task.status} />
                {b.task.merge_state && <Badge tone={b.task.merge_state === 'merged' ? 'emerald' : b.task.merge_state === 'conflict' || b.task.merge_state === 'failed' ? 'red' : 'zinc'}>{b.task.merge_state.replace('_', ' ')}</Badge>}
              </button>
            );
          })}
          {!g.branches.length && <div className="px-4 py-6 text-center text-sm text-zinc-500">No task branches yet.</div>}
        </div>
      </section>
      <div className="grid gap-6 lg:grid-cols-2">
        <section>
          <SectionTitle>Commits by agents</SectionTitle>
          <div className="card divide-y divide-zinc-100 dark:divide-white/[0.05]">
            {g.commits.map((c) => {
              const a = agent(c.agent_id);
              return (
                <div key={c.sha} className="flex items-start gap-2.5 px-4 py-2 text-sm">
                  <GitCommit className="mt-0.5 size-4 shrink-0 text-zinc-400" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate">{c.message}</div>
                    <div className="text-xs text-zinc-500">
                      <code className="font-mono">{c.sha.slice(0, 8)}</code> · {a?.name ?? (c.agent_id ? 'agent' : 'AgentOS')} · {c.branch} · <RelTime iso={c.committed_at ?? c.created_at} />
                    </div>
                  </div>
                </div>
              );
            })}
            {!g.commits.length && <div className="px-4 py-6 text-center text-sm text-zinc-500">No commits recorded yet.</div>}
          </div>
        </section>
        <section>
          <SectionTitle>Merges</SectionTitle>
          <div className="card divide-y divide-zinc-100 dark:divide-white/[0.05]">
            {g.merges.map((m) => (
              <div key={m.id} className="flex items-start gap-2.5 px-4 py-2 text-sm">
                <GitMerge className="mt-0.5 size-4 shrink-0 text-zinc-400" />
                <div className="min-w-0 flex-1">
                  <div className="truncate">{m.prompt}</div>
                  <div className="text-xs text-zinc-500">
                    {m.git?.mergeResult ?? m.status} · <RelTime iso={m.finished_at ?? m.queued_at} />
                  </div>
                </div>
                <Badge tone={m.status === 'succeeded' ? 'emerald' : m.status === 'failed' ? 'red' : 'sky'}>{m.status}</Badge>
              </div>
            ))}
            {!g.merges.length && <div className="px-4 py-6 text-center text-sm text-zinc-500">No merges yet.</div>}
          </div>
        </section>
      </div>
    </div>
  );
}
