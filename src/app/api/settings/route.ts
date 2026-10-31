import { HttpError, json, protect, readJson, str } from '@/lib/iam/http';
import { isPolicyKey } from '@/lib/iam/sso/policy-keys';
import { noteOf, routineMessage } from '@/lib/iam/sso/admin';

// What the settings and approval-matrix screens read. Identity and security
// policy (iam.*, security.*) — and its change history — goes only to holders of
// identity_settings:read: lockout thresholds, rate limits and which roles may
// skip MFA would help someone pace a password-guessing run (UI-11, AUTHZ-24).
export const GET = protect({ permission: ['settings', 'read'] }, async (ctx) => {
  const showPolicy = ctx.has('identity_settings', 'read');
  const rows = async (sql: string, params: unknown[] = []) => (await ctx.client.query(sql, params)).rows;
  const visible = `($1::boolean OR NOT (key LIKE 'iam.%' OR key LIKE 'security.%'))`;

  const settings = await rows(`SELECT s.*, lms.user_full_name(s.updated_by) AS updated_by_name
    FROM lms.system_setting s WHERE ${visible} ORDER BY s.key`, [showPolicy]);
  const history = await rows(`SELECT sh.*, lms.user_full_name(sh.changed_by) AS changed_by_name
    FROM lms.setting_history sh WHERE ${visible} ORDER BY sh.changed_at DESC LIMIT 100`, [showPolicy]);
  const workflows = await rows('SELECT * FROM lms.workflow ORDER BY code');
  const stages = await rows('SELECT * FROM lms.workflow_stage ORDER BY workflow_code, seq');
  const stepGroups = await rows('SELECT * FROM lms.workflow_step_group ORDER BY workflow_code, to_stage, group_code');
  const matrixHistory = await rows(`SELECT mh.*, lms.user_full_name(mh.changed_by) AS changed_by_name
    FROM lms.workflow_matrix_history mh ORDER BY mh.changed_at DESC LIMIT 100`);
  const groups = await rows('SELECT * FROM lms.approval_group ORDER BY display_order');

  return json({
    settings, setting_history: history, workflows, workflow_stages: stages, workflow_step_groups: stepGroups,
    matrix_history: matrixHistory, approval_groups: groups, policy_visible: showPolicy,
  });
});

const SETTING_KEY = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;

// General configuration and the approval matrix. Identity and security policy
// is refused here: it changes only through PUT /api/settings/policy
// (iam.set_policy, identity_settings:configure), never through api.set_setting
// (AUTHZ-16, IAMDB-08). Every change here is privileged, so it needs a recent
// re-authentication.
export const PUT = protect({ permission: ['settings', 'update'], reauth: true }, async (ctx) => {
  const b = await readJson(ctx.req, 64_000);
  const note = noteOf(b);

  // Which positions approve each workflow stage (api.set_step_groups, 0034).
  if (b.action === 'set_step_groups') {
    const workflow = str(b, 'workflow_code', { max: 64 }), stage = str(b, 'to_stage', { max: 64 });
    const groups = b.groups;
    if (!Array.isArray(groups) || groups.length > 50 || !groups.every((g) => typeof g === 'string' && g.length > 0 && g.length <= 64))
      throw new HttpError(400, 'groups must be a list of approval group codes.', 'validation');
    const r = await ctx.client.query('SELECT api.set_step_groups($1, $2, $3::text[], $4) AS groups', [workflow, stage, groups, note])
      .catch(routineMessage);
    return json({ success: true, groups: r.rows[0].groups });
  }
  if (b.action !== undefined) throw new HttpError(400, 'Unknown action.', 'validation');

  const key = str(b, 'key', { max: 100 });
  if (!SETTING_KEY.test(key)) throw new HttpError(400, 'key is not a setting name.', 'validation');
  if (isPolicyKey(key))
    throw new HttpError(400, 'This is an identity or security policy setting. Change it under Settings → Security policy.', 'policy_setting');
  if (!('value' in b)) throw new HttpError(400, 'value is required.', 'validation');

  await ctx.client.query('SELECT api.set_setting($1, $2::jsonb, $3)', [key, JSON.stringify(b.value), note ?? 'Updated in Settings'])
    .catch(routineMessage);
  return json({ success: true, key, value: b.value });
});
