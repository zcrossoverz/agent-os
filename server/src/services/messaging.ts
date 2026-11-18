import type { Core } from '../core/core.js';
import { toConversation, toInbox, toMessage } from '../core/mappers.js';
import type { Agent, Conversation, InboxItem, InboxType, Message } from '../core/types.js';
import { badRequest, forbidden, newId, notFound, nowIso, truncate } from '../util/util.js';

export type Participant = 'owner' | string; // 'owner' or an agent id

export type MessageTarget =
  | { type: 'owner' }
  | { type: 'agent'; agentId: string }
  | { type: 'team' }
  | { type: 'task'; taskId: string }
  | { type: 'conversation'; conversationId: string };

export interface SendInput {
  projectId: string;
  from: 'owner' | 'system' | { agentId: string };
  to: MessageTarget;
  body: string;
  expectsReply?: boolean;
  kind?: Message['kind'];
  runId?: string | null;
}

const MENTION_RE = /(?:^|[\s(])@([a-z0-9][a-z0-9-]{0,23})\b/g;

export class MessagingService {
  constructor(private core: Core) {}
  private get db() {
    return this.core.db;
  }

  // ---------------------------------------------------------------- conversations

  teamConversation(projectId: string): Conversation {
    return this.ensureConversation(projectId, 'team', 'team', null, 'Team');
  }

  directConversation(projectId: string, a: Participant, b: Participant): Conversation {
    if (a === b) throw badRequest('Cannot open a conversation with yourself');
    const [x, y] = [a, b].sort();
    const label = (p: Participant) => (p === 'owner' ? 'Owner' : (this.core.agents.find(p)?.name ?? p));
    return this.ensureConversation(projectId, 'direct', `dm:${x}|${y}`, null, `${label(x)} ↔ ${label(y)}`);
  }

  taskConversation(taskId: string): Conversation {
    const t = this.core.tasks.get(taskId);
    return this.ensureConversation(t.project_id, 'task', `task:${t.id}`, t.id, `${t.key} · ${t.title}`);
  }

  private ensureConversation(projectId: string, kind: Conversation['kind'], key: string, taskId: string | null, title: string): Conversation {
    const existing = this.db.get('SELECT * FROM conversations WHERE project_id = ? AND participant_key = ?', projectId, key);
    if (existing) return toConversation(existing);
    const id = newId('cnv');
    this.db.insert('conversations', { id, project_id: projectId, kind, participant_key: key, task_id: taskId, title, created_at: nowIso() });
    this.core.bus.change({ topic: 'conversations', projectId, id });
    return toConversation(this.db.get('SELECT * FROM conversations WHERE id = ?', id)!);
  }

  getConversation(id: string): Conversation {
    const r = this.db.get('SELECT * FROM conversations WHERE id = ?', id);
    if (!r) throw notFound('Conversation');
    return toConversation(r);
  }

  participants(c: Conversation): Participant[] {
    if (c.kind !== 'direct') return [];
    return c.participant_key.slice(3).split('|');
  }

  listConversations(projectId: string, forParticipant?: Participant) {
    let rows = this.db.all('SELECT * FROM conversations WHERE project_id = ? ORDER BY COALESCE(last_message_at, created_at) DESC', projectId).map(toConversation);
    if (forParticipant) {
      rows = rows.filter((c) => c.kind !== 'direct' || this.participants(c).includes(forParticipant));
    }
    return rows.map((c) => {
      const last = this.db.get('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', c.id);
      const count = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?', c.id)!.n;
      return { ...c, participants: this.participants(c), last_message: last ? toMessage(last) : null, message_count: count };
    });
  }

  messages(conversationId: string, opts: { limit?: number; before?: string } = {}): Message[] {
    const limit = Math.min(opts.limit ?? 100, 500);
    const rows = opts.before
      ? this.db.all('SELECT * FROM messages WHERE conversation_id = ? AND created_at < ? ORDER BY created_at DESC, rowid DESC LIMIT ?', conversationId, opts.before, limit)
      : this.db.all('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?', conversationId, limit);
    return rows.map(toMessage).reverse();
  }

  getMessage(id: string): Message | undefined {
    const r = this.db.get('SELECT * FROM messages WHERE id = ?', id);
    return r ? toMessage(r) : undefined;
  }

  // ---------------------------------------------------------------- sending

  send(input: SendInput): Message {
    const body = input.body?.trim();
    if (!body) throw badRequest('Message body is empty');
    if (body.length > 20000) throw badRequest('Message too long (max 20000 chars)');
    const project = this.core.projects.get(input.projectId);
    const sender: Agent | undefined = typeof input.from === 'object' ? this.core.agents.get(input.from.agentId) : undefined;
    if (sender && sender.project_id !== project.id) throw forbidden('Agent is not part of this project');
    const senderParticipant: Participant | null = input.from === 'owner' ? 'owner' : sender ? sender.id : null;

    // Resolve the conversation.
    let conv: Conversation;
    const to = input.to;
    if (to.type === 'team') conv = this.teamConversation(project.id);
    else if (to.type === 'task') conv = this.taskConversation(to.taskId);
    else if (to.type === 'conversation') conv = this.getConversation(to.conversationId);
    else {
      const other: Participant = to.type === 'owner' ? 'owner' : to.agentId;
      if (to.type === 'agent') {
        const target = this.core.agents.get(to.agentId);
        if (target.project_id !== project.id) throw badRequest('Recipient is not part of this project');
      }
      if (!senderParticipant) throw badRequest('System messages must target a conversation, task or team');
      conv = this.directConversation(project.id, senderParticipant, other);
    }
    if (conv.project_id !== project.id) throw forbidden('Conversation belongs to another project');
    if (conv.kind === 'direct' && senderParticipant && !this.participants(conv).includes(senderParticipant)) {
      throw forbidden('Not a participant of this conversation');
    }

    const now = nowIso();
    const id = newId('msg');
    const senderType = input.from === 'owner' ? 'owner' : input.from === 'system' ? 'system' : 'agent';
    const expectsReply = input.expectsReply ?? true;
    const limits = project.limits;

    return this.db.tx(() => {
      this.db.insert('messages', {
        id,
        project_id: project.id,
        conversation_id: conv.id,
        sender_type: senderType,
        sender_id: sender?.id ?? null,
        body,
        kind: input.kind ?? (senderType === 'system' ? 'system' : 'chat'),
        expects_reply: expectsReply,
        run_id: input.runId ?? null,
        created_at: now,
      });

      // Loop guard: count consecutive agent messages since the owner last spoke in this conversation.
      let streak = conv.agent_streak;
      let tripped = conv.loop_guard_tripped;
      let justTripped = false;
      if (senderType === 'owner') {
        streak = 0;
        tripped = false;
      } else if (senderType === 'agent') {
        streak += 1;
        if (!tripped && streak > limits.maxAgentStreak) {
          tripped = true;
          justTripped = true;
        }
      }
      this.db.update('conversations', conv.id, { agent_streak: streak, loop_guard_tripped: tripped, last_message_at: now });

      // Notify recipients through their inboxes.
      const msg = toMessage(this.db.get('SELECT * FROM messages WHERE id = ?', id)!);
      const fromLabel = senderType === 'owner' ? 'Owner' : senderType === 'system' ? 'AgentOS' : `${sender!.name} (@${sender!.slug})`;
      const summary = `${fromLabel} in ${conv.kind === 'direct' ? 'a direct message' : conv.title}: ${truncate(body.replace(/\s+/g, ' '), 160)}`;
      const mentions = this.mentionedAgents(project.id, body);
      const recipients = this.recipients(conv, senderParticipant, project.id);
      const pm = this.core.agents.pm(project.id);

      const notified = new Set<string>();
      const notify = (agentId: string, wake: boolean) => {
        if (agentId === sender?.id || notified.has(agentId)) return;
        notified.add(agentId);
        this.enqueue(project.id, agentId, 'message', { refId: id, taskId: conv.task_id, summary, wake: wake && !(tripped && senderType === 'agent') });
      };
      for (const m of mentions) notify(m.id, true);
      for (const r of recipients) {
        let wake: boolean;
        if (conv.kind === 'direct') wake = senderType === 'owner' || expectsReply;
        else if (conv.kind === 'team') wake = senderType === 'owner' && r === pm?.id;
        else wake = senderType === 'owner' || expectsReply; // task thread
        notify(r, wake);
      }

      if (justTripped) {
        const notice = `Loop guard: ${streak} consecutive agent messages in this conversation without owner input. Further agent messages here will not wake recipients until the owner replies.`;
        this.db.insert('messages', {
          id: newId('msg'),
          project_id: project.id,
          conversation_id: conv.id,
          sender_type: 'system',
          sender_id: null,
          body: notice,
          kind: 'system',
          expects_reply: false,
          run_id: null,
          created_at: nowIso(),
        });
        this.core.activity(project.id, 'system', 'guard.loop', `Loop guard tripped in "${conv.title}"`, { type: 'conversation', id: conv.id });
      }

      const actor = senderType === 'owner' ? 'owner' : senderType === 'system' ? 'system' : `agent:${sender!.id}`;
      if (senderType !== 'system') {
        this.core.activity(project.id, actor, 'message.sent', `${fromLabel} → ${conv.title}: ${truncate(body.replace(/\s+/g, ' '), 100)}`, {
          type: 'conversation',
          id: conv.id,
        });
      }
      this.core.bus.change({ topic: 'messages', projectId: project.id, id: conv.id });
      this.core.bus.kick();
      return msg;
    });
  }

  /** Who (besides the sender) should hear about a message in this conversation. */
  private recipients(conv: Conversation, sender: Participant | null, projectId: string): string[] {
    if (conv.kind === 'direct') return this.participants(conv).filter((p) => p !== 'owner' && p !== sender);
    if (conv.kind === 'team') return this.core.agents.list(projectId).filter((a) => a.enabled && a.id !== sender).map((a) => a.id);
    const t = conv.task_id ? this.core.tasks.find(conv.task_id) : undefined;
    const pm = this.core.agents.pm(projectId);
    return [t?.assignee_id, t?.reviewer_id, pm?.id].filter((x): x is string => !!x && x !== sender);
  }

  mentionedAgents(projectId: string, body: string): Agent[] {
    const out: Agent[] = [];
    for (const m of body.matchAll(MENTION_RE)) {
      const slug = m[1];
      const a = slug === 'pm' ? this.core.agents.pm(projectId) : this.core.agents.resolve(projectId, slug);
      if (a && a.enabled && !out.some((x) => x.id === a.id)) out.push(a);
    }
    return out;
  }

  /** Direct conversations where an agent asked the owner something and the owner has not answered. */
  unansweredForOwner(projectId?: string) {
    const rows = this.db.all(
      `SELECT c.*, m.id AS m_id, m.body AS m_body, m.sender_id AS m_sender, m.created_at AS m_at
       FROM conversations c
       JOIN messages m ON m.id = (SELECT id FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC, rowid DESC LIMIT 1)
       WHERE c.kind = 'direct' AND c.participant_key LIKE '%owner%' AND m.sender_type = 'agent' AND m.expects_reply = 1
       ${projectId ? 'AND c.project_id = ?' : ''}
       ORDER BY m.created_at DESC`,
      ...(projectId ? [projectId] : []),
    );
    return rows.map((r) => ({
      conversation_id: r.id as string,
      project_id: r.project_id as string,
      title: r.title as string,
      message_id: r.m_id as string,
      body: r.m_body as string,
      agent_id: r.m_sender as string,
      created_at: r.m_at as string,
    }));
  }

  // ---------------------------------------------------------------- inbox

  enqueue(projectId: string, agentId: string, type: InboxType, opts: { refId?: string | null; taskId?: string | null; summary: string; wake?: boolean }) {
    const agent = this.core.agents.find(agentId);
    if (!agent || agent.project_id !== projectId) return;
    if (opts.refId) {
      const dup = this.db.get("SELECT id FROM inbox WHERE agent_id = ? AND type = ? AND ref_id = ? AND status = 'pending'", agentId, type, opts.refId);
      if (dup) {
        if (opts.wake) this.db.update('inbox', dup.id, { wake: true });
        return;
      }
    }
    this.db.insert('inbox', {
      id: newId('inb'),
      project_id: projectId,
      agent_id: agentId,
      type,
      ref_id: opts.refId ?? null,
      task_id: opts.taskId ?? null,
      summary: opts.summary,
      wake: opts.wake ?? true,
      created_at: nowIso(),
    });
    this.core.bus.change({ topic: 'agents', projectId, id: agentId });
    this.core.bus.kick();
  }

  pendingInbox(agentId: string, wakeOnly = false): InboxItem[] {
    return this.db
      .all(`SELECT * FROM inbox WHERE agent_id = ? AND status = 'pending' ${wakeOnly ? 'AND wake = 1' : ''} ORDER BY created_at`, agentId)
      .map(toInbox);
  }

  inboxForRun(runId: string): InboxItem[] {
    return this.db.all('SELECT * FROM inbox WHERE run_id = ? ORDER BY created_at', runId).map(toInbox);
  }

  markDelivered(ids: string[], runId: string) {
    for (const id of ids) this.db.run("UPDATE inbox SET status = 'delivered', run_id = ?, attempts = attempts + 1 WHERE id = ?", runId, id);
  }

  completeInbox(runId: string) {
    this.db.run("UPDATE inbox SET status = 'done' WHERE run_id = ? AND status = 'delivered'", runId);
  }

  /** Failed run: give the items back so the next run sees them (up to 3 attempts). */
  releaseInbox(runId: string) {
    this.db.run("UPDATE inbox SET status = 'pending', run_id = NULL WHERE run_id = ? AND status = 'delivered' AND attempts < 3", runId);
    this.db.run("UPDATE inbox SET status = 'done' WHERE run_id = ? AND status = 'delivered'", runId);
  }

  inboxCounts(projectId: string): Record<string, { pending: number; wake: number }> {
    const out: Record<string, { pending: number; wake: number }> = {};
    for (const r of this.db.all("SELECT agent_id, COUNT(*) AS n, SUM(wake) AS w FROM inbox WHERE project_id = ? AND status = 'pending' GROUP BY agent_id", projectId)) {
      out[r.agent_id] = { pending: r.n, wake: r.w ?? 0 };
    }
    return out;
  }
}
