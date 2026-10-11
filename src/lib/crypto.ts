import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Random string from the Crockford base32 alphabet (no ambiguous characters). */
export function randomCode(length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += CROCKFORD[bytes[i]! & 31];
  return out;
}

/** Stable, human-readable submission identifier, e.g. TR-7KQ2M9XA4D. */
export function newSubmissionRef(): string {
  return `TR-${randomCode(10)}`;
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Server-side secret box. Encrypts small secrets and recoverable ticket payloads at rest
 * with AES-256-GCM using a key derived from ENCRYPTION_KEY.
 */
export class SecretBox {
  private readonly encKey: Buffer;
  private readonly macKey: Buffer;

  constructor(masterKey: Buffer) {
    this.encKey = Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), 'ticket-relay:encryption', 32));
    this.macKey = Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), 'ticket-relay:mac', 32));
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encKey, iv);
    const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
  }

  decrypt(box: string): string {
    const [version, iv, tag, data] = box.split('.');
    if (version !== 'v1' || !iv || !tag || data === undefined) throw new Error('Unsupported ciphertext format');
    const decipher = createDecipheriv('aes-256-gcm', this.encKey, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  }

  encryptJson(value: unknown): string {
    return this.encrypt(JSON.stringify(value));
  }

  decryptJson<T>(box: string): T {
    return JSON.parse(this.decrypt(box)) as T;
  }

  /** Keyed hash, so stored fingerprints of ticket text cannot be brute-forced offline. */
  mac(value: string): string {
    return createHmac('sha256', this.macKey).update(value).digest('hex');
  }
}
