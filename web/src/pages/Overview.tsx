import { Link } from 'react-router-dom';
import { CheckCircle2, MessageCircleQuestion, AlertOctagon, KeyRound, Ban, Plus, Server, Activity, BellRing, Layers } from 'lucide-react';
import { useOverview } from '../lib/queries';
import { ApprovalCard } from '../components/ApprovalCard';
import { ActivityList } from '../components/Activity';
import { AgentStatus, Avatar, Badge, Empty, Loading, ProgressBar, RelTime, SectionTitle, Stat } from '../components/ui';
import { ACCOUNT_STATUS, STATUS_META } from '../lib/format';

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Working late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

export function OverviewPage() {
  const { data, isLoading } = useOverview();
  if (isLoading || !data) return <Loading />;
  const agentName = (id: string) => {
    for (const p of data.projects) {
      const a = p.agents.find((x) => x.id === id);
      if (a) return a.name;
    }
    return undefined;
  };
  const projectOf = (id: string) => data.projects.find((p) => p.id === id);
  const at = data.attention;
  const agentIssues = at.agents.filter((a) => a.status === 'error' || a.status === 'waiting');
  const allAgents = data.projects.flatMap((p) => p.agents);
  const totalAgents = allAgents.length;
  const working = allAgents.filter((a) => a.status === 'running' || a.status === 'queued').length;
  const waiting = at.approvals.length + at.unanswered.length;
  const sum = (k: string) => data.projects.reduce((n, p) => n + (p.stats.tasks[k] ?? 0), 0);
  const inFlight = sum('in_progress') + sum('in_review');
  const blockedCount = sum('blocked');
  const doneCount = sum('done');
  const nothing = !at.approvals.length && !at.unanswered.length && !agentIssues.length && !at.accounts.length && !at.blocked.length && !at.runners.length;

  return (
    <div className="mx-auto max-w-6xl px-8 py-8">
      <div className="mb-7 flex items-end justify-between gap-4">
        <div>
          <p className="eyebrow">{greeting()}</p>
          <h1 className="mt-1 text-[26px] leading-tight font-semibold tracking-tight">Your AI team at a glance</h1>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">What your agents are doing, and what needs you.</p>
        </div>
        <Link to="/projects/new" className="btn btn-primary">
          <Plus className="size-4" /> New project
        </Link>
      </div>

      <div className="mb-8 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Agents working" value={`${working}/${totalAgents}`} tone="emerald" icon={<Activity className="size-4" />} sub={working ? 'running right now' : 'team idle'} />
        <Stat label="Waiting on you" value={waiting} tone={waiting ? 'amber' : undefined} icon={<BellRing className="size-4" />} sub="approvals and questions" />
        <Stat label="In progress" value={inFlight} tone="indigo" icon={<Layers className="size-4" />} sub={`${blockedCount} blocked`} />
        <Stat label="Done" value={doneCount} icon={<CheckCircle2 className="size-4" />} sub={`across ${data.projects.length} project${data.projects.length === 1 ? '' : 's'}`} />
      </div>

      <section className="mb-8">
        <SectionTitle>Needs your attention</SectionTitle>
        {nothing ? (
          <div className="card flex items-center gap-3 px-4 py-4 text-sm text-zinc-600 dark:text-zinc-400">
            <span className="flex size-8 items-center justify-center rounded-full bg-emerald-500/10"><CheckCircle2 className="size-4 text-emerald-500" /></span> All clear. Nothing is waiting on you.
          </div>
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {at.approvals.map((a) => {
              const p = projectOf(a.project_id);
              return <ApprovalCard key={a.id} a={a} compact agentName={a.agent_id ? agentName(a.agent_id) : undefined} projectName={p?.name} projectSlug={p?.slug} />;
            })}
            {at.unanswered.map((u) => {
              const p = projectOf(u.project_id);
              return (
                <Link key={u.message_id} to={`/p/${p?.slug}/chat/${u.conversation_id}`} className="card card-hover flex gap-3 p-4">
                  <MessageCircleQuestion className="mt-0.5 size-5 shrink-0 text-indigo-500" />
                  <div className="min-w-0">
                    <div className="text-xs text-zinc-500">
                      {agentName(u.agent_id)} asked you · {p?.name} · <RelTime iso={u.created_at} />
                    </div>
                    <div className="mt-0.5 line-clamp-3 text-sm">{u.body}</div>
                  </div>
                </Link>
              );
            })}
            {agentIssues.map((a) => {
              const p = projectOf(a.project_id);
              return (
                <Link key={a.id} to={`/p/${p?.slug}/agents`} className="card card-hover flex gap-3 p-4">
                  <AlertOctagon className={a.status === 'error' ? 'mt-0.5 size-5 shrink-0 text-red-500' : 'mt-0.5 size-5 shrink-0 text-amber-500'} />
                  <div className="min-w-0 text-sm">
                    <div className="font-medium">
                      {a.name} <span className="font-normal text-zinc-500">· {p?.name}</span>
                    </div>
                    <div className="text-zinc-600 dark:text-zinc-400">{a.status_detail ?? a.status}</div>
                  </div>
                </Link>
              );
            })}
            {at.accounts.map((acc) => (
              <Link key={acc.id} to="/accounts" className="card card-hover flex gap-3 p-4">
                <KeyRound className="mt-0.5 size-5 shrink-0 text-amber-500" />
                <div className="min-w-0 text-sm">
                  <div className="flex items-center gap-2 font-medium">
                    {acc.name} <span className={`rounded-md px-1.5 py-0.5 text-[11px] ${ACCOUNT_STATUS[acc.status]?.cls}`}>{ACCOUNT_STATUS[acc.status]?.label}</span>
                  </div>
                  <div className="text-zinc-600 dark:text-zinc-400">{acc.status_detail ?? acc.auth?.problem ?? 'Waiting for the runner to check this account.'}</div>
                </div>
              </Link>
            ))}
            {at.runners.map((r) => (
              <Link key={r.id} to="/accounts" className="card card-hover flex gap-3 p-4">
                <Server className="mt-0.5 size-5 shrink-0 text-zinc-400" />
                <div className="text-sm">
                  <div className="font-medium">Runner “{r.name}” is offline</div>
                  <div className="text-zinc-500">Last seen <RelTime iso={r.last_seen_at} /></div>
                </div>
              </Link>
            ))}
            {at.blocked.map((t) => {
              const p = projectOf(t.project_id);
              return (
                <Link key={t.id} to={`/p/${p?.slug}/board?task=${t.id}`} className="card card-hover flex gap-3 p-4">
                  <Ban className="mt-0.5 size-5 shrink-0 text-red-500" />
                  <div className="min-w-0 text-sm">
                    <div className="font-medium">
                      {t.key} {t.title}
                    </div>
                    <div className="line-clamp-2 text-zinc-600 dark:text-zinc-400">Blocked: {t.blocked_reason ?? 'no reason given'}</div>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </section>

      <section className="mb-8">
        <SectionTitle>Projects</SectionTitle>
        {data.projects.length === 0 ? (
          <div className="card">
            <Empty title="No projects yet" action={<Link to="/projects/new" className="btn btn-primary">Create your first project</Link>}>
              Create a project, connect an account, and appoint a Project Manager. Then describe what you want built.
            </Empty>
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {data.projects.map((p) => {
              const s = p.stats.tasks;
              const total = Object.values(s).reduce((a, b) => a + b, 0);
              const working = p.agents.filter((a) => a.status === 'running');
              return (
                <Link key={p.id} to={`/p/${p.slug}`} className="card card-hover block p-5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <h2 className="truncate font-semibold">{p.name}</h2>
                        <Badge>{p.key}</Badge>
                      </div>
                      <p className="mt-1 line-clamp-2 text-sm text-zinc-500">{p.description || 'No description'}</p>
                    </div>
                    <Badge tone={p.autonomy === 'autonomous' ? 'emerald' : p.autonomy === 'supervised' ? 'amber' : 'zinc'}>{p.autonomy}</Badge>
                  </div>
                  <ProgressBar
                    className="mt-4"
                    segments={['done', 'in_review', 'in_progress', 'todo', 'blocked', 'backlog'].map((k) => ({ label: STATUS_META[k].label, value: s[k] ?? 0, cls: STATUS_META[k].dot }))}
                  />
                  <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-zinc-500">
                    <span>
                      {s.done ?? 0}/{total - (s.cancelled ?? 0)} done
                    </span>
                    {(s.in_progress ?? 0) > 0 && <span>{s.in_progress} in progress</span>}
                    {(s.in_review ?? 0) > 0 && <span>{s.in_review} in review</span>}
                    {(s.blocked ?? 0) > 0 && <span className="text-red-600">{s.blocked} blocked</span>}
                    {p.stats.pendingApprovals > 0 && <span className="text-amber-600">{p.stats.pendingApprovals} approval(s)</span>}
                  </div>
                  <div className="mt-4 flex items-center justify-between">
                    <div className="flex -space-x-1.5">
                      {p.agents.map((a) => (
                        <span key={a.id} className="relative">
                          <Avatar name={a.name} seed={a.id} size="sm" ring />
                          <span className="absolute -right-0.5 -bottom-0.5">
                            <AgentStatus status={a.status} compact />
                          </span>
                        </span>
                      ))}
                    </div>
                    <span className="text-xs text-zinc-500">{working.length ? `${working.map((a) => a.name).join(', ')} working` : 'Team idle'}</span>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </section>

      <section>
        <SectionTitle>Recent activity</SectionTitle>
        <div className="card overflow-hidden">
          <ActivityList items={data.recentActivity} agentName={agentName} />
        </div>
      </section>
    </div>
  );
}

