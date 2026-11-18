import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import clsx from 'clsx';
import { Send, Users, Hash, Crown, Eye, Loader2 } from 'lucide-react';
import { api, useAction } from '../../lib/api';
import { useConversations, useMessages } from '../../lib/queries';
import type { ConversationRow } from '../../lib/types';
import { useProjectCtx } from './ProjectLayout';
import { AgentStatus, Avatar, Empty, Markdown, OwnerAvatar, RelTime } from '../../components/ui';

export function ChatPage() {
  const { project, agents, agent } = useProjectCtx();
  const { conversationId } = useParams();
  const nav = useNavigate();
  const convs = useConversations(project.id);
  const pm = agents.find((a) => a.is_pm);

  const openDirect = useAction((agentId: string) => api<ConversationRow>('POST', `/api/projects/${project.id}/direct/${agentId}`), {
    onSuccess: (c) => nav(`/p/${project.slug}/chat/${c.id}`, { replace: true }),
  });

  const directWith = (agentId: string) => convs.data?.find((c) => c.kind === 'direct' && c.participants.includes('owner') && c.participants.includes(agentId));

  // Default to the PM conversation.
  useEffect(() => {
    if (conversationId || !convs.data) return;
    if (pm) {
      const c = directWith(pm.id);
      if (c) nav(`/p/${project.slug}/chat/${c.id}`, { replace: true });
      else if (!openDirect.isPending) openDirect.mutate(pm.id);
    } else {
      const team = convs.data.find((c) => c.kind === 'team');
      if (team) nav(`/p/${project.slug}/chat/${team.id}`, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, convs.data, pm?.id]);

  const groups = useMemo(() => {
    const list = convs.data ?? [];
    return {
      team: list.filter((c) => c.kind === 'team'),
      tasks: list.filter((c) => c.kind === 'task' && c.message_count > 0),
      agentToAgent: list.filter((c) => c.kind === 'direct' && !c.participants.includes('owner')),
    };
  }, [convs.data]);

  const current = convs.data?.find((c) => c.id === conversationId);
  const item = (key: string, active: boolean, onClick: () => void, icon: React.ReactNode, label: React.ReactNode, sub?: React.ReactNode, right?: React.ReactNode) => (
    <button key={key} onClick={onClick} className={clsx('flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition', active ? 'bg-white shadow-xs dark:bg-zinc-800' : 'hover:bg-white/60 dark:hover:bg-zinc-800/50')}>
      {icon}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{label}</div>
        {sub && <div className="truncate text-xs text-zinc-500">{sub}</div>}
      </div>
      {right}
    </button>
  );

  return (
    <div className="flex h-full min-h-0">
      <div className="flex w-72 shrink-0 flex-col gap-4 overflow-y-auto border-r border-zinc-200 bg-zinc-50 p-3 scrollbar-thin dark:border-zinc-800 dark:bg-zinc-900/40">
        <div>
          <div className="px-2.5 pb-1 text-[11px] font-semibold tracking-wide text-zinc-500 uppercase">Direct</div>
          {agents.map((a) => {
            const c = directWith(a.id);
            return item(
              a.id,
              !!c && c.id === conversationId,
              () => (c ? nav(`/p/${project.slug}/chat/${c.id}`) : openDirect.mutate(a.id)),
              <span className="relative">
                <Avatar name={a.name} seed={a.id} size="sm" />
                <span className="absolute -right-0.5 -bottom-0.5">
                  <AgentStatus status={a.status} compact />
                </span>
              </span>,
              <span className="flex items-center gap-1">
                {a.name} {a.is_pm && <Crown className="size-3 text-amber-500" />}
              </span>,
              c?.last_message ? c.last_message.body.slice(0, 60) : a.role,
            );
          })}
        </div>
        <div>
          <div className="px-2.5 pb-1 text-[11px] font-semibold tracking-wide text-zinc-500 uppercase">Channels</div>
          {groups.team.map((c) => item(c.id, c.id === conversationId, () => nav(`/p/${project.slug}/chat/${c.id}`), <Users className="size-5 text-zinc-400" />, 'Team', c.last_message?.body.slice(0, 60) ?? 'Everyone; @mention to wake'))}
        </div>
        {groups.tasks.length > 0 && (
          <div>
            <div className="px-2.5 pb-1 text-[11px] font-semibold tracking-wide text-zinc-500 uppercase">Task threads</div>
            {groups.tasks.map((c) => item(c.id, c.id === conversationId, () => nav(`/p/${project.slug}/chat/${c.id}`), <Hash className="size-4 text-zinc-400" />, c.title, <RelTime iso={c.last_message_at} />))}
          </div>
        )}
        {groups.agentToAgent.length > 0 && (
          <div>
            <div className="px-2.5 pb-1 text-[11px] font-semibold tracking-wide text-zinc-500 uppercase">Between agents</div>
            {groups.agentToAgent.map((c) =>
              item(c.id, c.id === conversationId, () => nav(`/p/${project.slug}/chat/${c.id}`), <Eye className="size-4 text-zinc-400" />, c.title, `${c.message_count} messages${c.loop_guard_tripped ? ' · loop guard' : ''}`),
            )}
          </div>
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        {current ? <Thread conv={current} /> : <Empty title="Pick a conversation" />}
      </div>
    </div>
  );
}

function Thread({ conv }: { conv: ConversationRow }) {
  const { project, agent } = useProjectCtx();
  const messages = useMessages(conv.id);
  const [body, setBody] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  const other = conv.kind === 'direct' ? agent(conv.participants.find((p) => p !== 'owner')) : undefined;
  const readOnly = conv.kind === 'direct' && !conv.participants.includes('owner');
  const send = useAction(() => api('POST', `/api/projects/${project.id}/messages`, { to: { type: 'conversation', conversationId: conv.id }, body }), { onSuccess: () => setBody('') });
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.data?.length]);
  const lastIsOwner = messages.data?.at(-1)?.sender_type === 'owner';

  return (
    <>
      <div className="flex items-center gap-3 border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
        {other ? <Avatar name={other.name} seed={other.id} /> : <Users className="size-5 text-zinc-400" />}
        <div className="min-w-0">
          <div className="text-sm font-semibold">{other ? `${other.name} · ${other.role}` : conv.title}</div>
          {other ? <AgentStatus status={other.status} detail={other.status_detail} /> : <div className="text-xs text-zinc-500">{conv.kind === 'team' ? 'Visible to all agents. Only @mentions (and the PM, for your messages) wake someone.' : readOnly ? 'Read-only: agents coordinating directly' : 'Task discussion'}</div>}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 scrollbar-thin">
        <div className="mx-auto max-w-3xl space-y-4">
          {messages.data?.map((m) => {
            const a = m.sender_type === 'agent' ? agent(m.sender_id) : undefined;
            if (m.sender_type === 'system')
              return (
                <div key={m.id} className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                  {m.body}
                </div>
              );
            const mine = m.sender_type === 'owner';
            return (
              <div key={m.id} className={clsx('flex gap-3', mine && 'flex-row-reverse')}>
                {mine ? <OwnerAvatar size="sm" /> : <Avatar name={a?.name ?? '?'} seed={a?.id} size="sm" />}
                <div className={clsx('max-w-[85%] min-w-0', mine && 'text-right')}>
                  <div className="mb-0.5 text-xs text-zinc-500">
                    <span className="font-medium text-zinc-700 dark:text-zinc-300">{mine ? 'You' : (a?.name ?? 'Agent')}</span> · <RelTime iso={m.created_at} />
                    {m.kind === 'fyi' || (!m.expects_reply && !mine && m.kind === 'chat') ? '' : ''}
                  </div>
                  <div className={clsx('inline-block rounded-2xl px-3.5 py-2 text-left', mine ? 'bg-indigo-600 text-white [&_code]:bg-indigo-500 [&_a]:text-white' : 'bg-white shadow-xs ring-1 ring-zinc-200 dark:bg-zinc-800 dark:ring-zinc-700')}>
                    <Markdown>{m.body}</Markdown>
                  </div>
                </div>
              </div>
            );
          })}
          {messages.data?.length === 0 && (
            <Empty title={other?.is_pm ? `Start with ${other.name}` : 'No messages yet'}>
              {other?.is_pm ? 'Describe an objective in plain language. The PM will analyse it, plan the work, assign it to the team and report back.' : null}
            </Empty>
          )}
          {other && (other.status === 'running' || other.status === 'queued') && (lastIsOwner || conv.kind === 'direct') && (
            <div className="flex items-center gap-2 text-xs text-zinc-500">
              <Loader2 className="size-3.5 animate-spin" /> {other.name} is {other.status === 'queued' ? 'about to start' : 'working'}…
            </div>
          )}
          <div ref={endRef} />
        </div>
      </div>
      {!readOnly && (
        <form
          className="border-t border-zinc-200 px-5 py-3 dark:border-zinc-800"
          onSubmit={(e) => {
            e.preventDefault();
            if (body.trim()) send.mutate();
          }}
        >
          <div className="mx-auto flex max-w-3xl gap-2">
            <textarea
              className="input min-h-[2.75rem] flex-1 resize-none"
              rows={Math.min(8, Math.max(2, body.split('\n').length))}
              placeholder={other ? `Message ${other.name}… (⌘/Ctrl+Enter to send)` : 'Message the team… use @handle to wake someone'}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && body.trim()) send.mutate();
              }}
            />
            <button className="btn btn-primary self-end" disabled={!body.trim() || send.isPending}>
              <Send className="size-4" />
            </button>
          </div>
          {project.autonomy === 'paused' && <div className="mx-auto mt-1 max-w-3xl text-xs text-amber-600">The project is paused. Agents will read this when you resume it.</div>}
        </form>
      )}
    </>
  );
}
