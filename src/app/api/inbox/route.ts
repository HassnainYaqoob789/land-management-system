import { NextResponse } from 'next/server';
import { HttpError, protect, readJson, requireRecord, toResponse, type Ctx } from '@/lib/iam/http';
import { redact } from '@/lib/iam/pii';
import { paged } from '@/lib/paging';
import { WORKFLOW_RESOURCE, WORKFLOW_TABLE } from '@/lib/workflow';
import { landRequestInbox } from './landRequests';

// The approval queue aggregates every module's records, so each section is
// limited to the workflows whose module the caller may read, in the record's
// province (UI-09). A user's own notifications are always theirs to see, so
// the header badge never needs a permission it might not have (UI-13).
// Land requests have no workflow_assignment rows: their queue items and the
// requester's notices come from ./landRequests, gated by requests:read and the
// same position/province rules as the transition route; they are merged into
// "mine" / "assignments" (so the header bell, which counts mine_total, counts
// them) and returned as request_alerts.

const readableWorkflows = (ctx: Ctx) => Object.keys(WORKFLOW_RESOURCE).filter((w) => ctx.has(WORKFLOW_RESOURCE[w], 'read'));
const mayRead = (ctx: Ctx, workflow: string, province: string | null) =>
  !!WORKFLOW_RESOURCE[workflow] && ctx.can(WORKFLOW_RESOURCE[workflow], 'read', { province });

export const GET = protect({ authenticatedOnly: true }, async (ctx) => {
  const { query } = ctx.db;

  try {
    const { searchParams } = new URL(ctx.req.url);
    const province = searchParams.get('province');
    const provParam = province && province !== 'ALL' ? province : null;

    const notificationsRes = await query(
      `SELECT * FROM lms.notification
       WHERE user_id = $1 AND ($2::text IS NULL OR province_code = $2)
       ORDER BY created_at DESC LIMIT 100`,
      [ctx.user.id, provParam]
    );

    // The approval positions this user holds (what the queue is routed by).
    const groups: string[] = (await query(`SELECT coalesce(array_agg(group_code ORDER BY group_code), '{}') AS g FROM lms.app_user_group WHERE user_id = $1`, [ctx.user.id])).rows[0].g;
    // Land requests waiting on this user, and notices on their own requests (none without requests:read).
    const lr = await landRequestInbox(ctx, query, provParam, groups);

    if (!ctx.has('inbox', 'read')) {
      return NextResponse.json(redact({ assignments: lr.open, assignments_total: lr.open_total, mine: lr.mine, mine_total: lr.mine_total,
                    notifications: notificationsRes.rows, request_alerts: lr.alerts,
                    bottlenecks: [], comments: [], user_groups: groups }, ctx));
    }
    const workflows = readableWorkflows(ctx);

    // Open assignments on records this user can see, oldest first. $2 = positions (NULL = all), $3 = readable workflows.
    const base = `SELECT wa.id, wa.workflow_code, wa.record_id, wa.stage_code, wa.assigned_group, wa.assigned_at,
              lms.user_full_name(wa.assigned_user) as assigned_user_name,
              COALESCE(cc.code::text, acq.code::text, mut.code::text, lse.code::text, rowc.code::text, pay.code::text, dbp.code::text, grv.code::text, enc.code::text) as record_code,
              COALESCE(cc.province_code, acq.province_code, mut.province_code, lse.province_code, rowc.province_code, pay.province_code, dbp.province_code, grv.province_code, enc.province_code) as province_code,
              COALESCE(cc.case_remarks, acq.remarks, mut.remarks, lse.obligations, rowc.name, pay.remarks, dbp.remarks, grv.description, enc.description) as summary,
              EXTRACT(DAY FROM (now() - wa.assigned_at))::int as days_waiting
       FROM lms.workflow_assignment wa
       LEFT JOIN lms.compensation_case cc ON wa.workflow_code = 'cases' AND cc.id = wa.record_id
       LEFT JOIN lms.acquisition acq ON wa.workflow_code = 'acquisitions' AND acq.id = wa.record_id
       LEFT JOIN lms.mutation mut ON wa.workflow_code = 'mutations' AND mut.id = wa.record_id
       LEFT JOIN lms.lease lse ON wa.workflow_code = 'leases' AND lse.id = wa.record_id
       LEFT JOIN lms.row_corridor rowc ON wa.workflow_code = 'rows' AND rowc.id = wa.record_id
       LEFT JOIN lms.payment_request pay ON wa.workflow_code = 'payments' AND pay.id = wa.record_id
       LEFT JOIN lms.dbpfc_estimate dbp ON wa.workflow_code = 'dbpfc' AND dbp.id = wa.record_id
       LEFT JOIN lms.grievance grv ON wa.workflow_code = 'grievances' AND grv.id = wa.record_id
       LEFT JOIN lms.encroachment enc ON wa.workflow_code = 'encroachments' AND enc.id = wa.record_id
       WHERE wa.closed_at IS NULL
         -- only records this user can see (row-level security hides the rest, and so must the queue)
         AND COALESCE(cc.id, acq.id, mut.id, lse.id, rowc.id, pay.id, dbp.id, grv.id, enc.id) IS NOT NULL
         AND ($1::text IS NULL OR COALESCE(cc.province_code, acq.province_code, mut.province_code, lse.province_code, rowc.province_code,
                                           pay.province_code, dbp.province_code, grv.province_code, enc.province_code) = $1)
         AND ($2::text[] IS NULL OR wa.assigned_group = ANY ($2::text[]))
         AND wa.workflow_code = ANY ($3::text[])`;
    // Bounded: the 200 oldest of each list, with the full counts.
    const lim = { limit: 200, offset: 0 };
    const all = await paged(query, base, [provParam, null, workflows], 'assigned_at ASC', lim);
    const mine = await paged(query, base, [provParam, groups, workflows], 'assigned_at ASC', lim);
    const visible = (rows: any[]) => rows.filter((r) => mayRead(ctx, r.workflow_code, r.province_code));

    const [bottlenecksRes, commentsRes] = await Promise.all([
      query(
        `SELECT *, waiting_count AS waiting_records FROM api.v_approval_bottleneck
         WHERE ($1::text IS NULL OR province_code = $1) AND workflow_code = ANY ($2::text[])
         ORDER BY waiting_count DESC, max_days_waiting DESC`,
        [provParam, workflows]
      ),
      query(
        `SELECT wc.*, wc.commented_at AS created_at, lms.user_full_name(wc.commented_by) as author_name
         FROM lms.workflow_comment wc
         WHERE wc.retracted_at IS NULL AND wc.workflow_code = ANY ($1::text[])
         ORDER BY wc.commented_at DESC LIMIT 50`,
        [workflows]
      ),
    ]);

    // Oldest first across both kinds of item, as the workflow queue already is.
    const oldest = (a: any, b: any) => new Date(a.assigned_at).getTime() - new Date(b.assigned_at).getTime();
    return NextResponse.json(redact({
      assignments: [...visible(all.rows), ...lr.open].sort(oldest), assignments_total: all.page.total + lr.open_total,
      mine: [...visible(mine.rows), ...lr.mine].sort(oldest), mine_total: mine.page.total + lr.mine_total,
      notifications: notificationsRes.rows,
      request_alerts: lr.alerts,
      bottlenecks: visible(bottlenecksRes.rows),
      comments: visible(commentsRes.rows),
      user_groups: groups,
    }, ctx));
  } catch (error: any) {
    return toResponse(error, ctx.correlationId);
  }
});

