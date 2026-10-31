import { createHash } from 'node:crypto';
import * as client from 'openid-client';
import { HttpError } from '../http';
import { choice, describeError, fetchWithTimeout, text, url, type Input, type Provider, type TestResult } from './providers';
import type { ExternalIdentity } from './complete';

// OpenID Connect: authorization code flow with PKCE (S256), state and nonce
// (openid-client v6). openid-client checks the ID token's iss, aud, azp, exp,
// iat and nonce; with non-repudiation checks on it also verifies the token's
// signature against the provider's published keys. The subject is `sub`.

export interface OidcConfig {
  issuer: string;            // https://… exactly as the provider names itself
  client_id: string;
  scopes: string;            // space-separated, must include openid
  groups_claim: string;      // the claim that carries group names
  client_auth: 'client_secret_basic' | 'client_secret_post';
}

const SCOPE = /^[\x21\x23-\x5B\x5D-\x7E]+$/;
const CLAIM = /^[A-Za-z0-9_.:/-]{1,100}$/;

export function validateOidcConfig(input: Input): OidcConfig {
  const scopes = text(input, 'scopes', 'Scopes', { def: 'openid email profile', max: 300 }).split(/\s+/).filter(Boolean);
  if (!scopes.includes('openid')) scopes.unshift('openid');
  if (scopes.length > 20 || !scopes.every((s) => SCOPE.test(s))) throw new HttpError(400, 'Scopes: use space-separated scope names', 'validation');
  return {
    issuer: url(input, 'issuer', 'Issuer', { protocols: ['https:'] }),
    client_id: text(input, 'client_id', 'Client ID', { required: true, max: 200 }),
    scopes: [...new Set(scopes)].join(' '),
    groups_claim: text(input, 'groups_claim', 'Groups claim', { def: 'groups', pattern: CLAIM, hint: 'must be a claim name' }),
    client_auth: choice(input, 'client_auth', 'Client authentication', ['client_secret_basic', 'client_secret_post'] as const, 'client_secret_basic'),
  };
}

// Discovery is cached per provider configuration and secret, so a changed
// setting or secret is never served from the cache.
const cache = new Map<string, { at: number; config: client.Configuration }>();
const CACHE_MS = 10 * 60_000;

function cacheKey(p: Provider<OidcConfig>): string {
  return createHash('sha256').update(JSON.stringify([p.id, p.config, p.secret ?? ''])).digest('hex');
}

async function discover(p: Provider<OidcConfig>): Promise<client.Configuration> {
  if (!p.secret) throw new Error('no client secret is stored');
  const auth = p.config.client_auth === 'client_secret_post' ? client.ClientSecretPost(p.secret) : client.ClientSecretBasic(p.secret);
  return client.discovery(new URL(p.config.issuer), p.config.client_id, undefined, auth,
    { timeout: 8, execute: [client.enableNonRepudiationChecks] });
}

export async function oidcConfiguration(p: Provider<OidcConfig>): Promise<client.Configuration> {
  const key = cacheKey(p);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.config;
  const config = await discover(p);
  cache.set(key, { at: Date.now(), config });
  if (cache.size > 50) cache.delete(cache.keys().next().value!);
  return config;
}

export interface OidcStart { url: string; state: string; nonce: string; verifier: string }

