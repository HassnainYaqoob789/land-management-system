import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import type { NextResponse } from 'next/server';
import type { PoolClient } from 'pg';
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { withoutActor } from '../db';
import { appOrigin, RP_NAME } from './config';
import { sha256 } from './crypto';
import { isUuid, json, type Ctx } from './http';
import { finishLogin, GENERIC_LOGIN_ERROR, logEvent, num } from './login';
import { clientIp, userAgent } from './session';
import { SIGNIN_UNAVAILABLE_MESSAGE } from './signin-methods';

// Passkeys (WebAuthn / FIDO2): registration, first-factor sign-in (with or
// without a username), re-authentication, listing and removal.
//
// - Every challenge is a random value made by the library, stored only as its
//   SHA-256 through iam.challenge_issue and redeemed exactly once through
//   iam.challenge_take (5-minute life). A failed check never gives it back.
// - User verification is required, so a passkey sign-in is multi-factor.
// - Sign-in never says whether an account exists: the options are the same
//   for any username (no allowCredentials), and every refusal is the generic
//   login error. Failures are 'login' events, so the existing per-account and
//   per-address failure counters rate-limit them.
// - The session records the factor as 'webauthn', the value the
//   login_session.mfa_method check constraint accepts.

export const PASSKEY_MFA_METHOD = 'webauthn';
const CHALLENGE_SECONDS = 300;
const CEREMONY_MS = 120_000;            // browser timeout, inside the challenge life
const MAX_PASSKEYS = 10;
const LABEL_MAX = 60;
// What the browser may report (WebAuthn level 3); anything else is dropped.
const TRANSPORTS: readonly string[] = ['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb'];

export interface RelyingParty { rpID: string; rpName: string; origin: string }

/** RP ID = host of APP_ORIGIN, expected origin = APP_ORIGIN. Null when passkeys
 * cannot work there: WebAuthn needs a secure context (https, or http on
 * localhost) and a domain name, never an IP address. */
export function relyingParty(): RelyingParty | null {
  let u: URL;
  try { u = new URL(appOrigin()); } catch { return null; }
  const host = u.hostname;
  if (!host || isIP(host.replace(/^\[|\]$/g, '')) !== 0) return null;
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && host === 'localhost')) return null;
  return { rpID: host, rpName: RP_NAME, origin: u.origin };
}
export const passkeyAvailable = (): boolean => relyingParty() !== null;

// ---- input checks -------------------------------------------------------------
const B64U = /^[A-Za-z0-9_-]+={0,2}$/;
const b64u = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && B64U.test(v);

/** A sign-in assertion as the browser sends it, rebuilt from known fields only. */
export function asAssertion(v: unknown): AuthenticationResponseJSON | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, any>, r = o.response;
  if (o.type !== 'public-key' || !b64u(o.id, 1400) || o.rawId !== o.id || !r || typeof r !== 'object') return null;
  if (!b64u(r.clientDataJSON, 4096) || !b64u(r.authenticatorData, 4096) || !b64u(r.signature, 1024)) return null;
  const handle = r.userHandle === undefined || r.userHandle === null || r.userHandle === '' ? undefined : r.userHandle;
  if (handle !== undefined && !b64u(handle, 128)) return null;
  return { id: o.id, rawId: o.rawId, type: 'public-key', clientExtensionResults: {},
    response: { clientDataJSON: r.clientDataJSON, authenticatorData: r.authenticatorData, signature: r.signature, ...(handle ? { userHandle: handle } : {}) } };
}

/** A registration response, rebuilt from known fields only. */
export function asAttestation(v: unknown): RegistrationResponseJSON | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, any>, r = o.response;
  if (o.type !== 'public-key' || !b64u(o.id, 1400) || o.rawId !== o.id || !r || typeof r !== 'object') return null;
  if (!b64u(r.clientDataJSON, 4096) || !b64u(r.attestationObject, 32_768)) return null;
  const transports = Array.isArray(r.transports)
    ? [...new Set<string>(r.transports.filter((t: unknown): t is string => typeof t === 'string' && TRANSPORTS.includes(t)))] : undefined;
  const rk = o.clientExtensionResults?.credProps?.rk;
  return { id: o.id, rawId: o.rawId, type: 'public-key',
    clientExtensionResults: typeof rk === 'boolean' ? { credProps: { rk } } : {},
    response: { clientDataJSON: r.clientDataJSON, attestationObject: r.attestationObject, ...(transports ? { transports } : {}) } };
}

