import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { BASE, Client, PW, sql, signInAs } from './client';

// Passkeys (package P3) against the running server on IAM_TEST_BASE, whose
// APP_ORIGIN must be that same origin (RP ID = its host name).
//
// TEST DOUBLE: SoftAuthenticator below is a software WebAuthn authenticator
// (P-256 key in memory, "none" attestation, user presence + verification set).
// It exists only in this test so the server's real verification can be
// exercised without a browser; tests/e2e/passkey.spec.ts covers the browser
// path with Chrome's virtual authenticator.

const GENERIC = 'Invalid credentials, or the account is unavailable.';
const USER = 'negoqta';          // not used by any other suite
const OTHER = 'viewer';
const ORIGIN = new URL(BASE).origin;
const RP_ID = new URL(BASE).hostname;
const uid = (u: string) => `(SELECT id FROM lms.app_user WHERE username='${u}')`;

const sha = (b: string | Uint8Array) => createHash('sha256').update(b).digest();
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64url');

class SoftAuthenticator {
  private key: { publicKey: KeyObject; privateKey: KeyObject } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  readonly id = randomBytes(32);
  counter = 0;
  handle = '';
  constructor(public origin = ORIGIN, public rpId = RP_ID) {}

  private cose(): Uint8Array {
    const j = this.key.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    return isoCBOR.encode(new Map<number, any>([[1, 2], [3, -7], [-1, 1],
      [-2, new Uint8Array(Buffer.from(j.x, 'base64url'))], [-3, new Uint8Array(Buffer.from(j.y, 'base64url'))]]));
  }
  private authData(flags: number, attested = false): Buffer {
    const n = Buffer.alloc(4); n.writeUInt32BE(this.counter);
    const parts: Buffer[] = [sha(this.rpId), Buffer.from([flags]), n];
    if (attested) { const l = Buffer.alloc(2); l.writeUInt16BE(this.id.length); parts.push(Buffer.alloc(16), l, this.id, Buffer.from(this.cose())); }
    return Buffer.concat(parts);
  }
  /** navigator.credentials.create(), as JSON. Flags: UP | UV | AT. */
  create(options: any, o: { origin?: string } = {}) {
    this.handle = options.user.id;
    const cd = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin: o.origin ?? this.origin, crossOrigin: false }));
    const att = isoCBOR.encode(new Map<string, any>([['fmt', 'none'], ['attStmt', new Map()], ['authData', new Uint8Array(this.authData(0x45, true))]]));
    return { id: b64(this.id), rawId: b64(this.id), type: 'public-key',
      response: { clientDataJSON: b64(cd), attestationObject: b64(att), transports: ['internal'] },
      clientExtensionResults: { credProps: { rk: true } } };
  }
  /** navigator.credentials.get(), as JSON. Flags: UP | UV. */
  get(options: { challenge: string }, o: { origin?: string; keepCounter?: boolean } = {}) {
    if (!o.keepCounter) this.counter += 1;
    const cd = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin: o.origin ?? this.origin, crossOrigin: false }));
    const ad = this.authData(0x05);
    const sig = sign('sha256', Buffer.concat([ad, sha(cd)]), this.key.privateKey);
    return { id: b64(this.id), rawId: b64(this.id), type: 'public-key',
      response: { clientDataJSON: b64(cd), authenticatorData: b64(ad), signature: b64(sig), userHandle: this.handle },
      clientExtensionResults: {} };
  }
}

/** Register `auth` on the signed-in client's account. */
async function register(c: Client, auth: SoftAuthenticator, label = 'Test key') {
  const o = await c.post('/api/auth/passkey/register/options');
  expect(o.status, JSON.stringify(o.data)).toBe(200);
  return c.post('/api/auth/passkey/register/verify', { response: auth.create(o.data.options), label });
}
/** A complete passkey sign-in on a fresh client. */
async function passkeySignIn(auth: SoftAuthenticator, username?: string) {
  const c = new Client();
  const o = await c.post('/api/auth/passkey/login/options', username ? { username } : {});
  expect(o.status).toBe(200);
  const v = await c.post('/api/auth/passkey/login/verify', { response: auth.get(o.data.options) });
  return { c, v, options: o.data.options };
}
const makeStale = (u: string) =>
  sql(`UPDATE lms.login_session SET started_at = now() - interval '2 hours', reauth_at = NULL WHERE user_id = ${uid(u)} AND ended_at IS NULL`);
