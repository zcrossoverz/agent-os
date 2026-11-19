import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ExternalLink } from 'lucide-react';
import { api, get, useAction } from '../lib/api';
import type { Account } from '../lib/types';
import { CopyButton, Field, Modal } from './ui';

interface CloudSetupInfo {
  publicUrl: string;
  host: string | null;
  reachable: boolean;
  routinePrompt: string;
  files: Record<string, string>;
}

export const useCloudSetup = () => useQuery({ queryKey: ['cloudSetup'], queryFn: () => get<CloudSetupInfo>('/api/cloud/setup'), staleTime: 60_000 });

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-xs font-semibold text-white">{n}</span>
      <div className="min-w-0 flex-1 space-y-2 pb-1">
        <div className="text-sm font-medium">{title}</div>
        <div className="space-y-2 text-sm text-zinc-600 dark:text-zinc-400">{children}</div>
      </div>
    </li>
  );
}

function Copyable({ text, label }: { text: string; label?: string }) {
  return (
    <div className="flex items-start gap-2">
      <pre className="min-w-0 flex-1 overflow-x-auto rounded-lg bg-zinc-900 p-3 font-mono text-xs whitespace-pre-wrap text-zinc-100">{text}</pre>
      <CopyButton text={text} label={label} />
    </div>
  );
}

/**
 * Walks the owner through connecting one Claude account's cloud sessions to AgentOS:
 * cloud environment + network secret, a routine with an API trigger, and the repo config.
 */
