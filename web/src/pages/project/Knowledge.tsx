import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { FileText, Plus, Pencil, Trash2 } from 'lucide-react';
import { api, useAction } from '../../lib/api';
import { useDoc, useDocs } from '../../lib/queries';
import { useProjectCtx } from './ProjectLayout';
import { Empty, Field, Loading, Markdown, Modal, RelTime } from '../../components/ui';

export function KnowledgePage() {
  const { project, agent } = useProjectCtx();
  const docs = useDocs(project.id);
  const [slug, setSlug] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const doc = useDoc(project.id, slug);
  useEffect(() => {
    if (!slug && docs.data?.length) setSlug(docs.data.find((d) => d.slug === 'brief')?.slug ?? docs.data[0].slug);
  }, [docs.data, slug]);
  const del = useAction((s: string) => api('DELETE', `/api/projects/${project.id}/docs/${s}`), { success: 'Doc deleted', onSuccess: () => setSlug(null) });
  const who = (by: string) => (by === 'owner' ? 'you' : by.startsWith('agent:') ? (agent(by.slice(6))?.name ?? 'an agent') : 'AgentOS');

  if (docs.isLoading) return <Loading />;
  return (
    <div className="flex h-full min-h-0">
      <div className="w-64 shrink-0 overflow-y-auto border-r border-zinc-200 p-3 dark:border-white/[0.06]">
        <button className="btn btn-sm mb-3 w-full" onClick={() => setCreating(true)}>
          <Plus className="size-3.5" /> New doc
        </button>
        {docs.data?.map((d) => (
          <button key={d.slug} onClick={() => { setSlug(d.slug); setEditing(false); }} className={clsx('flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left', d.slug === slug ? 'bg-zinc-100 dark:bg-white/[0.06]' : 'hover:bg-zinc-50 dark:hover:bg-white/[0.03]')}>
            <FileText className="mt-0.5 size-4 shrink-0 text-zinc-400" />
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{d.title}</div>
              <div className="truncate text-[11px] text-zinc-500">
                {who(d.updated_by)} · <RelTime iso={d.updated_at} />
              </div>
            </div>
          </button>
        ))}
        <p className="mt-4 px-2 text-[11px] leading-relaxed text-zinc-500">Shared knowledge lives here, outside any agent's memory: the brief, plans, design notes and conventions. Agents read and write it with their tools.</p>
      </div>
      <div className="min-w-0 flex-1 overflow-y-auto px-8 py-6">
        {!slug ? (
          <Empty title="No docs yet" />
        ) : !doc.data ? (
          <Loading />
        ) : editing ? (
          <DocEditor key={doc.data.slug} projectId={project.id} slug={doc.data.slug} title={doc.data.title} body={doc.data.body} onDone={() => setEditing(false)} />
        ) : (
          <div className="mx-auto max-w-3xl">
            <div className="mb-4 flex items-center gap-2">
              <div className="flex-1 text-xs text-zinc-500">
                v{doc.data.version} · updated by {who(doc.data.updated_by)} <RelTime iso={doc.data.updated_at} />
              </div>
              <button className="btn btn-sm" onClick={() => setEditing(true)}>
                <Pencil className="size-3.5" /> Edit
              </button>
              <button className="btn btn-ghost btn-sm text-red-600" onClick={() => confirm('Delete this doc?') && del.mutate(doc.data!.slug)}>
                <Trash2 className="size-3.5" />
              </button>
            </div>
            <Markdown className="text-[15px]">{doc.data.body || '_Empty_'}</Markdown>
          </div>
        )}
      </div>
      {creating && (
        <Modal open onClose={() => setCreating(false)} title="New doc" width="max-w-3xl">
          <DocEditor projectId={project.id} slug="" title="" body="" onDone={(s) => { setCreating(false); if (s) setSlug(s); }} />
        </Modal>
      )}
    </div>
  );
}

function DocEditor({ projectId, slug, title, body, onDone }: { projectId: string; slug: string; title: string; body: string; onDone: (slug?: string) => void }) {
  const [t, setT] = useState(title);
  const [b, setB] = useState(body);
  const [s, setS] = useState(slug);
  const save = useAction(() => api('PUT', `/api/projects/${projectId}/docs/${encodeURIComponent(s || t.toLowerCase().replace(/[^a-z0-9]+/g, '-'))}`, { title: t, body: b }), { success: 'Saved', onSuccess: (d: any) => onDone(d.slug) });
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-[1fr_12rem] gap-3">
        <Field label="Title">
          <input className="input" value={t} onChange={(e) => setT(e.target.value)} />
        </Field>
        <Field label="Slug">
          <input className="input font-mono text-xs" value={s} disabled={!!slug} onChange={(e) => setS(e.target.value)} placeholder="auto" />
        </Field>
      </div>
      <textarea className="input min-h-[50vh] font-mono text-xs" value={b} onChange={(e) => setB(e.target.value)} placeholder="Markdown…" />
      <div className="flex justify-end gap-2">
        <button className="btn" onClick={() => onDone()}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={!t || save.isPending} onClick={() => save.mutate()}>
          Save
        </button>
      </div>
    </div>
  );
}