const dropPasskeys = (u: string) => sql(`DELETE FROM iam.mfa_webauthn WHERE user_id = ${uid(u)}`);   // as the system actor

beforeAll(() => {
  // The deliberate failures below are counted per address; keep that limit out
  // of the way (test DB only), as the other IAM suites do.
  sql(`UPDATE lms.system_setting SET value='100000' WHERE key='iam.rate_limit_per_ip'`);
  sql(`UPDATE iam.account_security SET failed_count = 0, locked_until = NULL WHERE user_id IN (${uid(USER)}, ${uid(OTHER)})`);
  dropPasskeys(USER); dropPasskeys(OTHER);
});
afterAll(() => { dropPasskeys(USER); dropPasskeys(OTHER); });

describe('passkey options', () => {
  it('registration needs a session, a same-origin request and a recent re-authentication', async () => {
    const anon = new Client();
    expect((await anon.post('/api/auth/passkey/register/options')).status).toBe(401);
    expect((await anon.post('/api/auth/passkey/register/verify', { response: {} })).status).toBe(401);
    expect((await anon.get('/api/auth/passkey')).status).toBe(401);

    const c = await signInAs(USER);
    expect((await c.post('/api/auth/passkey/register/options', {}, { origin: 'https://evil.example' })).status).toBe(403);
    makeStale(USER);
    const stale = await c.post('/api/auth/passkey/register/options');
    expect(stale.status).toBe(403);
    expect(stale.data.code).toBe('reauth_required');
    expect((await c.post('/api/auth/reauth', { password: PW[USER] })).status).toBe(200);

    const ok = await c.post('/api/auth/passkey/register/options');
    expect(ok.status).toBe(200);
    const o = ok.data.options;
    expect(o.rp.id).toBe(RP_ID);
    expect(o.user.name).toBe(USER);
    expect(o.authenticatorSelection).toMatchObject({ residentKey: 'preferred', userVerification: 'required' });
    expect(Array.isArray(o.excludeCredentials)).toBe(true);
  });

  it('sign-in options are the same whether or not the account exists', async () => {
    const shapes: string[] = [];
    for (const body of [{ username: USER }, { username: 'no-such-user-p3' }, {}]) {
      const r = await new Client().post('/api/auth/passkey/login/options', body);
      expect(r.status).toBe(200);
      expect(r.data.options.rpId).toBe(RP_ID);
      expect(r.data.options.userVerification).toBe('required');
      expect(r.data.options.allowCredentials ?? []).toEqual([]);
      shapes.push(JSON.stringify(Object.keys(r.data.options).sort()) + JSON.stringify(Object.keys(r.data).sort()));
    }
    expect(new Set(shapes).size).toBe(1);
  });

  it('a refused sign-in reads the same for an unknown passkey', async () => {
    const stranger = new SoftAuthenticator();
    const c = new Client();
    const o = await c.post('/api/auth/passkey/login/options', { username: 'no-such-user-p3' });
    const r = await c.post('/api/auth/passkey/login/verify', { response: stranger.get(o.data.options) });
    expect(r.status).toBe(401);
    expect(r.data.error).toBe(GENERIC);
    expect(r.setCookie.join(';')).not.toMatch(/lms_session=[^;]+/);
  });

  it('sign-in is rate limited by the existing failure counters, for any username', async () => {
    const probe = `p3-limit-${Date.now()}`;   // no such account
    const limit = Number(sql(`SELECT iam.setting_num('iam.rate_limit_per_user', 10)`));
    sql(`SELECT iam.log_event('login','failure',NULL,'${probe}',NULL,NULL,NULL,NULL,NULL,NULL,NULL,'{"method":"passkey"}'::jsonb)
         FROM generate_series(1, ${limit + 1})`);
    const r = await new Client().post('/api/auth/passkey/login/options', { username: probe });
    expect(r.status).toBe(429);
    expect(r.data.code).toBe('rate_limited');
  });
});