interface ClientData { type: string; challenge: string; origin: string }
export function clientData(clientDataJSON: string): ClientData | null {
  try {
    const d = JSON.parse(Buffer.from(clientDataJSON, 'base64url').toString('utf8'));
    if (!d || typeof d.type !== 'string' || !b64u(d.challenge, 128) || typeof d.origin !== 'string') return null;
    return { type: d.type, challenge: d.challenge, origin: d.origin };
  } catch { return null; }
}

/** A label people will recognise: printable text, at most 60 characters. */
export function cleanLabel(v: unknown): string {
  const s = typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() : '';
  return (s || 'Passkey').slice(0, LABEL_MAX);
}

/** The WebAuthn user handle: the account id's 16 bytes (no personal data). */
const userHandle = (userId: string) => new Uint8Array(Buffer.from(userId.replace(/-/g, ''), 'hex'));
const credId = (b64: string) => Buffer.from(b64, 'base64url');

// ---- challenges -----------------------------------------------------------------
type Purpose = 'webauthn_register' | 'webauthn_login';
async function issue(c: PoolClient, challenge: string, purpose: Purpose, userId: string | null, data: object) {
  await c.query('SELECT iam.challenge_issue($1,$2,$3,$4,$5)', [sha256(challenge), purpose, userId, JSON.stringify(data), CHALLENGE_SECONDS]);
}
async function take(c: PoolClient, challenge: string, purpose: Purpose): Promise<{ user_id: string | null; data: Record<string, any> } | null> {
  return (await c.query('SELECT user_id, data FROM iam.challenge_take($1,$2)', [sha256(challenge), purpose])).rows[0] ?? null;
}

// ---- rate limiting (the password sign-in's counters) -------------------------------
async function rateLimited(username: string | null, ip: string | null, corr: string, ua: string | null): Promise<NextResponse | null> {
  const win = await num('iam.rate_limit_window_minutes', 15);
  const f = (await withoutActor((c) => c.query('SELECT * FROM iam.failure_counts($1,$2,$3)', [username ?? '', ip, win]))).rows[0];
  const overUser = !!username && Number(f.by_user) >= (await num('iam.rate_limit_per_user', 10));
  const overIp = !!ip && Number(f.by_ip) >= (await num('iam.rate_limit_per_ip', 30));
  if (!overUser && !overIp) return null;
  await logEvent('login', 'denied', { username, ip, ua, corr, meta: { method: 'passkey', reason: 'rate_limited' } });
  return json({ error: 'Too many attempts. Try again later.', code: 'rate_limited', correlationId: corr }, 429, { 'Retry-After': String(win * 60) });
}

const unavailable = (corr: string) => json({ error: SIGNIN_UNAVAILABLE_MESSAGE, code: 'passkey_unavailable', correlationId: corr }, 503);

// ---- assertion check shared by sign-in and re-authentication -------------------------
interface StoredKey { public_key: Buffer; sign_count: string | number; transports: string[] | null }
type Checked = { ok: true; newCounter: number } | { ok: false; reason: 'counter_not_advanced' | 'bad_signature' };

async function checkAssertion(resp: AuthenticationResponseJSON, rp: RelyingParty, challenge: string, key: StoredKey): Promise<Checked> {
  try {
    const v = await verifyAuthenticationResponse({
      response: resp, expectedChallenge: challenge, expectedOrigin: rp.origin, expectedRPID: rp.rpID, requireUserVerification: true,
      credential: { id: resp.rawId, publicKey: new Uint8Array(key.public_key), counter: Number(key.sign_count), transports: key.transports ?? undefined },
    });
    if (!v.verified || !v.authenticationInfo.userVerified) return { ok: false, reason: 'bad_signature' };
    return { ok: true, newCounter: v.authenticationInfo.newCounter };
  } catch (e) {
    return { ok: false, reason: /counter value/i.test(String((e as Error)?.message)) ? 'counter_not_advanced' : 'bad_signature' };
  }
}

/** Store the new counter. False when the database refuses a counter that did
 * not advance (two parallel uses, or a cloned authenticator). */
