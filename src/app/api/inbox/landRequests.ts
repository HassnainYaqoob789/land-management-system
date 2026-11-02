import type { Ctx } from '@/lib/iam/http';
import { paged } from '@/lib/paging';

// Land requests in "Approvals & Alerts". They do not use lms.workflow_assignment:
// a request's stage names the position that acts next (see
// api/requests/[id]/transition), so the queue is derived from the stage here,
// with the same position, province and segregation-of-duties rules the
// transition route and the database triggers apply. Row-level security limits
// every row to the caller's provinces; a draft is only ever its author's.

type Q = (text: string, params?: unknown[]) => Promise<{ rows: any[] }>;

/** Who acts at each open stage, and what they do. */
const OPEN_SQL = `
  SELECT * FROM (
    SELECT lr.id, lr.code, lr.province_code, lr.project_id, lr.stage_code, lr.created_by, lr.handed_over_kind,
           p.code AS project_code, p.name AS project_name, lr.purpose, lr.area_acres, lr.required_date, lr.priority,
           lms.user_full_name(lr.created_by) AS requester_name,
           CASE
             WHEN lr.stage_code IN ('Submitted', 'Under Review - Ops') THEN 'Director Operations'
             WHEN lr.stage_code = 'Under Review - Regional'            THEN 'Regional Manager'
             WHEN lr.stage_code = 'Under Review - Land Affairs'        THEN 'DM / TL Land Affairs'
             WHEN lr.stage_code IN ('Approved', 'Handed over')         THEN 'Land Officer (Field)'
             ELSE 'Initiator' END AS assigned_group,
           CASE
             WHEN lr.stage_code IN ('Submitted', 'Under Review - Ops', 'Under Review - Regional', 'Under Review - Land Affairs') THEN 'decide'
             WHEN lr.stage_code = 'Approved'    THEN 'take_up'
             WHEN lr.stage_code = 'Handed over' THEN 'create_acquisition'
             ELSE 'revise' END AS task,
           COALESCE(CASE
             WHEN lr.stage_code IN ('Submitted', 'Under Review - Ops') THEN lr.submitted_at
             WHEN lr.stage_code = 'Under Review - Regional'            THEN lr.director_ops_date
             WHEN lr.stage_code = 'Under Review - Land Affairs'        THEN lr.regional_mgr_date
             WHEN lr.stage_code = 'Approved'                           THEN lr.land_affairs_date
             WHEN lr.stage_code = 'Handed over'                        THEN lr.handed_over_at
           END, lr.updated_at, lr.created_at) AS assigned_at,
           ($1::uuid = ANY (array_remove(ARRAY[lr.director_ops_id, lr.regional_mgr_id, lr.land_affairs_id], NULL))) AS decided_by_me
      FROM lms.land_request lr
      JOIN lms.project p ON p.id = lr.project_id
     WHERE (lr.stage_code IN ('Submitted', 'Under Review - Ops', 'Under Review - Regional', 'Under Review - Land Affairs', 'Approved')
            OR (lr.stage_code = 'Handed over' AND lr.handed_over_kind = 'Acquisition' AND lr.handed_over_record_id IS NULL)
            OR (lr.stage_code = 'Returned' AND lr.created_by = $1::uuid))
       AND ($2::text IS NULL OR lr.province_code = $2::text)
  ) x
  WHERE ($3::text[] IS NULL OR
         (x.task = 'decide' AND x.assigned_group = ANY ($3::text[]) AND x.created_by <> $1::uuid AND NOT x.decided_by_me)
      OR (x.task IN ('take_up', 'create_acquisition') AND 'Land Officer (Field)' = ANY ($3::text[]))
      OR (x.task = 'revise' AND x.created_by = $1::uuid))`;

/**
 * The requester's own requests worth a notice: drafts not sent and returned
 * requests (always, they wait on the requester), and rejected, approved,
 * handed-over and completed ones changed in the last 30 days. The 'Completed'
 * stage and its columns come with migration 0060; they are read through
 * to_jsonb() so this works on a database with or without them.
 */
