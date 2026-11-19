import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import clsx from 'clsx';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { X, Loader2, CheckCircle2, AlertTriangle, Info } from 'lucide-react';
import { AGENT_STATUS, STATUS_META, avatarColor, initials, timeAgo, fmtDate, PRIORITY } from '../lib/format';
import type { ToastKind } from '../lib/api';

export function Avatar({ name, seed, size = 'md', ring }: { name: string; seed?: string; size?: 'xs' | 'sm' | 'md' | 'lg'; ring?: boolean }) {
  const s = { xs: 'size-5 text-[9px]', sm: 'size-6 text-[10px]', md: 'size-8 text-xs', lg: 'size-10 text-sm' }[size];
  return (
    <span className={clsx('inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white shadow-[inset_0_0_0_1px_rgb(255_255_255/0.15)]', s, avatarColor(seed ?? name), ring && 'ring-2 ring-white dark:ring-ink-900')} title={name}>
      {initials(name)}
    </span>
  );
}

export function OwnerAvatar({ size = 'md' }: { size?: 'xs' | 'sm' | 'md' | 'lg' }) {
  const s = { xs: 'size-5 text-[9px]', sm: 'size-6 text-[10px]', md: 'size-8 text-xs', lg: 'size-10 text-sm' }[size];
  return <span className={clsx('inline-flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-zinc-700 to-zinc-900 font-semibold text-white dark:from-zinc-200 dark:to-zinc-400 dark:text-zinc-900', s)}>You</span>;
}

export function StatusChip({ status, className }: { status: string; className?: string }) {
  const m = STATUS_META[status] ?? STATUS_META.backlog;
  return (
    <span className={clsx('inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap', m.chip, className)}>
      <span className={clsx('size-1.5 rounded-full', m.dot)} />
      {m.label}
    </span>
  );
}

export function AgentStatus({ status, detail, compact }: { status: string; detail?: string | null; compact?: boolean }) {
  const m = AGENT_STATUS[status] ?? AGENT_STATUS.idle;
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-xs" title={detail ?? m.label}>
      <span className="relative flex size-2 shrink-0">
        {m.pulse && <span className={clsx('absolute inline-flex h-full w-full animate-ping rounded-full opacity-60', m.dot)} />}
        <span className={clsx('relative inline-flex size-2 rounded-full', m.dot)} />
      </span>
      {!compact && <span className="truncate text-zinc-600 dark:text-zinc-400">{m.label}{detail ? ` · ${detail}` : ''}</span>}
    </span>
  );
}

export function Priority({ p }: { p: number }) {
  const m = PRIORITY[p] ?? PRIORITY[2];
  return <span className={clsx('text-[11px] font-semibold', m.cls)} title={`${m.label} priority`}>{m.short}</span>;
}

export function Badge({ children, tone = 'zinc', className }: { children: ReactNode; tone?: 'zinc' | 'indigo' | 'amber' | 'red' | 'emerald' | 'violet' | 'sky'; className?: string }) {
  const tones = {
    zinc: 'bg-zinc-100 text-zinc-700 dark:bg-white/[0.06] dark:text-zinc-300',
    indigo: 'bg-indigo-50 text-indigo-700 dark:bg-indigo-400/10 dark:text-indigo-300 dark:ring-1 dark:ring-inset dark:ring-indigo-400/20',
    amber: 'bg-amber-50 text-amber-800 dark:bg-amber-400/10 dark:text-amber-300 dark:ring-1 dark:ring-inset dark:ring-amber-400/20',
    red: 'bg-red-50 text-red-700 dark:bg-red-400/10 dark:text-red-300 dark:ring-1 dark:ring-inset dark:ring-red-400/20',
    emerald: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300 dark:ring-1 dark:ring-inset dark:ring-emerald-400/20',
    violet: 'bg-violet-50 text-violet-700 dark:bg-violet-400/10 dark:text-violet-300 dark:ring-1 dark:ring-inset dark:ring-violet-400/20',
    sky: 'bg-sky-50 text-sky-700 dark:bg-sky-400/10 dark:text-sky-300 dark:ring-1 dark:ring-inset dark:ring-sky-400/20',
  };
  return <span className={clsx('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap', tones[tone], className)}>{children}</span>;
}

export function RelTime({ iso, className }: { iso: string | null | undefined; className?: string }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  return (
    <time className={clsx('whitespace-nowrap', className)} title={fmtDate(iso)} dateTime={iso ?? undefined}>
      {timeAgo(iso)}
    </time>
  );
}

export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={clsx('prose-agent', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: (p) => <a {...p} target="_blank" rel="noreferrer noopener" /> }}>
        {children}
      </ReactMarkdown>
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={clsx('size-4 animate-spin text-zinc-400', className)} />;
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 p-6 text-sm text-zinc-500">
      <Spinner /> {label}
    </div>
  );
}