export async function oidcStart(p: Provider<OidcConfig>, redirectUri: string): Promise<OidcStart> {
  const config = await oidcConfiguration(p);
  const state = client.randomState(), nonce = client.randomNonce(), verifier = client.randomPKCECodeVerifier();
  const url = client.buildAuthorizationUrl(config, {
    redirect_uri: redirectUri, scope: p.config.scopes, response_type: 'code', state, nonce,
    code_challenge: await client.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256',
  });
  return { url: url.href, state, nonce, verifier };
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' ? [v] : [];
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

/** The callback: exchange the code (PKCE verifier, expected state and nonce)
 * and read the validated ID token. Groups come from the ID token, or from the
 * userinfo endpoint (checked against the same subject) if the token has none. */
export async function oidcCallback(p: Provider<OidcConfig>, callbackUrl: URL, checks: { state: string; nonce: string; verifier: string }): Promise<ExternalIdentity> {
  const config = await oidcConfiguration(p);
  const tokens = await client.authorizationCodeGrant(config, callbackUrl,
    { pkceCodeVerifier: checks.verifier, expectedState: checks.state, expectedNonce: checks.nonce, idTokenExpected: true });
  const claims = tokens.claims();
  if (!claims?.sub) throw new Error('the ID token has no subject');
  let groups = claims[p.config.groups_claim];
  let email = str(claims.email), name = str(claims.name), verified = claims.email_verified === true;
  if ((groups === undefined || email === null) && tokens.access_token && config.serverMetadata().userinfo_endpoint) {
    const info = await client.fetchUserInfo(config, tokens.access_token, claims.sub);
    if (groups === undefined) groups = info[p.config.groups_claim];
    if (email === null) { email = str(info.email); verified = info.email_verified === true; }
    if (name === null) name = str(info.name);
  }
  return { subject: claims.sub, issuer: claims.iss, email, emailVerified: verified, displayName: name, groups: strings(groups) };
}

/** Test connection, against the provider itself: discovery (the issuer must
 * match exactly), PKCE S256 support, published signing keys, and the client
 * credentials — a code exchange with a deliberately unknown code is answered
 * invalid_grant only after the client has authenticated. */
export async function testOidc(p: Provider<OidcConfig>, redirectUri: string): Promise<TestResult> {
  if (!p.secret) return { ok: false, detail: 'No client secret is stored.' };
  let config: client.Configuration;
  try { config = await discover(p); } catch (e) { return { ok: false, detail: `Discovery failed: ${describeError(e)}` }; }
  const meta = config.serverMetadata();
  if (!meta.authorization_endpoint || !meta.token_endpoint) return { ok: false, detail: 'The provider does not publish authorization and token endpoints.' };
  const pkce = meta.code_challenge_methods_supported;
  if (Array.isArray(pkce) && !pkce.includes('S256')) return { ok: false, detail: 'The provider does not support PKCE with S256.' };
  if (!meta.jwks_uri) return { ok: false, detail: 'The provider publishes no signing keys (jwks_uri).' };
  try {
    const r = await fetchWithTimeout(meta.jwks_uri, { headers: { Accept: 'application/json' } }, 5000);
    const keys = r.ok ? ((await r.json()) as { keys?: unknown[] }).keys : undefined;
    if (!Array.isArray(keys) || keys.length === 0) return { ok: false, detail: 'The provider\'s signing key set is empty or unreadable.' };
  } catch (e) { return { ok: false, detail: `The signing keys could not be fetched: ${describeError(e)}` }; }
  try {
    await client.genericGrantRequest(config, 'authorization_code',
      { code: client.randomState(), redirect_uri: redirectUri, code_verifier: client.randomPKCECodeVerifier() });
    return { ok: false, detail: 'The token endpoint accepted a made-up authorization code; refusing to use this provider.' };
  } catch (e) {
    const x = e as any;
    // With HTTP Basic, a refused client is a 401 challenge (WWW-Authenticate)
    // rather than an error body.
    const challenged = Array.isArray(x?.cause) ? x.cause.map((c: any) => c?.parameters?.error).find(Boolean) : undefined;
    const err = x?.error ?? x?.cause?.error ?? challenged ?? (x?.status === 401 ? 'invalid_client' : undefined);
    if (err === 'invalid_grant')
      return { ok: true, detail: `Discovery OK (issuer ${meta.issuer}), PKCE S256 and signing keys available, client credentials accepted. Register ${redirectUri} as the redirect URI.` };
    if (err === 'invalid_client') return { ok: false, detail: 'The provider refused the client ID or client secret.' };
    if (err === 'unauthorized_client') return { ok: false, detail: 'The client is not allowed to use the authorization code flow.' };
    return { ok: false, detail: `The token endpoint answered unexpectedly: ${describeError(e)}` };
  }
}
