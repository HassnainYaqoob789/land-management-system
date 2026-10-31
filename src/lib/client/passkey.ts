// Browser side of passkeys (WebAuthn). The ceremony runs in @simplewebauthn/browser;
// every decision is the server's. Same-origin writes pick up the CSRF header from
// the Shell's fetch wrapper; the sign-in calls need none (no session yet).
import { browserSupportsWebAuthn, startAuthentication, startRegistration, WebAuthnError } from '@simplewebauthn/browser';

export interface PasskeyInfo {
  id: string; label: string; createdAt: string; lastUsedAt: string | null;
  backedUp: boolean | null; deviceType: 'singleDevice' | 'multiDevice' | null; transports: string[];
}
export interface PasskeyList { available: boolean; passkeys: PasskeyInfo[]; authenticatorApp: boolean; hasPassword: boolean }

/** An error with the server's (or the browser's) reason, and its code when there is one. */
export class PasskeyError extends Error {
  constructor(message: string, public code?: string) { super(message); this.name = 'PasskeyError'; }
}

/** This browser can create and use passkeys (WebAuthn in a secure context). */
export function passkeySupported(): boolean {
  if (typeof window === 'undefined' || !window.isSecureContext) return false;
  try { return browserSupportsWebAuthn(); } catch { return false; }
}

const NOT_SUPPORTED = 'This browser or device does not support passkeys. Use your password instead.';

/** What a person should read when the browser part of the ceremony fails. */
function ceremonyMessage(e: unknown, registering: boolean): string {
  const code = e instanceof WebAuthnError ? e.code : undefined;
  const name = (e as { name?: string })?.name;
  if (code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED' || (registering && name === 'InvalidStateError'))
    return 'This device already holds a passkey for your account.';
  if (code === 'ERROR_INVALID_DOMAIN' || code === 'ERROR_INVALID_RP_ID' || name === 'SecurityError')
    return 'Passkeys cannot be used at this address. Contact your administrator.';
  if (code === 'ERROR_AUTHENTICATOR_MISSING_USER_VERIFICATION_SUPPORT' || code === 'ERROR_AUTHENTICATOR_MISSING_DISCOVERABLE_CREDENTIAL_SUPPORT')
    return 'This device or security key cannot be used as a passkey here. Use another device, or your password.';
  if (name === 'NotAllowedError' || code === 'ERROR_CEREMONY_ABORTED')
    return registering ? 'The passkey was not created: the request was cancelled or timed out.'
      : 'The passkey request was cancelled or timed out. Try again, or use your password.';
  return registering ? 'Your device could not create a passkey. Try again.' : 'Your device could not use a passkey. Try again, or use your password.';
}

async function call(url: string, body: unknown, method = 'POST'): Promise<{ ok: boolean; status: number; data: any }> {
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

const serverError = (d: any, fallback: string) => new PasskeyError(typeof d?.error === 'string' ? d.error : fallback, typeof d?.code === 'string' ? d.code : undefined);

/** Sign in with a passkey: discoverable (no username) or username-first. On
 * success the server has set the session cookie; the result has the same
 * fields as a password sign-in. */
export async function signInWithPasskey(username?: string): Promise<
  { ok: true; mfaEnrollmentRequired: boolean; mustChangePassword: boolean } | { ok: false; error: string }> {
  if (!passkeySupported()) return { ok: false, error: NOT_SUPPORTED };
  let opt;
  try { opt = await call('/api/auth/passkey/login/options', username ? { username } : {}); }
  catch { return { ok: false, error: 'The server could not be reached. Check your connection and try again.' }; }
  if (!opt.ok || !opt.data?.options) return { ok: false, error: opt.data?.error || 'Passkey sign-in is not available right now. Use your password.' };
  let response;
  try { response = await startAuthentication({ optionsJSON: opt.data.options }); }
  catch (e) { return { ok: false, error: ceremonyMessage(e, false) }; }
  let v;
  try { v = await call('/api/auth/passkey/login/verify', { response }); }
  catch { return { ok: false, error: 'The server could not be reached. Check your connection and try again.' }; }
  if (!v.ok) return { ok: false, error: v.data?.error || 'Sign-in failed. Try again.' };
  return { ok: true, mfaEnrollmentRequired: !!v.data.mfaEnrollmentRequired, mustChangePassword: !!v.data.mustChangePassword };
}

/** Add a passkey to the signed-in account. Throws PasskeyError with a message
 * to show (code 'reauth_required' when the server wants identity confirmed first). */
export async function registerPasskey(label: string): Promise<void> {
  if (!passkeySupported()) throw new PasskeyError(NOT_SUPPORTED, 'not_supported');
  const opt = await call('/api/auth/passkey/register/options', {});
  if (!opt.ok || !opt.data?.options) throw serverError(opt.data, 'Could not start adding a passkey.');
  let response;
  try { response = await startRegistration({ optionsJSON: opt.data.options }); }
  catch (e) { throw new PasskeyError(ceremonyMessage(e, true), 'ceremony'); }
  const v = await call('/api/auth/passkey/register/verify', { response, label });
  if (!v.ok) throw serverError(v.data, 'The passkey could not be added. Try again.');
}

/** "Confirm it's you" with a passkey. True when the server accepted it. */
export async function reauthWithPasskey(): Promise<boolean> {
  if (!passkeySupported()) return false;
  const opt = await call('/api/auth/passkey/reauth/options', {});
  if (!opt.ok || !opt.data?.options) return false;
  let response;
  try { response = await startAuthentication({ optionsJSON: opt.data.options }); }
  catch { return false; }
  const v = await call('/api/auth/passkey/reauth/verify', { response });
  return v.ok;
}

/** Your passkeys, and the other factors on the account. */
export async function listPasskeys(): Promise<PasskeyList> {
  const r = await fetch('/api/auth/passkey');
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw serverError(d, 'Could not load your passkeys.');
  return d as PasskeyList;
}

/** Remove one of your passkeys. Throws PasskeyError ('reauth_required',
 * 'last_sign_in_method', …) with the server's message. */
export async function removePasskey(id: string): Promise<void> {
  const r = await call(`/api/auth/passkey?id=${encodeURIComponent(id)}`, undefined, 'DELETE');
  if (!r.ok) throw serverError(r.data, 'The passkey could not be removed.');
}
