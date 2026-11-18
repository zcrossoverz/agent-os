import type { RunAssignment, RunCompletion, RunnerEvent } from '../../core/types.js';

export interface DriverContext {
  assignment: RunAssignment;
  /** Absolute path of the agent's worktree (cwd for the agent). */
  workspace: string;
  /** Environment for the agent process (already passed through the billing guard). */
  env: NodeJS.ProcessEnv;
  /** Wake prompt; `recovery` is prepended when a fresh provider session is started. */
  prompt: string;
  recovery: string;
  emit: (type: RunnerEvent['type'], data: Record<string, unknown>) => void;
  signal: AbortSignal;
  timeoutSec: number;
}

/**
 * A provider driver executes one agent run with a specific coding-agent CLI and normalizes its
 * output. Adding Codex CLI or Gemini CLI means adding a driver; the control plane does not change.
 */
export interface AgentDriver {
  readonly provider: string;
  run(ctx: DriverContext): Promise<RunCompletion>;
}
