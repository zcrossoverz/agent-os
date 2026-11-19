import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import { WINDOWS, fmtClock, fmtDuration, useMetrics, useOps, useServerNow, useWidth, type Metrics, type Ops, type Span } from '../lib/metrics';
import { AgentStatus } from './ui';

/* ------------------------------------------------------------------ window */

export function WindowToggle({ hours, onChange }: { hours: number; onChange: (h: number) => void }) {
  return (
    <div className="flex rounded-md border border-zinc-200 p-0.5 dark:border-white/[0.08]" role="radiogroup" aria-label="Time window">
      {WINDOWS.map((w) => (
        <button
          key={w.hours}
          role="radio"
          aria-checked={hours === w.hours}
          onClick={() => onChange(w.hours)}
          className={clsx(
            'num rounded-[5px] px-2 py-0.5 text-[11px] transition',
            hours === w.hours ? 'bg-zinc-900 text-white dark:bg-white/[0.12] dark:text-white' : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-200',
          )}
        >
          {w.label}
        </button>
      ))}
    </div>
  );
}

/* --------------------------------------------------------------- sparkline */

export function Sparkline({ values, width = 96, height = 26, label }: { values: number[]; width?: number; height?: number; label: string }) {
  const max = Math.max(...values, 0);
  if (!values.length) return null;
  const dx = width / Math.max(1, values.length - 1);
  const y = (v: number) => height - 2 - (max ? (v / max) * (height - 4) : 0);
  const pts = values.map((v, i) => `${(i * dx).toFixed(1)},${y(v).toFixed(1)}`);
  const last = values.length - 1;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label} className="overflow-visible">
      <path d={`M0,${height} L${pts.join(' L')} L${width},${height} Z`} fill="var(--viz-series)" opacity={0.1} />
      <polyline points={pts.join(' ')} fill="none" stroke="var(--viz-series)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={last * dx} cy={y(values[last])} r={3} fill="var(--viz-series)" stroke="var(--viz-surface)" strokeWidth={2} />
    </svg>
  );
}

/* ------------------------------------------------------------------- tiles */

export interface Delta {
  text: string;
  /** true = good, false = bad, null = neutral */
  good: boolean | null;
  dir: 'up' | 'down' | 'flat';
}

export function delta(cur: number, prev: number, opts: { upIsGood: boolean; unit?: string; digits?: number; period: string }): Delta {
  const d = cur - prev;
  const dir = Math.abs(d) < 1e-9 ? 'flat' : d > 0 ? 'up' : 'down';
  const n = Math.abs(d).toFixed(opts.digits ?? 0);
  return {
    text: dir === 'flat' ? `same as previous ${opts.period}` : `${d > 0 ? '+' : '−'}${n}${opts.unit ?? ''} vs previous ${opts.period}`,
    good: dir === 'flat' ? null : (d > 0) === opts.upIsGood,
    dir,
  };
}

export function KpiTile({ label, value, unit, sub, d, spark, sparkLabel, tone }: { label: string; value: ReactNode; unit?: string; sub?: ReactNode; d?: Delta; spark?: number[]; sparkLabel?: string; tone?: 'warn' | 'bad' }) {
  const Icon = d?.dir === 'up' ? ArrowUpRight : d?.dir === 'down' ? ArrowDownRight : Minus;
  return (
    <div className="flex min-w-0 flex-col gap-1.5 px-4 py-3">
      <div className="flex items-center gap-1.5 text-[12px] text-zinc-500 dark:text-zinc-400">
        {tone && <span className={clsx('size-1.5 rounded-full', tone === 'bad' ? 'bg-[var(--viz-fail)]' : 'bg-[var(--viz-warn)]')} aria-hidden />}
        {label}
      </div>
      <div className="flex items-end justify-between gap-2">
        <div className="shrink-0 text-[26px] leading-none font-semibold tracking-tight whitespace-nowrap text-zinc-900 dark:text-zinc-50">
          {value}
          {unit && <span className="ml-0.5 text-[14px] font-medium text-zinc-500">{unit}</span>}
        </div>
        {spark && (
          <div className="flex min-w-0 justify-end overflow-hidden">
            <Sparkline values={spark} width={72} label={sparkLabel ?? `${label} trend`} />
          </div>
        )}
      </div>
      <div className="flex min-h-4 items-center gap-1 text-[11px] text-zinc-500">
        {d ? (
          <>
            <Icon className={clsx('size-3 shrink-0', d.good === true ? 'text-emerald-600 dark:text-emerald-500' : d.good === false ? 'text-red-600 dark:text-red-400' : 'text-zinc-400')} aria-hidden />
            <span className="truncate">{d.text}</span>
          </>
        ) : (
          sub
        )}
      </div>
    </div>
  );
}