export function CloudSetupModal({ account, token, onClose }: { account: Account; token?: string | null; onClose: () => void }) {
  const setup = useCloudSetup();
  const s = setup.data;
  const [shownToken, setShownToken] = useState<string | null>(token ?? null);
  const rotate = useAction(() => api<{ token: string }>('POST', `/api/accounts/${account.id}/rotate-cloud-token`), {
    success: 'New AgentOS token created. Update the network secret on claude.ai',
    onSuccess: (r) => setShownToken(r.token),
  });
  return (
    <Modal open onClose={onClose} title={`Connect “${account.name}” to AgentOS (Claude Code on the web)`} width="max-w-3xl">
      {s && !s.reachable && (
        <div className="mb-4 flex gap-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/50 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <div>
            AgentOS's public URL is <code className="kbd">{s.publicUrl}</code>. Cloud sessions run on Anthropic's servers and must reach AgentOS over <b>public HTTPS</b>. Deploy AgentOS on your VPS behind a domain and set <code className="kbd">AGENTOS_PUBLIC_URL</code> (see the operations guide), then come back to this guide.
          </div>
        </div>
      )}
      <ol className="space-y-5">
        <Step n={1} title="Connect GitHub on this Claude account">
          <p>
            Sign in to <a className="text-indigo-600 underline" href="https://claude.ai/code" target="_blank" rel="noreferrer">claude.ai/code</a> with this account and connect GitHub. Install the Claude GitHub App on the project repository so cloud sessions can clone it and push branches.
          </p>
        </Step>
        <Step n={2} title="Create a cloud environment with the AgentOS network secret">
          <p>
            In claude.ai/code, add a cloud environment, e.g. "AgentOS" (Limited network access is fine). Open <b>Network secrets → Add secret</b> and fill in:
          </p>
          <div className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1 rounded-lg border border-zinc-200 p-3 text-xs dark:border-zinc-800">
            <span className="text-zinc-500">Host</span>
            <code className="font-mono">{s?.host ?? '…'}</code>
            <span className="text-zinc-500">Header</span>
            <code className="font-mono">Authorization</code>
            <span className="text-zinc-500">Prefix</span>
            <code className="font-mono">Bearer</code>
            <span className="text-zinc-500">Value</span>
            <span>{shownToken ? <code className="font-mono break-all">{shownToken}</code> : <span className="italic">the AgentOS token for this account (shown once when it is created)</span>}</span>
          </div>
          {shownToken ? (
            <div className="flex items-center gap-2">
              <CopyButton text={shownToken} label="Copy token" />
              <span className="text-xs text-amber-700 dark:text-amber-400">Shown only now. Copy it into the network secret before closing this dialog.</span>
            </div>
          ) : (
            <button className="btn btn-sm" disabled={rotate.isPending} onClick={() => confirm('Create a new AgentOS token for this account? The previous one stops working.') && rotate.mutate()}>
              Create a new AgentOS token
            </button>
          )}
          <p className="text-xs">The secret is attached by Anthropic's proxy to requests for that host only. Sessions never see it, and AgentOS never sees your Claude login.</p>
        </Step>
        <Step n={3} title="Create the AgentOS routine with an API trigger">
          <p>
            At <a className="inline-flex items-center gap-1 text-indigo-600 underline" href="https://claude.ai/code/routines" target="_blank" rel="noreferrer">claude.ai/code/routines <ExternalLink className="size-3" /></a>, create a routine: select the project repository, the environment from step 2, and paste this prompt:
          </p>
          <Copyable text={s?.routinePrompt ?? '…'} label="Copy prompt" />
          <p>
            Add an <b>API</b> trigger and click <b>Generate token</b>. Put the Fire URL and token on this account in AgentOS ({account.has_fire_token ? 'already set; use “Routine trigger” to replace them' : 'use “Routine trigger” on the account card'}).
          </p>
        </Step>
        <Step n={4} title="Prepare each project repository">
          <p>
            In the project's <b>Settings</b>: choose the <b>GitHub</b> workspace, add a GitHub token (fine-grained, Contents: read & write on that repo), then click <b>Set up repository</b>. It commits these two files, neither of which contains a secret:
          </p>
          {s &&
            Object.entries(s.files).map(([path, content]) => (
              <div key={path}>
                <div className="mb-1 font-mono text-xs text-zinc-500">{path}</div>
                <Copyable text={content} />
              </div>
            ))}
        </Step>
      </ol>
      <p className="mt-5 border-t border-zinc-200 pt-3 text-xs text-zinc-500 dark:border-zinc-800">
        Each time an agent on this account has work, AgentOS fires the routine. Claude Code on the web starts a fresh session, which calls <code className="kbd">start_run</code> to get its briefing from AgentOS, works on a task branch, pushes, and reports back. Sessions count toward this account's normal subscription usage. Routines allow 30 fires per hour each and 100 per account.
      </p>
    </Modal>
  );
}

export function RoutineTriggerModal({ account, onClose }: { account: Account; onClose: () => void }) {
  const [fireUrl, setFireUrl] = useState(account.fire_url ?? '');
  const [token, setToken] = useState('');
  const save = useAction(() => api('PATCH', `/api/accounts/${account.id}`, { fire_url: fireUrl, ...(token ? { fire_token: token } : {}) }), { success: 'Routine trigger saved', onSuccess: onClose });
  return (
    <Modal
      open
      onClose={onClose}
      title={`Routine trigger: ${account.name}`}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!fireUrl || save.isPending} onClick={() => save.mutate()}>
            Save
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Fire URL" hint="From the routine's API trigger panel on claude.ai/code/routines.">
          <input className="input font-mono text-xs" value={fireUrl} onChange={(e) => setFireUrl(e.target.value)} placeholder="https://api.anthropic.com/v1/claude_code/routines/trig_…/fire" />
        </Field>
        <Field label="Trigger token" hint={account.has_fire_token ? 'Leave empty to keep the current token. Stored encrypted; never shown again.' : 'Stored encrypted; never shown again.'}>
          <input type="password" className="input font-mono text-xs" value={token} onChange={(e) => setToken(e.target.value)} placeholder="sk-ant-oat01-…" autoComplete="off" />
        </Field>
      </div>
    </Modal>
  );
}
