import { HttpError, json, protect, readJson, str } from '@/lib/iam/http';
import { audit, KINDS, PROVIDER_NAME, storeSecret, type Kind } from '@/lib/iam/sso/providers';
import { SECRET, validateConfig } from '@/lib/iam/sso/registry';
import { displayNameOf, providerViews, secretOf } from '@/lib/iam/sso/admin';

export const GET = protect({ permission: ['identity_settings', 'read'] }, async (ctx) => json({ providers: await providerViews(ctx) }));

// A new provider starts disabled and untested (the provider guard sees to it);
// it can be enabled only after a successful connection test.
export const POST = protect({ permission: ['identity_settings', 'configure'], reauth: true }, async (ctx) => {
  const b = await readJson(ctx.req, 64_000);
  const kind = str(b, 'kind', { max: 10 }) as Kind;
  if (!KINDS.includes(kind)) throw new HttpError(400, 'kind must be oidc, saml or ldap.', 'validation');
  const name = str(b, 'name', { max: 31 });
  if (!PROVIDER_NAME.test(name))
    throw new HttpError(400, 'name must be 2 to 31 lower-case letters, digits or hyphens, starting with a letter (it becomes part of the redirect URL).', 'validation');
  const displayName = displayNameOf(b);
  const config = validateConfig(kind, name, b.config);
  const secret = secretOf(b);
  if (SECRET[kind]?.required && !secret) throw new HttpError(400, `${SECRET[kind]!.label} is required.`, 'validation');

  const secretId = secret && SECRET[kind] ? await storeSecret(ctx.client, name, secret) : null;
  const r = await ctx.client.query(`INSERT INTO iam.auth_provider (kind, name, display_name, config, secret_id)
      VALUES ($1, $2, $3, $4::jsonb, $5) RETURNING id`, [kind, name, displayName, JSON.stringify(config), secretId])
    .catch((e) => { if (e?.code === '23505') throw new HttpError(409, 'A sign-in method with that name already exists.', 'conflict'); throw e; });
  const id = r.rows[0].id as string;
  await audit('provider_created', 'success', { actor: ctx.user.id, provider: id, corr: ctx.correlationId, meta: { kind, name } });
  return json({ ok: true, provider: (await providerViews(ctx, id))[0] }, 201);
});