/** A row of KPI tiles sharing one card, separated by hairlines. */
export function KpiStrip({ children }: { children: ReactNode }) {
  return <div className="card grid grid-cols-2 divide-zinc-200 overflow-hidden sm:grid-cols-3 xl:grid-cols-6 dark:divide-white/[0.07] [&>*]:border-zinc-200 [&>*]:dark:border-white/[0.07] [&>*:not(:last-child)]:border-b sm:[&>*]:border-r xl:[&>*]:border-b-0">{children}</div>;
}

/* --------------------------------------------------------------- run lanes */

const LANE_H = 26;
const AXIS_H = 22;
const CONC_H = 44;
const GAP = 6;

function tickStepHours(hours: number) {
  return hours <= 6 ? 1 : hours <= 24 ? 3 : hours <= 72 ? 12 : 24;
}

function ticks(from: number, to: number, hours: number) {
  const stepH = tickStepHours(hours);
  const out: number[] = [];
  const d = new Date(from);
  d.setMinutes(0, 0, 0);
  let t = d.getTime();
  while (t <= to) {
    if (t >= from && new Date(t).getHours() % stepH === 0) out.push(t);
    t += 3600_000;
  }
  return out;
}

const STATUS_FILL: Record<string, string> = {
  running: 'var(--viz-running)',
  succeeded: 'var(--viz-ok)',
  failed: 'var(--viz-fail)',
};

export const RUN_STATUS_LABEL: Record<string, string> = { running: 'Running', succeeded: 'Succeeded', failed: 'Failed', cancelled: 'Cancelled', queued: 'Queued' };

export function LanesLegend() {
  const item = (swatch: ReactNode, label: string) => (
    <span className="flex items-center gap-1.5">
      {swatch}
      {label}
    </span>
  );
  const bar = (fill: string, outline = false) => <span className="inline-block h-2 w-3 rounded-[2px]" style={outline ? { boxShadow: `inset 0 0 0 1px ${fill}` } : { background: fill }} />;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-500">
      {item(bar('var(--viz-running)'), 'Running')}
      {item(bar('var(--viz-ok)'), 'Succeeded')}
      {item(bar('var(--viz-fail)'), 'Failed')}
      {item(bar('var(--viz-muted)', true), 'Cancelled')}
      {item(<span className="inline-block size-2 rounded-full bg-[var(--viz-good)]" />, 'Merge')}
    </div>
  );
}

interface Hover {
  x: number;
  y: number;
  span?: Span;
  conc?: { t: number; v: number };
  pinned?: boolean;
}

