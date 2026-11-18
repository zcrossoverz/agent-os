import { useEffect, useState } from 'react';
import { queryClient } from './api';

interface Change {
  topic: string;
  projectId?: string | null;
  id?: string;
}

/** Which query-key roots depend on each change topic. */
const TOPIC_KEYS: Record<string, string[]> = {
  projects: ['projects', 'project', 'overview'],
  agents: ['agents', 'agent', 'overview', 'project'],
  accounts: ['accounts', 'overview', 'agents'],
  runners: ['runners', 'overview', 'accounts'],
  tasks: ['tasks', 'task', 'overview', 'project', 'git'],
  messages: ['messages', 'conversations', 'overview', 'task', 'project'],
  conversations: ['conversations'],
  approvals: ['approvals', 'overview', 'project', 'task'],
  runs: ['runs', 'run', 'agents', 'agent', 'project', 'task', 'git'],
  run_events: ['runEvents'],
  activity: ['activity', 'overview', 'task'],
  docs: ['docs', 'doc'],
  decisions: ['decisions'],
  commits: ['git', 'task'],
};

/** Subscribe to the server's change stream and invalidate affected queries. */
export function useLiveUpdates(enabled: boolean): 'connecting' | 'live' | 'offline' {
  const [state, setState] = useState<'connecting' | 'live' | 'offline'>('connecting');
  useEffect(() => {
    if (!enabled) return;
    let es: EventSource | null = null;
    let retry: number | undefined;
    const connect = () => {
      es = new EventSource('/api/stream');
      es.onopen = () => setState('live');
      es.onmessage = (ev) => {
        let batch: Change[] = [];
        try {
          batch = JSON.parse(ev.data);
        } catch {
          return;
        }
        const roots = new Set<string>();
        for (const c of batch) for (const k of TOPIC_KEYS[c.topic] ?? []) roots.add(k);
        for (const r of roots) queryClient.invalidateQueries({ queryKey: [r] });
      };
      es.onerror = () => {
        setState('offline');
        es?.close();
        retry = window.setTimeout(connect, 3000);
      };
    };
    connect();
    return () => {
      es?.close();
      if (retry) clearTimeout(retry);
    };
  }, [enabled]);
  return state;
}
