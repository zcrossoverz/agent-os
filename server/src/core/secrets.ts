import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Encryption at rest for the few third-party secrets AgentOS must hold: routine trigger tokens
 * (claude.ai cloud scheduled-task API tokens, scoped to firing one routine) and GitHub tokens.
 * Claude subscription credentials are never stored here — see docs/feasibility.md.
 *
 * Key: AGENTOS_SECRET_KEY (base64, 32 bytes) or <dataDir>/secret.key (created with mode 0600).
 */
export class SecretBox {
  private key: Buffer;

  constructor(dataDir: string) {
    const fromEnv = process.env.AGENTOS_SECRET_KEY;
    if (fromEnv) {
      this.key = Buffer.from(fromEnv, 'base64');
      if (this.key.length !== 32) throw new Error('AGENTOS_SECRET_KEY must be 32 bytes, base64-encoded');
      return;
    }
    const file = path.join(dataDir, 'secret.key');
    if (fs.existsSync(file)) {
      this.key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
    } else {
      fs.mkdirSync(dataDir, { recursive: true });
      this.key = randomBytes(32);
      fs.writeFileSync(file, this.key.toString('base64'), { mode: 0o600 });
    }
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
  }

  decrypt(box: string | null | undefined): string | null {
    if (!box) return null;
    const [v, iv, tag, ct] = box.split(':');
    if (v !== 'v1') throw new Error('Unknown secret format');
    const d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
  }
}