export const POST = protect({ authenticatedOnly: true }, async (ctx) => {
  try {
    const body = await readJson(ctx.req);
    const { action, notification_id, workflow_code, record_id, body: commentBody } = body;

    const res = await ctx.db.withTransaction(async (client) => {
      // Notifications are personal: only your own are marked.
      if (action === 'mark_read' && notification_id) {
        await client.query(
          `UPDATE lms.notification SET read_at = COALESCE(read_at, now()) WHERE id = $1 AND user_id = $2`,
          [notification_id, ctx.user.id]
        );
        return { marked: notification_id };
      }

      if (action === 'mark_all_read') {
        await client.query(`UPDATE lms.notification SET read_at = now() WHERE user_id = $1 AND read_at IS NULL`, [ctx.user.id]);
        return { marked_all: true };
      }

      if (action === 'comment') {
        // Writing into an approval discussion is a change to that record: it needs the
        // record's own :update permission for its province (UI-02, AUTHZ-20), not inbox:read.
        const table = typeof workflow_code === 'string' ? WORKFLOW_TABLE[workflow_code] : undefined;
        if (!table) throw new HttpError(400, 'workflow_code is not a workflow.', 'validation');
        if (typeof commentBody !== 'string' || !commentBody.trim()) throw new HttpError(400, 'Write the comment.', 'validation');
        if (commentBody.length > 4000) throw new HttpError(400, 'The comment is too long (4000 characters at most).', 'validation');
        const rec = await requireRecord(ctx, table, record_id, [WORKFLOW_RESOURCE[workflow_code], 'update']);
        // Filed under the record's own province (row-level security then decides who sees it).
        const cRes = await client.query(
          `INSERT INTO lms.workflow_comment (workflow_code, record_id, province_code, commented_by, body)
           VALUES ($1, $2, $3, $4, $5) RETURNING *`,
          [workflow_code, rec.id, rec.province, ctx.user.id, commentBody.trim()]
        );
        return cRes.rows[0];
      }

      throw new HttpError(400, 'Invalid action', 'validation');
    });

    return NextResponse.json({ success: true, result: res });
  } catch (error: any) {
    return toResponse(error, ctx.correlationId);
  }
});
