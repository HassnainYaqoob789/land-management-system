import { HttpError, json, protect } from '@/lib/iam/http';
import { adminProviderRow, describeError, markHealthy, providerFromRow, type Provider, type TestResult } from '@/lib/iam/sso/providers';
import { testProvider } from '@/lib/iam/sso/registry';
import { idOf, providerViews } from '@/lib/iam/sso/admin';

// Test connection: a real check against the identity provider with the stored
// configuration and secret (never unsaved form values), recorded with
// iam.record_provider_test. Only a passed test of the CURRENT configuration
// lets the provider be enabled; if the configuration changes while the test
// runs, the result is not recorded.
export const POST = protect({ permission: ['identity_settings', 'configure'], reauth: true }, async (ctx) => {
  const id = idOf(ctx.params?.id);
  const row = await adminProviderRow(ctx.client, id);
  if (!row) throw new HttpError(404, 'Not found.', 'not_found');

  let provider: Provider | null = null;
  let result: TestResult;
  try { provider = providerFromRow(row); } catch (e) {
    console.warn(`[${ctx.correlationId}] stored secret for ${row.name} cannot be opened:`, describeError(e));
  }
  if (!provider) result = { ok: false, detail: 'The stored secret cannot be decrypted with the server\'s current keys. Enter it again.' };
  else result = await testProvider(provider);

  const now = (await ctx.client.query('SELECT version FROM iam.auth_provider WHERE id = $1 FOR UPDATE', [id])).rows[0];
  if (!now || now.version !== row.version)
    throw new HttpError(409, 'The sign-in method was changed while it was being tested. Test it again.', 'conflict');
  await ctx.client.query('SELECT iam.record_provider_test($1, $2, $3)', [id, result.ok, result.detail.slice(0, 300)]);
  if (result.ok) markHealthy(row.name);
  return json({ ok: result.ok, detail: result.detail, provider: (await providerViews(ctx, id))[0] });
});
