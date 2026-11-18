import path from 'node:path';
import type { Core } from '../core/core.js';
import type { Agent, ApprovalKind, Run } from '../core/types.js';
import { truncate } from '../util/util.js';

export type GateDecision = { behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string };

interface Rule {
  kind: ApprovalKind;
  reason: string;
  test: (cmd: string) => boolean;
}

const re = (r: RegExp) => (cmd: string) => r.test(cmd);

/** Bash commands that need the owner's approval. Anything else runs (inside the agent's worktree). */
export const BASH_RULES: Rule[] = [
  { kind: 'security', reason: 'touches provider credentials', test: re(/ANTHROPIC_(API_KEY|AUTH_TOKEN)|CLAUDE_CODE_OAUTH_TOKEN|\.credentials\.json|CLAUDE_CONFIG_DIR/) },
  { kind: 'security', reason: 'pipes a download into a shell', test: re(/\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/) },
  { kind: 'security', reason: 'uses sudo/su', test: re(/(^|[;&|]\s*)(sudo|su|doas)\s/) },
  { kind: 'destructive', reason: 'force-pushes or rewrites published history', test: re(/\bgit\s+push\b.*(\s-f\b|--force|--mirror|--delete|\s:\S)/) },
  { kind: 'production', reason: 'pushes to a remote', test: re(/\bgit\s+push\b/) },
  { kind: 'destructive', reason: 'rewrites repository history', test: re(/\bgit\s+(filter-branch|filter-repo|reflog\s+expire|gc\s+--prune=now|update-ref\s+-d)/) },
  { kind: 'destructive', reason: 'deletes branches', test: re(/\bgit\s+branch\s+(-D|--delete\s+--force|-d\s+-f)/) },
  { kind: 'destructive', reason: 'recursive delete outside the worktree', test: (c) => /\brm\s+(-\w*[rR]\w*|--recursive)\b/.test(c) && /\brm\s[^;&|]*\s(\/(?!tmp\/)|~|\$HOME|\.\.(\/|\s|$)|\*(\s|$)|\.(\s|$))/.test(c) },
  { kind: 'destructive', reason: 'formats disks or writes raw devices', test: re(/\b(mkfs|fdisk|parted)\b|\bdd\s+.*\bof=\/dev\//) },
  { kind: 'production', reason: 'controls system services or the host', test: re(/\b(systemctl|service|shutdown|reboot|halt|crontab|iptables|ufw)\b/) },
  { kind: 'production', reason: 'deploys or changes infrastructure', test: re(/\b(kubectl|helm|terraform\s+(apply|destroy|import)|pulumi\s+(up|destroy)|ansible-playbook|flyctl|fly\s+deploy|vercel\s+.*--prod|netlify\s+deploy|heroku|serverless\s+deploy|sls\s+deploy|eb\s+deploy|gcloud\s+.*\b(deploy|delete)|aws\s+\S+\s+(delete|terminate|put|create|update)|az\s+.*\b(delete|create|deploy))\b/) },
  { kind: 'production', reason: 'publishes a package or release', test: re(/\b(npm|pnpm|yarn)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b|\bgem\s+push\b|\bgh\s+(release|pr\s+merge|repo\s+delete)\b|\bdocker\s+push\b/) },
  { kind: 'production', reason: 'runs containers with host access', test: re(/\bdocker\s+(run|exec|rm|rmi|system\s+prune|compose\s+down)|\bdocker-compose\s+down\b/) },
  { kind: 'destructive', reason: 'destroys database objects', test: re(/\b(DROP\s+(DATABASE|TABLE|SCHEMA)|TRUNCATE\s+TABLE)\b/i) },
  { kind: 'destructive', reason: 'changes permissions recursively', test: re(/\bch(mod|own)\s+-R\b/) },
];

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/**
 * AgentOS's permission gate (Claude Code's --permission-prompt-tool). Claude Code calls it for
 * every tool use that isn't pre-approved. Risky calls are denied *and* turned into an owner
 * approval; once approved, a one-off grant lets that exact call through.
 */
export function evaluatePermission(core: Core, run: Run, agent: Agent, toolName: string, input: Record<string, unknown>): GateDecision {
  const allow = (): GateDecision => ({ behavior: 'allow', updatedInput: input });
  if (toolName.startsWith('mcp__agentos__')) return allow();
  const workspace = typeof run.git?.workspace === 'string' ? run.git.workspace : (run.payload?.workspace as string | undefined);

  if (EDIT_TOOLS.has(toolName)) {
    if (agent.tool_profile === 'readonly') return { behavior: 'deny', message: `${agent.role} agents are read-only: file edits are disabled for you. Describe the change in a review comment or message instead.` };
    const file = String(input.file_path ?? input.notebook_path ?? '');
    if (/(^|\/)\.claude\/settings(\.local)?\.json$/.test(file)) {
      return { behavior: 'deny', message: 'Editing Claude Code settings files is not allowed (they can change billing and permissions).' };
    }
    if (/(^|\/)\.git\//.test(file)) return { behavior: 'deny', message: 'Do not edit git internals directly; use git commands.' };
    if (workspace && file && path.isAbsolute(file) && !isInside(file, workspace) && !isInside(file, '/tmp')) {
      return { behavior: 'deny', message: `You may only edit files inside your worktree (${workspace}).` };
    }
    return allow();
  }

  if (toolName === 'Bash') {
    const cmd = String(input.command ?? '');
    const rule = BASH_RULES.find((r) => r.test(cmd));
    const otherWorktree = workspace && referencesOtherWorktree(cmd, workspace);
    if (!rule && !otherWorktree) return allow();
    const match = cmd.trim();
    if (core.approvals.consumeGrant(agent.id, 'Bash', match)) return allow();
    const kind = rule?.kind ?? 'destructive';
    const reason = rule?.reason ?? "accesses another agent's worktree";
    const task = core.tasks.find(run.focus_task_id);
    const approval = core.approvals.request(
      {
        projectId: agent.project_id,
        agentId: agent.id,
        runId: run.id,
        taskId: task?.id ?? null,
        kind: 'permission',
        title: `${agent.name} wants to run: ${truncate(match.replace(/\s+/g, ' '), 90)}`,
        description: `**Why this was stopped:** the command ${reason} (${kind}).\n\n**Agent:** ${agent.name} (${agent.role})${task ? `\n**Task:** ${task.key} ${task.title}` : ''}\n\n\`\`\`bash\n${truncate(match, 4000)}\n\`\`\`\n\nApproving lets the agent run exactly this command once (within 24h).`,
        payload: { tool_name: 'Bash', match, category: kind, reason },
      },
      `agent:${agent.id}`,
    );
    return {
      behavior: 'deny',
      message: `AgentOS permission gate: this command ${reason}, so it needs the project owner's approval. Approval #${approval.number} has been requested for you. Do not retry it or work around it. Continue with other work or end your turn; you will be woken when the owner decides.`,
    };
  }

  return allow();
}

function isInside(file: string, dir: string): boolean {
  const rel = path.relative(path.resolve(dir), path.resolve(file));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Heuristic: the command mentions a sibling worktree path (…/worktrees/<project>/<other-agent>). */
function referencesOtherWorktree(cmd: string, workspace: string): boolean {
  const parent = path.dirname(workspace);
  if (!cmd.includes(parent)) return /\.\.\/[a-z0-9-]+\/?/.test(cmd) && /\bcd\s+\.\.\/[a-z0-9-]+/.test(cmd);
  const idx = cmd.indexOf(parent);
  const after = cmd.slice(idx + parent.length + 1).split(/[\s/;'"]/)[0];
  return !!after && after !== path.basename(workspace);
}
