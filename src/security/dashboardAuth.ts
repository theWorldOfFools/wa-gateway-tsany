import {
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  type ScryptOptions
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: ScryptOptions
) => Promise<Buffer>;

export const DASHBOARD_COOKIE_NAME = 'wa_dashboard';
export const DASHBOARD_CSRF_HEADER = 'x-dashboard-request';

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_SALT_BYTES = 16;
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;

/**
 * Precomputed hash used when the email does not exist so the login endpoint
 * spends a comparable amount of time whether or not the account is real.
 */
export const DUMMY_PASSWORD_HASH =
  'scrypt$16384$8$1$mnwuTWuPGjxefZsPKkxujQ$QFVePg11jLJJqPH8eSvexj7biqZW574AMa5iD7zbxyUyL_mUCzdx9c732ZjHD0FcIDf7RPkvC9VLwEni22WlqA';

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const derived = await scrypt(password, salt, SCRYPT_KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAX_MEMORY
  });

  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64url'),
    derived.toString('base64url')
  ].join('$');
}

export async function verifyPassword(
  password: string,
  storedHash: string
): Promise<boolean> {
  try {
    const parts = storedHash.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

    const N = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    if (
      !Number.isInteger(N) ||
      !Number.isInteger(r) ||
      !Number.isInteger(p) ||
      N < 1_024 ||
      N > 1_048_576 ||
      (N & (N - 1)) !== 0 ||
      r < 1 ||
      r > 32 ||
      p < 1 ||
      p > 16
    ) {
      return false;
    }

    const salt = Buffer.from(parts[4] ?? '', 'base64url');
    const expected = Buffer.from(parts[5] ?? '', 'base64url');
    if (salt.length < 8 || expected.length < 16) return false;

    const derived = await scrypt(password, salt, expected.length, {
      N,
      r,
      p,
      maxmem: SCRYPT_MAX_MEMORY
    });

    return (
      derived.length === expected.length && timingSafeEqual(derived, expected)
    );
  } catch {
    return false;
  }
}

export interface GeneratedSessionToken {
  token: string;
  tokenHash: string;
}

export function generateSessionToken(): GeneratedSessionToken {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashSessionToken(token) };
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
