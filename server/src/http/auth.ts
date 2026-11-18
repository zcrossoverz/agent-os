import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Core } from '../core/core.js';
import { newToken, safeEqual } from '../util/util.js';

const SESSION_DAYS = 14;

/** Single-owner authentication for the dashboard. Passwords are scrypt-hashed in the settings table. */
export class OwnerAuth {
  constructor(private core: Core) {}

  private secret(): string {
    let s = this.core.getSetting('session_secret');
    if (!s) {
      s = newToken(32);
      this.core.setSetting('session_secret', s);
    }
    return s;
  }

  hasPassword(): boolean {
    return !!this.core.getSetting('owner_password_hash');
  }

  setPassword(password: string) {
    if (password.length < 8) throw new Error('Password must be at least 8 characters');
    const salt = randomBytes(16);
    const hash = scryptSync(password, salt, 64);
    this.core.setSetting('owner_password_hash', `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`);
    // Rotating the secret signs out every existing session.
    this.core.setSetting('session_secret', newToken(32));
  }

  /** Ensures a password exists; returns a generated one if it had to create it. */
  ensurePassword(fromEnv?: string): string | null {
    if (this.hasPassword()) {
      if (fromEnv && !this.verifyPassword(fromEnv)) this.setPassword(fromEnv);
      return null;
    }
    const pw = fromEnv || newToken(12);
    this.setPassword(pw);
    return fromEnv ? null : pw;
  }

  verifyPassword(password: string): boolean {
    const stored = this.core.getSetting('owner_password_hash');
    if (!stored) return false;
    const [, saltB64, hashB64] = stored.split('$');
    const expected = Buffer.from(hashB64, 'base64');
    const actual = scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length);
    return timingSafeEqual(expected, actual);
  }

  issueSession(): string {
    const exp = Date.now() + SESSION_DAYS * 86400_000;
    const nonce = newToken(9);
    const payload = `${exp}.${nonce}`;
    return `${payload}.${this.sign(payload)}`;
  }

  verifySession(token: string | undefined): boolean {
    if (!token) return false;
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const payload = `${parts[0]}.${parts[1]}`;
    if (!safeEqual(this.sign(payload), parts[2])) return false;
    return Number(parts[0]) > Date.now();
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.secret()).update(payload).digest('base64url');
  }
}

export const SESSION_COOKIE = 'aos_session';
export const SESSION_MAX_AGE = SESSION_DAYS * 86400;

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