async function recordUse(cred: Buffer, n: number): Promise<boolean> {
  try { await withoutActor((c) => c.query('SELECT iam.passkey_record_use($1,$2)', [cred, n])); return true; }
  catch (e: any) { if (e?.code === '42501') return false; throw e; }
}

/** A counter that went backwards is a security event, not just a failed sign-in. */
async function cloneSuspected(who: { userId: string; username: string }, o: { ip: string | null; ua: string | null; corr: string; session?: string }) {
  console.warn(`[SECURITY] passkey signature counter did not advance for ${who.username} (correlation ${o.corr}); possible cloned authenticator`);
  await logEvent('passkey_counter', 'denied', { userId: who.userId, username: who.username, ip: o.ip, ua: o.ua, corr: o.corr, session: o.session ?? null,
    meta: { reason: 'counter_not_advanced' } }).catch(() => {});
}

// ---- sign-in -------------------------------------------------------------------------
const normUser = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase().slice(0, 64) : '') || null;

/** Options for a sign-in. Identical for every username, known or not: the
 * username (when given) is kept with the challenge and checked at verify. */
export async function loginOptions(req: Request, body: Record<string, unknown>): Promise<NextResponse> {
  const corr = randomUUID(), ip = clientIp(req), ua = userAgent(req);
  const rp = relyingParty();
  if (!rp) return unavailable(corr);
  const username = normUser(body.username);
  const limited = await rateLimited(username, ip, corr, ua);
  if (limited) return limited;
  const options = await generateAuthenticationOptions({ rpID: rp.rpID, userVerification: 'required', timeout: CEREMONY_MS, allowCredentials: [] });
  await withoutActor((c) => issue(c, options.challenge, 'webauthn_login', null, { kind: 'login', username }));
  return json({ options });
}

export async function loginVerify(req: Request, body: Record<string, unknown>): Promise<NextResponse> {
  const corr = randomUUID(), ip = clientIp(req), ua = userAgent(req);
  const rp = relyingParty();
  if (!rp) return unavailable(corr);
  const deny = async (reason: string, who: { userId?: string; username?: string | null } = {}, outcome = 'failure') => {
    await logEvent('login', outcome, { userId: who.userId, username: who.username ?? null, ip, ua, corr, meta: { method: 'passkey', reason } });
    return json({ error: GENERIC_LOGIN_ERROR, code: 'invalid', correlationId: corr }, 401);
  };

  const resp = asAssertion(body.response);
  const cd = resp && clientData(resp.response.clientDataJSON);
  if (!resp || !cd || cd.type !== 'webauthn.get') return deny('malformed');
  if (cd.origin !== rp.origin) return deny('foreign_origin');
  const early = await rateLimited(null, ip, corr, ua);
  if (early) return early;

  const ch = await withoutActor((c) => take(c, cd.challenge, 'webauthn_login'));
  if (!ch || ch.data?.kind !== 'login') return deny('unknown_challenge');
  const hint: string | null = typeof ch.data.username === 'string' ? ch.data.username : null;

  const cred = credId(resp.rawId);
  const row = (await withoutActor((c) => c.query('SELECT * FROM iam.passkey_lookup($1)', [cred]))).rows[0];
  if (!row) return deny('unknown_passkey', { username: hint });
  if (hint && hint !== String(row.username).toLowerCase()) return deny('other_account', { username: hint });
  const who = { userId: row.user_id as string, username: row.username as string };
  const limited = await rateLimited(who.username.toLowerCase(), ip, corr, ua);
  if (limited) return limited;
  if (row.is_service_account || row.status !== 'Active') return deny('inactive', who, 'suspended');

  const acct = (await withoutActor((c) => c.query('SELECT locked_until, is_break_glass, must_change_password FROM iam.authn_lookup($1)', [who.username]))).rows[0];
  if (!acct) return deny('inactive', who, 'suspended');
  if (acct.is_break_glass) return deny('emergency_account', who, 'denied');   // emergency access is password-only, and always flagged
  if (acct.locked_until && new Date(acct.locked_until) > new Date()) return deny('locked', who, 'locked_out');
  if (resp.response.userHandle && resp.response.userHandle.replace(/=+$/, '') !== Buffer.from(userHandle(who.userId)).toString('base64url'))
    return deny('user_handle_mismatch', who);

  const v = await checkAssertion(resp, rp, cd.challenge, row);
  if (!v.ok) {
    if (v.reason === 'counter_not_advanced') await cloneSuspected(who, { ip, ua, corr });
    return deny(v.reason, who, v.reason === 'counter_not_advanced' ? 'denied' : 'failure');
  }
  if (!(await recordUse(cred, v.newCounter))) { await cloneSuspected(who, { ip, ua, corr }); return deny('counter_not_advanced', who, 'denied'); }

  // User verification on a passkey is two factors in one: MFA is satisfied.
  return finishLogin(req, { userId: who.userId, username: who.username, method: 'passkey', mfaMethod: PASSKEY_MFA_METHOD,
    enrollmentRequired: false, mustChange: !!acct.must_change_password, corr });
}

