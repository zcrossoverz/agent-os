import { useEffect, useState, type ReactNode } from 'react';
import { BrowserRouter, Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClientProvider, useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { LayoutDashboard, KeyRound, Plus, LogOut, FolderKanban, Circle } from 'lucide-react';
import { api, get, queryClient } from './lib/api';
import { useLiveUpdates } from './lib/live';
import { useOverview } from './lib/queries';
import { Loading, Toasts } from './components/ui';
import { OverviewPage } from './pages/Overview';
import { AccountsPage } from './pages/Accounts';
import { NewProjectPage } from './pages/NewProject';
import { ProjectLayout } from './pages/project/ProjectLayout';
import { LoginPage } from './pages/Login';

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthGate />
        <Toasts />
      </BrowserRouter>
    </QueryClientProvider>
  );
}

function AuthGate() {
  const me = useQuery({ queryKey: ['me'], queryFn: () => get<{ authenticated: boolean; version: string }>('/api/auth/me'), staleTime: 60_000 });
  useEffect(() => {
    const on = () => queryClient.invalidateQueries({ queryKey: ['me'] });
    window.addEventListener('agentos:unauthorized', on);
    return () => window.removeEventListener('agentos:unauthorized', on);
  }, []);
  if (me.isLoading) return <Loading label="Connecting to AgentOS…" />;
  if (me.isError) return <div className="p-8 text-sm text-red-600">Cannot reach the AgentOS server: {(me.error as Error).message}</div>;
  if (!me.data?.authenticated) return <LoginPage />;
  return <Shell version={me.data.version} />;
}

function Shell({ version }: { version: string }) {
  const live = useLiveUpdates(true);
  return (
    <div className="flex h-full">
      <Sidebar live={live} version={version} />
      <main className="min-w-0 flex-1 overflow-y-auto">
        <Routes>
          <Route path="/" element={<OverviewPage />} />
          <Route path="/accounts" element={<AccountsPage />} />
          <Route path="/projects/new" element={<NewProjectPage />} />
          <Route path="/p/:projectId/*" element={<ProjectLayout />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

function Sidebar({ live, version }: { live: string; version: string }) {
  const { data } = useOverview();
  const loc = useLocation();
  const [collapsed] = useState(false);
  const attention = data ? data.attention.approvals.length + data.attention.unanswered.length + data.attention.agents.filter((a) => a.status === 'error').length + data.attention.accounts.length : 0;
  const nav = (to: string, icon: ReactNode, label: string, badge?: number) => (
    <NavLink to={to} end className={({ isActive }) => clsx('flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm font-medium transition', isActive ? 'bg-zinc-200/70 text-zinc-900 dark:bg-zinc-800 dark:text-white' : 'text-zinc-600 hover:bg-zinc-200/40 dark:text-zinc-400 dark:hover:bg-zinc-800/60')}>
      {icon}
      <span className="flex-1 truncate">{label}</span>
      {!!badge && <span className="rounded-full bg-red-500 px-1.5 text-[10px] font-semibold text-white">{badge}</span>}
    </NavLink>
  );
  if (collapsed) return null;
  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-zinc-200 bg-zinc-100/60 dark:border-zinc-800 dark:bg-zinc-900/40">
      <div className="flex items-center gap-2 px-4 py-4">
        <img src="/favicon.svg" className="size-7" alt="" />
        <div>
          <div className="text-sm font-semibold leading-tight">AgentOS</div>
          <div className="text-[11px] text-zinc-500">AI team control plane</div>
        </div>
      </div>
      <nav className="flex flex-col gap-0.5 px-2">
        {nav('/', <LayoutDashboard className="size-4" />, 'Overview', attention)}
        {nav('/accounts', <KeyRound className="size-4" />, 'Accounts & runners', data?.attention.accounts.length || undefined)}
      </nav>
      <div className="mt-5 flex items-center justify-between px-4">
        <span className="text-[11px] font-semibold tracking-wide text-zinc-500 uppercase">Projects</span>
        <NavLink to="/projects/new" className="btn btn-ghost btn-sm" title="New project">
          <Plus className="size-3.5" />
        </NavLink>
      </div>
      <nav className="mt-1 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 scrollbar-thin">
        {data?.projects.map((p) => {
          const active = loc.pathname.startsWith(`/p/${p.slug}`) || loc.pathname.startsWith(`/p/${p.id}`);
          const working = p.agents.filter((a) => a.status === 'running').length;
          const needs = p.stats.pendingApprovals + p.stats.unansweredOwner + p.stats.agentsInError;
          return (
            <NavLink key={p.id} to={`/p/${p.slug}`} className={clsx('flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm transition', active ? 'bg-zinc-200/70 font-medium text-zinc-900 dark:bg-zinc-800 dark:text-white' : 'text-zinc-600 hover:bg-zinc-200/40 dark:text-zinc-400 dark:hover:bg-zinc-800/60')}>
              <FolderKanban className="size-4 shrink-0" />
              <span className="flex-1 truncate">{p.name}</span>
              {p.autonomy === 'paused' && <span className="text-[10px] text-zinc-400">paused</span>}
              {working > 0 && <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" title={`${working} agent(s) working`} />}
              {needs > 0 && <span className="rounded-full bg-red-500 px-1.5 text-[10px] font-semibold text-white">{needs}</span>}
            </NavLink>
          );
        })}
        {data && data.projects.length === 0 && <div className="px-2.5 py-2 text-xs text-zinc-500">No projects yet.</div>}
      </nav>
      <div className="flex items-center justify-between border-t border-zinc-200 px-4 py-3 text-[11px] text-zinc-500 dark:border-zinc-800">
        <span className="flex items-center gap-1.5" title="Live updates">
          <Circle className={clsx('size-2 fill-current', live === 'live' ? 'text-emerald-500' : live === 'offline' ? 'text-red-500' : 'text-amber-500')} />
          {live === 'live' ? 'Live' : live === 'offline' ? 'Reconnecting…' : 'Connecting…'} · v{version}
        </span>
        <button
          className="btn btn-ghost btn-sm"
          title="Sign out"
          onClick={async () => {
            await api('POST', '/api/auth/logout');
            queryClient.clear();
            window.location.href = '/';
          }}
        >
          <LogOut className="size-3.5" />
        </button>
      </div>
    </aside>
  );
}
