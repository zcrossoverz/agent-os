import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Send, Crown } from 'lucide-react';
import { api, useAction } from '../../lib/api';
import { useActivity, useApprovals, useTasks } from '../../lib/queries';
import { useProjectCtx } from './ProjectLayout';
import { ActivityList } from '../../components/Activity';
import { ApprovalCard } from '../../components/ApprovalCard';
import { AgentStatus, Avatar, Empty, Priority, ProgressBar, SectionTitle, Stat, StatusChip } from '../../components/ui';
import { STATUS_META } from '../../lib/format';

export function ProjectOverview() {
  const { project, agents, agent, openTask } = useProjectCtx();
  const tasks = useTasks(project.id);
  const approvals = useApprovals(project.id, 'pending');
  const activity = useActivity(project.id);
  const nav = useNavigate();
  const pm = agents.find((a) => a.is_pm);
  const [msg, setMsg] = useState('');
  const send = useAction(() => api('POST', `/api/projects/${project.id}/messages`, { to: { type: 'agent', agentId: pm!.id }, body: msg }), {
    success: `Sent to ${pm?.name}`,
    onSuccess: () => {
      setMsg('');
      nav(`/p/${project.slug}/chat`);
    },
  });
  const s = project.stats.tasks;
  const total = Object.entries(s).filter(([k]) => k !== 'cancelled').reduce((a, [, b]) => a + b, 0);
  const active = (tasks.data ?? []).filter((t) => ['in_progress', 'in_review', 'blocked'].includes(t.status));

  return (
    <div className="mx-auto grid max-w-7xl gap-6 px-6 py-6 lg:grid-cols-[1fr_22rem]">
      <div className="min-w-0 space-y-6">
        {pm ? (
          <div className="card p-4">
            <div className="mb-2 flex items-center gap-2 text-sm">
              <Avatar name={pm.name} seed={pm.id} size="sm" />
              <span className="font-medium">{pm.name}</span>
              <span className="text-zinc-500">· Project Manager</span>
              <span className="ml-auto">
                <AgentStatus status={pm.status} detail={pm.status_detail} />
              </span>
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (msg.trim()) send.mutate();
              }}
              className="flex gap-2"
            >
              <textarea
                className="input min-h-[2.5rem] flex-1 resize-y"
                rows={2}
                placeholder={`Tell ${pm.name} what you want, e.g. “Build an authentication system” or “Find out why development is blocked”…`}
                value={msg}
                onChange={(e) => setMsg(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && msg.trim()) send.mutate();
                }}
              />
              <button className="btn btn-primary self-end" disabled={!msg.trim() || send.isPending}>
                <Send className="size-4" />
              </button>
            </form>
          </div>
        ) : (
          <div className="card p-4 text-sm text-zinc-600">
            No Project Manager yet. <Link className="text-indigo-600 underline" to={`/p/${project.slug}/agents`}>Appoint one</Link> to coordinate the team.
          </div>
        )}

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Done" value={`${s.done ?? 0}/${total}`} tone="emerald" />
          <Stat label="In progress" value={(s.in_progress ?? 0) + (s.in_review ?? 0)} sub={`${s.in_review ?? 0} in review`} />
          <Stat label="Blocked" value={s.blocked ?? 0} tone={(s.blocked ?? 0) > 0 ? 'red' : undefined} />
          <Stat label="Waiting on you" value={project.stats.pendingApprovals + project.stats.unansweredOwner} tone={project.stats.pendingApprovals + project.stats.unansweredOwner ? 'amber' : undefined} sub="approvals + questions" />
        </div>
        <ProgressBar segments={['done', 'in_review', 'in_progress', 'todo', 'blocked', 'backlog'].map((k) => ({ label: STATUS_META[k].label, value: s[k] ?? 0, cls: STATUS_META[k].dot }))} />

        <section>
          <SectionTitle>Team</SectionTitle>
          <div className="card divide-y divide-zinc-100 dark:divide-zinc-800">
            {agents.map((a) => (
              <div key={a.id} className="flex items-center gap-3 px-4 py-2.5">
                <Avatar name={a.name} seed={a.id} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-sm font-medium">
                    {a.name}
                    {a.is_pm && <Crown className="size-3.5 text-amber-500" />}
                    <span className="font-normal text-zinc-500">@{a.slug} · {a.role}</span>
                  </div>
                  <AgentStatus status={a.status} detail={a.status_detail} />
                </div>
                {a.inbox.pending > 0 && <span className="text-xs text-zinc-500">{a.inbox.pending} in inbox</span>}
              </div>
            ))}
            {agents.length === 0 && <Empty title="No agents yet" />}
          </div>
        </section>

        <section>
          <SectionTitle>Active work</SectionTitle>
          <div className="card divide-y divide-zinc-100 dark:divide-zinc-800">
            {active.map((t) => {
              const a = agent(t.assignee_id);
              return (
                <button key={t.id} onClick={() => openTask(t.id)} className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
                  <Priority p={t.priority} />
                  <span className="w-20 shrink-0 text-xs font-medium text-zinc-500">{t.key}</span>
                  <span className="min-w-0 flex-1 truncate text-sm">{t.title}</span>
                  <StatusChip status={t.status} />
                  {a && <Avatar name={a.name} seed={a.id} size="xs" />}
                </button>
              );
            })}
            {active.length === 0 && <div className="px-4 py-6 text-center text-sm text-zinc-500">Nothing in flight right now.</div>}
          </div>
        </section>
      </div>

      <aside className="space-y-6">
        <section>
          <SectionTitle>Pending approvals</SectionTitle>
          <div className="space-y-3">
            {approvals.data?.map((a) => <ApprovalCard key={a.id} a={a} compact agentName={agent(a.agent_id)?.name} />)}
            {approvals.data?.length === 0 && <div className="card px-4 py-4 text-sm text-zinc-500">No decisions waiting.</div>}
          </div>
        </section>
        <section>
          <SectionTitle>Activity</SectionTitle>
          <div className="card max-h-[32rem] overflow-y-auto scrollbar-thin">
            <ActivityList items={(activity.data ?? []).slice(0, 40)} agentName={(id) => agent(id)?.name} dense onTask={openTask} />
          </div>
        </section>
      </aside>
    </div>
  );
}
