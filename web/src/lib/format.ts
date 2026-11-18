export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '—';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 0) return `in ${humanDuration(-s)}`;
  if (s < 45) return 'just now';
  return `${humanDuration(s)} ago`;
}

export function humanDuration(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.round(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export const PRIORITY = [
  { label: 'Urgent', short: 'P0', cls: 'text-red-600 dark:text-red-400' },
  { label: 'High', short: 'P1', cls: 'text-orange-600 dark:text-orange-400' },
  { label: 'Normal', short: 'P2', cls: 'text-zinc-500 dark:text-zinc-400' },
  { label: 'Low', short: 'P3', cls: 'text-zinc-400 dark:text-zinc-500' },
];

export const STATUS_META: Record<string, { label: string; dot: string; chip: string }> = {
  backlog: { label: 'Backlog', dot: 'bg-zinc-400', chip: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300' },
  todo: { label: 'To do', dot: 'bg-sky-500', chip: 'bg-sky-50 text-sky-700 dark:bg-sky-950 dark:text-sky-300' },
  in_progress: { label: 'In progress', dot: 'bg-amber-500', chip: 'bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300' },
  in_review: { label: 'In review', dot: 'bg-violet-500', chip: 'bg-violet-50 text-violet-700 dark:bg-violet-950 dark:text-violet-300' },
  blocked: { label: 'Blocked', dot: 'bg-red-500', chip: 'bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300' },
  done: { label: 'Done', dot: 'bg-emerald-500', chip: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300' },
  cancelled: { label: 'Cancelled', dot: 'bg-zinc-300', chip: 'bg-zinc-100 text-zinc-500 line-through dark:bg-zinc-800' },
};

export const AGENT_STATUS: Record<string, { label: string; dot: string; pulse?: boolean }> = {
  idle: { label: 'Idle', dot: 'bg-zinc-400' },
  queued: { label: 'Queued', dot: 'bg-sky-500', pulse: true },
  running: { label: 'Working', dot: 'bg-emerald-500', pulse: true },
  waiting: { label: 'Waiting', dot: 'bg-amber-500' },
  error: { label: 'Needs attention', dot: 'bg-red-500' },
};

export const ACCOUNT_STATUS: Record<string, { label: string; cls: string }> = {
  unknown: { label: 'Checking…', cls: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300' },
  ready: { label: 'Ready', cls: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300' },
  auth_required: { label: 'Sign-in required', cls: 'bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-300' },
  rate_limited: { label: 'Usage limit', cls: 'bg-orange-50 text-orange-700 dark:bg-orange-950 dark:text-orange-300' },
  billing_blocked: { label: 'Billing guard', cls: 'bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300' },
  error: { label: 'Error', cls: 'bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300' },
};

const AVATAR_COLORS = ['bg-indigo-500', 'bg-emerald-500', 'bg-amber-500', 'bg-rose-500', 'bg-sky-500', 'bg-violet-500', 'bg-teal-500', 'bg-fuchsia-500', 'bg-orange-500', 'bg-cyan-600'];
export function avatarColor(seed: string): string {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) | 0;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase();
}
