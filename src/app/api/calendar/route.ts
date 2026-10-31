import { NextResponse } from 'next/server';
import { protect, toResponse } from '@/lib/iam/http';

// Dated events for the calendar: lease expiries, ROW renewals, court hearings
// and land-request due dates, from 30 days ago to a year ahead, at most 500.
// Each kind is included only for a user who may read that register, and every
// row comes through row-level security (province scope).
const KINDS: { perm: [string, string]; kind: string; sql: string }[] = [
  { perm: ['leases', 'read'], kind: 'Lease Expiry', sql: `SELECT 'lease-' || lease_id AS id, end_date AS date, 'Lease Expiry' AS kind, lease_code::text AS code,
      project_name || coalesce(' · ' || lessors, '') AS title, province_code, lease_status AS status, '/leases' AS href
      FROM api.v_lease_register WHERE end_date IS NOT NULL` },
  { perm: ['rows', 'read'], kind: 'ROW Renewal', sql: `SELECT 'row-' || row_id, next_renewal_date, 'ROW Renewal', row_code::text,
      coalesce(segment_name, row_type) || ' (' || project_code || ')', province_code, stage_code, '/rows'
      FROM api.v_row_renewal_schedule WHERE next_renewal_date IS NOT NULL` },
  { perm: ['legal', 'read'], kind: 'Court Hearing', sql: `SELECT 'legal-' || id, next_hearing, 'Court Hearing', code::text,
      court || ': ' || coalesce(parties, court_case_no, ''), province_code, CASE WHEN stay_order THEN 'Stay order' ELSE status END, '/legal'
      FROM lms.legal_case WHERE next_hearing IS NOT NULL` },
  { perm: ['requests', 'read'], kind: 'Land Request', sql: `SELECT 'req-' || r.id, r.required_date, 'Land Request', r.code::text,
      r.purpose || ' — ' || coalesce(p.name, r.concession_name, ''), r.province_code, r.stage_code, '/requests'
      FROM lms.land_request r LEFT JOIN lms.project p ON p.id = r.project_id WHERE r.required_date IS NOT NULL
        AND r.stage_code NOT IN ('Withdrawn', 'Rejected') AND (r.stage_code <> 'Draft' OR r.created_by = util.actor_id())` },
];

export const GET = protect({ authenticatedOnly: true }, async (ctx) => {
  try {
    const province = new URL(ctx.req.url).searchParams.get('province');
    const parts = KINDS.filter((k) => ctx.has(...k.perm)).map((k) => k.sql);
    if (!parts.length) return NextResponse.json({ events: [] });
    const res = await ctx.db.query(
      `SELECT * FROM (${parts.join(' UNION ALL ')}) e(id, date, kind, code, title, province_code, status, href)
        WHERE date BETWEEN current_date - 30 AND current_date + 365
          AND ($1::text IS NULL OR province_code = $1)
        ORDER BY date, kind LIMIT 500`, [province && province !== 'ALL' ? province : null]);
    // A grant limited to one province covers that province's events only.
    const permOf = Object.fromEntries(KINDS.map((k) => [k.kind, k.perm]));
    return NextResponse.json({ events: res.rows.filter((e: any) => ctx.can(...(permOf[e.kind] as [string, string]), { province: e.province_code })) });
  } catch (e) {
    return toResponse(e, ctx.correlationId);
  }
});