export function RunLanes({ m, ops, slugOf, nameOf }: { m: Metrics; ops: Ops; slugOf: (projectId: string) => string | undefined; nameOf?: (projectId: string) => string | undefined }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const nav = useNavigate();
  const [hover, setHover] = useState<Hover | null>(null);
  const mergeSpans = ops.spans.filter((s) => s.run.kind === 'merge' && s.end >= ops.from);
  const lanes = useMemo(() => {
    const byAgent = new Map<string, Span[]>();
    for (const s of ops.spans) if (s.run.kind === 'agent' && s.run.agent_id && s.end >= ops.from) byAgent.set(s.run.agent_id, [...(byAgent.get(s.run.agent_id) ?? []), s]);
    return m.agents.map((a) => ({ agent: a, spans: byAgent.get(a.id) ?? [] }));
  }, [m.agents, ops.spans, ops.from]);
  const rows = lanes.length + (mergeSpans.length ? 1 : 0);
  const plotW = Math.max(0, width);
  const H = AXIS_H + CONC_H + GAP + rows * LANE_H + 4;
  const span = ops.to - ops.from;
  const x = (t: number) => ((Math.min(Math.max(t, ops.from), ops.to) - ops.from) / span) * plotW;
  const tAt = (px: number) => ops.from + (px / plotW) * span;
  const tks = ticks(ops.from, ops.to, m.hours);
  const withDay = m.hours > 24;
  // Thin the labels (not the gridlines) so they never collide on a narrow plot.
  const labelPx = withDay ? 74 : 40;
  const tickGap = tks.length > 1 ? x(tks[1]) - x(tks[0]) : plotW;
  const labelEvery = Math.max(1, Math.ceil(labelPx / Math.max(1, tickGap)));
  const maxV = Math.max(m.concurrencyLimit, ops.peak, 1);
  const cy = (v: number) => AXIS_H + CONC_H - 3 - (v / maxV) * (CONC_H - 8);
  const laneTop = (i: number) => AXIS_H + CONC_H + GAP + i * LANE_H;

  const concPath = useMemo(() => {
    if (!plotW) return { line: '', area: '' };
    let d = '';
    let prevY = cy(0);
    ops.concurrency.forEach((p, i) => {
      const px = x(p.t).toFixed(1);
      const py = cy(p.v).toFixed(1);
      d += i === 0 ? `M${px},${py}` : ` H${px} V${py}`;
      prevY = cy(p.v);
    });
    void prevY;
    return { line: d, area: `${d} V${cy(0).toFixed(1)} H0 Z` };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ops.concurrency, plotW, maxV]);

  const pick = (px: number, py: number): Hover | null => {
    if (py >= AXIS_H && py < AXIS_H + CONC_H) {
      const t = tAt(px);
      let v = 0;
      for (const p of ops.concurrency) if (p.t <= t) v = p.v;
      return { x: px, y: py, conc: { t, v } };
    }
    const i = Math.floor((py - AXIS_H - CONC_H - GAP) / LANE_H);
    if (i < 0 || i >= rows) return null;
    const list = i < lanes.length ? lanes[i].spans : mergeSpans;
    const tol = (8 / plotW) * span;
    const t = tAt(px);
    let best: Span | undefined;
    let bestD = Infinity;
    for (const s of list) {
      const d = t < s.start ? s.start - t : t > s.end ? t - s.end : 0;
      if (d <= tol && d < bestD) {
        best = s;
        bestD = d;
      }
    }
    return best ? { x: px, y: laneTop(i) + LANE_H / 2, span: best } : null;
  };

  const local = (e: React.PointerEvent | React.MouseEvent) => {
    const r = (e.currentTarget as SVGElement).getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top] as const;
  };

  const open = (s: Span) => {
    const slug = slugOf(s.run.project_id);
    if (slug) nav(`/p/${slug}/runs/${s.run.id}`);
  };

  return (
    <div className="flex">
      {/* Lane labels (HTML, so names truncate cleanly) */}
      <div className="w-[88px] shrink-0 border-r border-zinc-200 sm:w-[168px] dark:border-white/[0.07]">
        <div style={{ height: AXIS_H }} />
        <div style={{ height: CONC_H }} className="flex flex-col justify-center px-3">
          <div className="text-[11px] text-zinc-500">Concurrent</div>
          <div className="num text-[13px] text-zinc-900 dark:text-zinc-100">
            {ops.running}
            <span className="text-zinc-500">/{m.concurrencyLimit}</span>
          </div>
        </div>
        <div style={{ height: GAP }} />
        {lanes.map(({ agent }) => (
          <div key={agent.id} style={{ height: LANE_H }} className="flex min-w-0 items-center gap-1.5 px-3" title={`${agent.name} · ${agent.role}${agent.account ? ` · ${agent.account}` : ''}`}>
            <AgentStatus status={agent.status} compact />
            <span className="max-w-full shrink-0 truncate text-[12px] text-zinc-800 dark:text-zinc-200">{agent.name}</span>
            <span className="hidden min-w-0 truncate text-[11px] text-zinc-500 sm:inline">{agent.role}</span>
          </div>
        ))}
        {mergeSpans.length > 0 && (
          <div style={{ height: LANE_H }} className="flex items-center px-3 text-[12px] text-zinc-500">
            Merges
          </div>
        )}
      </div>

      {/* Plot */}
      <div ref={ref} className="relative min-w-0 flex-1">
        {plotW > 0 && (
          <svg
            width={plotW}
            height={H}
            className="block touch-pan-y select-none"
            role="img"
            aria-label={`Run timeline for the last ${m.hours} hours: ${ops.runsInWindow} runs, ${ops.failed} failed, ${ops.running} running now.`}
            onPointerMove={(e) => {
              if (hover?.pinned || e.pointerType !== 'mouse') return;
              const [px, py] = local(e);
              setHover(pick(px, py));
            }}
            onPointerLeave={(e) => e.pointerType === 'mouse' && !hover?.pinned && setHover(null)}
            onClick={(e) => {
              const [px, py] = local(e);
              const h = pick(px, py);
              const mouse = (e.nativeEvent as PointerEvent).pointerType === 'mouse' || !('pointerType' in e.nativeEvent);
              if (mouse && h?.span) return open(h.span);
              setHover(h ? { ...h, pinned: true } : null);
            }}
            style={{ cursor: hover?.span ? 'pointer' : 'default' }}
          >
            {/* time grid + axis */}
            {tks.map((t, i) => (
              <g key={t}>
                <line x1={x(t)} x2={x(t)} y1={AXIS_H - 4} y2={H} stroke="var(--viz-grid)" strokeWidth={1} />
                {i % labelEvery === 0 && x(t) + labelPx < plotW && (
                  <text x={x(t) + 4} y={13} className="num" fontSize={10} fill="var(--viz-muted)">
                    {fmtClock(t, withDay)}
                  </text>
                )}
              </g>
            ))}
            <line x1={0} x2={plotW} y1={AXIS_H + CONC_H - 0.5} y2={AXIS_H + CONC_H - 0.5} stroke="var(--viz-axis)" strokeWidth={1} />

            {/* concurrency vs limit */}
            <path d={concPath.area} fill="var(--viz-series)" opacity={0.1} />
            <path d={concPath.line} fill="none" stroke="var(--viz-series)" strokeWidth={2} strokeLinejoin="round" />
            {m.concurrencyLimit > 0 && (
              <g>
                <line x1={0} x2={plotW} y1={cy(m.concurrencyLimit)} y2={cy(m.concurrencyLimit)} stroke="var(--viz-muted)" strokeWidth={1} opacity={0.7} />
                <text x={plotW - 4} y={cy(m.concurrencyLimit) - 3} textAnchor="end" className="num" fontSize={10} fill="var(--viz-muted)">
                  limit {m.concurrencyLimit}
                </text>
              </g>
            )}

            {/* lanes */}
            {Array.from({ length: rows }, (_, i) => (
              <line key={i} x1={0} x2={plotW} y1={laneTop(i) + LANE_H - 0.5} y2={laneTop(i) + LANE_H - 0.5} stroke="var(--viz-grid)" strokeWidth={1} />
            ))}
            {lanes.map(({ spans }, i) =>
              spans.map((s) => {
                const x0 = x(s.start);
                const w = Math.max(3, x(s.end) - x0);
                const y0 = laneTop(i) + (LANE_H - 10) / 2;
                const outline = s.run.status === 'cancelled' || s.run.status === 'queued';
                const color = outline ? (s.run.status === 'queued' ? 'var(--viz-running)' : 'var(--viz-muted)') : (STATUS_FILL[s.run.status] ?? 'var(--viz-ok)');
                const hot = hover?.span?.run.id === s.run.id;
                return (
                  <g key={s.run.id}>
                    <rect x={x0} y={y0} width={w} height={10} rx={3} fill={outline ? 'transparent' : color} stroke={outline ? color : 'none'} strokeWidth={outline ? 1 : 0} opacity={hover?.span && !hot ? 0.55 : 1} />
                    {s.open && s.run.status === 'running' && <circle className="lane-pulse" cx={x0 + w} cy={y0 + 5} r={4} fill="var(--viz-running)" stroke="var(--viz-surface)" strokeWidth={2} />}
                    {hot && <rect x={x0 - 2} y={y0 - 2} width={w + 4} height={14} rx={4} fill="none" stroke="var(--viz-ink)" strokeWidth={1} />}
                  </g>
                );
              }),
            )}
            {mergeSpans.map((s) => (
              <circle key={s.run.id} cx={x(s.end)} cy={laneTop(lanes.length) + LANE_H / 2} r={4} fill={s.run.status === 'failed' ? 'var(--viz-fail)' : 'var(--viz-good)'} stroke="var(--viz-surface)" strokeWidth={2} />
            ))}

            {/* now */}
            <line x1={plotW - 0.5} x2={plotW - 0.5} y1={AXIS_H - 4} y2={H} stroke="var(--viz-now)" strokeWidth={1} />

            {/* crosshair on the concurrency strip */}
            {hover?.conc && <line x1={hover.x} x2={hover.x} y1={AXIS_H} y2={AXIS_H + CONC_H} stroke="var(--viz-ink-2)" strokeWidth={1} />}
          </svg>
        )}
        {hover && (hover.span || hover.conc) && (
          <LaneTooltip hover={hover} plotW={plotW} nameOf={nameOf} slugOf={slugOf} agentName={(id) => m.agents.find((a) => a.id === id)?.name} onClose={() => setHover(null)} />
        )}
      </div>
    </div>
  );
}

