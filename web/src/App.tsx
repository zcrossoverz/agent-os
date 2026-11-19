import { useEffect, type ReactNode } from 'react';
import { BrowserRouter, Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClientProvider, useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { LayoutDashboard, KeyRound, Plus, LogOut, Sparkles, Moon, Sun, Monitor, Pause } from 'lucide-react';
import { useTheme } from './lib/theme';
import { avatarColor } from './lib/format';
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
  const [theme, setTheme] = useTheme();
  const attention = data ? data.attention.approvals.length + data.attention.unanswered.length + data.attention.agents.filter((a) => a.status === 'error').length + data.attention.accounts.length : 0;
  const item = (active: boolean) =>
    clsx(
      'group relative flex items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-[13px] transition',
      active
        ? 'bg-white font-medium text-zinc-900 shadow-[0_1px_2px_rgb(0_0_0/0.06)] ring-1 ring-zinc-200 dark:bg-white/[0.06] dark:text-white dark:shadow-none dark:ring-white/[0.06]'
        : 'text-zinc-600 hover:bg-zinc-200/50 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-white/[0.04] dark:hover:text-zinc-100',
    );
  const nav = (to: string, icon: ReactNode, label: string, badge?: number) => (
    <NavLink to={to} end className={({ isActive }) => item(isActive)}>
      {icon}
      <span className="flex-1 truncate">{label}</span>
      {!!badge && <span className="rounded-full bg-red-500/90 px-1.5 text-[10px] leading-4 font-semibold text-white">{badge}</span>}
    </NavLink>
  );
  return (
    <aside className="flex w-[244px] shrink-0 flex-col border-r border-zinc-200/80 bg-zinc-100/70 dark:border-white/[0.05] dark:bg-ink-950/80">
      <div className="flex items-center gap-2.5 px-4 pt-5 pb-4">
        <div className="relative flex size-8 items-center justify-center rounded-[10px] bg-gradient-to-br from-accent-400 via-accent-500 to-fuchsia-500 shadow-[0_4px_14px_-4px_rgb(109_106_240/0.7)]">
          <Sparkles className="size-4 text-white" />
        </div>
        <div>
          <div className="text-[14px] leading-tight font-semibold tracking-tight">AgentOS</div>
          <div className="text-[11px] text-zinc-500">AI team control plane</div>
        </div>
      </div>
      <nav className="flex flex-col gap-0.5 px-2.5">
        {nav('/', <LayoutDashboard className="size-4" />, 'Overview', attention)}
        {nav('/accounts', <KeyRound className="size-4" />, 'Accounts & runners', data?.attention.accounts.length || undefined)}
      </nav>
      <div className="mt-6 flex items-center justify-between px-[18px]">
        <span className="eyebrow">Projects</span>
        <NavLink to="/projects/new" className="rounded-md p-1 text-zinc-500 transition hover:bg-zinc-200/60 hover:text-zinc-900 dark:hover:bg-white/[0.06] dark:hover:text-white" title="New project">
          <Plus className="size-3.5" />
        </NavLink>
      </div>
      <nav className="mt-1.5 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2.5 pb-3">
        {data?.projects.map((p) => {
          const active = loc.pathname.startsWith(`/p/${p.slug}`) || loc.pathname.startsWith(`/p/${p.id}`);
          const working = p.agents.filter((a) => a.status === 'running').length;
          const needs = p.stats.pendingApprovals + p.stats.unansweredOwner + p.stats.agentsInError;
          return (
            <NavLink key={p.id} to={`/p/${p.slug}`} className={item(active)}>
              <span className={clsx('flex size-5 shrink-0 items-center justify-center rounded-md text-[10px] font-bold text-white', avatarColor(p.id))}>{p.name[0]?.toUpperCase()}</span>
              <span className="flex-1 truncate">{p.name}</span>
              {p.autonomy === 'paused' && <Pause className="size-3 text-zinc-400" />}
              {working > 0 && (
                <span className="relative flex size-2" title={`${working} agent(s) working`}>
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                  <span className="relative inline-flex size-2 rounded-full bg-emerald-400" />
                </span>
              )}
              {needs > 0 && <span className="rounded-full bg-red-500/90 px-1.5 text-[10px] leading-4 font-semibold text-white">{needs}</span>}
            </NavLink>
          );
        })}
        {data && data.projects.length === 0 && <div className="px-2.5 py-2 text-xs text-zinc-500">No projects yet.</div>}
      </nav>
      <div className="space-y-2.5 border-t border-zinc-200/80 px-3 py-3 dark:border-white/[0.05]">
        <div className="flex rounded-lg bg-zinc-200/60 p-0.5 dark:bg-white/[0.04]">
          {(
            [
              ['dark', Moon, 'Dark'],
              ['light', Sun, 'Light'],
              ['system', Monitor, 'System'],
            ] as const
          ).map(([v, Icon, label]) => (
            <button
              key={v}
              onClick={() => setTheme(v)}
              title={`${label} theme`}
              className={clsx('flex flex-1 items-center justify-center gap-1 rounded-md py-1 text-[11px] font-medium transition', theme === v ? 'bg-white text-zinc-900 shadow-sm dark:bg-white/[0.1] dark:text-white' : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200')}
            >
              <Icon className="size-3" /> {label}
            </button>
          ))}
        </div>
        <div className="flex items-center justify-between px-1 text-[11px] text-zinc-500">
          <span className="flex items-center gap-1.5" title="Live updates">
            <span className={clsx('size-1.5 rounded-full', live === 'live' ? 'bg-emerald-400 shadow-[0_0_8px_rgb(52_211_153/0.8)]' : live === 'offline' ? 'bg-red-500' : 'bg-amber-400')} />
            {live === 'live' ? 'Live' : live === 'offline' ? 'Reconnecting…' : 'Connecting…'} · v{version}
          </span>
          <button
            className="rounded-md p-1 transition hover:bg-zinc-200/60 hover:text-zinc-900 dark:hover:bg-white/[0.06] dark:hover:text-white"
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
      </div>
    </aside>
  );
}