describe('passkey registration, sign-in and verification', () => {
  const key = new SoftAuthenticator();
  let c: Client;

  beforeAll(async () => { dropPasskeys(USER); c = await signInAs(USER); });

  it('registers a passkey with its label and properties, and refuses the same response twice', async () => {
    const o = await c.post('/api/auth/passkey/register/options');
    const response = key.create(o.data.options);
    const r = await c.post('/api/auth/passkey/register/verify', { response, label: '  Work\nlaptop ' });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.passkey).toMatchObject({ label: 'Work laptop', backedUp: false, deviceType: 'singleDevice', transports: ['internal'] });
    expect((await c.post('/api/auth/passkey/register/verify', { response, label: 'again' })).status).toBe(400);   // challenge already used

    const list = await c.get('/api/auth/passkey');
    expect(list.status).toBe(200);
    expect(list.data.passkeys).toHaveLength(1);
    expect(list.data.passkeys[0]).toMatchObject({ label: 'Work laptop', lastUsedAt: null });
    expect(list.data.hasPassword).toBe(true);
    expect(sql(`SELECT count(*) FROM audit.auth_event WHERE event_type='passkey_registered' AND outcome='success' AND user_id=${uid(USER)}`)).not.toBe('0');

    // The same authenticator is listed in excludeCredentials from now on.
    const again = await c.post('/api/auth/passkey/register/options');
    expect(again.data.options.excludeCredentials.map((x: any) => x.id)).toContain(b64(key.id));
  });

  it('refuses a registration signed for another origin', async () => {
    const o = await c.post('/api/auth/passkey/register/options');
    const r = await c.post('/api/auth/passkey/register/verify', { response: new SoftAuthenticator().create(o.data.options, { origin: 'https://evil.example' }) });
    expect(r.status).toBe(400);
  });

  it('signs in without a username (discoverable) and the session counts as multi-factor', async () => {
    const { c: s, v } = await passkeySignIn(key);
    expect(v.status, JSON.stringify(v.data)).toBe(200);
    expect(v.data).toMatchObject({ ok: true, mfaEnrollmentRequired: false, mustChangePassword: false });
    expect(v.setCookie.join(';')).toMatch(/lms_session=/);
    const me = await s.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.data.user.username).toBe(USER);
    expect(me.data.session).toMatchObject({ method: 'passkey', mfaSatisfied: true });
    expect(me.data.mfa.enrolmentOutstanding).toBe(false);
    const listed = (await s.get('/api/auth/passkey')).data.passkeys[0];
    expect(listed.lastUsedAt).not.toBeNull();
  });

  it('signs in username-first, and refuses the passkey for a different username', async () => {
    expect((await passkeySignIn(key, USER.toUpperCase())).v.status).toBe(200);
    const wrong = await passkeySignIn(key, OTHER);
    expect(wrong.v.status).toBe(401);
    expect(wrong.v.data.error).toBe(GENERIC);
  });

  it('rejects a challenge the server never issued', async () => {
    const r = await new Client().post('/api/auth/passkey/login/verify', { response: key.get({ challenge: b64(randomBytes(32)) }) });
    expect(r.status).toBe(401);
    expect(r.data.error).toBe(GENERIC);
  });

  it('rejects a replayed challenge', async () => {
    const c1 = new Client();
    const o = await c1.post('/api/auth/passkey/login/options', {});
    const response = key.get(o.data.options);
    expect((await c1.post('/api/auth/passkey/login/verify', { response })).status).toBe(200);
    const replay = await new Client().post('/api/auth/passkey/login/verify', { response });
    expect(replay.status).toBe(401);
    expect(replay.data.error).toBe(GENERIC);
  });

  it('rejects an assertion made for a foreign origin, and a cross-origin request', async () => {
    const c1 = new Client();
    const o = await c1.post('/api/auth/passkey/login/options', {});
    const r = await c1.post('/api/auth/passkey/login/verify', { response: key.get(o.data.options, { origin: 'https://evil.example' }) });
    expect(r.status).toBe(401);
    expect(r.data.error).toBe(GENERIC);
    const o2 = await c1.post('/api/auth/passkey/login/options', {});
    expect((await c1.post('/api/auth/passkey/login/verify', { response: key.get(o2.data.options) }, { origin: 'https://evil.example' })).status).toBe(403);
  });

  it('refuses a signature counter that did not advance and records a security event', async () => {
    const c1 = new Client();
    // A clone repeats the last counter the server accepted. The soft key's own counter
    // is ahead of it: the refused assertions above (replay, foreign origin) advanced it
    // without the server ever storing those values.
    (key as any).counter = Number(sql(`SELECT sign_count FROM iam.mfa_webauthn WHERE user_id=${uid(USER)}`));
    const o = await c1.post('/api/auth/passkey/login/options', {});
    const r = await c1.post('/api/auth/passkey/login/verify', { response: key.get(o.data.options, { keepCounter: true }) });
    expect(r.status).toBe(401);
    expect(r.data.error).toBe(GENERIC);
    expect(sql(`SELECT count(*) FROM audit.auth_event WHERE event_type='passkey_counter' AND user_id=${uid(USER)} AND occurred_at > now() - interval '5 minutes'`)).not.toBe('0');
  });

  it('refuses a suspended account with the generic error', async () => {
    sql(`UPDATE lms.app_user SET status='Suspended' WHERE username='${USER}'`);
    try {
      const { v } = await passkeySignIn(key);
      expect(v.status).toBe(401);
      expect(v.data.error).toBe(GENERIC);
    } finally { sql(`UPDATE lms.app_user SET status='Active' WHERE username='${USER}'`); }
  });

  it('re-authenticates with a passkey', async () => {
    const { c: s } = await passkeySignIn(key);
    makeStale(USER);
    expect((await s.post('/api/auth/passkey/register/options')).data.code).toBe('reauth_required');
    const o = await s.post('/api/auth/passkey/reauth/options');
    expect(o.status).toBe(200);
    expect(o.data.options.allowCredentials.map((x: any) => x.id)).toEqual([b64(key.id)]);
    // A re-authentication challenge cannot be spent as a sign-in, nor the reverse.
    expect((await new Client().post('/api/auth/passkey/login/verify', { response: key.get(o.data.options) })).status).toBe(401);
    const o2 = await s.post('/api/auth/passkey/reauth/options');
    expect((await s.post('/api/auth/passkey/reauth/verify', { response: key.get(o2.data.options) })).status).toBe(200);
    expect((await s.post('/api/auth/passkey/register/options')).status).toBe(200);
  });
});

