import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { X, GitBranch, GitCommit, Plus, Pencil, Send } from 'lucide-react';
import { api, useAction } from '../../lib/api';
import { useMessages, useTask, useTasks } from '../../lib/queries';
import type { Task, TaskStatus } from '../../lib/types';
import { useProjectCtx } from './ProjectLayout';
import { ActivityList } from '../../components/Activity';
import { Avatar, Badge, Drawer, Loading, Markdown, OwnerAvatar, RelTime, SectionTitle, StatusChip } from '../../components/ui';
import { NewTaskModal } from './Board';
import { STATUS_META } from '../../lib/format';

export function TaskDrawer({ taskId, onClose }: { taskId: string | null; onClose: () => void }) {
  return (
    <Drawer open={!!taskId} onClose={onClose} width="max-w-4xl">
      {taskId && <TaskDetail id={taskId} onClose={onClose} />}
    </Drawer>
  );
}

function EditableText({ value, onSave, placeholder, markdown = true, className }: { value: string; onSave: (v: string) => void; placeholder: string; markdown?: boolean; className?: string }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    setDraft(value);
  }, [value]);
  if (editing)
    return (
      <div className={className}>
        <textarea className="input min-h-28 font-mono text-xs" value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus />
        <div className="mt-2 flex gap-2">
          <button
            className="btn btn-primary btn-sm"
            onClick={() => {
              onSave(draft);
              setEditing(false);
            }}
          >
            Save
          </button>
          <button className="btn btn-sm" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </div>
      </div>
    );
  return (
    <div className={clsx('group relative rounded-lg', className)}>
      {value ? markdown ? <Markdown>{value}</Markdown> : <p className="text-sm whitespace-pre-wrap">{value}</p> : <p className="text-sm text-zinc-400 italic">{placeholder}</p>}
      <button className="btn btn-ghost btn-sm absolute top-0 right-0 opacity-0 group-hover:opacity-100" onClick={() => setEditing(true)} title="Edit">
        <Pencil className="size-3.5" />
      </button>
    </div>
  );
}

function TaskDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const { project, agents, agent, openTask } = useProjectCtx();
  const task = useTask(id);
  const all = useTasks(project.id);
  const messages = useMessages(task.data?.conversation_id ?? null);
  const [comment, setComment] = useState('');
  const [reviewNote, setReviewNote] = useState('');
  const [subtaskOpen, setSubtaskOpen] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [title, setTitle] = useState('');
  const patch = useAction((p: Record<string, unknown>) => api('PATCH', `/api/tasks/${id}`, p));
  const postComment = useAction(() => api('POST', `/api/tasks/${id}/comments`, { body: comment }), { onSuccess: () => setComment('') });
  const review = useAction((verdict: 'approve' | 'request_changes') => api('POST', `/api/tasks/${id}/review`, { verdict, comments: reviewNote }), { success: 'Review recorded', onSuccess: () => setReviewNote('') });
  const merge = useAction(() => api('POST', `/api/tasks/${id}/merge`), { success: 'Merge queued' });

  if (task.isLoading || !task.data) return <Loading />;
  const t = task.data;
  const keyOf = (tid: string) => all.data?.find((x) => x.id === tid);

  return (
    <>
      <div className="flex items-start gap-3 border-b border-zinc-200 px-6 py-4 dark:border-zinc-800">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <span className="font-semibold">{t.key}</span>
            <Badge tone={t.kind === 'epic' ? 'violet' : 'zinc'}>{t.kind}</Badge>
            {t.parent_id && (
              <button className="hover:underline" onClick={() => openTask(t.parent_id!)}>
                ↳ {keyOf(t.parent_id)?.key} {keyOf(t.parent_id)?.title}
              </button>
            )}
            <span>
              created by {t.created_by === 'owner' ? 'you' : t.created_by.startsWith('agent:') ? agent(t.created_by.slice(6))?.name : 'AgentOS'} · <RelTime iso={t.created_at} />
            </span>
          </div>
          {editingTitle ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                patch.mutate({ title });
                setEditingTitle(false);
              }}
            >
              <input className="input mt-1 text-base font-semibold" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus onBlur={() => setEditingTitle(false)} />
            </form>
          ) : (
            <h2
              className="mt-1 cursor-text text-lg leading-snug font-semibold"
              onClick={() => {
                setTitle(t.title);
                setEditingTitle(true);
              }}
            >
              {t.title}
            </h2>
          )}
        </div>
        <select className="input w-36" value={t.status} onChange={(e) => patch.mutate({ status: e.target.value as TaskStatus })}>
          {(['backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled'] as TaskStatus[]).map((s) => (
            <option key={s} value={s} disabled={s === 'in_review' && t.status !== 'in_review'}>
              {STATUS_META[s].label}
            </option>
          ))}
        </select>
        <button className="btn btn-ghost" onClick={onClose} aria-label="Close">
          <X className="size-4" />
        </button>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto md:grid-cols-[1fr_17rem]">
        <div className="min-w-0 space-y-6 px-6 py-5">
          {t.status === 'blocked' && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950/50 dark:text-red-300">Blocked: {t.blocked_reason ?? 'no reason given'}</div>}
          {t.status === 'in_review' && (
            <div className="rounded-xl border border-violet-200 bg-violet-50/60 p-4 dark:border-violet-900 dark:bg-violet-950/30">
              <div className="text-sm font-medium">In review{t.merge_state ? ` · merge ${t.merge_state.replace('_', ' ')}` : ''}</div>
              <p className="mt-0.5 text-xs text-zinc-600 dark:text-zinc-400">
                {agent(t.reviewer_id)?.name ? `${agent(t.reviewer_id)!.name} is reviewing.` : 'The PM reviews by default.'} You can also review as the owner: approval merges <code className="kbd">{t.branch}</code> into <code className="kbd">{project.base_branch}</code>.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <input className="input min-w-48 flex-1" placeholder="Review comments (required for changes)…" value={reviewNote} onChange={(e) => setReviewNote(e.target.value)} />
                <button className="btn btn-primary btn-sm" disabled={review.isPending} onClick={() => review.mutate('approve')}>
                  Approve & merge
                </button>
                <button className="btn btn-sm" disabled={review.isPending || !reviewNote.trim()} onClick={() => review.mutate('request_changes')}>
                  Request changes
                </button>
              </div>
            </div>
          )}
          {(t.merge_state === 'conflict' || t.merge_state === 'failed') && (
            <div className="flex items-center gap-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950/50 dark:text-red-300">
              Merge {t.merge_state}. The assignee has been asked to rebase.
              <button className="btn btn-sm ml-auto" onClick={() => merge.mutate()}>
                Retry merge
              </button>
            </div>
          )}

          <section>
            <SectionTitle>Description</SectionTitle>
            <EditableText value={t.description} onSave={(v) => patch.mutate({ description: v })} placeholder="No description" />
          </section>
          <section>
            <SectionTitle>Acceptance criteria</SectionTitle>
            <EditableText value={t.acceptance_criteria} onSave={(v) => patch.mutate({ acceptance_criteria: v })} placeholder="No acceptance criteria" />
          </section>

          <section>
            <SectionTitle
              action={
                <button className="btn btn-ghost btn-sm" onClick={() => setSubtaskOpen(true)}>
                  <Plus className="size-3.5" /> Subtask
                </button>
              }
            >
              Subtasks
            </SectionTitle>
            {t.subtasks.length ? (
              <div className="card divide-y divide-zinc-100 dark:divide-zinc-800">
                {t.subtasks.map((s) => (
                  <button key={s.id} onClick={() => openTask(s.id)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
                    <span className="w-16 text-xs text-zinc-500">{s.key}</span>
                    <span className="flex-1 truncate">{s.title}</span>
                    <StatusChip status={s.status} />
                  </button>
                ))}
              </div>
            ) : (
              <p className="text-sm text-zinc-400">No subtasks.</p>
            )}
          </section>

          <section>
            <SectionTitle>Discussion</SectionTitle>
            <div className="space-y-3">
              {messages.data?.map((m) => {
                const a = m.sender_type === 'agent' ? agent(m.sender_id) : undefined;
                return (
                  <div key={m.id} className="flex gap-2.5">
                    {m.sender_type === 'owner' ? <OwnerAvatar size="sm" /> : a ? <Avatar name={a.name} seed={a.id} size="sm" /> : <span className="size-6 shrink-0 rounded-full bg-zinc-200 dark:bg-zinc-700" />}
                    <div className="min-w-0 flex-1">
                      <div className="text-xs text-zinc-500">
                        <span className="font-medium text-zinc-700 dark:text-zinc-300">{m.sender_type === 'owner' ? 'You' : (a?.name ?? 'AgentOS')}</span> · <RelTime iso={m.created_at} />
                      </div>
                      <Markdown className={clsx(m.sender_type === 'system' && 'text-zinc-500 italic')}>{m.body}</Markdown>
                    </div>
                  </div>
                );
              })}
              {messages.data?.length === 0 && <p className="text-sm text-zinc-400">No discussion yet.</p>}
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (comment.trim()) postComment.mutate();
                }}
              >
                <textarea className="input min-h-[2.5rem] flex-1" rows={2} placeholder="Comment. The assignee, reviewer and PM are notified, and @mentions pull someone in." value={comment} onChange={(e) => setComment(e.target.value)} />
                <button className="btn btn-primary self-end" disabled={!comment.trim() || postComment.isPending}>
                  <Send className="size-4" />
                </button>
              </form>
            </div>
          </section>

          <section>
            <SectionTitle>History</SectionTitle>
            <div className="card">
              <ActivityList items={t.activity} agentName={(aid) => agent(aid)?.name} dense />
            </div>
          </section>
        </div>

        <aside className="space-y-5 border-l border-zinc-200 bg-zinc-50/60 px-5 py-5 text-sm dark:border-zinc-800 dark:bg-zinc-950/30">
          <Prop label="Assignee">
            <select className="input" value={t.assignee_id ?? ''} onChange={(e) => patch.mutate({ assignee: e.target.value || null })}>
              <option value="">Unassigned</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} · {a.role}
                </option>
              ))}
            </select>
          </Prop>
          <Prop label="Reviewer">
            <select className="input" value={t.reviewer_id ?? ''} onChange={(e) => patch.mutate({ reviewer: e.target.value || null })}>
              <option value="">Auto (PM)</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </Prop>
          <Prop label="Priority">
            <select className="input" value={t.priority} onChange={(e) => patch.mutate({ priority: Number(e.target.value) })}>
              <option value={0}>Urgent</option>
              <option value={1}>High</option>
              <option value={2}>Normal</option>
              <option value={3}>Low</option>
            </select>
          </Prop>
          <Prop label="Depends on">
            <div className="space-y-1">
              {(t.depends_on ?? []).map((d) => {
                const dt = keyOf(d);
                return (
                  <div key={d} className="flex items-center gap-1.5">
                    <button className="truncate text-left hover:underline" onClick={() => openTask(d)}>
                      {dt?.key} {dt?.title}
                    </button>
                    {dt && <StatusChip status={dt.status} className="ml-auto" />}
                  </div>
                );
              })}
              <select
                className="input"
                value=""
                onChange={(e) => e.target.value && patch.mutate({ depends_on: [...(t.depends_on ?? []), e.target.value] })}
              >
                <option value="">+ Add dependency…</option>
                {all.data
                  ?.filter((x: Task) => x.id !== t.id && !(t.depends_on ?? []).includes(x.id))
                  .map((x: Task) => (
                    <option key={x.id} value={x.id}>
                      {x.key} {x.title}
                    </option>
                  ))}
              </select>
            </div>
          </Prop>
          {t.dependents.length > 0 && (
            <Prop label="Blocks">
              {t.dependents.map((d) => (
                <button key={d.id} className="block truncate text-left hover:underline" onClick={() => openTask(d.id)}>
                  {d.key} {d.title}
                </button>
              ))}
            </Prop>
          )}
          <Prop label="Branch">
            {t.branch ? (
              <div className="flex items-center gap-1.5 font-mono text-xs break-all">
                <GitBranch className="size-3.5 shrink-0" /> {t.branch}
              </div>
            ) : (
              <span className="text-zinc-400">Created when work starts</span>
            )}
            {t.merge_state && <div className="mt-1 text-xs text-zinc-500">Merge: {t.merge_state.replace('_', ' ')}</div>}
          </Prop>
          <Prop label={`Commits (${t.commits.length})`}>
            <div className="space-y-1.5">
              {t.commits.map((c) => (
                <div key={c.sha} className="text-xs">
                  <div className="flex items-center gap-1 font-mono text-zinc-500">
                    <GitCommit className="size-3" /> {c.sha.slice(0, 8)}
                  </div>
                  <div className="truncate" title={c.message}>
                    {c.message}
                  </div>
                </div>
              ))}
              {!t.commits.length && <span className="text-zinc-400">None yet</span>}
            </div>
          </Prop>
          <Prop label="Runs">
            <div className="space-y-1">
              {t.runs.slice(0, 8).map((r) => (
                <Link key={r.id} to={`/p/${project.slug}/runs/${r.id}`} className="flex items-center justify-between text-xs hover:underline">
                  <span>{r.kind === 'merge' ? 'Merge' : agent(r.agent_id)?.name}</span>
                  <span className={r.status === 'failed' ? 'text-red-600' : 'text-zinc-500'}>
                    {r.status} · <RelTime iso={r.queued_at} />
                  </span>
                </Link>
              ))}
              {!t.runs.length && <span className="text-zinc-400">No runs yet</span>}
            </div>
          </Prop>
        </aside>
      </div>
      {subtaskOpen && <NewTaskModal status="todo" parent={t} onClose={() => setSubtaskOpen(false)} />}
    </>
  );
}

function Prop({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[11px] font-semibold tracking-wide text-zinc-500 uppercase">{label}</div>
      {children}
    </div>
  );
}
