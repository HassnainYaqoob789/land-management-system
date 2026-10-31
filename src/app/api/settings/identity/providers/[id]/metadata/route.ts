import { NextResponse } from 'next/server';
import { HttpError, protect } from '@/lib/iam/http';
import { adminProviderRow, type Provider } from '@/lib/iam/sso/providers';
import { samlMetadata, type SamlConfig } from '@/lib/iam/sso/saml';
import { idOf } from '@/lib/iam/sso/admin';

// The service-provider metadata of a SAML method, for the IdP administrator —
// available while it is still being set up (the public
// /api/auth/saml/<name>/metadata serves enabled methods only).
export const GET = protect({ permission: ['identity_settings', 'read'] }, async (ctx) => {
  const row = await adminProviderRow(ctx.client, idOf(ctx.params?.id));
  if (!row || row.kind !== 'saml') throw new HttpError(404, 'Not found.', 'not_found');
  const p: Provider<SamlConfig> = { id: row.id, kind: 'saml', name: row.name, displayName: row.display_name,
    config: row.config as unknown as SamlConfig, secret: null };
  return new NextResponse(samlMetadata(p), {
    headers: { 'Content-Type': 'application/samlmetadata+xml; charset=utf-8',
               'Content-Disposition': `attachment; filename="${row.name}-sp-metadata.xml"`, 'X-Content-Type-Options': 'nosniff' },
  });
});