describe('passkey removal', () => {
  it('refuses to remove the last way in of a password-less account, then removes once a password exists', async () => {
    dropPasskeys(USER);
    const key = new SoftAuthenticator();
    const c = await signInAs(USER);
    expect((await register(c, key)).status).toBe(200);
    const id = (await c.get('/api/auth/passkey')).data.passkeys[0].id;

    const hash = sql(`SELECT password_hash FROM lms.app_user WHERE username='${USER}'`);
    expect(hash).toMatch(/^\$/);
    sql(`UPDATE lms.app_user SET password_hash = NULL WHERE username='${USER}'`);
    try {
      expect((await c.get('/api/auth/passkey')).data.hasPassword).toBe(false);
      const r = await c.req('DELETE', `/api/auth/passkey?id=${id}`);
      expect(r.status).toBe(409);
      expect(r.data.code).toBe('last_sign_in_method');
      expect(r.data.error).toMatch(/only way to sign in/i);
      expect((await c.get('/api/auth/passkey')).data.passkeys).toHaveLength(1);
    } finally {
      sql(`UPDATE lms.app_user SET password_hash = '${hash.replace(/'/g, "''")}' WHERE username='${USER}'`);
    }

    expect((await c.req('DELETE', '/api/auth/passkey?id=not-a-uuid')).status).toBe(400);
    expect((await c.req('DELETE', '/api/auth/passkey?id=00000000-0000-4000-8000-000000000000')).status).toBe(404);
    makeStale(USER);
    expect((await c.req('DELETE', `/api/auth/passkey?id=${id}`)).data.code).toBe('reauth_required');
    expect((await c.post('/api/auth/reauth', { password: PW[USER] })).status).toBe(200);
    const ok = await c.req('DELETE', `/api/auth/passkey?id=${id}`);
    expect(ok.status).toBe(200);
    expect((await c.get('/api/auth/passkey')).data.passkeys).toHaveLength(0);
    expect(sql(`SELECT count(*) FROM audit.auth_event WHERE event_type='passkey_removed' AND outcome='success' AND user_id=${uid(USER)}`)).not.toBe('0');

    // Someone else's passkey is not yours to remove: it reads as not found.
    const theirs = await signInAs(OTHER);
    expect((await register(theirs, new SoftAuthenticator())).status).toBe(200);
    const theirId = (await theirs.get('/api/auth/passkey')).data.passkeys[0].id;
    expect((await c.req('DELETE', `/api/auth/passkey?id=${theirId}`)).status).toBe(404);
    dropPasskeys(OTHER);
  });
});
