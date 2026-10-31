import { HttpError, json, protect, readJson, str } from '@/lib/iam/http';
import { isPolicyKey } from '@/lib/iam/sso/policy-keys';
import { noteOf, routineMessage } from '@/lib/iam/sso/admin';

// Identity and security policy: iam.*, security.*, workflow.admin_override and
// workflow.sod_mode. Read with identity_settings:read; changed only through
// iam.set_policy, which needs identity_settings:configure, validates the value
// and records a policy_changed security event (AUTHZ-16, IAMDB-08).
export const GET = protect({ permission: ['identity_settings', 'read'] }, async (ctx) => {
  const r = await ctx.client.query(`SELECT s.key, s.value, s.value_type, s.description, s.updated_at, s.version,
      lms.user_full_name(s.updated_by) AS updated_by_name
    FROM lms.system_setting s
    WHERE s.key LIKE 'iam.%' OR s.key LIKE 'security.%' OR s.key IN ('workflow.admin_override', 'workflow.sod_mode')
    ORDER BY s.key`);
  return json({ policy: r.rows, canConfigure: ctx.has('identity_settings', 'configure') });
});

export const PUT = protect({ permission: ['identity_settings', 'configure'], reauth: true }, async (ctx) => {
  const b = await readJson(ctx.req, 16_000);
  const key = str(b, 'key', { max: 100 });
  if (!isPolicyKey(key)) throw new HttpError(400, 'That is not an identity or security policy setting.', 'validation');
  if (!('value' in b)) throw new HttpError(400, 'value is required.', 'validation');
  const note = noteOf(b) ?? 'Changed in Settings → Security policy';
  await ctx.client.query('SELECT iam.set_policy($1, $2::jsonb, $3)', [key, JSON.stringify(b.value), note]).catch(routineMessage);
  return json({ ok: true, key, value: b.value });
});
