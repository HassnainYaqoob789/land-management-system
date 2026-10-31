import { X509Certificate, randomBytes } from 'node:crypto';
import type { NextResponse } from 'next/server';
import type { PoolClient } from 'pg';
import { withoutActor } from '../../db';
import { HttpError } from '../http';
import { appOrigin, cookieSecure } from '../config';
import { decrypt, encrypt, keyring, newToken, sha256 } from '../crypto';
import type { ProviderKind } from '../signin-methods';

// Everything the three external sign-in protocols share: the provider record,
// its encrypted secret, configuration checks, run-time availability, the
// security log and the cookie that binds a sign-in attempt to one browser.

export type Kind = ProviderKind;
export const KINDS: Kind[] = ['oidc', 'saml', 'ldap'];
export const KIND_LABEL: Record<Kind, string> = { oidc: 'OpenID Connect', saml: 'SAML 2.0', ldap: 'LDAP / Active Directory' };

/** iam.auth_provider.name: also part of every redirect URI. */
export const PROVIDER_NAME = /^[a-z][a-z0-9-]{1,30}$/;

export interface Provider<C = any> {
  id: string; kind: Kind; name: string; displayName: string; config: C;
  /** Decrypted client secret / bind password; never logged, never returned. */
  secret: string | null;
}

// ---- endpoints this application exposes to identity providers --------------
export const oidcRedirectUri = (name: string) => `${appOrigin()}/api/auth/oidc/${name}/callback`;
export const samlAcsUrl = (name: string) => `${appOrigin()}/api/auth/saml/${name}/acs`;
export const samlMetadataUrl = (name: string) => `${appOrigin()}/api/auth/saml/${name}/metadata`;

// ---- secrets ------------------------------------------------------------------
// A changed secret is a NEW iam.secret row: pointing the provider at it changes
// secret_id, and the provider guard then clears the last test and disables the
// provider, so a secret that was never tested can never be in use.
export async function storeSecret(c: PoolClient, providerName: string, plaintext: string): Promise<string> {
  const name = `idp:${providerName}:${randomBytes(6).toString('hex')}`;
  const { keyId, blob } = encrypt(plaintext, name);   // the name is the associated data
  const r = await c.query('INSERT INTO iam.secret(name, key_id, ciphertext) VALUES ($1, $2, $3) RETURNING id', [name, keyId, blob]);
  return r.rows[0].id;
}

function openSecret(row: { secret_name?: string | null; secret_key_id?: string | null; secret_ciphertext?: Buffer | null }): string | null {
  if (!row.secret_ciphertext || !row.secret_name || !row.secret_key_id) return null;
  return decrypt(row.secret_ciphertext, row.secret_key_id, row.secret_name);
}

/** Before sign-in: an enabled provider that passed its last test, or null. */
export async function runtimeProvider(name: string): Promise<Provider | null> {
  if (!PROVIDER_NAME.test(name)) return null;
  const row = (await withoutActor((c) => c.query('SELECT * FROM iam.provider_runtime($1)', [name]))).rows[0];
  if (!row) return null;
  return { id: row.id, kind: row.kind, name: row.name, displayName: row.display_name, config: row.config ?? {}, secret: openSecret(row) };
}

export interface ProviderRow {
  id: string; kind: Kind; name: string; display_name: string; enabled: boolean; config: Record<string, unknown>;
  secret_id: string | null; last_tested_at: Date | null; last_test_ok: boolean | null; last_test_detail: string | null;
  last_test_by: string | null; version: number; created_at: Date; updated_at: Date;
  secret_name: string | null; secret_key_id: string | null; secret_ciphertext: Buffer | null;
}

/** As an identity administrator (row-level security applies). */
export async function adminProviderRow(c: PoolClient, id: string, opts: { lock?: boolean } = {}): Promise<ProviderRow | null> {
  const r = await c.query(`SELECT p.*, s.name AS secret_name, s.key_id AS secret_key_id, s.ciphertext AS secret_ciphertext
      FROM iam.auth_provider p LEFT JOIN iam.secret s ON s.id = p.secret_id
     WHERE p.id = $1 ${opts.lock ? 'FOR UPDATE OF p' : ''}`, [id]);
  return r.rows[0] ?? null;
}

export function providerFromRow(row: ProviderRow): Provider {
  return { id: row.id, kind: row.kind, name: row.name, displayName: row.display_name, config: row.config ?? {}, secret: openSecret(row) };
}

