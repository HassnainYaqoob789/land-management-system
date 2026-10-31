import { hash, verify } from '@node-rs/argon2';
import bcrypt from 'bcryptjs';
import { hmac } from './crypto';

/** A short keyed fingerprint of a reset or invitation link, written to every
 * event about that link (request, delivery, redeem, refused re-use) so they can
 * be correlated. It cannot be turned back into the link. */
export const linkRef = (token: string) => hmac('recovery-link', token).toString('base64url').slice(0, 16);

// Argon2id (algorithm 2), at the OWASP-recommended cost: 64 MiB, 3 passes.
const OPTS = { algorithm: 2, memoryCost: 65536, timeCost: 3, parallelism: 1 } as const;

export const hashPassword = (pw: string) => hash(pw, OPTS as any);

// A real hash, computed once, to verify against when the account does not
// exist, so "no such user" costs the same time as "wrong password".
let dummy: Promise<string> | undefined;
const dummyHash = () => (dummy ??= hashPassword('dummy-password-for-timing-equalisation'));
export async function burnTime(pw: string) { await verify(await dummyHash(), pw).catch(() => false); }

export interface PasswordCheck { ok: boolean; needsRehash: boolean }
export async function verifyPassword(stored: string | null, pw: string): Promise<PasswordCheck> {
  if (!stored) { await burnTime(pw); return { ok: false, needsRehash: false }; }
  try {
    if (stored.startsWith('$argon2')) return { ok: await verify(stored, pw), needsRehash: false };
    // Legacy bcrypt from the pre-IAM prototype: accepted once, then replaced.
    if (/^\$2[aby]\$/.test(stored)) { const ok = await bcrypt.compare(pw, stored); return { ok, needsRehash: ok }; }
  } catch { /* malformed hash: treat as a failed attempt */ }
  await burnTime(pw);
  return { ok: false, needsRehash: false };
}

const COMMON = new Set(['password','password1','password123','passw0rd','qwerty','qwerty123','letmein','welcome','welcome1',
  'admin','admin123','administrator','changeme','iloveyou','monkey','dragon','football','abc123','123456','12345678',
  '123456789','1234567890','111111','000000','pakistan','pakistan1','mari','marienergies','secret','login']);

/** NIST 800-63B style: length, a deny-list and context words — no composition
 * rules, which push people to predictable substitutions. */
export function checkPasswordPolicy(pw: string, ctx: { username?: string; fullName?: string; minLength: number }): string[] {
  const errors: string[] = [];
  if (pw.length < ctx.minLength) errors.push(`Use at least ${ctx.minLength} characters.`);
  if (pw.length > 128) errors.push('Use at most 128 characters.');
  const low = pw.toLowerCase();
  if (COMMON.has(low) || COMMON.has(low.replace(/[^a-z0-9]/g, ''))) errors.push('That password is too common.');
  if (/^(.)\1+$/.test(pw)) errors.push('Do not repeat a single character.');
  if (ctx.username && ctx.username.length >= 3 && low.includes(ctx.username.toLowerCase())) errors.push('Do not include your username.');
  for (const part of (ctx.fullName || '').toLowerCase().split(/\s+/).filter((p) => p.length >= 4))
    if (low.includes(part)) { errors.push('Do not include your name.'); break; }
  return errors;
}

export async function matchesHistory(newPw: string, hashes: string[]): Promise<boolean> {
  for (const h of hashes) { if ((await verifyPassword(h, newPw)).ok) return true; }
  return false;
}
