// Environment-derived configuration for the IAM layer. Nothing here has a
// default that would be unsafe in production: a missing key is an error, not
// a fallback to a built-in secret.

export const isProd = process.env.NODE_ENV === 'production';

/** Secure cookies are the default in production; a test harness serving plain
 * HTTP on localhost may set IAM_COOKIE_SECURE=false, and nothing else may. */
export const cookieSecure =
  process.env.IAM_COOKIE_SECURE !== undefined ? process.env.IAM_COOKIE_SECURE === 'true' : isProd;

export const SESSION_COOKIE = cookieSecure ? '__Host-lms_session' : 'lms_session';
export const OIDC_COOKIE = cookieSecure ? '__Host-lms_oidc' : 'lms_oidc';

export function appOrigin(): string {
  const o = process.env.APP_ORIGIN;
  if (!o) throw new Error('APP_ORIGIN is not set (e.g. https://lms.example.com); it is used to validate redirect URIs and request origins');
  return o.replace(/\/$/, '');
}

/** Extra origins accepted on mutating requests besides APP_ORIGIN, from the
 * comma-separated APP_ALLOWED_ORIGINS (e.g. the same server reached by
 * localhost and by LAN IP). Empty by default: nothing is trusted implicitly. */
export function allowedOrigins(): ReadonlySet<string> {
  const extra = (process.env.APP_ALLOWED_ORIGINS || '')
    .split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
  return new Set([appOrigin(), ...extra]);
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

export const ISSUER_NAME = process.env.IAM_TOTP_ISSUER || 'Mari LMS';
export const RP_NAME = process.env.IAM_RP_NAME || 'Mari LMS';
