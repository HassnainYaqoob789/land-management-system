import type { PoolClient } from 'pg';
import { generateSecret, generateURI, verify } from 'otplib';
import QRCode from 'qrcode';
import { decrypt, encrypt, newRecoveryCodes, recoveryVerifier } from './crypto';
import { ISSUER_NAME } from './config';

const aad = (userId: string) => `totp:${userId}`;

/** Whether an account must use a second factor. The database decides
 * (iam.mfa_required_for): everyone when iam.mfa_required_all, holders of the
 * roles in iam.mfa_required_roles, and anyone holding an active permission
 * marked sensitive — so a custom role cannot carry sensitive power without
 * MFA. No answer counts as "required". */
export async function mfaRequiredFor(c: PoolClient, userId: string): Promise<boolean> {
  return (await c.query('SELECT iam.mfa_required_for($1) AS r', [userId])).rows[0]?.r !== false;
}

/** Whether a session must have passed MFA before it is usable: always for an
 * enrolled account or emergency access, otherwise by policy. */
export async function sessionRequiresMfa(c: PoolClient, s: { userId: string; mfaEnrolled: boolean; authMethod: string }): Promise<boolean> {
  if (s.mfaEnrolled || s.authMethod === 'break_glass') return true;
  return mfaRequiredFor(c, s.userId);
}

/** Begin enrolment: a fresh secret, encrypted, unconfirmed. Re-running replaces
 * an unconfirmed secret but never a confirmed one (that needs an admin reset
 * or a re-authenticated removal). */
export async function startTotp(c: PoolClient, userId: string, label: string) {
  const existing = (await c.query('SELECT confirmed_at FROM iam.mfa_totp WHERE user_id = $1', [userId])).rows[0];
  if (existing?.confirmed_at) throw Object.assign(new Error('An authenticator app is already enrolled.'), { code: 'P0001' });
  const secret = generateSecret();
  const { keyId, blob } = encrypt(secret, aad(userId));
  await c.query(`INSERT INTO iam.mfa_totp(user_id, secret_ct, key_id) VALUES ($1,$2,$3)
                 ON CONFLICT (user_id) DO UPDATE SET secret_ct = EXCLUDED.secret_ct, key_id = EXCLUDED.key_id,
                   last_used_step = 0, created_at = now() WHERE iam.mfa_totp.confirmed_at IS NULL`, [userId, blob, keyId]);
  const uri = generateURI({ issuer: ISSUER_NAME, label, secret });
  return { uri, secret, qrSvg: await QRCode.toString(uri, { type: 'svg', margin: 1, width: 200 }) };
}

/** Verify a code. Accepts the current step ±1 (30 s of clock drift) and only
 * a step strictly later than the last one accepted, so a code cannot be
 * replayed — not even within its own 30 seconds. */
export async function checkTotp(c: PoolClient, userId: string, code: string, opts: { requireConfirmed: boolean }): Promise<boolean> {
  if (!/^\d{6}$/.test(code)) return false;
  const row = (await c.query('SELECT secret_ct, key_id, last_used_step, confirmed_at FROM iam.mfa_totp WHERE user_id = $1 FOR UPDATE', [userId])).rows[0];
  if (!row || (opts.requireConfirmed && !row.confirmed_at)) return false;
  const secret = decrypt(row.secret_ct, row.key_id, aad(userId));
  const r: any = await verify({ secret, token: code, epochTolerance: 30 });
  if (!r?.valid) return false;
  const upd = await c.query('UPDATE iam.mfa_totp SET last_used_step = $1 WHERE user_id = $2 AND last_used_step < $1', [r.timeStep, userId]);
  return upd.rowCount === 1;
}

export async function confirmTotp(c: PoolClient, userId: string, code: string): Promise<string[] | null> {
  if (!(await checkTotp(c, userId, code, { requireConfirmed: false }))) return null;
  await c.query('UPDATE iam.mfa_totp SET confirmed_at = now() WHERE user_id = $1', [userId]);
  return regenerateRecoveryCodes(c, userId);
}

/** Ten codes, shown once. Only keyed verifiers are stored. */
export async function regenerateRecoveryCodes(c: PoolClient, userId: string): Promise<string[]> {
  const codes = newRecoveryCodes(10);
  await c.query('DELETE FROM iam.mfa_recovery_code WHERE user_id = $1', [userId]);
  for (const code of codes) await c.query('INSERT INTO iam.mfa_recovery_code(user_id, verifier) VALUES ($1,$2)', [userId, recoveryVerifier(code)]);
  return codes;
}

export async function useRecoveryCode(c: PoolClient, userId: string, code: string): Promise<{ ok: boolean; remaining: number }> {
  if (!/^[0-9a-fA-F-]{20,30}$/.test(code)) return { ok: false, remaining: -1 };
  const r = await c.query('UPDATE iam.mfa_recovery_code SET used_at = now() WHERE user_id = $1 AND verifier = $2 AND used_at IS NULL',
    [userId, recoveryVerifier(code)]);
  const left = Number((await c.query('SELECT count(*) AS n FROM iam.mfa_recovery_code WHERE user_id = $1 AND used_at IS NULL', [userId])).rows[0].n);
  return { ok: r.rowCount === 1, remaining: left };
}
