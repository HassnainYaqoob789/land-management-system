import { publicRoute } from '@/lib/iam/public';
import { json } from '@/lib/iam/http';

// Retired. This was a staging "simulator" that signed anyone in by name with
// no identity provider at all. Real single sign-on now exists — OIDC
// (/api/auth/oidc/<name>/start), SAML (/api/auth/saml/<name>/start) and LDAP
// (the password form) — and GET /api/auth/options lists what is configured.
// A passwordless sign-in path must not survive behind a switch.
export const GET = publicRoute(async () =>
  json({ error: 'Single sign-on starts from the sign-in page.', code: 'sso_not_configured', options: '/api/auth/options' }, 404));
