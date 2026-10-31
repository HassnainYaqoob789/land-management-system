import { HttpError } from '../http';
import { appOrigin } from '../config';
import { describeError, oidcRedirectUri, samlAcsUrl, samlMetadataUrl, type Input, type Kind, type Provider, type TestResult } from './providers';
import { testOidc, validateOidcConfig, type OidcConfig } from './oidc';
import { testSaml, validateSamlConfig, type SamlConfig } from './saml';
import { testLdap, validateLdapConfig, type LdapConfig } from './ldap';

// One place that knows the three provider kinds: how to check a
// configuration, how to test it for real, and what endpoints this
// application gives the identity provider's administrator.

/** OIDC needs a client secret, LDAP a bind password; SAML stores none (the
 * IdP certificate is public and lives in the configuration). */
export const SECRET: Record<Kind, { required: boolean; label: string } | null> = {
  oidc: { required: true, label: 'Client secret' },
  ldap: { required: true, label: 'Bind password' },
  saml: null,
};

export function validateConfig(kind: Kind, name: string, input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'config must be an object.', 'validation');
  const cfg = kind === 'oidc' ? validateOidcConfig(input as Input)
    : kind === 'saml' ? validateSamlConfig(input as Input, name)
    : validateLdapConfig(input as Input);
  return cfg as unknown as Record<string, unknown>;
}

/** A real check against the provider, with the stored configuration and secret. */
export async function testProvider(p: Provider): Promise<TestResult> {
  try {
    if (p.kind === 'oidc') return await testOidc(p as Provider<OidcConfig>, oidcRedirectUri(p.name));
    if (p.kind === 'saml') return await testSaml(p as Provider<SamlConfig>);
    return await testLdap(p as Provider<LdapConfig>);
  } catch (e) {
    return { ok: false, detail: `The test could not run: ${describeError(e)}` };
  }
}

/** What the IdP administrator must be told about this application. */
export function endpointsFor(kind: Kind, name: string, config: Record<string, unknown>): Record<string, string> {
  try {
    appOrigin();
  } catch { return {}; }
  if (kind === 'oidc') return { redirectUri: oidcRedirectUri(name) };
  if (kind === 'saml') return { acsUrl: samlAcsUrl(name), spEntityId: String(config.sp_entity_id ?? samlMetadataUrl(name)), metadataUrl: samlMetadataUrl(name) };
  return {};
}

/** Key-order independent JSON, to tell whether a configuration really changed. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as any)[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}
