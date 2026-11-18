import { useMemo, useState } from 'react';
import clsx from 'clsx';
import { Plus, GitBranch, Link2 } from 'lucide-react';
import { api, useAction } from '../../lib/api';
import { useTasks } from '../../lib/queries';
import type { Task, TaskStatus } from '../../lib/types';
import { useProjectCtx } from './ProjectLayout';
import { Avatar, Field, Loading, Modal, Priority } from '../../components/ui';
import { STATUS_META } from '../../lib/format';

const COLUMNS: TaskStatus[] = ['backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done'];

export function BoardPage() {
  const { project, agent, openTask } = useProjectCtx();
  const tasks = useTasks(project.id);
  const [creating, setCreating] = useState<TaskStatus | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [showEpics, setShowEpics] = useState(true);
  const move = useAction(({ id, status }: { id: string; status: TaskStatus }) => api('PATCH', `/api/tasks/${id}`, { status }));

  const byStatus = useMemo(() => {
    const m: Record<string, Task[]> = {};
    for (const c of COLUMNS) m[c] = [];
    for (const t of tasks.data ?? []) {
      if (!showEpics && t.kind === 'epic') continue;
      if (filter && !`${t.key} ${t.title}`.toLowerCase().includes(filter.toLowerCase()) && agent(t.assignee_id)?.name.toLowerCase() !== filter.toLowerCase()) continue;
      (m[t.status] ?? (m[t.status] = [])).push(t);
    }
    return m;
  }, [tasks.data, filter, showEpics, agent]);

  if (tasks.isLoading) return <Loading />;
  const keyOf = (id: string) => tasks.data?.find((t) => t.id === id)?.key;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 px-6 pt-4">
        <input className="input max-w-xs" placeholder="Filter by key, title or agent…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <label className="flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400">
          <input type="checkbox" checked={showEpics} onChange={(e) => setShowEpics(e.target.checked)} /> Show epics
        </label>
        <span className="ml-auto text-xs text-zinc-500">Drag cards to change status. Agents move their own cards as they work.</span>
        <button className="btn btn-primary btn-sm" onClick={() => setCreating('todo')}>
          <Plus className="size-3.5" /> New task
        </button>
      </div>
      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-6 py-4 scrollbar-thin">
        {COLUMNS.map((col) => (
          <div
            key={col}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(col);
            }}
            onDragLeave={() => setDragOver((d) => (d === col ? null : d))}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(null);
              const id = e.dataTransfer.getData('text/task');
              const t = tasks.data?.find((x) => x.id === id);
              if (t && t.status !== col) {
                if (col === 'in_review') return alert('Tasks enter review when their assignee submits them.');
                move.mutate({ id, status: col });
              }
            }}
            className={clsx('flex w-72 shrink-0 flex-col rounded-xl bg-zinc-100/80 dark:bg-zinc-900/60', dragOver === col && 'ring-2 ring-indigo-400')}
          >
            <div className="flex items-center gap-2 px-3 pt-3 pb-2">
              <span className={clsx('size-2 rounded-full', STATUS_META[col].dot)} />
              <span className="text-xs font-semibold text-zinc-600 dark:text-zinc-300">{STATUS_META[col].label}</span>
              <span className="text-xs text-zinc-400">{byStatus[col]?.length ?? 0}</span>
              {col !== 'in_review' && col !== 'done' && (
                <button className="ml-auto text-zinc-400 hover:text-zinc-700" onClick={() => setCreating(col)} title="Add task">
                  <Plus className="size-3.5" />
                </button>
              )}
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2 scrollbar-thin">
              {byStatus[col]?.map((t) => {
                const a = agent(t.assignee_id);
                return (
                  <div
                    key={t.id}
                    draggable
                    onDragStart={(e) => e.dataTransfer.setData('text/task', t.id)}
                    onClick={() => openTask(t.id)}
                    className="card cursor-pointer p-3 transition hover:border-indigo-300 hover:shadow-sm dark:hover:border-indigo-700"
                  >
                    <div className="flex items-center gap-1.5 text-[11px] text-zinc-500">
                      <span className="font-medium">{t.key}</span>
                      {t.kind === 'epic' && <span className="rounded bg-violet-100 px-1 text-violet-700 dark:bg-violet-950 dark:text-violet-300">epic</span>}
                      {t.parent_id && <span title="Subtask of">↳ {keyOf(t.parent_id)}</span>}
                      <span className="ml-auto">
                        <Priority p={t.priority} />
                      </span>
                    </div>
                    <div className="mt-1 text-sm leading-snug">{t.title}</div>
                    {t.status === 'blocked' && t.blocked_reason && <div className="mt-1 line-clamp-2 text-xs text-red-600 dark:text-red-400">{t.blocked_reason}</div>}
                    <div className="mt-2 flex items-center gap-2 text-[11px] text-zinc-500">
                      {a ? (
                        <span className="flex items-center gap-1">
                          <Avatar name={a.name} seed={a.id} size="xs" /> {a.name}
                        </span>
                      ) : (
                        <span className="italic">Unassigned</span>
                      )}
                      {t.depends_on && t.depends_on.length > 0 && (
                        <span className="flex items-center gap-0.5" title={`Depends on ${t.depends_on.map(keyOf).join(', ')}`}>
                          <Link2 className="size-3" />
                          {t.depends_on.length}
                        </span>
                      )}
                      {t.branch && <GitBranch className="size-3" />}
                      {t.merge_state && t.merge_state !== 'merged' && <span className={clsx('ml-auto rounded px-1', t.merge_state === 'conflict' || t.merge_state === 'failed' ? 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300' : 'bg-zinc-200 dark:bg-zinc-800')}>{t.merge_state.replace('_', ' ')}</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      {creating && <NewTaskModal status={creating} onClose={() => setCreating(null)} />}
    </div>
  );
}

export function NewTaskModal({ status, onClose, parent }: { status: TaskStatus; onClose: () => void; parent?: Task }) {
  const { project, agents } = useProjectCtx();
  const [f, setF] = useState({ title: '', description: '', acceptance_criteria: '', priority: 2, assignee: '', reviewer: '', kind: parent ? 'subtask' : 'task' });
  const create = useAction(() => api('POST', `/api/projects/${project.id}/tasks`, { ...f, status, parent: parent?.id, assignee: f.assignee || undefined, reviewer: f.reviewer || undefined }), { success: (t: Task) => `${t.key} created`, onSuccess: onClose });
  return (
    <Modal
      open
      onClose={onClose}
      title={parent ? `New subtask of ${parent.key}` : 'New task'}
      width="max-w-xl"
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!f.title || create.isPending} onClick={() => create.mutate()}>
            Create
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Title">
          <input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} autoFocus />
        </Field>
        <Field label="Description">
          <textarea className="input min-h-20" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </Field>
        <Field label="Acceptance criteria">
          <textarea className="input min-h-16" value={f.acceptance_criteria} onChange={(e) => setF({ ...f, acceptance_criteria: e.target.value })} placeholder="- Testable statement…" />
        </Field>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field label="Kind">
            <select className="input" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
              <option value="epic">Epic</option>
              <option value="task">Task</option>
              <option value="subtask">Subtask</option>
            </select>
          </Field>
          <Field label="Priority">
            <select className="input" value={f.priority} onChange={(e) => setF({ ...f, priority: Number(e.target.value) })}>
              <option value={0}>Urgent</option>
              <option value={1}>High</option>
              <option value={2}>Normal</option>
              <option value={3}>Low</option>
            </select>
          </Field>
          <Field label="Assignee">
            <select className="input" value={f.assignee} onChange={(e) => setF({ ...f, assignee: e.target.value })}>
              <option value="">—</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Reviewer">
            <select className="input" value={f.reviewer} onChange={(e) => setF({ ...f, reviewer: e.target.value })}>
              <option value="">Auto (PM)</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </div>
    </Modal>
  );
}

