import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface AccessKey {
  id: string;
  name: string;
  salt: string;
  secretHash: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface CreatedKey {
  key: AccessKey;
  secret: string;
}

const SCRYPT_KEYLEN = 32;

function hashSecret(secret: string, salt: string): string {
  return crypto.scryptSync(secret, salt, SCRYPT_KEYLEN).toString('hex');
}

function timingSafeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Access keys are stored as scrypt hashes — the plaintext secret is returned
 * exactly once, at creation, and is not recoverable afterwards.
 *
 * Persistence is a JSON file under DATA_DIR (a Railway volume in production).
 * When that path is not writable the store degrades to memory-only so the
 * relay still boots; keys then do not survive a redeploy.
 */
export class KeyStore {
  private keys = new Map<string, AccessKey>();
  private readonly filePath: string | null;

  constructor(dataDir: string | null) {
    this.filePath = dataDir ? path.join(dataDir, 'access-keys.json') : null;
    this.load();
  }

  get persistent(): boolean {
    return this.filePath !== null;
  }

  private load(): void {
    if (!this.filePath) return;
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as AccessKey[];
      for (const key of parsed) this.keys.set(key.id, key);
    } catch {
      // No file yet, or unreadable — start empty.
    }
  }

  private persist(): void {
    if (!this.filePath) return;
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify([...this.keys.values()], null, 2));
  }

  create(name: string): CreatedKey {
    const id = 'pk_' + crypto.randomBytes(8).toString('hex');
    const secret = 'sk_' + crypto.randomBytes(24).toString('base64url');
    const salt = crypto.randomBytes(16).toString('hex');

    const key: AccessKey = {
      id,
      name: name.trim() || 'unnamed',
      salt,
      secretHash: hashSecret(secret, salt),
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      revokedAt: null,
    };

    this.keys.set(id, key);
    this.persist();
    return { key, secret };
  }

  list(): AccessKey[] {
    return [...this.keys.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  revoke(id: string): boolean {
    const key = this.keys.get(id);
    if (!key || key.revokedAt) return false;
    key.revokedAt = new Date().toISOString();
    this.persist();
    return true;
  }

  get count(): number {
    return [...this.keys.values()].filter((k) => !k.revokedAt).length;
  }

  /** Verify a bare secret against every active key. Returns the key, or null. */
  verifySecret(secret: string): AccessKey | null {
    if (!secret) return null;
    for (const key of this.keys.values()) {
      if (key.revokedAt) continue;
      if (timingSafeEqualHex(hashSecret(secret, key.salt), key.secretHash)) {
        return this.touch(key);
      }
    }
    return null;
  }

  /** Verify an explicit id + secret pair, as sent by Proxy-Authorization. */
  verifyPair(id: string, secret: string): AccessKey | null {
    const key = this.keys.get(id);
    if (!key || key.revokedAt || !secret) return null;
    if (!timingSafeEqualHex(hashSecret(secret, key.salt), key.secretHash)) return null;
    return this.touch(key);
  }

  private touch(key: AccessKey): AccessKey {
    const previous = key.lastUsedAt;
    key.lastUsedAt = new Date().toISOString();
    // Only rewrite the file on the first use of a given minute, so a busy
    // relay does not hammer the volume on every single request.
    if (!previous || previous.slice(0, 16) !== key.lastUsedAt.slice(0, 16)) {
      this.persist();
    }
    return key;
  }
}

/** Resolve the data directory, falling back to memory-only when unwritable. */
export function resolveDataDir(preferred: string): string | null {
  try {
    fs.mkdirSync(preferred, { recursive: true });
    fs.accessSync(preferred, fs.constants.W_OK);
    return preferred;
  } catch {
    return null;
  }
}