// ---- run-time availability --------------------------------------------------
// A provider that failed at run time (discovery down, directory unreachable)
// is shown as unavailable for a short while instead of as a button that fails.
// Only failures an outsider cannot cause count: never a bad assertion or code.
const failing = new Map<string, number>();
const FAILING_MS = 2 * 60_000;
export function markFailing(name: string) { failing.set(name, Date.now() + FAILING_MS); }
export function markHealthy(name: string) { failing.delete(name); }
export function isFailing(name: string): boolean {
  const until = failing.get(name);
  if (!until) return false;
  if (until < Date.now()) { failing.delete(name); return false; }
  return true;
}

/** The server-side prerequisites of a kind: the public origin (redirect and
 * ACS URLs) and, where a secret is stored, the keyring that opens it. */
export function prerequisitesMet(kind: Kind): boolean {
  try {
    if (kind !== 'ldap') appOrigin();
    if (kind !== 'saml') keyring();
    return true;
  } catch { return false; }
}

/** WebAuthn needs a secure context: https, or the browser's localhost exemption. */
export function passkeyAvailable(): boolean {
  try {
    const u = new URL(appOrigin());
    return u.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch { return false; }
}

// ---- security log -------------------------------------------------------------
/** iam.log_event; metadata keys must pass iam.metadata_is_safe (no "code",
 * "token", "secret" …). Logging never breaks a sign-in answer. */
export async function audit(type: string, outcome: string, o: { userId?: string | null; username?: string | null; provider?: string | null;
  corr?: string | null; meta?: Record<string, unknown>; ip?: string | null; ua?: string | null; actor?: string | null } = {}) {
  try {
    await withoutActor((c) => c.query('SELECT iam.log_event($1,$2,$3,$4,$5,NULL,$6,$7,$8,NULL,$9,$10)',
      [type, outcome, o.userId ?? null, o.username ? o.username.slice(0, 64) : null, o.actor ?? null, o.provider ?? null,
       o.ip ?? null, o.ua ? o.ua.slice(0, 300) : null, o.corr ?? null, JSON.stringify(o.meta ?? {})]));
  } catch (e) { console.error(`[${o.corr ?? '-'}] could not record ${type}/${outcome}:`, describeError(e)); }
}

/** A short, credential-free description of an error for logs and test results. */
export function describeError(e: unknown): string {
  const x = e as any;
  const name = typeof x?.name === 'string' ? x.name : 'Error';
  let msg = typeof x?.message === 'string' ? x.message : String(e);
  msg = msg.replace(/(password|secret|passwd|credential)\S*\s*[:=]\s*\S+/gi, '$1=[redacted]');
  const cause = x?.cause?.code ?? x?.code;
  return `${name}: ${msg}${typeof cause === 'string' && !msg.includes(cause) ? ` (${cause})` : ''}`.replace(/\s+/g, ' ').slice(0, 280);
}

// ---- the browser binding --------------------------------------------------------
// A random value in an HttpOnly, SameSite=Lax cookie; its digest is stored
// with the sign-in challenge. The flow can only be completed in the browser
// that started it, so nobody can make a victim's browser finish (and sign in
// to) an attacker's own sign-in (login CSRF).
export const SSO_COOKIE = cookieSecure ? '__Host-lms_sso' : 'lms_sso';
const BINDING = /^[A-Za-z0-9_-]{43}$/;

export function readBinding(req: Request): string | null {
  const raw = req.headers.get('cookie');
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === SSO_COOKIE) {
      const v = part.slice(i + 1).trim();
      return BINDING.test(v) ? v : null;
    }
  }
  return null;
}
export function bindingFor(req: Request): string { return readBinding(req) ?? newToken(32); }
export const bindingDigest = (value: string) => sha256(value).toString('hex');
export function setBinding(res: NextResponse, value: string) {
  res.cookies.set(SSO_COOKIE, value, { httpOnly: true, secure: cookieSecure, sameSite: 'lax', path: '/', maxAge: 900 });
}
export function clearBinding(res: NextResponse) {
  res.cookies.set(SSO_COOKIE, '', { httpOnly: true, secure: cookieSecure, sameSite: 'lax', path: '/', maxAge: 0 });
}

