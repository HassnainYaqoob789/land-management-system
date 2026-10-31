import { randomBytes } from 'node:crypto';
import { SAML, ValidateInResponseTo } from '@node-saml/node-saml';
// Pinned dependency (5.1.0): its own DOM parser, for the unsigned envelope.
import { parseDomFromString, xpath } from '@node-saml/node-saml/lib/xml';
import {
  bool, certificateProblems, choice, describeError, fetchWithTimeout, pem, samlAcsUrl, samlMetadataUrl, text, url,
  type Input, type Provider, type TestResult,
} from './providers';
import type { ExternalIdentity } from './complete';

// SAML 2.0 Web SSO as a service provider: AuthnRequest over HTTP-Redirect,
// Response over HTTP-POST. The assertion must be signed by the configured IdP
// certificate; issuer, audience, recipient, destination, InResponseTo and the
// validity windows are all checked. A request id is accepted once only: the
// ACS route consumes it with iam.challenge_take, so a replayed response fails.

export interface SamlConfig {
  idp_entity_id: string;
  sso_url: string;
  idp_certificate: string;
  sp_entity_id: string;
  nameid_format: 'persistent' | 'unspecified';
  attr_subject: string;      // empty: the NameID is the subject
  attr_email: string;
  attr_name: string;
  attr_groups: string;
  require_signed_response: boolean;   // assertions are always required signed
}

export const SKEW_MS = 60_000;             // clock skew allowed on every time check
const MAX_ASSERTION_AGE_MS = 10 * 60_000;
const NAMEID: Record<SamlConfig['nameid_format'], string> = {
  persistent: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
  unspecified: 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified',
};
const TRANSIENT = 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient';
const BEARER = 'urn:oasis:names:tc:SAML:2.0:cm:bearer';
const ATTR_NAME = /^[^\u0000-\u001f\u007f]{1,200}$/;

export function validateSamlConfig(input: Input, providerName: string): SamlConfig {
  return {
    idp_entity_id: text(input, 'idp_entity_id', 'IdP entity ID', { required: true, max: 500 }),
    sso_url: url(input, 'sso_url', 'IdP single sign-on URL', { protocols: ['https:'], loopbackHttp: true }),
    idp_certificate: pem(input, 'idp_certificate', 'IdP signing certificate', { required: true }),
    sp_entity_id: text(input, 'sp_entity_id', 'SP entity ID', { def: samlMetadataUrl(providerName), max: 500 }),
    nameid_format: choice(input, 'nameid_format', 'NameID format', ['persistent', 'unspecified'] as const, 'persistent'),
    attr_subject: text(input, 'attr_subject', 'Subject attribute', { max: 200, pattern: ATTR_NAME }),
    attr_email: text(input, 'attr_email', 'E-mail attribute', { def: 'email', max: 200, pattern: ATTR_NAME }),
    attr_name: text(input, 'attr_name', 'Display-name attribute', { def: 'displayName', max: 200, pattern: ATTR_NAME }),
    attr_groups: text(input, 'attr_groups', 'Groups attribute', { def: 'groups', max: 200, pattern: ATTR_NAME }),
    require_signed_response: bool(input, 'require_signed_response', false),
  };
}

function samlFor(p: Provider<SamlConfig>, requestId?: string): SAML {
  return new SAML({
    callbackUrl: samlAcsUrl(p.name),
    entryPoint: p.config.sso_url,
    issuer: p.config.sp_entity_id,
    audience: p.config.sp_entity_id,
    idpCert: p.config.idp_certificate,
    idpIssuer: p.config.idp_entity_id,
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: p.config.require_signed_response,
    acceptedClockSkewMs: SKEW_MS,
    maxAssertionAgeMs: MAX_ASSERTION_AGE_MS,
    // InResponseTo is checked below against the database's single-use record.
    validateInResponseTo: ValidateInResponseTo.never,
    identifierFormat: NAMEID[p.config.nameid_format],
    disableRequestedAuthnContext: true,   // the IdP decides how strongly to authenticate (MFA included)
    ...(requestId ? { generateUniqueId: () => requestId } : {}),
  });
}

/** An id that is a valid xs:ID (starts with "_"), 160 random bits. */
export const newRequestId = () => `_${randomBytes(20).toString('hex')}`;

/** The redirect to the IdP, carrying a deflated, signed-over-nothing
 * AuthnRequest whose ID the caller stores as a saml_request challenge. */
export async function samlStart(p: Provider<SamlConfig>): Promise<{ url: string; requestId: string }> {
  const requestId = newRequestId();
  const url = await samlFor(p, requestId).getAuthorizeUrlAsync('', undefined, {});
  return { url, requestId };
}

export class SamlRejected extends Error {}

type Xml = Record<string, any>;
const first = (v: unknown): string | null => {
  const x = Array.isArray(v) ? v[0] : v;
  return typeof x === 'string' && x.trim() ? x.trim() : x && typeof x === 'object' && typeof (x as Xml)._ === 'string' ? (x as Xml)._.trim() : null;
};
const all = (v: unknown): string[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v])
  .map((x) => first(x)).filter((x): x is string => !!x);

