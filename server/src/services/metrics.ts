import type { Core } from '../core/core.js';

/**
 * Operational metrics for the dashboard: every run that overlaps the window (for the run lanes
 * and concurrency), the same totals for the previous window of equal length (for deltas),
 * merges per hour, and the review queue. Raw rows go to the client, which buckets them; the
 * window is capped so the payload stays small.
 */
export interface MetricsRun {
  id: string;
  project_id: string;
  agent_id: string | null;
  kind: string;
  status: string;
  trigger: string;
  error_kind: string | null;
  task_key: string | null;
  queued_at: string;
  started_at: string | null;
  finished_at: string | null;
  tool_calls: number;
}

export interface Metrics {
  now: string;
  from: string;
  hours: number;
  concurrencyLimit: number;
  agents: { id: string; project_id: string; name: string; role: string; is_pm: boolean; status: string; account: string | null }[];
  runs: MetricsRun[];
  previous: { runs: number; succeeded: number; failed: number; busySec: number; merged: number };
  /** Tasks completed in the window (merged, or done without a merge). */
  merges: { at: string; project_id: string; task_key: string | null }[];
  reviewQueue: { key: string; title: string; project_id: string; since: string }[];
}

const MAX_HOURS = 24 * 7;

export function buildMetrics(core: Core, opts: { projectId?: string | null; hours?: number }): Metrics {
  const hours = Math.min(MAX_HOURS, Math.max(1, Math.round(opts.hours ?? 24)));
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const from = new Date(nowMs - hours * 3600_000).toISOString();
  const prevFrom = new Date(nowMs - 2 * hours * 3600_000).toISOString();
  const pid = opts.projectId ?? null;
  const projectFilter = pid ? 'AND r.project_id = ?' : '';
  const pArgs = pid ? [pid] : [];

  const projects = pid ? [core.projects.get(pid)] : core.projects.list();
  const concurrencyLimit = projects.reduce((n, p) => n + (p.autonomy === 'paused' ? 0 : p.limits.maxConcurrentRuns), 0);

  const agents = (pid ? core.agents.list(pid) : core.agents.list())
    .filter((a) => a.enabled)
    .map((a) => ({ id: a.id, project_id: a.project_id, name: a.name, role: a.role, is_pm: a.is_pm, status: a.status, account: core.accounts.find(a.account_id)?.name ?? null }));

  const runs = core.db.all<MetricsRun>(
    `SELECT r.id, r.project_id, r.agent_id, r.kind, r.status, r.trigger, r.error_kind, t.key AS task_key,
            r.queued_at, r.started_at, r.finished_at,
            (SELECT COUNT(*) FROM run_events e WHERE e.run_id = r.id AND e.type = 'tool_use') AS tool_calls
       FROM runs r LEFT JOIN tasks t ON t.id = r.focus_task_id
      WHERE (r.finished_at IS NULL OR r.finished_at >= ?) AND r.queued_at <= ? ${projectFilter}
      ORDER BY r.queued_at
      LIMIT 3000`,
    from,
    now,
    ...pArgs,
  );

  const prev = core.db.get<{ runs: number; succeeded: number; failed: number; busy: number | null }>(
    `SELECT COUNT(*) AS runs,
            SUM(r.status = 'succeeded') AS succeeded,
            SUM(r.status = 'failed') AS failed,
            SUM((julianday(r.finished_at) - julianday(MAX(COALESCE(r.started_at, r.queued_at), ?))) * 86400) AS busy
       FROM runs r
      WHERE r.kind = 'agent' AND r.finished_at >= ? AND r.finished_at < ? ${projectFilter}`,
    prevFrom,
    prevFrom,
    from,
    ...pArgs,
  )!;

  // Completed tasks (merged, or done without a merge) by completion time.
  const merges = core.db
    .all<{ at: string; project_id: string; task_key: string | null }>(
      `SELECT completed_at AS at, project_id, key AS task_key FROM tasks WHERE status = 'done' AND completed_at >= ? ${pid ? 'AND project_id = ?' : ''} ORDER BY completed_at`,
      prevFrom,
      ...pArgs,
    );

  const reviewQueue = core.db.all<{ key: string; title: string; project_id: string; since: string }>(
    `SELECT key, title, project_id, updated_at AS since FROM tasks WHERE status = 'in_review' ${pid ? 'AND project_id = ?' : ''} ORDER BY updated_at`,
    ...pArgs,
  );

  return {
    now,
    from,
    hours,
    concurrencyLimit,
    agents,
    runs: runs.map((r) => ({ ...r, tool_calls: Number(r.tool_calls) })),
    previous: {
      runs: Number(prev.runs ?? 0),
      succeeded: Number(prev.succeeded ?? 0),
      failed: Number(prev.failed ?? 0),
      busySec: Math.max(0, Math.round(Number(prev.busy ?? 0))),
      merged: merges.filter((m) => m.at < from).length,
    },
    merges: merges.filter((m) => m.at >= from),
    reviewQueue,
  };
}
