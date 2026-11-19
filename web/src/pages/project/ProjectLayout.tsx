import { createContext, useContext, useMemo } from 'react';
import { NavLink, Route, Routes, useParams, useSearchParams } from 'react-router-dom';
import clsx from 'clsx';
import { Pause, Eye, Zap } from 'lucide-react';
import { api, useAction } from '../../lib/api';
import { useAgents, useProject } from '../../lib/queries';
import type { AgentRow, ProjectWithStats } from '../../lib/types';
import { Badge, Loading } from '../../components/ui';
import { avatarColor } from '../../lib/format';
import { ProjectOverview } from './ProjectOverview';
import { BoardPage } from './Board';
import { ChatPage } from './Chat';
import { AgentsPage } from './Agents';
import { ApprovalsPage } from './Approvals';
import { RunsPage } from './Runs';
import { ActivityPage } from './ActivityPage';
import { KnowledgePage } from './Knowledge';
import { GitPage } from './Git';
import { SettingsPage } from './Settings';
import { TaskDrawer } from './TaskDrawer';

interface Ctx {
  project: ProjectWithStats;
  agents: AgentRow[];
  agent: (id: string | null | undefined) => AgentRow | undefined;
  openTask: (id: string) => void;
}
const ProjectCtx = createContext<Ctx | null>(null);
export const useProjectCtx = () => useContext(ProjectCtx)!;

export function ProjectLayout() {
  const { projectId } = useParams();
  const project = useProject(projectId!);
  const agents = useAgents(project.data?.id ?? '');
  const [params, setParams] = useSearchParams();
  const ctx = useMemo<Ctx | null>(() => {
    if (!project.data) return null;
    const list = agents.data ?? [];
    return {
      project: project.data,
      agents: list,
      agent: (id) => list.find((a) => a.id === id),
      openTask: (id) => {
        const p = new URLSearchParams(params);
        p.set('task', id);
        setParams(p);
      },
    };
  }, [project.data, agents.data, params, setParams]);

  if (project.isLoading) return <Loading />;
  if (project.isError || !ctx) return <div className="p-8 text-sm text-red-600">Project not found.</div>;
  const p = ctx.project;
  const base = `/p/${p.slug}`;
  const tab = (to: string, label: string, count?: number) => (
    <NavLink
      to={to}
      end={to === base}
      className={({ isActive }) =>
        clsx(
          'relative -mb-px flex items-center gap-1.5 border-b-2 px-0.5 pt-1 pb-3 text-[13px] whitespace-nowrap transition',
          isActive ? 'border-accent-500 font-medium text-zinc-900 dark:border-accent-400 dark:text-white' : 'border-transparent text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-100',
        )
      }
    >
      {label}
      {!!count && <span className="rounded-full bg-amber-400/90 px-1.5 text-[10px] leading-4 font-semibold text-amber-950">{count}</span>}
    </NavLink>
  );

  return (
    <ProjectCtx.Provider value={ctx}>
      <div className="flex h-full flex-col">
        <header className="glass sticky top-0 z-20 border-b border-zinc-200/80 px-6 pt-5 dark:border-white/[0.06]">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className={clsx('flex size-7 shrink-0 items-center justify-center rounded-lg text-xs font-bold text-white shadow-[inset_0_0_0_1px_rgb(255_255_255/0.15)]', avatarColor(p.id))}>{p.name[0]?.toUpperCase()}</span>
                <h1 className="truncate text-lg font-semibold tracking-tight">{p.name}</h1>
                <Badge>{p.key}</Badge>
                <Badge tone="indigo">{p.coordination_mode === 'pm_led' ? 'PM-led' : 'Collaborative'}</Badge>
              </div>
              <p className="mt-0.5 line-clamp-1 max-w-2xl text-sm text-zinc-500">{p.description || 'No description'}</p>
            </div>
            <AutonomySwitch project={p} />
          </div>
          <nav className="mt-4 flex gap-6 overflow-x-auto scrollbar-thin">
            {tab(base, 'Overview')}
            {tab(`${base}/board`, 'Board')}
            {tab(`${base}/chat`, 'Chat', p.stats.unansweredOwner)}
            {tab(`${base}/agents`, 'Agents', p.stats.agentsInError)}
            {tab(`${base}/approvals`, 'Approvals', p.stats.pendingApprovals)}
            {tab(`${base}/runs`, 'Runs')}
            {tab(`${base}/activity`, 'Activity')}
            {tab(`${base}/knowledge`, 'Knowledge')}
            {tab(`${base}/git`, 'Git')}
            {tab(`${base}/settings`, 'Settings')}
          </nav>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <Routes>
            <Route index element={<ProjectOverview />} />
            <Route path="board" element={<BoardPage />} />
            <Route path="chat" element={<ChatPage />} />
            <Route path="chat/:conversationId" element={<ChatPage />} />
            <Route path="agents" element={<AgentsPage />} />
            <Route path="approvals" element={<ApprovalsPage />} />
            <Route path="runs" element={<RunsPage />} />
            <Route path="runs/:runId" element={<RunsPage />} />
            <Route path="activity" element={<ActivityPage />} />
            <Route path="knowledge" element={<KnowledgePage />} />
            <Route path="git" element={<GitPage />} />
            <Route path="settings" element={<SettingsPage />} />
          </Routes>
        </div>
      </div>
      <TaskDrawer
        taskId={params.get('task')}
        onClose={() => {
          const n = new URLSearchParams(params);
          n.delete('task');
          setParams(n);
        }}
      />
    </ProjectCtx.Provider>
  );
}

function AutonomySwitch({ project }: { project: ProjectWithStats }) {
  const set = useAction((autonomy: string) => api('PATCH', `/api/projects/${project.id}`, { autonomy }), { success: (p: any) => `Project is now ${p.autonomy}` });
  const opts = [
    { v: 'paused', label: 'Paused', icon: Pause, hint: 'No agent runs. Messages wait in inboxes.' },
    { v: 'supervised', label: 'Supervised', icon: Eye, hint: 'Agents work. You approve plans and merges.' },
    { v: 'autonomous', label: 'Autonomous', icon: Zap, hint: 'Agents plan, build, review and merge within guardrails.' },
  ];
  return (
    <div className="flex rounded-xl border border-zinc-200 bg-zinc-100/80 p-1 dark:border-white/[0.06] dark:bg-white/[0.03]">
      {opts.map((o) => (
        <button
          key={o.v}
          title={o.hint}
          disabled={set.isPending}
          onClick={() => o.v !== project.autonomy && set.mutate(o.v)}
          className={clsx(
            'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition',
            project.autonomy === o.v
              ? o.v === 'paused'
                ? 'bg-white text-zinc-800 shadow-sm dark:bg-white/[0.08] dark:text-white'
                : o.v === 'supervised'
                  ? 'bg-white text-amber-700 shadow-sm dark:bg-amber-400/10 dark:text-amber-300 dark:ring-1 dark:ring-amber-400/25'
                  : 'bg-white text-emerald-700 shadow-sm dark:bg-emerald-400/10 dark:text-emerald-300 dark:ring-1 dark:ring-emerald-400/25'
              : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200',
          )}
        >
          <o.icon className="size-3.5" /> {o.label}
        </button>
      ))}
    </div>
  );
}
