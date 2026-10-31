import { protect, json, readJson, HttpError } from '@/lib/iam/http';
import { fail, text, uuid, UUID_RE } from '../../_lib/admin';

// One access review: its items (GET, users:read) and the reviewer's actions
// (POST, users:assign, re-authenticated): decide an item — keep, or revoke
// with a reason, which revokes the assignment at once through the ordinary
// guards — and close the review once every item is decided. Nobody decides
// on their own access (iam.decide_access_review_item refuses it).

function idOf(params: any): string {
  const id = typeof params?.id === 'string' ? params.id : '';
  if (!UUID_RE.test(id)) throw new HttpError(404, 'No such access review.', 'not_found');
  return id.toLowerCase();
}

export const GET = protect({ permission: ['users', 'read'] }, async (ctx) => {
  try {
    const id = idOf(ctx.params);
    const review = (await ctx.client.query(
      `SELECT r.id, r.note, r.started_at, lms.user_full_name(r.started_by) AS started_by_name,
              r.completed_at, lms.user_full_name(r.completed_by) AS completed_by_name, r.completion_note,
              ro.code AS role_code, ro.name AS role_name, r.scope_province
       FROM iam.access_review r LEFT JOIN iam.role ro ON ro.id = r.scope_role WHERE r.id = $1`, [id])).rows[0];
    if (!review) throw new HttpError(404, 'No such access review.', 'not_found');
    const items = (await ctx.client.query(
      `SELECT i.id, i.decision, i.reason, i.decided_at, lms.user_full_name(i.decided_by) AS decided_by_name,
              ur.id AS assignment_id, ur.user_id, lms.user_username(ur.user_id)::text AS username,
              lms.user_full_name(ur.user_id) AS full_name, r.code AS role_code, r.name AS role_name,
              ur.scope_province, ur.granted_at, lms.user_full_name(ur.granted_by) AS granted_by_name,
              ur.expires_at, ur.reason AS grant_reason, ur.revoked_at,
              (ur.revoked_at IS NULL AND (ur.expires_at IS NULL OR ur.expires_at > now())) AS active
       FROM iam.access_review_item i
       JOIN iam.user_role ur ON ur.id = i.user_role_id
       JOIN iam.role r ON r.id = ur.role_id
       WHERE i.review_id = $1
       ORDER BY lms.user_full_name(ur.user_id), r.name
       LIMIT 5000`, [id])).rows;
    return json({ review, items, actorId: ctx.user.id, can: { decide: ctx.has('users', 'assign') && !review.completed_at } });
  } catch (e) { return fail(e, ctx.correlationId); }
});

export const POST = protect({ permission: ['users', 'assign'], reauth: true }, async (ctx) => {
  try {
    const id = idOf(ctx.params);
    const b = await readJson(ctx.req, 5_000);
    if (b.action === 'decide') {
      const item = uuid(b, 'item_id', 'review item');
      const decision = b.decision;
      if (decision !== 'keep' && decision !== 'revoke') throw new HttpError(400, 'The decision must be keep or revoke.', 'validation');
      const reason = text(b, 'reason', { min: decision === 'revoke' ? 5 : 0, max: 300, optional: decision === 'keep' });
      const own = (await ctx.client.query(
        `SELECT ur.user_id FROM iam.access_review_item i JOIN iam.user_role ur ON ur.id = i.user_role_id
         WHERE i.id = $1 AND i.review_id = $2`, [item, id])).rows[0];
      if (!own) throw new HttpError(404, 'No such item in this review.', 'not_found');
      if (own.user_id === ctx.user.id)
        throw new HttpError(403, 'You cannot review your own access; another reviewer must decide this item.', 'forbidden');
      await ctx.client.query('SELECT iam.decide_access_review_item($1, $2, $3)', [item, decision, reason || null]);
      return json({ ok: true });
    }
    if (b.action === 'close') {
      const note = text(b, 'note', { max: 500, optional: true });
      await ctx.client.query('SELECT iam.close_access_review($1, $2)', [id, note || null]);
      return json({ ok: true });
    }
    throw new HttpError(400, 'The action must be decide or close.', 'validation');
  } catch (e) { return fail(e, ctx.correlationId); }
});