function LaneTooltip({ hover, plotW, agentName, nameOf, slugOf, onClose }: { hover: Hover; plotW: number; agentName: (id: string) => string | undefined; nameOf?: (id: string) => string | undefined; slugOf: (id: string) => string | undefined; onClose: () => void }) {
  const W = 232;
  const left = Math.min(Math.max(0, hover.x - W / 2), Math.max(0, plotW - W));
  const top = hover.y + 14;
  const row = (k: string, v: ReactNode) => (
    <div className="flex justify-between gap-3">
      <span className="text-zinc-500">{k}</span>
      <span className="num truncate text-right text-zinc-900 dark:text-zinc-100">{v}</span>
    </div>
  );
  return (
    <div
      className={clsx('absolute z-10 rounded-md border border-zinc-200 bg-white p-2.5 text-[11px] shadow-lg dark:border-white/[0.1] dark:bg-ink-850', hover.pinned ? 'pointer-events-auto' : 'pointer-events-none')}
      style={{ left, top, width: W }}
      role="tooltip"
    >
      {hover.conc ? (
        <>
          {row('Time', fmtClock(hover.conc.t, true))}
          {row('Running', hover.conc.v)}
        </>
      ) : (
        hover.span && (
          <>
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <span className="truncate text-[12px] font-semibold text-zinc-900 dark:text-zinc-100">{hover.span.run.kind === 'merge' ? 'Merge' : (agentName(hover.span.run.agent_id ?? '') ?? 'Agent')}</span>
              <span className="flex items-center gap-1 text-zinc-600 dark:text-zinc-300">
                <span className="inline-block size-2 rounded-full" style={{ background: hover.span.run.status === 'cancelled' ? 'var(--viz-muted)' : (STATUS_FILL[hover.span.run.status] ?? 'var(--viz-ok)') }} />
                {RUN_STATUS_LABEL[hover.span.run.status] ?? hover.span.run.status}
              </span>
            </div>
            {nameOf && row('Project', nameOf(hover.span.run.project_id))}
            {hover.span.run.task_key && row('Task', hover.span.run.task_key)}
            {row('Started', fmtClock(hover.span.start, true))}
            {row('Duration', `${fmtDuration(hover.span.end - hover.span.start)}${hover.span.open ? ' so far' : ''}`)}
            {row('Tool calls', hover.span.run.tool_calls)}
            {row('Woken by', hover.span.run.trigger)}
            {hover.span.run.error_kind && row('Error', hover.span.run.error_kind)}
            {hover.pinned ? (
              <div className="mt-2 flex justify-between">
                <button className="text-zinc-500" onClick={onClose}>
                  Close
                </button>
                {slugOf(hover.span.run.project_id) && (
                  <Link className="font-medium text-accent-600 dark:text-accent-400" to={`/p/${slugOf(hover.span.run.project_id)}/runs/${hover.span.run.id}`}>
                    Open run →
                  </Link>
                )}
              </div>
            ) : (
              <div className="mt-1.5 text-zinc-500">Click to open the run</div>
            )}
          </>
        )
      )}
    </div>
  );
}

