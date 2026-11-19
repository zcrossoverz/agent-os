import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { get } from './api';

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
  merges: { at: string; project_id: string; task_key: string | null }[];
  reviewQueue: { key: string; title: string; project_id: string; since: string }[];
}

export const WINDOWS = [
  { hours: 6, label: '6h' },
  { hours: 24, label: '24h' },
  { hours: 72, label: '3d' },
  { hours: 168, label: '7d' },
] as const;

export function useMetrics(projectId: string | null, hours: number) {
  return useQuery({
    queryKey: ['metrics', projectId ?? 'all', hours],
    queryFn: () => get<Metrics>(`/api/metrics?${new URLSearchParams({ hours: String(hours), ...(projectId ? { project: projectId } : {}) })}`),
    refetchInterval: 60_000,
    placeholderData: (prev) => prev,
  });
}

/** The server's "now", kept moving between fetches so running bars grow and the now-line advances. */
export function useServerNow(metrics: Metrics | undefined, everyMs = 15_000): number {
  const offset = useRef(0);
  useEffect(() => {
    if (metrics) offset.current = Date.parse(metrics.now) - Date.now();
  }, [metrics]);
  const [, tick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), everyMs);
    return () => window.clearInterval(id);
  }, [everyMs]);
  return Date.now() + offset.current;
}

export interface Span {
  run: MetricsRun;
  start: number;
  end: number;
  open: boolean;
}

/** A run as a time span: from its start (or queue time) to its end, or to now while it runs. */
export function spanOf(run: MetricsRun, now: number): Span {
  const start = Date.parse(run.started_at ?? run.queued_at);
  const open = !run.finished_at;
  const end = open ? now : Date.parse(run.finished_at!);
  return { run, start, end: Math.max(end, start), open };
}

export function useOps(metrics: Metrics | undefined, now: number) {
  return useMemo(() => {
    if (!metrics) return null;
    const to = now;
    const from = to - metrics.hours * 3600_000;
    const spans = metrics.runs.map((r) => spanOf(r, now));
    const agentSpans = spans.filter((s) => s.run.kind === 'agent');
    const clip = (s: Span) => Math.max(0, Math.min(s.end, to) - Math.max(s.start, from));

    const finished = agentSpans.filter((s) => !s.open && s.end >= from);
    const succeeded = finished.filter((s) => s.run.status === 'succeeded').length;
    const failed = finished.filter((s) => s.run.status === 'failed').length;
    const busyMs = agentSpans.reduce((n, s) => n + clip(s), 0);
    const runsInWindow = agentSpans.filter((s) => s.end >= from).length;
    const running = agentSpans.filter((s) => s.open && s.run.status === 'running').length;

    // Even buckets across the window, for sparklines and the completions chart.
    const n = 24;
    const step = (to - from) / n;
    const bucketOf = (t: number) => Math.min(n - 1, Math.max(0, Math.floor((t - from) / step)));
    const startedPer = new Array(n).fill(0);
    const busyPer = new Array(n).fill(0);
    const okPer = new Array(n).fill(0);
    const donePer = new Array(n).fill(0);
    for (const s of agentSpans) {
      if (s.start >= from) startedPer[bucketOf(s.start)]++;
      if (!s.open && s.end >= from && s.run.status === 'succeeded') okPer[bucketOf(s.end)]++;
      for (let i = 0; i < n; i++) {
        const b0 = from + i * step;
        busyPer[i] += Math.max(0, Math.min(s.end, b0 + step) - Math.max(s.start, b0)) / 3600_000;
      }
    }
    for (const m of metrics.merges) donePer[bucketOf(Date.parse(m.at))]++;

    // Concurrency as a step series: +1 at each start, -1 at each end.
    const edges: [number, number][] = [];
    for (const s of agentSpans) {
      if (s.run.status === 'queued') continue;
      if (s.end < from) continue;
      edges.push([Math.max(s.start, from), 1], [s.end, -1]);
    }
    edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const concurrency: { t: number; v: number }[] = [{ t: from, v: 0 }];
    let level = 0;
    let peak = 0;
    for (const [t, d] of edges) {
      level += d;
      peak = Math.max(peak, level);
      concurrency.push({ t, v: level });
    }
    concurrency.push({ t: to, v: level });

    const oldestReview = metrics.reviewQueue[0] ? to - Date.parse(metrics.reviewQueue[0].since) : null;
    return {
      from,
      to,
      spans,
      runsInWindow,
      running,
      succeeded,
      failed,
      successRate: succeeded + failed ? succeeded / (succeeded + failed) : null,
      busyHours: busyMs / 3600_000,
      completed: metrics.merges.length,
      oldestReview,
      buckets: { n, step, startedPer, busyPer, okPer, donePer },
      concurrency,
      peak,
    };
  }, [metrics, now]);
}

export type Ops = NonNullable<ReturnType<typeof useOps>>;

/** Element width, kept current with a ResizeObserver. */
export function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width)));
    ro.observe(el);
    setW(Math.floor(el.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

export function fmtClock(t: number, withDay = false): string {
  const d = new Date(t);
  const hm = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
  return withDay ? `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${hm}` : hm;
}