const ALERTS_SQL = `
  SELECT * FROM (
    SELECT lr.id, lr.code, lr.province_code, lr.project_id, lr.stage_code, lr.handed_over_kind, lr.handed_over_record_code,
           p.code AS project_code, p.name AS project_name, lr.purpose, lr.area_acres,
           lr.updated_at, lr.created_at, lr.handed_over_at,
           (to_jsonb(lr) ->> 'completed_at')::timestamptz AS completed_at,
           to_jsonb(lr) ->> 'completed_comment' AS completed_comment,
           to_jsonb(lr) ->> 'work_stage' AS work_stage,
           CASE lr.stage_code
             WHEN 'Returned' THEN COALESCE(CASE WHEN lr.land_affairs_action = 'RETURNED' THEN lr.land_affairs_comment END,
                                           CASE WHEN lr.regional_mgr_action = 'RETURNED' THEN lr.regional_mgr_comment END,
                                           CASE WHEN lr.director_ops_action = 'RETURNED' THEN lr.director_ops_comment END)
             WHEN 'Rejected' THEN COALESCE(CASE WHEN lr.land_affairs_action = 'REJECTED' THEN lr.land_affairs_comment END,
                                           CASE WHEN lr.regional_mgr_action = 'REJECTED' THEN lr.regional_mgr_comment END,
                                           CASE WHEN lr.director_ops_action = 'REJECTED' THEN lr.director_ops_comment END)
             WHEN 'Approved' THEN lr.land_affairs_comment
             WHEN 'Handed over' THEN lr.handed_over_comment
           END AS decision_comment,
           CASE lr.stage_code
             WHEN 'Returned' THEN lms.user_full_name(COALESCE(CASE WHEN lr.land_affairs_action = 'RETURNED' THEN lr.land_affairs_id END,
                                                              CASE WHEN lr.regional_mgr_action = 'RETURNED' THEN lr.regional_mgr_id END,
                                                              CASE WHEN lr.director_ops_action = 'RETURNED' THEN lr.director_ops_id END))
             WHEN 'Rejected' THEN lms.user_full_name(COALESCE(CASE WHEN lr.land_affairs_action = 'REJECTED' THEN lr.land_affairs_id END,
                                                              CASE WHEN lr.regional_mgr_action = 'REJECTED' THEN lr.regional_mgr_id END,
                                                              CASE WHEN lr.director_ops_action = 'REJECTED' THEN lr.director_ops_id END))
             WHEN 'Approved' THEN lms.user_full_name(lr.land_affairs_id)
             WHEN 'Handed over' THEN lms.user_full_name(lr.handed_over_by)
             WHEN 'Completed' THEN lms.user_full_name(((to_jsonb(lr) ->> 'completed_by'))::uuid)
           END AS decided_by_name
      FROM lms.land_request lr
      JOIN lms.project p ON p.id = lr.project_id
     WHERE lr.created_by = $1::uuid
       AND ($2::text IS NULL OR lr.province_code = $2::text)
       AND lr.stage_code IN ('Draft', 'Returned', 'Rejected', 'Approved', 'Handed over', 'Completed')
  ) x
  WHERE x.stage_code IN ('Draft', 'Returned')
     OR (x.stage_code = 'Completed' AND COALESCE(x.completed_at, x.updated_at) >= now() - interval '30 days')
     OR (x.stage_code IN ('Rejected', 'Approved', 'Handed over') AND x.updated_at >= now() - interval '30 days')
  ORDER BY CASE x.stage_code WHEN 'Returned' THEN 0 WHEN 'Completed' THEN 1 WHEN 'Draft' THEN 3 ELSE 2 END,
           COALESCE(x.completed_at, x.updated_at) DESC
  LIMIT 50`;

const LIMIT = 200;
const TASK_LABEL: Record<string, string> = {
  decide: 'Approve, return or reject',
  take_up: 'Take it up ("Start land work")',
  create_acquisition: 'Create the acquisition',
  revise: 'Make the changes and send it again',
};

/** May this user do the row's task, in the row's own province and project? (mirrors the transition route) */
function mayAct(ctx: Ctx, r: any): boolean {
  const scope = { province: r.province_code, project: r.project_id };
  switch (r.task) {
    case 'decide': return ctx.can('requests', 'approve', scope);
    case 'take_up': return ctx.can('requests', 'create', scope);
    case 'create_acquisition': return ctx.can('requests', 'read', scope) && ctx.can('acquisitions', 'create', { province: r.province_code });
    case 'revise': return ctx.can('requests', 'create', scope);
    default: return false;
  }
}

