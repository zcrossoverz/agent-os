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
    <span className={clsx('inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white', s, avatarColor(seed ?? name), ring && 'ring-2 ring-white dark:ring-zinc-900')} title={name}>
      {initials(name)}
    </span>
  );
}

export function OwnerAvatar({ size = 'md' }: { size?: 'xs' | 'sm' | 'md' | 'lg' }) {
  const s = { xs: 'size-5 text-[9px]', sm: 'size-6 text-[10px]', md: 'size-8 text-xs', lg: 'size-10 text-sm' }[size];
  return <span className={clsx('inline-flex shrink-0 items-center justify-center rounded-full bg-zinc-900 font-semibold text-white dark:bg-zinc-100 dark:text-zinc-900', s)}>You</span>;
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
    zinc: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
    indigo: 'bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300',
    amber: 'bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
    red: 'bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300',
    emerald: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
    violet: 'bg-violet-50 text-violet-700 dark:bg-violet-950 dark:text-violet-300',
    sky: 'bg-sky-50 text-sky-700 dark:bg-sky-950 dark:text-sky-300',
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
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-zinc-950/40 p-4 pt-[8vh] backdrop-blur-[2px]" onMouseDown={onClose}>
      <div className={clsx('card w-full shadow-xl', width)} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">
            <X className="size-4" />
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-zinc-200 px-5 py-3 dark:border-zinc-800">{footer}</div>}
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
    <div className="fixed inset-0 z-40 flex justify-end bg-zinc-950/30" onMouseDown={onClose}>
      <div className={clsx('flex h-full w-full flex-col overflow-hidden border-l border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-900', width)} onMouseDown={(e) => e.stopPropagation()}>
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
      <h3 className="text-xs font-semibold tracking-wide text-zinc-500 uppercase dark:text-zinc-400">{children}</h3>
      {action}
    </div>
  );
}

export function Stat({ label, value, tone, sub }: { label: string; value: ReactNode; tone?: 'red' | 'amber' | 'emerald' | 'indigo'; sub?: ReactNode }) {
  const tc = tone ? { red: 'text-red-600 dark:text-red-400', amber: 'text-amber-600 dark:text-amber-400', emerald: 'text-emerald-600 dark:text-emerald-400', indigo: 'text-indigo-600 dark:text-indigo-400' }[tone] : '';
  return (
    <div className="card px-4 py-3">
      <div className="text-xs text-zinc-500 dark:text-zinc-400">{label}</div>
      <div className={clsx('mt-0.5 text-2xl font-semibold tabular-nums', tc)}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-zinc-500">{sub}</div>}
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
        <div key={t.id} className="card pointer-events-auto flex max-w-sm items-start gap-2 px-3 py-2 text-sm shadow-lg">
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
    <div className={clsx('flex h-2 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800', className)}>
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
