import type { Core } from '../core/core.js';
import type { Agent, InboxItem, Project, Task } from '../core/types.js';
import { truncate } from '../util/util.js';

const PRIORITY = ['urgent', 'high', 'normal', 'low'];

/**
 * The agent's standing instructions (appended to Claude Code's default system prompt).
 * Keep this stable per agent: Claude Code snapshots the system prompt per conversation.
 */
export function buildSystemPrompt(core: Core, agent: Agent, project: Project): string {
  const base = project.base_branch;
  const key = project.key;
  const cloud = project.workspace_mode === 'github';
  const parts: string[] = [];
  parts.push(`# AgentOS operating manual

You are **${agent.name}** (handle @${agent.slug}), the **${agent.role}** on the software project "${project.name}" (task keys ${key}-N). You are one member of a team of AI agents coordinated through AgentOS. The human Project Owner has final authority over the project.

## How you work
${
    cloud
      ? '- AgentOS starts a fresh Claude Code on the web session for you when something needs your attention: a message, an assignment, a review request, an approval decision. The assignment below lists the reasons. Handle them, then call finish_run with a short summary and stop. You will get a new session when there is more to do, so never wait, sleep or poll.\n- This session is temporary. Anything you have not pushed to GitHub or recorded in AgentOS is lost when it ends.'
      : '- AgentOS wakes you when something needs your attention: a message, an assignment, a review request, an approval decision. Each wake-up message lists the reasons. Handle them, then end your turn with a short summary of what you did. You will be woken again when there is more to do, so never wait, sleep or poll.'
  }
- AgentOS is the source of truth for tasks, messages, decisions and approvals. Your conversation memory may be reset at any time. Record anything others need (progress notes, decisions, design notes) with AgentOS tools, not only in your reply.
- Coordinate only through the \`agentos\` MCP tools (send_message, the task tools, request_approval, docs). Never ask the owner to relay messages between agents.

## Communication rules
- Be concise and specific. Refer to tasks by key (e.g. ${key}-12) and to teammates by @handle.
- Use expects_reply=false for FYIs and status updates. Never send pure acknowledgements ("thanks", "got it"): they waste the team's capacity.
- Ask a teammate directly when you need information from them. Ask the PM about priorities and scope. Ask the owner only for decisions that genuinely need a human.
- Avoid duplicate work: check the board (list_tasks) before starting anything that isn't assigned to you.

## Escalation (you MUST call request_approval and wait for the decision before):
- significant architectural decisions: new services, frameworks, or data-model changes that are hard to reverse;
- anything security-sensitive: authentication design, secrets handling, permissions;
- destructive operations: deleting data, branches or files outside your task's scope, force pushes, rewriting history;
- anything that touches production, deployments, billing, external services or credentials.
Routine implementation choices inside your task need no approval. While you wait on an approval, continue other unblocked work or end your turn.
${cloud ? 'In cloud sessions no permission gate stops you, so these escalation rules are yours to follow strictly.' : "AgentOS's permission gate intercepts tool calls that look risky. If one is denied, do not try to work around it."}

## Git rules
${
    cloud
      ? `- You are in a fresh clone of the project's GitHub repository. GitHub is the shared workspace: teammates only see what you push.
- For task work, use the task branch named in your assignment (\`task/<key>-…\`): \`git fetch origin && (git checkout -B <branch> origin/<branch> 2>/dev/null || git checkout -b <branch> origin/${base})\`. Commit early and often, starting each message with the task key, e.g. "${key}-12: add login endpoint".
- Push your branch (\`git push -u origin <branch>\`) before submit_for_review; AgentOS checks GitHub for your commits and merges reviewed branches into "${base}" itself.
- Never push to "${base}", force-push, delete branches, or open or merge pull requests. Never touch other agents' branches.
- Before you submit, make sure the tests pass and your branch is rebased on the latest \`origin/${base}\` if it moved.
- Never commit credentials or API keys. Don't edit \`.mcp.json\` or \`.claude/settings*.json\`: they connect you to AgentOS.`
      : `- Your current working directory is your own git worktree. Work only inside it.
- For task work, use the task branch named in your wake-up message (\`task/<key>-…\`). Commit early and often, starting each message with the task key, e.g. "${key}-12: add login endpoint".
- Never force-push, rewrite history, push to a remote, or commit to the base branch "${base}". Never touch other agents' worktrees or branches. AgentOS merges approved work into "${base}".
- Before you submit for review, commit everything, make sure the tests pass, and rebase on the latest "${base}" if it moved (\`git rebase ${base}\`; all worktrees share one repository, so no fetch is needed).
- Never commit credentials or API keys. Never create or edit \`.claude/settings*.json\`.`
  }

## Task lifecycle
backlog → todo → in_progress → in_review → done (or blocked / cancelled)
- Call start_task when you begin. Call submit_for_review with what changed and how you tested it. Call block_task with a precise reason if you cannot proceed.
- If you must stop before a large task is finished, ${cloud ? 'push your branch, then ' : ''}call checkpoint(continue=true) with notes. AgentOS wakes you again to continue.
- As a reviewer: inspect the diff (${cloud ? `\`git fetch origin && git diff origin/${base}...origin/<branch>\`` : `\`git diff ${base}...<branch>\``}), run the tests, then call review_task with "approve" or "request_changes" and specific, actionable comments.`);

  if (agent.is_pm) {
    parts.push(`## Your responsibilities as Project Manager
- You are the owner's main point of contact. When the owner gives you an objective, analyse it (read the code and docs as needed) and make a plan. Break the plan into epics, tasks and subtasks with acceptance criteria and dependencies. Assign each task to the best-suited teammate, with a reviewer where useful.
- Keep the board accurate. When woken, check progress, unblock teammates, reassign stuck work, and resolve routine coordination issues yourself.
- Report to the owner when something meaningful happens: a plan is ready, a milestone is done, or a blocker needs their decision. Keep reports short: what's done, what's next, what needs their input.
- Delegate. Don't implement features yourself unless the owner asks you to.
- Keep the "brief" doc and a "plan" doc up to date with write_doc.${
      project.autonomy === 'supervised'
        ? `\n- This project is SUPERVISED: tasks you create start in the backlog. Once your plan is ready, call request_approval(kind="plan", task_keys=[…]) so the owner can release it.`
        : ''
    }`);
  }

  if (project.coordination_mode === 'collaborative') {
    parts.push(`## Collaborative mode
Agents may create and assign tasks and coordinate directly with each other. The PM supervises overall progress. Keep the board accurate and tell the PM about significant re-planning.`);
  } else if (!agent.is_pm) {
    parts.push(`## PM-led mode
The PM plans and assigns work. You may break your own task into subtasks or propose backlog items, but ask the PM (send_message to "pm") before taking on new scope.`);
  }

  if (agent.instructions.trim()) parts.push(`## Your role-specific instructions\n${agent.instructions.trim()}`);
  return parts.join('\n\n');
}

function itemBlock(core: Core, item: InboxItem, i: number): string {
  const n = `${i + 1}.`;
  switch (item.type) {
    case 'message': {
      const m = item.ref_id ? core.messaging.getMessage(item.ref_id) : undefined;
      if (!m) return `${n} ${item.summary}`;
      const conv = core.messaging.getConversation(m.conversation_id);
      const who = m.sender_type === 'owner' ? 'the Owner' : m.sender_type === 'system' ? 'AgentOS' : core.actorLabel(`agent:${m.sender_id}`);
      const where = conv.kind === 'direct' ? 'direct conversation' : conv.kind === 'team' ? 'team channel' : `task thread ${conv.title}`;
      const reply = conv.kind === 'direct' ? (m.sender_type === 'owner' ? 'owner' : `@${core.agents.find(m.sender_id)?.slug}`) : conv.kind === 'team' ? 'team' : conv.title.split(' ')[0];
      return `${n} **Message from ${who}** (${where}${m.expects_reply ? ', expects a reply' : ', FYI'}; reply with send_message to="${reply}"):\n${quote(truncate(m.body, 6000))}`;
    }
    case 'task_assigned':
    case 'task_unblocked':
    case 'changes_requested':
    case 'merge_result':
    case 'review_requested': {
      const t = core.tasks.find(item.task_id);
      const head = {
        task_assigned: 'Task assigned to you',
        task_unblocked: 'Task unblocked',
        changes_requested: 'Changes requested',
        merge_result: 'Merge problem',
        review_requested: 'Review requested',
      }[item.type];
      if (!t) return `${n} **${head}**: ${item.summary}`;
      const lines = [`${n} **${head}: ${t.key} "${t.title}"**. ${item.summary}`];
      if (item.type !== 'review_requested') lines.push(taskDetails(core, t, '   '));
      else lines.push(`   Branch: \`${t.branch}\` · assignee: ${core.actorLabel(`agent:${t.assignee_id}`)}\n   Acceptance criteria:\n${indent(t.acceptance_criteria || '(none given)', '   ')}`);
      return lines.join('\n');
    }
    case 'approval_decided':
      return `${n} **Approval decision**: ${item.summary}`;
    default:
      return `${n} ${item.summary}`;
  }
}

function taskDetails(core: Core, t: Task, pad = ''): string {
  const deps = (t.depends_on ?? []).map((id) => core.tasks.find(id)).filter(Boolean) as Task[];
  return [
    `${pad}Status: ${t.status} · priority: ${PRIORITY[t.priority]}${t.branch ? ` · branch: \`${t.branch}\`` : ''}${t.parent_id ? ` · parent: ${core.tasks.find(t.parent_id)?.key}` : ''}`,
    deps.length ? `${pad}Depends on: ${deps.map((d) => `${d.key} (${d.status})`).join(', ')}` : '',
    `${pad}Description:\n${indent(t.description || '(none)', pad + '  ')}`,
    `${pad}Acceptance criteria:\n${indent(t.acceptance_criteria || '(none given; ask the PM if unclear)', pad + '  ')}`,
  ]
    .filter(Boolean)
    .join('\n');
}

const quote = (s: string) =>
  s
    .split('\n')
    .map((l) => `   > ${l}`)
    .join('\n');
const indent = (s: string, pad: string) =>
  s
    .split('\n')
    .map((l) => pad + l)
    .join('\n');

export interface WakePromptInput {
  agent: Agent;
  project: Project;
  items: InboxItem[];
  focusTask: Task | null;
  trigger: 'inbox' | 'continue' | 'manual';
  branch: string | null;
  runId?: string;
}

/** The per-run user message: why the agent was woken and what it should look at. */
export function buildWakePrompt(core: Core, w: WakePromptInput): { prompt: string; recovery: string } {
  const { agent, project, items, focusTask } = w;
  const wake = items.filter((i) => i.wake);
  const fyi = items.filter((i) => !i.wake);
  const out: string[] = [];
  out.push(`[AgentOS wake-up · ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC]`);

  if (w.trigger === 'continue' && focusTask) {
    out.push(`## Continue your work on ${focusTask.key} "${focusTask.title}"\nYou asked to continue (or ran out of turns last time). Pick up where you left off. Check \`git log\` and the task thread for your notes.\n${taskDetails(core, focusTask, '')}`);
  }
  if (w.trigger === 'manual' && !wake.length) out.push('## Check-in requested by the owner\nReview your assignments and the board, make progress on your work, and report anything noteworthy.');
  if (wake.length) out.push(`## What needs your attention\n${wake.map((it, i) => itemBlock(core, it, i)).join('\n\n')}`);
  if (fyi.length) out.push(`## Also new (FYI, act only if relevant)\n${fyi.map((it) => `- ${it.summary}`).join('\n')}`);

  const mine = core.tasks.list(project.id, { assigneeId: agent.id, includeClosed: false });
  const reviews = core.tasks.list(project.id, { status: ['in_review'] }).filter((t) => core.tasks.reviewerFor(t)?.id === agent.id && t.merge_state == null);
  const lines = mine.map((t) => `- ${t.key} [${t.status}] ${t.title}${t.branch ? ` (branch \`${t.branch}\`)` : ''}`);
  out.push(`## Your assignments\n${lines.length ? lines.join('\n') : '- (none)'}${reviews.length ? `\nReviews waiting on you: ${reviews.map((t) => t.key).join(', ')}` : ''}`);

  const cloud = project.workspace_mode === 'github';
  const ws = [`- Base branch: \`${project.base_branch}\``];
  if (cloud) {
    if (w.branch) ws.unshift(`- Work on task branch \`${w.branch}\` for ${focusTask?.key}: \`git fetch origin && (git checkout -B ${w.branch} origin/${w.branch} 2>/dev/null || git checkout -b ${w.branch} origin/${project.base_branch})\`. Push it before you submit.`);
    else ws.unshift(`- You are in a fresh clone of the GitHub repository. To review a teammate's work: \`git fetch origin && git diff origin/${project.base_branch}...origin/<branch>\`.`);
  } else if (w.branch) ws.unshift(`- AgentOS checked out task branch \`${w.branch}\` in your worktree for ${focusTask?.key}.`);
  else ws.unshift('- Your worktree is checked out on your own scratch branch. To review a teammate\'s work, use `git diff`/`git log` against their branch or `git checkout --detach <branch>`.');
  out.push(`## Workspace\n${ws.join('\n')}`);

  const ownerMsg = items.some((i) => i.type === 'message' && core.messaging.getMessage(i.ref_id ?? '')?.sender_type === 'owner');
  if (cloud) {
    out.push(
      ownerMsg
        ? 'When you are done, call finish_run with your reply to the owner as the summary (AgentOS posts it to them unless you already answered with send_message). Then stop.'
        : 'When you are done, call finish_run with a 1-3 sentence summary of what you did. Then stop.',
    );
  } else {
    out.push(
      ownerMsg
        ? 'When you are done, end your turn with your reply to the owner. AgentOS posts your final message to them, unless you already answered with send_message.'
        : 'When you are done, end your turn with a 1-3 sentence summary of what you did (it is logged, not sent to anyone).',
    );
  }

  return { prompt: out.join('\n\n'), recovery: buildRecovery(core, agent, project, focusTask) };
}

/** Prepended when a run starts a fresh provider session, so no context depends on chat history. */
export function buildRecovery(core: Core, agent: Agent, project: Project, focusTask: Task | null): string {
  const out: string[] = ['# Context recovery\nYou are starting a fresh session. Here is the current state from AgentOS. Use get_project_overview, list_tasks, get_task, read_messages and read_doc for more.'];
  out.push(`## Project\n${project.name} (${project.key}). ${project.description || ''}\nCoordination: ${project.coordination_mode === 'pm_led' ? 'PM-led' : 'collaborative'} · autonomy: ${project.autonomy} · base branch: ${project.base_branch}`);
  const team = core.agents
    .list(project.id)
    .filter((a) => a.enabled)
    .map((a) => `- ${a.name} (@${a.slug}) — ${a.role}${a.is_pm ? ' [PM]' : ''}${a.id === agent.id ? ' ← you' : ''}`);
  out.push(`## Team\n${team.join('\n')}\n- Owner (human, final authority) — address with to="owner"`);
  try {
    const brief = core.knowledge.getDoc(project.id, 'brief');
    out.push(`## Project brief (doc "brief")\n${truncate(brief.body, 3000)}`);
  } catch {
    /* no brief */
  }
  const decisions = core.knowledge.listDecisions(project.id).slice(0, 8);
  if (decisions.length) out.push(`## Recent decisions\n${decisions.map((d) => `- ${d.title}: ${truncate(d.decision, 200)} (${d.status})`).join('\n')}`);
  if (focusTask) {
    const conv = core.messaging.taskConversation(focusTask.id);
    const msgs = core.messaging.messages(conv.id, { limit: 12 });
    out.push(`## Focus task ${focusTask.key} "${focusTask.title}"\n${taskDetails(core, focusTask)}${msgs.length ? `\nRecent task thread:\n${msgs.map((m) => `- ${senderName(core, m)}: ${truncate(m.body.replace(/\s+/g, ' '), 400)}`).join('\n')}` : ''}`);
  }
  if (agent.is_pm) {
    const conv = core.messaging.directConversation(project.id, 'owner', agent.id);
    const msgs = core.messaging.messages(conv.id, { limit: 10 });
    if (msgs.length) out.push(`## Recent conversation with the owner\n${msgs.map((m) => `- ${senderName(core, m)}: ${truncate(m.body.replace(/\s+/g, ' '), 600)}`).join('\n')}`);
    const open = core.tasks.list(project.id, { includeClosed: false });
    if (open.length) out.push(`## Open tasks\n${open.slice(0, 40).map((t) => `- ${t.key} [${t.status}] ${t.title}${t.assignee_id ? ` → @${core.agents.find(t.assignee_id)?.slug}` : ''}`).join('\n')}`);
  }
  return out.join('\n\n');
}

function senderName(core: Core, m: { sender_type: string; sender_id: string | null }) {
  if (m.sender_type === 'owner') return 'Owner';
  if (m.sender_type === 'system') return 'AgentOS';
  return core.agents.find(m.sender_id)?.name ?? 'agent';
}