/** The inbox's queue item shape (same fields as a workflow assignment, plus a link). */
function item(r: any) {
  const days = Math.max(0, Math.floor((Date.now() - new Date(r.assigned_at).getTime()) / 86_400_000));
  const what = [r.purpose, r.project_code, r.area_acres != null ? `${Number(r.area_acres).toLocaleString('en-GB', { maximumFractionDigits: 2 })} ac` : null]
    .filter(Boolean).join(' · ');
  return {
    id: `land_request:${r.id}`,
    kind: 'land_request',
    type_label: 'Land request',
    workflow_code: 'requests',
    record_id: r.id,
    record_code: r.code,
    province_code: r.province_code,
    stage_code: r.stage_code,
    assigned_group: r.assigned_group,
    assigned_at: r.assigned_at,
    assigned_user_name: null,
    summary: `${TASK_LABEL[r.task] ?? ''}${what ? ` — ${what}` : ''}${r.requester_name ? ` (raised by ${r.requester_name})` : ''}`,
    days_waiting: days,
    task: r.task,
    href: `/requests?open=${r.id}`,
  };
}

/** Count after the permission filter: exact when the whole result fitted in one page. */
const totalOf = (raw: any[], kept: any[], total: number) => (raw.length >= total ? kept.length : Math.max(kept.length, total - (raw.length - kept.length)));

function alertOf(r: any) {
  const kind = r.handed_over_kind ? ` (${r.handed_over_kind})` : '';
  const by = r.decided_by_name ? ` by ${r.decided_by_name}` : '';
  const said = r.decision_comment ? `: “${r.decision_comment}”` : '';
  let tone: 'i' | 'w' | 'd' = 'i', title = '', body = '';
  switch (r.stage_code) {
    case 'Draft': tone = 'i'; title = 'Draft not sent yet'; body = 'Saved as a draft. Nobody else sees it until you send it.'; break;
    case 'Returned': tone = 'w'; title = 'Returned to you for changes'; body = `Returned${by}${said}. Change it and send it again.`; break;
    case 'Rejected': tone = 'd'; title = 'Rejected'; body = `Rejected${by}${said}.`; break;
    case 'Approved': tone = 'i'; title = 'Approved — waiting for the Land Officer'; body = `Approved${by}. The Land Officer (Field) of ${r.province_code} takes it up next.`; break;
    case 'Handed over':
      tone = 'i'; title = `Land work started${kind}`;
      body = `Taken up${by}${r.handed_over_record_code ? `; ${r.handed_over_record_code} created` : ''}${r.work_stage ? `; now: ${r.work_stage}` : ''}.`;
      break;
    case 'Completed':
      tone = 'i'; title = 'Land ready';
      body = `The land work is complete${by}${r.completed_comment ? `: “${r.completed_comment}”` : ''}.`;
      break;
  }
  return {
    id: `land_request_alert:${r.id}`,
    kind: 'land_request',
    record_id: r.id,
    record_code: r.code,
    province_code: r.province_code,
    stage_code: r.stage_code,
    tone, title, body,
    project: [r.project_code, r.project_name].filter(Boolean).join(' — '),
    at: r.stage_code === 'Completed' ? (r.completed_at ?? r.updated_at) : (r.updated_at ?? r.created_at),
    href: `/requests?open=${r.id}`,
  };
}

export interface LandRequestInbox {
  mine: any[]; mine_total: number;
  open: any[]; open_total: number;
  alerts: any[];
}

const EMPTY: LandRequestInbox = { mine: [], mine_total: 0, open: [], open_total: 0, alerts: [] };

/** Land-request queue items and the requester's notices. Nothing at all without requests:read. */
export async function landRequestInbox(ctx: Ctx, query: Q, province: string | null, groups: string[]): Promise<LandRequestInbox> {
  if (!ctx.has('requests', 'read')) return EMPTY;
  const lim = { limit: LIMIT, offset: 0 };
  const readable = (r: any) => ctx.can('requests', 'read', { province: r.province_code, project: r.project_id });

  // One request, one transaction, one connection: the queries run one after another.
  const mineRes = await paged(query, OPEN_SQL, [ctx.user.id, province, groups], 'assigned_at ASC', lim);
  const openRes = await paged(query, OPEN_SQL, [ctx.user.id, province, null], 'assigned_at ASC', lim);
  const alertsRes = await query(ALERTS_SQL, [ctx.user.id, province]);
  const mine = mineRes.rows.filter((r) => readable(r) && mayAct(ctx, r));
  const open = openRes.rows.filter(readable);
  return {
    mine: mine.map(item), mine_total: totalOf(mineRes.rows, mine, mineRes.page.total),
    open: open.map(item), open_total: totalOf(openRes.rows, open, openRes.page.total),
    alerts: alertsRes.rows.filter(readable).map(alertOf),
  };
}
