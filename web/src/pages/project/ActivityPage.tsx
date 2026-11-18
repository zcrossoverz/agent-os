import { useMemo, useState } from 'react';
import { useActivity } from '../../lib/queries';
import { useProjectCtx } from './ProjectLayout';
import { ActivityList } from '../../components/Activity';
import { Loading } from '../../components/ui';

const FILTERS: [string, string][] = [
  ['all', 'Everything'],
  ['task', 'Tasks'],
  ['message', 'Messages'],
  ['run', 'Runs'],
  ['approval', 'Approvals'],
  ['guard', 'Guards'],
  ['decision', 'Decisions'],
];

export function ActivityPage() {
  const { project, agents, agent, openTask } = useProjectCtx();
  const activity = useActivity(project.id);
  const [kind, setKind] = useState('all');
  const [who, setWho] = useState('all');
  const items = useMemo(
    () =>
      (activity.data ?? []).filter((e) => {
        if (kind !== 'all' && !e.type.startsWith(kind)) return false;
        if (who === 'owner' && e.actor !== 'owner') return false;
        if (who !== 'all' && who !== 'owner' && e.actor !== `agent:${who}`) return false;
        return true;
      }),
    [activity.data, kind, who],
  );
  if (activity.isLoading) return <Loading />;
  return (
    <div className="mx-auto max-w-4xl px-6 py-6">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {FILTERS.map(([k, label]) => (
          <button key={k} onClick={() => setKind(k)} className={`btn btn-sm ${kind === k ? 'btn-primary' : ''}`}>
            {label}
          </button>
        ))}
        <select className="input ml-auto w-44" value={who} onChange={(e) => setWho(e.target.value)}>
          <option value="all">All actors</option>
          <option value="owner">You</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </div>
      <div className="card overflow-hidden">
        <ActivityList items={items} agentName={(id) => agent(id)?.name} onTask={openTask} />
      </div>
    </div>
  );
}
