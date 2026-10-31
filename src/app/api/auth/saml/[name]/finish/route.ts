import { safeEqual } from '@/lib/iam/crypto';
import { audit, bindingDigest, readBinding, type Provider } from '@/lib/iam/sso/providers';
import { netOf, takeChallenge, usableProvider } from '@/lib/iam/sso/flow';
import { finishBrowserSignIn, provision, type ExternalIdentity } from '@/lib/iam/sso/complete';
import type { SamlConfig } from '@/lib/iam/sso/saml';
import { outcomePage, ssoRoute } from '@/lib/iam/sso/respond';

// Second half of the SAML sign-in (see ../acs/route.ts): a same-site GET that
// carries the browser-binding cookie. The parked identity is taken once; it
// must have been started in this browser.
export const GET = ssoRoute(async (req, corr, { name }) => {
  const deny = async (reason: string, provider: string | null = null) => {
    await audit('login', 'denied', { provider, corr, ...netOf(req), meta: { method: 'saml', reason } });
    return outcomePage(req, 'failed', corr);
  };
  const t = new URL(req.url).searchParams.get('t') ?? '';
  if (!/^[A-Za-z0-9_-]{43}$/.test(t)) return deny('finish_malformed');
  const ch = await takeChallenge(t, 'saml_request');
  if (!ch || ch.stage !== 'assertion' || ch.provider !== name) return deny('finish_unknown_or_used');
  const binding = readBinding(req);
  if (!binding || typeof ch.bind !== 'string' || !safeEqual(bindingDigest(binding), ch.bind)) return deny('not_bound_to_browser', ch.providerId);

  const p = await usableProvider('saml', name, corr) as Provider<SamlConfig> | null;
  if (!p || p.id !== ch.providerId) return outcomePage(req, 'unavailable', corr);
  const out = await provision(p, ch.identity as ExternalIdentity, 'saml', corr, netOf(req));
  return finishBrowserSignIn(req, p, out, 'saml', corr);
});
