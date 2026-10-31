import { protect, json, readJson, HttpError } from '@/lib/iam/http';
import { fail, text, PROVINCE_RE } from '../_lib/admin';
import { ROLE_CODE_RE } from '@/components/roles/model';

// Periodic access reviews (iam.access_review). Reading follows users:read
// (row-level security); starting one needs users:assign and re-authenticates.
// The snapshot is taken by iam.start_access_review in the database.

export const GET = protect({ permission: ['users', 'read'] }, async (ctx) => {
  try {
    const reviews = (await ctx.client.query(
      `SELECT r.id, r.note, r.started_at, lms.user_full_name(r.started_by) AS started_by_name,
              r.completed_at, lms.user_full_name(r.completed_by) AS completed_by_name, r.completion_note,
              ro.code AS role_code, ro.name AS role_name, r.scope_province,
              count(i.id)::int AS items,
              (count(i.id) FILTER (WHERE i.decision IS NULL))::int AS open,
              (count(i.id) FILTER (WHERE i.decision = 'keep'))::int AS kept,
              (count(i.id) FILTER (WHERE i.decision = 'revoke'))::int AS revoked
       FROM iam.access_review r
       LEFT JOIN iam.role ro ON ro.id = r.scope_role
       LEFT JOIN iam.access_review_item i ON i.review_id = r.id
       GROUP BY r.id, ro.code, ro.name
       ORDER BY r.started_at DESC
       LIMIT 100`)).rows;
    return json({ reviews, can: { start: ctx.has('users', 'assign') } });
  } catch (e) { return fail(e, ctx.correlationId); }
});

export const POST = protect({ permission: ['users', 'assign'], reauth: true }, async (ctx) => {
  try {
    const b = await readJson(ctx.req, 5_000);
    const note = text(b, 'note', { min: 5, max: 500, label: 'description' });
    const role = text(b, 'role_code', { max: 31, optional: true, label: 'role' }) || null;
    if (role && !ROLE_CODE_RE.test(role)) throw new HttpError(400, 'Unknown role.', 'validation');
    const province = (text(b, 'province', { max: 3, optional: true }) || '').toUpperCase() || null;
    if (province && !PROVINCE_RE.test(province)) throw new HttpError(400, 'Unknown province.', 'validation');
    if (province && !ctx.provinces.includes(province))
      throw new HttpError(403, `You cannot review province ${province}, which you do not hold.`, 'forbidden');
    const id = (await ctx.client.query('SELECT iam.start_access_review($1, $2, $3) AS id', [note, role, province])).rows[0].id;
    const items = Number((await ctx.client.query('SELECT count(*) AS n FROM iam.access_review_item WHERE review_id = $1', [id])).rows[0].n);
    return json({ id, items }, 201);
  } catch (e) { return fail(e, ctx.correlationId); }
});
