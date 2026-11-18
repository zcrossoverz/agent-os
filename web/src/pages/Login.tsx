import { useState } from 'react';
import { api, queryClient } from '../lib/api';

export function LoginPage() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <form
        className="card w-full max-w-sm p-6"
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
        <div className="mb-5 flex items-center gap-2.5">
          <img src="/favicon.svg" className="size-9" alt="" />
          <div>
            <h1 className="text-base font-semibold">AgentOS</h1>
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