function within(now: number, notBefore?: string, notOnOrAfter?: string, requireEnd = false): boolean {
  if (requireEnd && !notOnOrAfter) return false;
  if (notBefore && now + SKEW_MS < Date.parse(notBefore)) return false;
  if (notOnOrAfter && !(now - SKEW_MS < Date.parse(notOnOrAfter))) return false;
  return true;
}

/** Validate a posted SAMLResponse. Returns the identity and the request id it
 * answers; the caller must still consume that id (single use). */
export async function samlValidate(p: Provider<SamlConfig>, samlResponse: string): Promise<{ identity: ExternalIdentity; requestId: string }> {
  // Signature (IdP certificate only), Conditions NotBefore/NotOnOrAfter,
  // AudienceRestriction and assertion age are checked by node-saml.
  const { profile } = await samlFor(p).validatePostResponseAsync({ SAMLResponse: samlResponse });
  if (!profile) throw new SamlRejected('the response carries no assertion');
  // node-saml does not check the issuer of a POSTed response: do it here, on
  // the signed assertion.
  if (profile.issuer !== p.config.idp_entity_id) throw new SamlRejected('the assertion was issued by another entity');

  const acs = samlAcsUrl(p.name);
  const assertion = (profile.getAssertion?.() as Xml | undefined)?.Assertion;
  const subject = assertion?.Subject?.[0];
  const now = Date.now();
  // A bearer confirmation for THIS endpoint, in its window, answering a request.
  const confirmation = (subject?.SubjectConfirmation ?? [] as Xml[])
    .filter((sc: Xml) => sc?.$?.Method === BEARER)
    .map((sc: Xml) => sc?.SubjectConfirmationData?.[0]?.$ as Xml | undefined)
    .find((d: Xml | undefined) => d && d.Recipient === acs && typeof d.InResponseTo === 'string' && d.InResponseTo
      && within(now, d.NotBefore, d.NotOnOrAfter, true));
  if (!confirmation) throw new SamlRejected('no valid bearer confirmation for this service provider');
  const requestId: string = confirmation.InResponseTo;

  // The envelope is not necessarily signed; when it states a destination or a
  // request id, they must agree with the signed assertion.
  const doc = await parseDomFromString(profile.getSamlResponseXml?.() ?? '');
  const attr = (name: string) => xpath.selectAttributes(doc, `/*[local-name()='Response']/@${name}`)[0]?.nodeValue ?? null;
  const destination = attr('Destination');
  if (destination !== null && destination !== acs) throw new SamlRejected('the response was addressed to another endpoint');
  const envelopeRequest = attr('InResponseTo');
  if (envelopeRequest !== null && envelopeRequest !== requestId) throw new SamlRejected('the response and assertion answer different requests');

  const attributes = (profile.attributes ?? {}) as Record<string, unknown>;
  let subjectId: string | null;
  if (p.config.attr_subject) subjectId = first(attributes[p.config.attr_subject]);
  else {
    if (profile.nameIDFormat === TRANSIENT) throw new SamlRejected('a transient NameID cannot identify a person; configure a subject attribute');
    subjectId = profile.nameID ?? null;
  }
  if (!subjectId) throw new SamlRejected('the assertion has no subject');
  return {
    requestId,
    identity: {
      subject: subjectId, issuer: profile.issuer,
      email: first(attributes[p.config.attr_email]),
      emailVerified: false,     // SAML has no verified-e-mail claim: never link by e-mail on it
      displayName: first(attributes[p.config.attr_name]),
      groups: all(attributes[p.config.attr_groups]),
    },
  };
}

/** This service provider's metadata, for the IdP administrator. */
export function samlMetadata(p: Provider<SamlConfig>): string {
  return samlFor(p).generateServiceProviderMetadata(null, null);
}

/** Test connection: the signing certificate is valid today, and the IdP's
 * single sign-on endpoint accepts an AuthnRequest from this service provider
 * (answers with its sign-in page or a redirect, not an error). */
export async function testSaml(p: Provider<SamlConfig>): Promise<TestResult> {
  const problem = certificateProblems(p.config.idp_certificate, 'The IdP signing certificate');
  if (problem) return { ok: false, detail: `${problem}.` };
  let target: string;
  try { target = (await samlStart(p)).url; } catch (e) { return { ok: false, detail: `Could not build an authentication request: ${describeError(e)}` }; }
  try {
    const r = await fetchWithTimeout(target, { redirect: 'manual', headers: { Accept: 'text/html' } });
    await r.body?.cancel().catch(() => {});
    if (r.status >= 200 && r.status < 400)
      return { ok: true, detail: `Signing certificate valid; the IdP accepted an authentication request (HTTP ${r.status}). Give the IdP this SP's metadata: ACS ${samlAcsUrl(p.name)}, entity ID ${p.config.sp_entity_id}.` };
    return { ok: false, detail: `The IdP single sign-on URL answered HTTP ${r.status} to an authentication request.` };
  } catch (e) { return { ok: false, detail: `The IdP single sign-on URL could not be reached: ${describeError(e)}` }; }
}
