import { withoutActor } from '../../db';
import { sha256 } from '../crypto';
import { clientIp, userAgent } from '../session';
import type { SigninOptions } from '../signin-methods';
import {
  audit, describeError, isFailing, passkeyAvailable, prerequisitesMet, runtimeProvider, type Kind, type Provider,
} from './providers';

// The pieces every sign-in route repeats: load a usable provider, and keep a
// single-use challenge for the attempt (iam.challenge_issue / challenge_take:
// stored by SHA-256 only, expiring in minutes, consumed atomically).

/** An enabled, tested provider of this kind that can run here, or null. The
 * reason it cannot is logged, never shown. */
export async function usableProvider(kind: Kind, name: string, corr: string): Promise<Provider | null> {
  if (!prerequisitesMet(kind)) {
    await audit('sso_unavailable', 'failure', { corr, meta: { method: kind, reason: 'server_configuration' } });
    return null;
  }
  let p: Provider | null;
  try { p = await runtimeProvider(name); } catch (e) {
    console.error(`[${corr}] provider ${name} could not be opened:`, describeError(e));
    await audit('sso_unavailable', 'failure', { corr, meta: { method: kind, reason: 'secret_unreadable' } });
    return null;
  }
  if (!p || p.kind !== kind) return null;
  return p;
}

// Starting a sign-in writes a challenge and an assertion costs a signature
// check, both before anyone is known: cap them per server process. The key is
// fixed (kind and step), never taken from the request.
const recent = new Map<string, number[]>();
export function withinRate(key: `${Kind}:${'start' | 'acs'}`, max: number, windowMs = 10_000): boolean {
  const now = Date.now();
  const hits = (recent.get(key) ?? []).filter((t) => now - t < windowMs);
  const ok = hits.length < max;
  if (ok) hits.push(now);
  recent.set(key, hits);
  return ok;
}

/** The request body as text, refusing more than `max` bytes even when no
 * Content-Length was sent (chunked). */
export async function readCapped(req: Request, max: number): Promise<string | null> {
  if (Number(req.headers.get('content-length') ?? 0) > max) return null;
  if (!req.body) return '';
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel().catch(() => {}); return null; }
    parts.push(value);
  }
  return Buffer.concat(parts).toString('utf8');
}

/** Source address (behind a trusted proxy only) and user agent, for the security log. */
export const netOf = (req: Request) => ({ ip: clientIp(req), ua: userAgent(req) });

export type ChallengePurpose = 'oidc_state' | 'saml_request';

export async function issueChallenge(token: string, purpose: ChallengePurpose, data: Record<string, unknown>, ttlSeconds: number): Promise<void> {
  await withoutActor((c) => c.query('SELECT iam.challenge_issue($1, $2, NULL, $3::jsonb, $4)',
    [sha256(token), purpose, JSON.stringify(data), ttlSeconds]));
}

/** Find and consume in one statement: true exactly once per token. */
export async function takeChallenge(token: string, purpose: ChallengePurpose): Promise<Record<string, any> | null> {
  if (!token || token.length > 256) return null;
  const r = await withoutActor((c) => c.query('SELECT data FROM iam.challenge_take($1, $2)', [sha256(token), purpose]));
  return r.rows[0]?.data ?? null;
}

/** GET /api/auth/options: every configured provider, each marked available
 * or not, and nothing about its configuration. */
export async function signinOptions(): Promise<SigninOptions> {
  return withoutActor(async (c) => {
    const local = (await c.query(`SELECT iam.setting_txt('iam.local_login_enabled', 'true') AS v`)).rows[0].v === 'true';
    const rows = (await c.query('SELECT name, display_name, kind, available FROM iam.signin_methods()')).rows;
    return {
      local,
      passkey: passkeyAvailable(),
      providers: rows.map((p: any) => {
        const kind = p.kind as Kind;
        const available = p.available === true && prerequisitesMet(kind) && !isFailing(p.name);
        return {
          name: p.name, displayName: p.display_name, kind, available,
          startUrl: available && kind !== 'ldap' ? `/api/auth/${kind}/${encodeURIComponent(p.name)}/start` : null,
        };
      }),
    };
  });
}
