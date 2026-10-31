import { HttpError, json, protect, readJson, str } from '@/lib/iam/http';
import { audit } from '@/lib/iam/sso/providers';
import { idOf } from '@/lib/iam/sso/admin';

// Group mappings: external group → role, approval position and/or province.
// They are the ONLY way an external sign-in receives any access, and each one
// is explicit. The database refuses a mapping to a privileged role (anything
// sensitive, or that administers users, roles or identity): such roles are
// assigned by hand on the Users screen.
const GROUP = /^[^\u0000-\u001f\u007f]{1,256}$/;

export const POST = protect({ permission: ['identity_settings', 'configure'], reauth: true }, async (ctx) => {
  const b = await readJson(ctx.req, 4096);
  const providerId = idOf(b.providerId);
  const group = str(b, 'externalGroup', { max: 256 }).trim();
  if (!GROUP.test(group)) throw new HttpError(400, 'externalGroup must be 1 to 256 printable characters.', 'validation');
  const roleCode = str(b, 'roleCode', { max: 64, optional: true }) || null;
  const approvalGroup = str(b, 'approvalGroup', { max: 120, optional: true }) || null;
  const province = str(b, 'province', { max: 3, optional: true }) || null;
  if (!roleCode && !approvalGroup && !province)
    throw new HttpError(400, 'Choose a role, an approval position or a province for this group.', 'validation');

  let roleId: string | null = null;
  if (roleCode) {
    roleId = (await ctx.client.query(`SELECT id FROM iam.role WHERE code = $1 AND status = 'active'`, [roleCode])).rows[0]?.id ?? null;
    if (!roleId) throw new HttpError(400, 'That role does not exist or is not active.', 'validation');
  }
  const provider = (await ctx.client.query('SELECT id FROM iam.auth_provider WHERE id = $1', [providerId])).rows[0];
  if (!provider) throw new HttpError(404, 'Not found.', 'not_found');

  const r = await ctx.client.query(`INSERT INTO iam.group_mapping (provider_id, external_group, role_id, approval_group, province_code)
      VALUES ($1, $2, $3, $4, $5) RETURNING id`, [providerId, group, roleId, approvalGroup, province]).catch((e) => {
    if (e?.code === '23505') throw new HttpError(409, 'That mapping already exists.', 'conflict');
    if (e?.code === '23503') throw new HttpError(400, 'That approval position or province does not exist.', 'validation');
    throw e;   // 42501 from the guard carries its own explanation
  });
  await audit('group_mapping_added', 'success', { actor: ctx.user.id, provider: providerId, corr: ctx.correlationId,
    meta: { group, role: roleCode, approval_group: approvalGroup, province } });
  return json({ ok: true, id: r.rows[0].id }, 201);
});

// Removing a mapping stops it applying at the next sign-in; access it already
// granted is revoked on the Users screen, where every revocation is recorded.
export const DELETE = protect({ permission: ['identity_settings', 'configure'], reauth: true }, async (ctx) => {
  const id = idOf(new URL(ctx.req.url).searchParams.get('id'));
  const r = await ctx.client.query('DELETE FROM iam.group_mapping WHERE id = $1 RETURNING provider_id, external_group', [id]);
  if (!r.rowCount) throw new HttpError(404, 'Not found.', 'not_found');
  await audit('group_mapping_removed', 'success', { actor: ctx.user.id, provider: r.rows[0].provider_id, corr: ctx.correlationId,
    meta: { group: r.rows[0].external_group } });
  return json({ ok: true });
});
