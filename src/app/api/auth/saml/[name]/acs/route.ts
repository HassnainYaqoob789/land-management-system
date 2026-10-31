import { newToken } from '@/lib/iam/crypto';
import { audit, describeError, type Provider } from '@/lib/iam/sso/providers';
import { issueChallenge, netOf, readCapped, takeChallenge, usableProvider, withinRate } from '@/lib/iam/sso/flow';
import { cleanIdentity } from '@/lib/iam/sso/complete';
import { samlValidate, type SamlConfig } from '@/lib/iam/sso/saml';
import { outcomePage, redirectTo, ssoRoute } from '@/lib/iam/sso/respond';

// Assertion consumer service (HTTP-POST binding). The IdP's page posts here
// from its own origin, so there is no same-origin or CSRF-token check: the
// protection is the signature, the single-use request id and the browser
// binding. A cross-site POST does not carry our SameSite=Lax cookie, so the
// validated identity is parked in a two-minute, single-use challenge and the
// browser is sent to /finish — a same-site navigation that does carry the
// cookie — where the binding is checked and the session made.
const MAX_BODY = 512 * 1024;

export const POST = ssoRoute(async (req, corr, { name }) => {
  const deny = async (reason: string, provider: string | null = null) => {
    await audit('login', 'denied', { provider, corr, ...netOf(req), meta: { method: 'saml', reason } });
    return outcomePage(req, 'failed', corr);
  };
  if (!withinRate('saml:acs', 100)) return outcomePage(req, 'busy', corr);
  if (!(req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/x-www-form-urlencoded')) return deny('not_a_form_post');
  const raw = await readCapped(req, MAX_BODY);
  if (raw === null) return deny('response_too_large');
  const samlResponse = new URLSearchParams(raw).get('SAMLResponse') ?? '';
  if (!samlResponse || !/^[A-Za-z0-9+/=\s]+$/.test(samlResponse)) return deny('no_response');

  const p = await usableProvider('saml', name, corr) as Provider<SamlConfig> | null;
  if (!p) return outcomePage(req, 'unavailable', corr);

  let result;
  try { result = await samlValidate(p, samlResponse); } catch (e) {
    console.warn(`[${corr}] SAML response for ${p.name} refused:`, describeError(e));
    return deny('assertion_invalid', p.id);
  }
  // Single use: the request this response answers is consumed now. A replay
  // of the same (still validly signed) response finds nothing.
  const request = await takeChallenge(result.requestId, 'saml_request');
  if (!request || request.stage !== 'request' || request.provider !== p.name || request.providerId !== p.id)
    return deny('request_unknown_or_used', p.id);

  const identity = cleanIdentity(result.identity);
  // Challenge data is limited to 8 KB; a person in very many groups keeps the
  // first ones (fewer mappings can only mean less access, never more).
  while (JSON.stringify(identity).length > 7000 && identity.groups.length) identity.groups.pop();
  const finish = newToken(32);
  await issueChallenge(finish, 'saml_request',
    { stage: 'assertion', provider: p.name, providerId: p.id, bind: request.bind, identity }, 120);
  return redirectTo(`/api/auth/saml/${p.name}/finish?t=${finish}`);
});
