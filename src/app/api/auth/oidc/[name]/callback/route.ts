import { audit, bindingDigest, describeError, oidcRedirectUri, readBinding, type Provider } from '@/lib/iam/sso/providers';
import { netOf, takeChallenge, usableProvider } from '@/lib/iam/sso/flow';
import { oidcCallback, type OidcConfig } from '@/lib/iam/sso/oidc';
import { finishBrowserSignIn, provision } from '@/lib/iam/sso/complete';
import { outcomePage, ssoRoute } from '@/lib/iam/sso/respond';
import { safeEqual } from '@/lib/iam/crypto';

// The provider sends the browser back here with ?code&state (or ?error).
// The state is consumed first, so it works once only whatever happens next;
// then it must belong to this provider and to this browser, and the code is
// exchanged with the PKCE verifier and checked against the expected state and
// nonce. Only then does the identity reach iam.provision_external.
export const GET = ssoRoute(async (req, corr, { name }) => {
  const q = new URL(req.url).searchParams;
  const deny = async (reason: string, provider: string | null = null, extra: Record<string, unknown> = {}) => {
    await audit('login', 'denied', { provider, corr, ...netOf(req), meta: { method: 'oidc', reason, ...extra } });
    return outcomePage(req, 'failed', corr);
  };

  const state = q.get('state') ?? '';
  const ch = await takeChallenge(state, 'oidc_state');
  if (!ch || ch.provider !== name) return deny('state_unknown_or_used');
  const binding = readBinding(req);
  if (!binding || typeof ch.bind !== 'string' || !safeEqual(bindingDigest(binding), ch.bind)) return deny('state_not_bound_to_browser', ch.providerId);

  const p = await usableProvider('oidc', name, corr) as Provider<OidcConfig> | null;
  if (!p || p.id !== ch.providerId) return outcomePage(req, 'unavailable', corr);
  const idpError = q.get('error');
  if (idpError) return deny('provider_error', p.id, { error_code: idpError.slice(0, 64) });

  let identity;
  try {
    // The URL the provider redirected to, rebuilt on the public origin so it
    // matches the registered redirect URI exactly.
    identity = await oidcCallback(p, new URL(oidcRedirectUri(p.name) + new URL(req.url).search),
      { state, nonce: String(ch.nonce ?? ''), verifier: String(ch.verifier ?? '') });
  } catch (e) {
    console.warn(`[${corr}] OIDC callback for ${p.name} refused:`, describeError(e));
    return deny('token_validation', p.id, { error_code: String((e as any)?.code ?? (e as any)?.error ?? 'error').slice(0, 64) });
  }
  const out = await provision(p, identity, 'oidc', corr, netOf(req));
  return finishBrowserSignIn(req, p, out, 'oidc', corr);
});
