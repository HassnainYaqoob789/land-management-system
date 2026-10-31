import type { NextResponse } from 'next/server';
import { withActor, withoutActor } from '../../db';
import { newToken, sha256 } from '../crypto';
import { finishLogin, mfaPolicy } from '../login';
import { audit, clearBinding } from './providers';
import { outcomePage, redirectTo } from './respond';

// Every external sign-in ends here. The identity provider proved who the
// person is; what they may do comes only from LMS role assignments, and an
// external login gets a role, approval position or province only through a
// group mapping an identity administrator created (iam.provision_external).

export interface ExternalIdentity {
  /** The provider's immutable id for the person (OIDC sub, SAML NameID, LDAP entryUUID). */
  subject: string;
  issuer: string | null;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
  groups: string[];
}
export type Method = 'oidc' | 'saml' | 'ldap';
/** All the completion step needs to know about the provider. */
export type ProviderRef = { id: string; name: string };

export type Provisioned =
  | { status: 'ok'; userId: string; username: string; mfaEnrolled: boolean }
  | { status: 'pending' }
  | { status: 'inactive'; userId: string | null };

const HAS_CONTROL = /[\u0000-\u001f\u007f]/;
const CONTROLS = /[\u0000-\u001f\u007f]/g;
const EMAIL = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i;
const MAX_GROUPS = 300;

/** Bound and clean what a provider asserted before it reaches the database. */
export function cleanIdentity(id: ExternalIdentity): ExternalIdentity {
  const subject = String(id.subject ?? '').trim();
  if (!subject || subject.length > 512 || HAS_CONTROL.test(subject)) throw new Error('the provider did not assert a usable subject');
  const email = id.email && id.email.length <= 254 && EMAIL.test(id.email.trim()) ? id.email.trim().toLowerCase() : null;
  const displayName = id.displayName ? id.displayName.replace(CONTROLS, ' ').trim().slice(0, 200) || null : null;
  const groups = [...new Set((id.groups ?? []).filter((g) => typeof g === 'string')
    .map((g) => g.replace(CONTROLS, '').trim()).filter((g) => g.length > 0 && g.length <= 256))].slice(0, MAX_GROUPS);
  return { subject, issuer: id.issuer ? String(id.issuer).slice(0, 500) : null, email, emailVerified: id.emailVerified === true, displayName, groups };
}

/** Link or request the account, apply group mappings, and check the account
 * may sign in at all. Service and emergency-access accounts never sign in
 * through an external provider. */
export async function provision(p: ProviderRef, raw: ExternalIdentity, method: Method, corr: string,
  net: { ip?: string | null; ua?: string | null } = {}): Promise<Provisioned> {
  const id = cleanIdentity(raw);
  const r = (await withoutActor((c) => c.query('SELECT * FROM iam.provision_external($1, $2, $3, $4, $5, $6, $7::text[])',
    [p.id, id.subject, id.issuer, id.email, id.emailVerified, id.displayName, id.groups]))).rows[0];
  if (r?.status === 'pending') {
    await audit('login', 'denied', { provider: p.id, corr, ...net, meta: { method, reason: 'pending_approval', subject: id.subject } });
    return { status: 'pending' };
  }
  if (r?.status !== 'ok' || !r.user_id) {
    await audit('login', 'suspended', { userId: r?.user_id ?? null, provider: p.id, corr, ...net, meta: { method, reason: 'account_inactive' } });
    return { status: 'inactive', userId: r?.user_id ?? null };
  }
  // Read the account as itself: api.set_actor refuses anything not Active and
  // any service account, and row-level security shows only its own row.
  let acct: { username: string; status: string; is_service_account: boolean; is_break_glass: boolean; mfa_enrolled: boolean; locked: boolean } | undefined;
  try {
    acct = await withActor(r.user_id, async (c) => (await c.query(`
      SELECT u.username::text AS username, u.status, u.is_service_account, coalesce(a.is_break_glass, false) AS is_break_glass,
             coalesce(a.locked_until > now(), false) AS locked,
             (EXISTS (SELECT 1 FROM iam.mfa_totp t WHERE t.user_id = u.id AND t.confirmed_at IS NOT NULL)
              OR EXISTS (SELECT 1 FROM iam.mfa_webauthn w WHERE w.user_id = u.id)) AS mfa_enrolled
        FROM lms.app_user u LEFT JOIN iam.account_security a ON a.user_id = u.id WHERE u.id = $1`, [r.user_id])).rows[0]);
  } catch { acct = undefined; }
  if (!acct || acct.status !== 'Active' || acct.is_service_account || acct.is_break_glass) {
    await audit('login', 'denied', { userId: r.user_id, provider: p.id, corr, ...net, meta: { method, reason: 'account_not_permitted' } });
    return { status: 'inactive', userId: r.user_id };
  }
  // The account's own lockout (e.g. after repeated second-factor failures)
  // applies to every way in, not only to the password.
  if (acct.locked) {
    await audit('login', 'locked_out', { userId: r.user_id, username: acct.username, provider: p.id, corr, ...net, meta: { method } });
    return { status: 'inactive', userId: r.user_id };
  }
  return { status: 'ok', userId: r.user_id, username: acct.username, mfaEnrolled: acct.mfa_enrolled };
}

/** The browser end of OIDC and SAML: a session and a redirect into the
 * application, the MFA step, or a page that says why not. */
export async function finishBrowserSignIn(req: Request, p: ProviderRef, out: Provisioned, method: 'oidc' | 'saml', corr: string): Promise<NextResponse> {
  if (out.status === 'pending') { const res = outcomePage(req, 'pending', corr); clearBinding(res); return res; }
  if (out.status === 'inactive') { const res = outcomePage(req, 'inactive', corr); clearBinding(res); return res; }

  // An account with its own second factor proves it here as after a password:
  // the sign-in page continues with this single-use, five-minute challenge.
  // The fragment never reaches a server log or a Referer header.
  if (out.mfaEnrolled) {
    const token = newToken(32);
    await withoutActor((c) => c.query('SELECT iam.challenge_issue($1, $2, $3, $4::jsonb, $5)',
      [sha256(token), 'mfa_login', out.userId, JSON.stringify({ method, username: out.username, providerId: p.id }), 300]));
    const res = redirectTo(`/login#mfa=${token}`);
    clearBinding(res);
    return res;
  }
  // Otherwise the MFA policy decides whether enrolment is due first.
  const policy = await mfaPolicy(out.userId);
  const session = await finishLogin(req, { userId: out.userId, username: out.username, method, providerId: p.id, mfaMethod: null,
    enrollmentRequired: policy.required, mustChange: false, corr });
  const res = redirectTo(policy.required ? '/account/security' : '/dashboard', session);
  clearBinding(res);
  return res;
}
