import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import { api, queryClient } from '../lib/api';

export function LoginPage() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="relative flex min-h-full items-center justify-center overflow-hidden p-6">
      <div className="pointer-events-none absolute top-1/4 left-1/2 size-[520px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent-500/20 blur-[120px]" />
      <form
        className="card animate-in relative w-full max-w-sm p-7 dark:bg-ink-900/90 dark:backdrop-blur-xl"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await api('POST', '/api/auth/login', { password });
            await queryClient.invalidateQueries({ queryKey: ['me'] });
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="mb-6 flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-gradient-to-br from-accent-400 via-accent-500 to-fuchsia-500 shadow-[0_6px_20px_-6px_rgb(109_106_240/0.8)]">
            <Sparkles className="size-5 text-white" />
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight">AgentOS</h1>
            <p className="text-xs text-zinc-500">Sign in as the project owner</p>
          </div>
        </div>
        <label className="label" htmlFor="pw">
          Owner password
        </label>
        <input id="pw" type="password" autoFocus className="input" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
        <button className="btn btn-primary mt-4 w-full" disabled={busy || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <p className="mt-4 text-[11px] leading-relaxed text-zinc-500">The initial password is printed in the server log on first start. Change it with <code className="kbd">agentos set-password</code>.</p>
      </form>
    </div>
  );
}
