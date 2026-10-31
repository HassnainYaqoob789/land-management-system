// What the sign-in page needs to know about sign-in methods. Client-safe:
// constants and types only (no server imports), so the login page and the
// server routes share one wording.

/** Shown for any sign-in method that is configured but cannot be used now —
 * disabled, never tested, failing its test, or failing at run time. The
 * technical reason is recorded in the security log, never shown. */
export const SIGNIN_UNAVAILABLE_MESSAGE =
  'This sign-in method is currently unavailable due to a technical configuration issue. Please contact your administrator.';

/** A first external sign-in waits for an administrator (iam.provisioning_mode = approval). */
export const PENDING_APPROVAL_MESSAGE = 'Your access request is awaiting administrator approval.';

/** The external account is linked, but the LMS account cannot sign in (suspended, deactivated, or not allowed to). */
export const ACCOUNT_UNAVAILABLE_MESSAGE = 'This account cannot sign in. Please contact your administrator.';

/** The sign-in attempt could not be completed (expired, replayed, tampered or refused by the provider). */
export const SIGNIN_FAILED_MESSAGE = 'Sign-in could not be completed. Please start again.';

export type ProviderKind = 'oidc' | 'saml' | 'ldap';

export interface SigninProvider {
  name: string;
  displayName: string;
  kind: ProviderKind;
  available: boolean;
  /** Where the browser goes to start (OIDC / SAML); null for LDAP, which uses
   * the password form, and for any provider that is unavailable. */
  startUrl: string | null;
}

/** GET /api/auth/options */
export interface SigninOptions {
  local: boolean;
  passkey: boolean;
  providers: SigninProvider[];
}
