import { NextResponse } from 'next/server';
import { usableProvider } from '@/lib/iam/sso/flow';
import { samlMetadata, type SamlConfig } from '@/lib/iam/sso/saml';
import type { Provider } from '@/lib/iam/sso/providers';
import { outcomePage, ssoRoute } from '@/lib/iam/sso/respond';

// Service-provider metadata (entity ID, ACS URL, NameID format) for an enabled
// SAML provider, so the IdP can read it by URL. It holds nothing secret. While
// a provider is being set up, administrators download it from
// /api/settings/identity/providers/<id>/metadata instead.
export const GET = ssoRoute(async (req, corr, { name }) => {
  const p = await usableProvider('saml', name, corr) as Provider<SamlConfig> | null;
  if (!p) return outcomePage(req, 'unavailable', corr, 404);
  return new NextResponse(samlMetadata(p), {
    headers: { 'Content-Type': 'application/samlmetadata+xml; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
});