// ---- registration (signed in, recently re-authenticated) --------------------------
export async function registrationOptions(ctx: Ctx): Promise<NextResponse> {
  const corr = ctx.correlationId;
  const rp = relyingParty();
  if (!rp) return unavailable(corr);
  // Once a factor is in place, adding another needs it first (as for TOTP).
  if (ctx.session.mfaEnrolled && !ctx.session.mfaSatisfiedAt)
    return json({ error: 'Verify your existing factor first.', code: 'mfa_required', correlationId: corr }, 403);
  const acct = (await ctx.client.query('SELECT is_break_glass FROM iam.authn_lookup($1)', [ctx.user.username])).rows[0];
  if (acct?.is_break_glass)
    return json({ error: 'Emergency-access accounts sign in with their password only.', code: 'forbidden', correlationId: corr }, 403);
  const existing = (await ctx.client.query('SELECT credential_id, transports FROM iam.mfa_webauthn WHERE user_id = $1', [ctx.user.id])).rows;
  if (existing.length >= MAX_PASSKEYS)
    return json({ error: `You already have ${MAX_PASSKEYS} passkeys. Remove one before adding another.`, code: 'limit', correlationId: corr }, 409);
  const options = await generateRegistrationOptions({
    rpName: rp.rpName, rpID: rp.rpID, userName: ctx.user.username, userID: userHandle(ctx.user.id),
    userDisplayName: ctx.user.fullName || ctx.user.username, timeout: CEREMONY_MS, attestationType: 'none',
    excludeCredentials: existing.map((r) => ({ id: Buffer.from(r.credential_id).toString('base64url'), transports: r.transports ?? undefined })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
    extensions: { credProps: true },
  });
  await issue(ctx.client, options.challenge, 'webauthn_register', ctx.user.id, { kind: 'register' });
  return json({ options });
}

export async function registrationVerify(ctx: Ctx, body: Record<string, unknown>): Promise<NextResponse> {
  const corr = ctx.correlationId;
  const rp = relyingParty();
  if (!rp) return unavailable(corr);
  const label = cleanLabel(body.label);
  const base = { userId: ctx.user.id, username: ctx.user.username, session: ctx.session.sessionId, corr, req: ctx.req };
  // Answers are returned, never thrown, once the challenge is taken: its use must commit.
  const fail = async (reason: string, error = 'The passkey could not be added. Try again.', status = 400) => {
    await logEvent('passkey_registered', 'failure', { ...base, meta: { reason } }).catch(() => {});
    return json({ error, code: 'passkey_invalid', correlationId: corr }, status);
  };

  const resp = asAttestation(body.response);
  const cd = resp && clientData(resp.response.clientDataJSON);
  if (!resp || !cd || cd.type !== 'webauthn.create') return fail('malformed');
  if (cd.origin !== rp.origin) return fail('foreign_origin');
  const ch = await take(ctx.client, cd.challenge, 'webauthn_register');
  if (!ch || ch.user_id !== ctx.user.id || ch.data?.kind !== 'register') return fail('unknown_challenge');
  if (resp.clientExtensionResults.credProps?.rk === false)
    return fail('not_discoverable', 'This security key cannot keep a passkey for sign-in. Use a device or a security key that supports passkeys.');

  let info;
  try {
    const v = await verifyRegistrationResponse({ response: resp, expectedChallenge: cd.challenge, expectedOrigin: rp.origin,
      expectedRPID: rp.rpID, requireUserVerification: true });
    if (!v.verified || !v.registrationInfo.userVerified) return fail('not_verified');
    info = v.registrationInfo;
  } catch { return fail('not_verified'); }

  const c = info.credential;
  const transports = (resp.response.transports ?? c.transports ?? []).filter((t) => TRANSPORTS.includes(t));
  await ctx.client.query('SAVEPOINT passkey_insert');
  let row;
  try {
    row = (await ctx.client.query(
      `INSERT INTO iam.mfa_webauthn (user_id, credential_id, public_key, sign_count, transports, label, aaguid, backed_up, device_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id, label, created_at, last_used_at, backed_up, device_type, transports`,
      [ctx.user.id, credId(c.id), Buffer.from(c.publicKey), c.counter, transports.length ? transports : null, label,
       info.aaguid, info.credentialBackedUp, info.credentialDeviceType])).rows[0];
    await ctx.client.query('RELEASE SAVEPOINT passkey_insert');
  } catch (e: any) {
    await ctx.client.query('ROLLBACK TO SAVEPOINT passkey_insert');
    if (e?.code === '23505') return fail('duplicate', 'This passkey is already registered.', 409);
    throw e;
  }
  // Enrolling satisfies MFA for this session, as confirming an authenticator app does.
  if (!ctx.session.mfaSatisfiedAt) await ctx.client.query('SELECT iam.mark_session_mfa($1,$2)', [ctx.session.sessionId, PASSKEY_MFA_METHOD]);
  await logEvent('passkey_registered', 'success', { ...base,
    meta: { passkey_id: row.id, label, aaguid: info.aaguid, device_type: info.credentialDeviceType, backed_up: info.credentialBackedUp } }).catch(() => {});
  return json({ ok: true, passkey: shape(row) });
}

// ---- list and remove ------------------------------------------------------------
const shape = (r: Record<string, any>) => ({ id: r.id as string, label: r.label as string, createdAt: r.created_at, lastUsedAt: r.last_used_at ?? null,
  backedUp: r.backed_up ?? null, deviceType: r.device_type ?? null, transports: r.transports ?? [] });

export async function listOwn(ctx: Ctx): Promise<NextResponse> {
  const rows = (await ctx.client.query(
    `SELECT id, label, created_at, last_used_at, backed_up, device_type, transports
       FROM iam.mfa_webauthn WHERE user_id = $1 ORDER BY created_at, id LIMIT 50`, [ctx.user.id])).rows;
  const f = (await ctx.client.query(
    `SELECT EXISTS (SELECT 1 FROM iam.mfa_totp t WHERE t.user_id = $1 AND t.confirmed_at IS NOT NULL) AS totp,
            (SELECT u.password_hash IS NOT NULL FROM lms.app_user u WHERE u.id = $1) AS has_password`, [ctx.user.id])).rows[0];
  return json({ available: passkeyAvailable(), passkeys: rows.map(shape), authenticatorApp: !!f?.totp, hasPassword: !!f?.has_password });
}

export async function removeOwn(ctx: Ctx, id: string | null): Promise<NextResponse> {
  const corr = ctx.correlationId;
  if (!isUuid(id)) return json({ error: 'Passkey id is not valid.', code: 'validation', correlationId: corr }, 400);
  const base = { userId: ctx.user.id, username: ctx.user.username, session: ctx.session.sessionId, corr, req: ctx.req };
  await ctx.client.query('SAVEPOINT passkey_delete');
  try {
    const r = await ctx.client.query('DELETE FROM iam.mfa_webauthn WHERE id = $1 AND user_id = $2 RETURNING label', [id, ctx.user.id]);
    await ctx.client.query('RELEASE SAVEPOINT passkey_delete');
    if (!r.rowCount) return json({ error: 'Passkey not found.', code: 'not_found', correlationId: corr }, 404);
    await logEvent('passkey_removed', 'success', { ...base, meta: { passkey_id: id, label: r.rows[0].label } }).catch(() => {});
    return json({ ok: true });
  } catch (e: any) {
    await ctx.client.query('ROLLBACK TO SAVEPOINT passkey_delete');
    // The database keeps the last way in (iam.tg_webauthn_keep_one_way_in).
    if (e?.code === 'P0001' && /only way to sign in/i.test(String(e.message))) {
      await logEvent('passkey_removed', 'denied', { ...base, meta: { passkey_id: id, reason: 'last_sign_in_method' } }).catch(() => {});
      const m = String(e.message);
      return json({ error: `${m.charAt(0).toUpperCase()}${m.slice(1)}${/[.!?]$/.test(m) ? '' : '.'}`, code: 'last_sign_in_method', correlationId: corr }, 409);
    }
    throw e;
  }
}

// ---- re-authentication with a passkey (the Shell's "Confirm it's you") ---------------
export async function reauthOptions(ctx: Ctx): Promise<NextResponse> {
  const corr = ctx.correlationId;
  const rp = relyingParty();
  if (!rp) return unavailable(corr);
  const keys = (await ctx.client.query('SELECT credential_id, transports FROM iam.mfa_webauthn WHERE user_id = $1', [ctx.user.id])).rows;
  if (!keys.length) return json({ error: 'There is no passkey on this account. Confirm with your password instead.', code: 'no_passkey', correlationId: corr }, 409);
  const options = await generateAuthenticationOptions({ rpID: rp.rpID, userVerification: 'required', timeout: CEREMONY_MS,
    allowCredentials: keys.map((k) => ({ id: Buffer.from(k.credential_id).toString('base64url'), transports: k.transports ?? undefined })) });
  await issue(ctx.client, options.challenge, 'webauthn_login', ctx.user.id, { kind: 'reauth' });
  return json({ options });
}

export async function reauthVerify(ctx: Ctx, body: Record<string, unknown>): Promise<NextResponse> {
  const corr = ctx.correlationId, ip = clientIp(ctx.req), ua = userAgent(ctx.req);
  const rp = relyingParty();
  if (!rp) return unavailable(corr);
  const log = (outcome: string, meta: object) => logEvent('reauth', outcome, { userId: ctx.user.id, username: ctx.user.username,
    session: ctx.session.sessionId, corr, req: ctx.req, meta: { method: 'passkey', ...meta } }).catch(() => {});
  // The same serialisation and lockout as the password / code re-authentication.
  await ctx.client.query(`SELECT pg_advisory_xact_lock(hashtextextended('iam.mfa_login:' || $1::text, 0))`, [ctx.user.id]);
  const sec = (await ctx.client.query('SELECT locked_until FROM iam.account_security WHERE user_id = $1', [ctx.user.id])).rows[0];
  if (sec?.locked_until && new Date(sec.locked_until) > new Date()) {
    await log('locked_out', {});
    return json({ error: 'Too many failed attempts. Try again in a few minutes.', code: 'locked', correlationId: corr }, 429);
  }
  const fail = async (reason: string) => {
    await ctx.client.query('SELECT iam.note_auth_failure($1)', [ctx.user.id]);
    await log('failure', { reason });
    return json({ error: 'That did not match.', code: 'invalid', correlationId: corr }, 401);
  };

  const resp = asAssertion(body.response);
  const cd = resp && clientData(resp.response.clientDataJSON);
  if (!resp || !cd || cd.type !== 'webauthn.get') return fail('malformed');
  if (cd.origin !== rp.origin) return fail('foreign_origin');
  const ch = await take(ctx.client, cd.challenge, 'webauthn_login');
  if (!ch || ch.user_id !== ctx.user.id || ch.data?.kind !== 'reauth') return fail('unknown_challenge');
  const cred = credId(resp.rawId);
  const key = (await ctx.client.query('SELECT public_key, sign_count, transports FROM iam.mfa_webauthn WHERE credential_id = $1 AND user_id = $2',
    [cred, ctx.user.id])).rows[0];
  if (!key) return fail('unknown_passkey');
  const v = await checkAssertion(resp, rp, cd.challenge, key);
  const who = { userId: ctx.user.id, username: ctx.user.username };
  if (!v.ok) {
    if (v.reason === 'counter_not_advanced') await cloneSuspected(who, { ip, ua, corr, session: ctx.session.sessionId });
    return fail(v.reason);
  }
  if (!(await recordUse(cred, v.newCounter))) { await cloneSuspected(who, { ip, ua, corr, session: ctx.session.sessionId }); return fail('counter_not_advanced'); }
  await ctx.client.query('SELECT iam.mark_session_reauth($1)', [ctx.session.sessionId]);
  await log('success', {});
  return json({ ok: true });
}
