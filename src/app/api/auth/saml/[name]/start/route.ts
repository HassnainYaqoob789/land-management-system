import { audit, bindingDigest, bindingFor, describeError, setBinding, type Provider } from '@/lib/iam/sso/providers';
import { issueChallenge, usableProvider, withinRate } from '@/lib/iam/sso/flow';
import { samlStart, type SamlConfig } from '@/lib/iam/sso/saml';
import { outcomePage, redirectTo, ssoRoute } from '@/lib/iam/sso/respond';

// Begin a SAML sign-in: an AuthnRequest over HTTP-Redirect. Its ID is kept as
// a single-use saml_request challenge bound to this browser; the response
// must answer exactly this request, once.
export const GET = ssoRoute(async (req, corr, { name }) => {
  if (!withinRate('saml:start', 50)) return outcomePage(req, 'busy', corr);
  const p = await usableProvider('saml', name, corr) as Provider<SamlConfig> | null;
  if (!p) return outcomePage(req, 'unavailable', corr);
  let start;
  try { start = await samlStart(p); } catch (e) {
    console.warn(`[${corr}] SAML request for ${p.name} could not be built:`, describeError(e));
    await audit('sso_unavailable', 'failure', { provider: p.id, corr, meta: { method: 'saml', reason: 'request' } });
    return outcomePage(req, 'unavailable', corr);
  }
  const binding = bindingFor(req);
  await issueChallenge(start.requestId, 'saml_request',
    { stage: 'request', provider: p.name, providerId: p.id, bind: bindingDigest(binding) }, 600);
  const res = redirectTo(start.url);
  setBinding(res, binding);
  return res;
});
