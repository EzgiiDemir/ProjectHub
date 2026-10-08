import crypto from 'node:crypto';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** Cryptographically random, URL safe token (base62). 32 chars ≈ 190 bits of entropy. */
export function randomToken(length = 32): string {
  const out: string[] = [];
  while (out.length < length) {
    const bytes = crypto.randomBytes(length * 2);
    for (const b of bytes) {
      // Rejection sampling keeps the distribution uniform (62 * 4 = 248).
      if (b < 248 && out.length < length) out.push(ALPHABET[b % 62]!);
    }
  }
  return out.join('');
}

export function sha256(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function hmacSha256(key: string | Buffer, value: string | Buffer): string {
  return crypto.createHmac('sha256', key).update(value).digest('hex');
}

export function timingSafeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

export interface EncryptedValue {
  ciphertext: string;
  iv: string;
  authTag: string;
}

/** AES-256-GCM with a random 96-bit IV per value. */
export function encrypt(key: Buffer, plaintext: string): EncryptedValue {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('hex'),
    authTag: cipher.getAuthTag().toString('hex'),
  };
}

export function decrypt(key: Buffer, value: EncryptedValue): string {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(value.authTag, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, 'base64')), decipher.final()]).toString('utf8');
}

/** Packs an encrypted value into one string ("v1.iv.tag.ciphertext") for single-column storage. */
export function encryptToString(key: Buffer, plaintext: string): string {
  const e = encrypt(key, plaintext);
  return `v1.${e.iv}.${e.authTag}.${e.ciphertext}`;
}

export function decryptFromString(key: Buffer, packed: string): string {
  const [v, iv, authTag, ciphertext] = packed.split('.');
  if (v !== 'v1' || !iv || !authTag || !ciphertext) throw new Error('Unsupported encrypted value format');
  return decrypt(key, { iv, authTag, ciphertext });
}

/** Argon2id with OWASP recommended parameters (19 MiB, t=2, p=1). */
export function hashPassword(password: string): Promise<string> {
  return argonHash(password, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
}

export async function verifyPassword(hash: string | null | undefined, password: string): Promise<boolean> {
  if (!hash) {
    // Still spend comparable time so response timing does not reveal whether the account exists.
    await argonHash(password, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
    return false;
  }
  try {
    return await argonVerify(hash, password);
  } catch {
    return false;
  }
}
