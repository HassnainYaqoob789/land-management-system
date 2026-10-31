import { publicRoute } from '@/lib/iam/public';
import { json } from '@/lib/iam/http';
import { signinOptions } from '@/lib/iam/sso/flow';

// What single sign-on actually exists, and nothing more: a protocol is
// "configured" when at least one provider of that kind is available now.
// (GET /api/auth/options is the full answer the sign-in page uses.)
export const GET = publicRoute(async () => {
  const { providers } = await signinOptions();
  const usable = providers.filter((p) => p.available);
  const state = (kind: string) => (usable.some((p) => p.kind === kind) ? 'configured' : 'not configured');
  return json({
    configured_providers: usable.map((p) => ({ name: p.name, display_name: p.displayName, kind: p.kind })),
    protocols: { oidc: state('oidc'), saml: state('saml'), ldap: state('ldap') },
  });
});
