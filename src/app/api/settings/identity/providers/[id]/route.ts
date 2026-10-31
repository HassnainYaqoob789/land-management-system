import { HttpError, json, protect, readJson } from '@/lib/iam/http';
import { adminProviderRow, audit, storeSecret } from '@/lib/iam/sso/providers';
import { canonical, SECRET, validateConfig } from '@/lib/iam/sso/registry';
import { displayNameOf, idOf, providerViews, routineMessage, secretOf } from '@/lib/iam/sso/admin';

export const GET = protect({ permission: ['identity_settings', 'read'] }, async (ctx) => {
  const [view] = await providerViews(ctx, idOf(ctx.params?.id));
  if (!view) throw new HttpError(404, 'Not found.', 'not_found');
  return json({ provider: view });
});

// Change a provider. The kind and name are fixed (the name is part of the
// redirect URLs). A changed configuration or secret clears the last test and
// disables the provider until it passes a new one; `enabled` is in the SET
// list so the lockout guard refuses to disable the last way in.
export const PUT = protect({ permission: ['identity_settings', 'configure'], reauth: true }, async (ctx) => {
  const id = idOf(ctx.params?.id);
  const b = await readJson(ctx.req, 64_000);
  const row = await adminProviderRow(ctx.client, id, { lock: true });
  if (!row) throw new HttpError(404, 'Not found.', 'not_found');

  const displayName = b.displayName === undefined ? row.display_name : displayNameOf(b);
  const config = b.config === undefined ? row.config : validateConfig(row.kind, row.name, b.config);
  const secret = secretOf(b);
  if (secret && !SECRET[row.kind]) throw new HttpError(400, 'This kind of sign-in method stores no secret.', 'validation');
  const configChanged = canonical(config) !== canonical(row.config);

  if (!configChanged && !secret) {
    if (displayName !== row.display_name)
      await ctx.client.query('UPDATE iam.auth_provider SET display_name = $2 WHERE id = $1', [id, displayName]);
  } else {
    const secretId = secret ? await storeSecret(ctx.client, row.name, secret) : row.secret_id;
    await ctx.client.query(`UPDATE iam.auth_provider SET display_name = $2, config = $3::jsonb, secret_id = $4, enabled = false WHERE id = $1`,
      [id, displayName, JSON.stringify(config), secretId]).catch(routineMessage);
    await audit('provider_changed', 'success', { actor: ctx.user.id, provider: id, corr: ctx.correlationId,
      meta: { settings_changed: configChanged, rotated: !!secret, was_enabled: row.enabled } });
  }
  return json({ ok: true, retestRequired: configChanged || !!secret, provider: (await providerViews(ctx, id))[0] });
});
