import { audit, bindingDigest, bindingFor, describeError, markFailing, markHealthy, oidcRedirectUri, setBinding, type Provider } from '@/lib/iam/sso/providers';
import { issueChallenge, usableProvider, withinRate } from '@/lib/iam/sso/flow';
import { oidcStart, type OidcConfig } from '@/lib/iam/sso/oidc';
import { outcomePage, redirectTo, ssoRoute } from '@/lib/iam/sso/respond';

// Begin an OpenID Connect sign-in: discovery, then a redirect to the
// provider with PKCE (S256), state and nonce. state, nonce and the code
// verifier are kept server-side as a single-use oidc_state challenge bound to
// this browser; nothing secret goes into the URL.
export const GET = ssoRoute(async (req, corr, { name }) => {
  if (!withinRate('oidc:start', 50)) return outcomePage(req, 'busy', corr);
  const p = await usableProvider('oidc', name, corr) as Provider<OidcConfig> | null;
  if (!p) return outcomePage(req, 'unavailable', corr);

  let start;
  try { start = await oidcStart(p, oidcRedirectUri(p.name)); } catch (e) {
    markFailing(p.name);
    console.warn(`[${corr}] OIDC discovery for ${p.name} failed:`, describeError(e));
    await audit('sso_unavailable', 'failure', { provider: p.id, corr, meta: { method: 'oidc', reason: 'discovery' } });
    return outcomePage(req, 'unavailable', corr);
  }
  markHealthy(p.name);

  const binding = bindingFor(req);
  await issueChallenge(start.state, 'oidc_state',
    { provider: p.name, providerId: p.id, nonce: start.nonce, verifier: start.verifier, bind: bindingDigest(binding) }, 600);
  const res = redirectTo(start.url);
  setBinding(res, binding);
  return res;
});