/* ------------------------------------------------------- completions chart */

function niceMax(v: number) {
  if (v <= 4) return Math.max(1, v);
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

export function CompletionsChart({ ops, hours }: { ops: Ops; hours: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hot, setHot] = useState<number | null>(null);
  const vals = ops.buckets.donePer;
  const H = 150;
  const padL = 28;
  const padB = 20;
  const padT = 14;
  const plotW = Math.max(0, width - padL - 4);
  const plotH = H - padB - padT;
  const max = niceMax(Math.max(...vals, 0));
  const slot = plotW / vals.length;
  const bw = Math.min(24, Math.max(2, slot - 2));
  const y = (v: number) => padT + plotH - (v / max) * plotH;
  const top = vals.indexOf(Math.max(...vals));
  const yTicks = max <= 4 ? Array.from({ length: max + 1 }, (_, i) => i) : [0, max / 2, max];
  const bucketStart = (i: number) => ops.from + i * ops.buckets.step;
  const labelEvery = Math.ceil(vals.length / Math.max(1, Math.floor(plotW / 56)));
  return (
    <div ref={ref} className="relative">
      {width > 0 && (
        <svg width={width} height={H} role="img" aria-label={`Tasks completed per ${fmtDuration(ops.buckets.step)}: ${ops.completed} in the last ${hours} hours`} onPointerLeave={() => setHot(null)}>
          {yTicks.map((t) => (
            <g key={t}>
              <line x1={padL} x2={width - 4} y1={y(t)} y2={y(t)} stroke={t === 0 ? 'var(--viz-axis)' : 'var(--viz-grid)'} strokeWidth={1} />
              <text x={padL - 6} y={y(t) + 3} textAnchor="end" className="num" fontSize={10} fill="var(--viz-muted)">
                {Number.isInteger(t) ? t : t.toFixed(1)}
              </text>
            </g>
          ))}
          {vals.map((v, i) => {
            const cx = padL + i * slot + slot / 2;
            const h = Math.max(0, y(0) - y(v));
            return (
              <g key={i} onPointerEnter={() => setHot(i)}>
                <rect x={padL + i * slot} y={padT} width={slot} height={plotH} fill="transparent" />
                {v > 0 && <path d={`M${cx - bw / 2},${y(0)} V${y(v) + Math.min(4, h)} q0,-${Math.min(4, h)} ${Math.min(4, bw / 2)},-${Math.min(4, h)} H${cx + bw / 2 - Math.min(4, bw / 2)} q${Math.min(4, bw / 2)},0 ${Math.min(4, bw / 2)},${Math.min(4, h)} V${y(0)} Z`} fill="var(--viz-series)" opacity={hot === null || hot === i ? 1 : 0.5} />}
                {i % labelEvery === 0 && (
                  <text x={cx} y={H - 5} textAnchor="middle" className="num" fontSize={10} fill="var(--viz-muted)">
                    {fmtClock(bucketStart(i), hours > 24)}
                  </text>
                )}
              </g>
            );
          })}
          {vals[top] > 0 && hot === null && (
            <text x={padL + top * slot + slot / 2} y={y(vals[top]) - 4} textAnchor="middle" className="num" fontSize={10} fill="var(--viz-ink-2)">
              {vals[top]}
            </text>
          )}
        </svg>
      )}
      {hot !== null && (
        <div className="pointer-events-none absolute top-0 rounded-md border border-zinc-200 bg-white px-2 py-1 text-[11px] shadow-md dark:border-white/[0.1] dark:bg-ink-850" style={{ left: Math.min(Math.max(0, padL + hot * slot + slot / 2 - 70), Math.max(0, width - 140)), width: 140 }}>
          <div className="num text-zinc-500">
            {fmtClock(bucketStart(hot), true)}–{fmtClock(bucketStart(hot + 1))}
          </div>
          <div className="num text-zinc-900 dark:text-zinc-100">{vals[hot]} completed</div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ agent blotter */

export function AgentBlotter({ m, ops, slugOf }: { m: Metrics; ops: Ops; slugOf: (projectId: string) => string | undefined }) {
  const win = ops.to - ops.from;
  const rows = m.agents.map((a) => {
    const spans = ops.spans.filter((s) => s.run.kind === 'agent' && s.run.agent_id === a.id && s.end >= ops.from);
    const done = spans.filter((s) => !s.open);
    const ok = done.filter((s) => s.run.status === 'succeeded').length;
    const failed = done.filter((s) => s.run.status === 'failed').length;
    const busy = spans.reduce((n, s) => n + Math.max(0, Math.min(s.end, ops.to) - Math.max(s.start, ops.from)), 0);
    const avg = done.length ? done.reduce((n, s) => n + (s.end - s.start), 0) / done.length : null;
    const last = spans.length ? Math.max(...spans.map((s) => s.start)) : null;
    return { a, runs: spans.length, ok, failed, rate: ok + failed ? ok / (ok + failed) : null, busy, util: busy / win, avg, tools: spans.reduce((n, s) => n + s.run.tool_calls, 0), last };
  });
  const th = 'px-3 py-2 text-left text-[11px] font-medium text-zinc-500 whitespace-nowrap';
  const td = 'px-3 py-2 whitespace-nowrap';
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] text-[12px]">
        <thead className="border-b border-zinc-200 dark:border-white/[0.07]">
          <tr>
            <th className={th}>Agent</th>
            <th className={th}>Account</th>
            <th className={clsx(th, 'text-right')}>Runs</th>
            <th className={clsx(th, 'text-right')}>OK</th>
            <th className={th}>Busy</th>
            <th className={clsx(th, 'text-right')}>Avg run</th>
            <th className={clsx(th, 'text-right')}>Tools</th>
            <th className={clsx(th, 'text-right')}>Last start</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100 dark:divide-white/[0.05]">
          {rows.map((r) => {
            const slug = slugOf(r.a.project_id);
            return (
              <tr key={r.a.id} className="hover:bg-zinc-50 dark:hover:bg-white/[0.02]">
                <td className={td}>
                  <Link to={slug ? `/p/${slug}/runs?agent=${r.a.id}` : '#'} className="flex items-center gap-2 hover:underline">
                    <AgentStatus status={r.a.status} compact />
                    <span className="font-medium text-zinc-900 dark:text-zinc-100" title={r.a.role}>{r.a.name}</span>
                  </Link>
                </td>
                <td className={clsx(td, 'text-zinc-500')}>{r.a.account ?? '—'}</td>
                <td className={clsx(td, 'num text-right')}>{r.runs}</td>
                <td className={clsx(td, 'num text-right')}>
                  {r.rate === null ? <span className="text-zinc-400">—</span> : `${Math.round(r.rate * 100)}%`}
                  {r.failed > 0 && <span className="ml-1.5 text-red-600 dark:text-red-400">{r.failed} failed</span>}
                </td>
                <td className={td}>
                  <div className="flex items-center gap-2" title={`${fmtDuration(r.busy)} busy (${Math.round(r.util * 100)}% of the window)`}>
                    <div className="h-1.5 w-20 overflow-hidden rounded-full bg-[color-mix(in_oklab,var(--viz-series)_18%,transparent)]">
                      <div className="h-full rounded-full bg-[var(--viz-series)]" style={{ width: `${Math.min(100, r.util * 100)}%` }} />
                    </div>
                    <span className="num text-zinc-600 dark:text-zinc-300">{Math.round(r.util * 100)}%</span>
                  </div>
                </td>
                <td className={clsx(td, 'num text-right')}>{r.avg === null ? <span className="text-zinc-400">—</span> : fmtDuration(r.avg)}</td>
                <td className={clsx(td, 'num text-right')}>{r.tools}</td>
                <td className={clsx(td, 'num text-right text-zinc-500')}>{r.last ? fmtClock(r.last, ops.to - r.last > 20 * 3600_000) : '—'}</td>
              </tr>
            );
          })}
          {rows.length === 0 && (
            <tr>
              <td colSpan={8} className="px-3 py-6 text-center text-zinc-500">
                No agents yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/* --------------------------------------------------------- operations block */

export function KpisFor({ m, ops, label }: { m: Metrics; ops: Ops; label: string }) {
  const period = label;
  const rate = ops.successRate;
  const prevRate = m.previous.succeeded + m.previous.failed ? m.previous.succeeded / (m.previous.succeeded + m.previous.failed) : null;
  const review = ops.oldestReview;
  return (
    <KpiStrip>
      <KpiTile label="Running now" value={<span className="num">{ops.running}</span>} unit={`/${m.concurrencyLimit}`} sub={`peak ${ops.peak} in the last ${period}`} />
      <KpiTile label="Runs" value={<span className="num">{ops.runsInWindow}</span>} d={delta(ops.runsInWindow, m.previous.runs, { upIsGood: true, period })} spark={ops.buckets.startedPer} sparkLabel="Runs started per bucket" />
      <KpiTile
        label="Success rate"
        tone={rate !== null && rate < 0.8 ? 'bad' : undefined}
        value={<span className="num">{rate === null ? '—' : Math.round(rate * 100)}</span>}
        unit={rate === null ? undefined : '%'}
        d={rate !== null && prevRate !== null ? delta(rate * 100, prevRate * 100, { upIsGood: true, unit: ' pts', period }) : undefined}
        sub={`${ops.failed} failed of ${ops.succeeded + ops.failed}`}
      />
      <KpiTile label="Agent-hours" value={<span className="num">{ops.busyHours.toFixed(1)}</span>} unit="h" d={delta(ops.busyHours, m.previous.busySec / 3600, { upIsGood: true, unit: 'h', digits: 1, period })} spark={ops.buckets.busyPer} sparkLabel="Agent-hours per bucket" />
      <KpiTile label="Tasks completed" value={<span className="num">{ops.completed}</span>} d={delta(ops.completed, m.previous.merged, { upIsGood: true, period })} spark={ops.buckets.donePer} sparkLabel="Tasks completed per bucket" />
      <KpiTile
        label="Review queue"
        tone={review !== null && review > 30 * 60_000 ? 'warn' : undefined}
        value={<span className="num">{m.reviewQueue.length}</span>}
        sub={review === null ? 'nothing waiting' : `oldest waiting ${fmtDuration(review)}`}
      />
    </KpiStrip>
  );
}

function useStoredHours(key: string, initial: number): [number, (h: number) => void] {
  const [h, setH] = useState(() => {
    try {
      const v = Number(localStorage.getItem(key));
      return WINDOWS.some((w) => w.hours === v) ? v : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, String(h));
    } catch {
      /* private mode: the choice just isn't remembered */
    }
  }, [key, h]);
  return [h, setH];
}

/** KPIs, run lanes, completions and the agent table for one project, or for all of them. */
export function OperationsSection({ projectId, slugOf, nameOf, title = 'Operations' }: { projectId: string | null; slugOf: (projectId: string) => string | undefined; nameOf?: (projectId: string) => string | undefined; title?: string }) {
  const [hours, setHours] = useStoredHours('agentos.opsWindow', 24);
  const q = useMetrics(projectId, hours);
  const now = useServerNow(q.data);
  const ops = useOps(q.data, now);
  const label = WINDOWS.find((w) => w.hours === hours)?.label ?? `${hours}h`;
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[13px] font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
          {title} <span className="font-normal text-zinc-500">· last {label}</span>
        </h2>
        <WindowToggle hours={hours} onChange={setHours} />
      </div>
      {!q.data || !ops ? (
        <div className="card h-40 animate-pulse" aria-busy />
      ) : (
        <>
          <KpisFor m={q.data} ops={ops} label={label} />
          <div className="card overflow-hidden">
            <div className="panel-head">
              <span className="panel-title">Run lanes</span>
              <span className="hidden text-[11px] text-zinc-500 md:inline">Each bar is one agent session. Click a bar to open the run.</span>
              <div className="ml-auto">
                <LanesLegend />
              </div>
            </div>
            {q.data.agents.length ? (
              <RunLanes m={q.data} ops={ops} slugOf={slugOf} nameOf={nameOf} />
            ) : (
              <div className="px-4 py-8 text-center text-sm text-zinc-500">Add agents to a project to see their runs here.</div>
            )}
          </div>
          <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
            <div className="card overflow-hidden">
              <div className="panel-head">
                <span className="panel-title">Tasks completed</span>
                <span className="num ml-auto text-[11px] text-zinc-500">per {fmtDuration(ops.buckets.step)}</span>
              </div>
              <div className="px-2 pt-3 pb-1">
                <CompletionsChart ops={ops} hours={hours} />
              </div>
            </div>
            <div className="card overflow-hidden">
              <div className="panel-head">
                <span className="panel-title">Agents</span>
                <span className="text-[11px] text-zinc-500">in the last {label}</span>
              </div>
              <AgentBlotter m={q.data} ops={ops} slugOf={slugOf} />
            </div>
          </div>
        </>
      )}
    </section>
  );
}