// ---- configuration checks (shared by the three kinds) ----------------------------
export type Input = Record<string, unknown>;
const bad = (label: string, why: string): never => { throw new HttpError(400, `${label}: ${why}`, 'validation'); };
const CONTROL = /[\u0000-\u001f\u007f]/;

export function text(input: Input, key: string, label: string, o: { required?: boolean; max?: number; def?: string; pattern?: RegExp; hint?: string } = {}): string {
  const v = input[key];
  if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
    if (o.def !== undefined) return o.def;
    if (o.required) bad(label, 'is required');
    return '';
  }
  if (typeof v !== 'string') bad(label, 'must be text');
  const s = (v as string).trim();
  if (s.length > (o.max ?? 500)) bad(label, `is too long (${o.max ?? 500} characters at most)`);
  if (CONTROL.test(s)) bad(label, 'contains control characters');
  if (o.pattern && !o.pattern.test(s)) bad(label, o.hint ?? 'is not in the expected form');
  return s;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
/** An absolute URL. http: only towards the loopback interface (a test or a
 * local relay), never across a network. */
export function url(input: Input, key: string, label: string, o: { protocols: string[]; loopbackHttp?: boolean; required?: boolean }): string {
  const s = text(input, key, label, { required: o.required ?? true, max: 500 });
  if (!s) return s;
  let u: URL;
  try { u = new URL(s); } catch { return bad(label, 'is not a valid URL'); }
  const httpOk = o.loopbackHttp && u.protocol === 'http:' && LOOPBACK.has(u.hostname);
  if (!o.protocols.includes(u.protocol) && !httpOk) bad(label, `must use ${o.protocols.join(' or ')}`);
  if (u.username || u.password) bad(label, 'must not contain a user name or password');
  if (u.hash) bad(label, 'must not contain a fragment (#…)');
  return s;
}

export function choice<T extends string>(input: Input, key: string, label: string, options: readonly T[], def: T): T {
  const v = input[key];
  if (v === undefined || v === null || v === '') return def;
  if (typeof v !== 'string' || !options.includes(v as T)) bad(label, `must be one of: ${options.join(', ')}`);
  return v as T;
}

export function bool(input: Input, key: string, def: boolean): boolean {
  const v = input[key];
  if (v === undefined || v === null || v === '') return def;
  if (typeof v !== 'boolean') bad(key, 'must be true or false');
  return v as boolean;
}

/** One or more PEM certificates, each parsed; returned normalised. */
export function pem(input: Input, key: string, label: string, o: { required?: boolean; multiple?: boolean } = {}): string {
  const v = input[key];
  if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
    if (o.required) bad(label, 'is required');
    return '';
  }
  if (typeof v !== 'string') bad(label, 'must be text');
  if ((v as string).length > 32_000) bad(label, 'is too long');
  const blocks = (v as string).match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  if (!blocks.length) bad(label, 'must be a PEM certificate (-----BEGIN CERTIFICATE----- …)');
  if (!o.multiple && blocks.length > 1) bad(label, 'must be exactly one certificate');
  if (blocks.length > 10) bad(label, 'has too many certificates');
  const out: string[] = [];
  for (const b of blocks) {
    const body = b.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');
    const norm = `-----BEGIN CERTIFICATE-----\n${body.match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----`;
    try { new X509Certificate(norm); } catch { bad(label, 'is not a valid X.509 certificate'); }
    out.push(norm);
  }
  return out.join('\n') + '\n';
}

/** Certificates that are expired or not yet valid, for the connection test. */
export function certificateProblems(pemText: string, label: string): string | null {
  const blocks = pemText.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  const now = Date.now();
  for (const b of blocks) {
    const c = new X509Certificate(b);
    if (Date.parse(c.validTo) <= now) return `${label} expired on ${new Date(c.validTo).toISOString().slice(0, 10)}`;
    if (Date.parse(c.validFrom) > now) return `${label} is not valid until ${new Date(c.validFrom).toISOString().slice(0, 10)}`;
  }
  return null;
}

/** A test result: what the administrator sees and what iam.record_provider_test keeps. */
export interface TestResult { ok: boolean; detail: string }

/** fetch with a deadline; network errors become a readable message. */
export async function fetchWithTimeout(input: string | URL, init: RequestInit = {}, ms = 8000): Promise<Response> {
  return fetch(input, { ...init, signal: AbortSignal.timeout(ms) });
}