export function Empty({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      {icon && <div className="text-zinc-300 dark:text-zinc-600">{icon}</div>}
      <div className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{title}</div>
      {children && <div className="max-w-md text-sm text-zinc-500 dark:text-zinc-400">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function Modal({ open, onClose, title, children, width = 'max-w-lg', footer }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; width?: string; footer?: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-zinc-950/40 p-4 pt-[8vh] backdrop-blur-sm dark:bg-black/60" onMouseDown={onClose}>
      <div className={clsx('card animate-in w-full shadow-2xl dark:bg-ink-900 dark:shadow-[0_0_0_1px_rgb(255_255_255/0.06),0_24px_64px_-12px_rgb(0_0_0/0.8)]', width)} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-3 dark:border-white/[0.06]">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">
            <X className="size-4" />
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-zinc-200 px-5 py-3 dark:border-white/[0.06]">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function Drawer({ open, onClose, children, width = 'max-w-3xl' }: { open: boolean; onClose: () => void; children: ReactNode; width?: string }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !(e.target as HTMLElement)?.closest?.('textarea,input,select') && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-40 flex justify-end bg-zinc-950/30 backdrop-blur-[2px] dark:bg-black/50" onMouseDown={onClose}>
      <div className={clsx('flex h-full w-full flex-col overflow-hidden border-l border-zinc-200 bg-white shadow-2xl dark:border-white/[0.07] dark:bg-ink-925', width)} onMouseDown={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>,
    document.body,
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-zinc-500 dark:text-zinc-400">{hint}</span>}
    </label>
  );
}

export function SectionTitle({ children, action, className }: { children: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={clsx('mb-2 flex items-center justify-between gap-2', className)}>
      <h3 className="eyebrow">{children}</h3>
      {action}
    </div>
  );
}

export function Stat({ label, value, tone, sub }: { label: string; value: ReactNode; tone?: 'red' | 'amber' | 'emerald' | 'indigo'; sub?: ReactNode; icon?: ReactNode }) {
  const dot = tone ? { red: 'bg-[var(--viz-fail)]', amber: 'bg-[var(--viz-warn)]', emerald: 'bg-[var(--viz-good)]', indigo: 'bg-accent-500' }[tone] : null;
  return (
    <div className="card px-4 py-3">
      <div className="flex items-center gap-1.5 text-[12px] text-zinc-500 dark:text-zinc-400">
        {dot && <span className={clsx('size-1.5 rounded-full', dot)} aria-hidden />}
        {label}
      </div>
      <div className="num mt-1.5 text-[24px] leading-none font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">{value}</div>
      {sub && <div className="mt-1.5 text-[11px] text-zinc-500">{sub}</div>}
    </div>
  );
}

export function Toasts() {
  const [items, setItems] = useState<{ id: number; message: string; kind: ToastKind }[]>([]);
  useEffect(() => {
    let n = 0;
    const on = (e: Event) => {
      const { message, kind } = (e as CustomEvent).detail;
      const id = ++n;
      setItems((xs) => [...xs.slice(-3), { id, message, kind }]);
      setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 3500);
    };
    window.addEventListener('agentos:toast', on);
    return () => window.removeEventListener('agentos:toast', on);
  }, []);
  return createPortal(
    <div className="pointer-events-none fixed right-4 bottom-4 z-[60] flex flex-col gap-2">
      {items.map((t) => (
        <div key={t.id} className="card animate-in pointer-events-auto flex max-w-sm items-start gap-2 px-3 py-2.5 text-sm shadow-lg dark:bg-ink-850">
          {t.kind === 'success' ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-500" /> : t.kind === 'error' ? <AlertTriangle className="mt-0.5 size-4 shrink-0 text-red-500" /> : <Info className="mt-0.5 size-4 shrink-0 text-indigo-500" />}
          <span>{t.message}</span>
        </div>
      ))}
    </div>,
    document.body,
  );
}

export function ProgressBar({ segments, className }: { segments: { value: number; cls: string; label: string }[]; className?: string }) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  return (
    <div className={clsx('flex h-1.5 w-full gap-px overflow-hidden rounded-full bg-zinc-100 dark:bg-white/[0.05]', className)}>
      {total > 0 && segments.map((s) => s.value > 0 && <div key={s.label} className={s.cls} style={{ width: `${(s.value / total) * 100}%` }} title={`${s.label}: ${s.value}`} />)}
    </div>
  );
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="btn btn-sm"
      onClick={() => {
        navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
    >
      {done ? 'Copied' : label}
    </button>
  );
}

/** The AgentOS mark: three run lanes of different lengths, as on the timeline. */
export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className="shrink-0">
      <rect width="32" height="32" rx="8" className="fill-zinc-900 dark:fill-white/[0.08]" />
      <rect x="7" y="9" width="12" height="3.5" rx="1.75" fill="#8b8cf8" />
      <rect x="11" y="14.25" width="14" height="3.5" rx="1.75" fill="#ffffff" opacity="0.92" />
      <rect x="7" y="19.5" width="8" height="3.5" rx="1.75" fill="#ffffff" opacity="0.55" />
    </svg>
  );
}
