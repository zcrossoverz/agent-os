import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Short, prefixed, URL-safe random id, e.g. `tsk_k3j9x0a1b2c3`. */
export function newId(prefix: string, len = 12): string {
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return `${prefix}_${out}`;
}

export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function isoAfter(ms: number, from = Date.now()): string {
  return new Date(from + ms).toISOString();
}

export function slugify(s: string, max = 40): string {
  const slug = s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return slug || 'item';
}

export function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (s == null || s === '') return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = 'error',
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new HttpError(404, `${what} not found`, 'not_found');
export const badRequest = (msg: string) => new HttpError(400, msg, 'bad_request');
export const forbidden = (msg: string) => new HttpError(403, msg, 'forbidden');
export const conflict = (msg: string) => new HttpError(409, msg, 'conflict');

type Level = 'debug' | 'info' | 'warn' | 'error';
const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let minLevel: Level = (process.env.AGENTOS_LOG_LEVEL as Level) || 'info';

export function setLogLevel(l: Level) {
  minLevel = l;
}

export function log(level: Level, msg: string, data?: Record<string, unknown>) {
  if (LEVELS[level] < LEVELS[minLevel]) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}${
    data ? ' ' + JSON.stringify(data) : ''
  }`;
  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}
