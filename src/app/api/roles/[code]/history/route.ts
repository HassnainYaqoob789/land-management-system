import { protect, json, HttpError } from '@/lib/iam/http';
import { fail } from '../../_lib/admin';
import { ROLE_CODE_RE, describeRoleEvent, type HistoryRow } from '@/components/roles/model';

// Who changed what about one role, and when: the row audit of the role, its
// permissions and its assignments (iam.role_history, roles:read), newest
// first, paged by ?before=<event id>.

export const GET = protect({ permission: ['roles', 'read'] }, async (ctx) => {
  try {
    const code = typeof ctx.params?.code === 'string' ? ctx.params.code : '';
    if (!ROLE_CODE_RE.test(code)) throw new HttpError(404, 'No such role.', 'not_found');
    const sp = new URL(ctx.req.url).searchParams;
    const limit = Math.min(Math.max(Number(sp.get('limit') || 50) || 50, 1), 200);
    const beforeRaw = sp.get('before');
    if (beforeRaw !== null && !/^\d{1,18}$/.test(beforeRaw)) throw new HttpError(400, 'before must be an event number.', 'validation');
    const rows: HistoryRow[] = (await ctx.client.query(
      'SELECT * FROM iam.role_history($1, $2, $3)', [code, limit + 1, beforeRaw])).rows;
    const page = rows.slice(0, limit);
    return json({
      events: page.map((e) => ({
        id: String(e.event_id), at: e.occurred_at, actor: e.actor_name || e.actor_username || '—', actorUsername: e.actor_username,
        entity: e.entity, action: e.action, summary: describeRoleEvent(e),
      })),
      next: rows.length > limit ? String(page[page.length - 1].event_id) : null,
    });
  } catch (e) { return fail(e, ctx.correlationId); }
});
