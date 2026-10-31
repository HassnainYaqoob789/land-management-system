import { HttpError, json, protect, readJson } from '@/lib/iam/http';
import { audit } from '@/lib/iam/sso/providers';
import { idOf, providerViews } from '@/lib/iam/sso/admin';

// Enable or disable a sign-in method. The database refuses to enable one whose
// last test (of its current configuration) did not pass, and refuses to
// disable the last way anyone can sign in.
export const PUT = protect({ permission: ['identity_settings', 'configure'], reauth: true }, async (ctx) => {
  const id = idOf(ctx.params?.id);
  const b = await readJson(ctx.req, 1024);
  if (typeof b.enabled !== 'boolean') throw new HttpError(400, 'enabled must be true or false.', 'validation');
  const r = await ctx.client.query('UPDATE iam.auth_provider SET enabled = $2 WHERE id = $1 RETURNING name', [id, b.enabled]).catch((e) => {
    if (e?.code === '23514')
      throw new HttpError(409, 'This sign-in method has not passed a connection test with its current settings. Run "Test connection" first.', 'untested');
    if (e?.code === 'P0001') throw new HttpError(409, String(e.message), 'lockout');
    throw e;
  });
  if (!r.rowCount) throw new HttpError(404, 'Not found.', 'not_found');
  await audit(b.enabled ? 'provider_enabled' : 'provider_disabled', 'success', { actor: ctx.user.id, provider: id, corr: ctx.correlationId });
  return json({ ok: true, provider: (await providerViews(ctx, id))[0] });
});
