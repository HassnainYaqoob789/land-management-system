import { likeOf, pageOf, paged, summarize } from '@/lib/paging';
import { NextResponse } from 'next/server';
import { HttpError, protect, readJson, requireLinked, requireRecord, toResponse } from '@/lib/iam/http';
import { redact } from '@/lib/iam/pii';
import { queueFirstStep, reopenForChanges, termsFrozen } from '@/lib/workflow';

// The terms an approval fixes (the database freezes the same list).
const TERMS = ['subsequent_area', 'rate_per_acre', 'escalation_pct'] as const;
const num = (v: unknown) => (v === undefined || v === null || v === '' ? null : Number(v));

const VALID_KINDS = ['Private Land', 'Government Land', 'ROW / Easement'];

function normalizeLeaseKind(kind?: string): string {
  if (!kind) return 'Private Land';
  if (VALID_KINDS.includes(kind)) return kind;
  if (kind.toLowerCase().includes('gov')) return 'Government Land';
  if (kind.toLowerCase().includes('row') || kind.toLowerCase().includes('easement')) return 'ROW / Easement';
  return 'Private Land';
}

export const GET = protect({ permission: ['leases', 'read'] }, async (ctx) => {
  const request = ctx.req;
  const { query } = ctx.db;

  try {
    const { searchParams } = new URL(request.url);
    const province = searchParams.get('province');
    const alertsOnly = searchParams.get('alerts');
    const id = searchParams.get('id');

    if (id) {
      const leaseRes = await query(
        `SELECT lr.*, l.is_on_hold, l.hold_reason, l.hold_placed_at, l.renewal_clause, l.obligations, l.project_id, l.case_id
         FROM api.v_lease_register lr
         JOIN lms.lease l ON l.id = lr.lease_id
         WHERE lr.lease_id = $1`,
        [id]
      );
      if (leaseRes.rows.length === 0) {
        return NextResponse.json({ error: 'Lease not found' }, { status: 404 });
      }
      const renewalsRes = await query(
        `SELECT r.*, lms.user_full_name(r.recorded_by) as recorded_by_name
         FROM lms.lease_renewal r
         WHERE r.lease_id = $1
         ORDER BY r.renewal_no DESC`,
        [id]
      );
      return NextResponse.json(redact({
        lease: leaseRes.rows[0],
        renewals: renewalsRes.rows,
      }, ctx));
    }

    if (alertsOnly === 'true') {
      const alertsRes = await query('SELECT * FROM api.v_lease_expiry_alert ORDER BY days_to_expiry ASC LIMIT 100');
      return NextResponse.json({ alerts: alertsRes.rows });
    }

    let sql = `
      SELECT lr.lease_id, lr.lease_code, lr.province_code, lr.project_code, lr.project_name, lr.case_code,
             lr.kind, lr.registration_no, lr.initial_area, lr.current_area, lr.start_date, lr.term_years,
             lr.end_date, lr.terminated_on, lr.rate_per_acre, lr.escalation_pct, lr.auto_extend,
             lr.stage_code, lr.annual_rent, lr.days_to_expiry, lr.lease_status, lr.renewal_count,
             lr.lessors, lr.parcels,
             l.is_on_hold, l.hold_reason, l.obligations, l.renewal_clause, l.project_id
      FROM api.v_lease_register lr
      JOIN lms.lease l ON l.id = lr.lease_id
      WHERE 1=1
    `;
    const params: any[] = [];

    if (province && province !== 'ALL') {
      params.push(province);
      sql += ` AND lr.province_code = $${params.length}`;
    }
    const project = searchParams.get('project');
    if (project) {
      params.push(project);
      sql += ` AND lr.project_code = $${params.length}`;
    }

    // Register totals for the KPI tiles: the whole register in scope, before the search narrows it.

    const summary = await summarize(query, sql, params, { total: `count(*)`, on_hold: `count(*) FILTER (WHERE is_on_hold OR lease_status = 'On Hold')` });

    const q = (searchParams.get('q') ?? '').trim();

    if (q) { params.push(likeOf(q)); sql += ` AND (lr.lease_code::text ILIKE $${params.length} OR lr.project_name::text ILIKE $${params.length} OR lr.lessors::text ILIKE $${params.length})`; }

    const { rows: resultRows, page } = await paged(query, sql, params, `lr.start_date DESC`, pageOf(searchParams));

    const result = { rows: resultRows };
    // The soonest 20 for the alert strip, and how many there are in all (in the province shown).
    const prov = province && province !== 'ALL' ? province : null;
    const alerts = await query(`SELECT * FROM api.v_lease_expiry_alert WHERE ($1::text IS NULL OR province_code = $1) ORDER BY days_to_expiry ASC LIMIT 20`, [prov]);
    const alertsTotal = Number((await query(`SELECT count(*) AS n FROM api.v_lease_expiry_alert WHERE ($1::text IS NULL OR province_code = $1)`, [prov])).rows[0].n);

    return NextResponse.json(redact({ page, summary,
      leases: result.rows,
      alerts: alerts.rows,
      alerts_total: alertsTotal,
    }, ctx));
  } catch (error: any) {
    return toResponse(error, ctx.correlationId);
  }
});

export const POST = protect({ permission: ['leases', 'create'] }, async (ctx) => {
  const request = ctx.req;
  const { withTransaction } = ctx.db;
  const user = ctx.legacyUser;

  try {
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await readJson(request);
    const {
      project_id,
      case_id,
      kind,
      registration_no,
      initial_area,
      subsequent_area,
      start_date,
      term_years,
      annual_rent,
      rate_per_acre,
      escalation_pct,
      auto_extend,
      renewal_clause,
      obligations,
      lessor_ids,
      survey_ids,
    } = body;
    // stage_code is not read: a lease starts at the first stage of its workflow
    // and is approved through it (AUTHZ-02; the database forces the same).

    if (!project_id || !start_date || !term_years) {
      return NextResponse.json({ error: 'Missing mandatory lease parameters', code: 'validation' }, { status: 400 });
    }

    const created = await withTransaction(async (client) => {
      const proj = await requireRecord(ctx, 'project', project_id, ['leases', 'create']);
      const prov = proj.province as string;
      const surveys = await requireLinked(ctx, 'survey', survey_ids, prov, 'survey');
      const lessors = await requireLinked(ctx, 'landowner', lessor_ids, prov, 'landowner');
      if (case_id) await requireLinked(ctx, 'compensation_case', [case_id], prov, 'compensation case');
      // Created from a land request handed over for a lease: link the request to this lease, once.
      let fromRequest: any = null;
      if (body.land_request_id) {
        fromRequest = (await requireRecord(ctx, 'land_request', String(body.land_request_id), ['requests', 'read'], { forUpdate: true })).row;
        if (fromRequest.stage_code !== 'Handed over' || fromRequest.handed_over_kind !== 'Lease')
          throw new HttpError(409, 'That land request was not handed over for a lease.', 'state');
        if (fromRequest.handed_over_record_id)
          throw new HttpError(409, `A record (${fromRequest.handed_over_record_code}) was already created from that land request.`, 'state');
        if (fromRequest.province_code !== prov) throw new HttpError(400, "The project must be in the land request's province.", 'validation');
      }

      const codeRes = await client.query("SELECT lms.next_code('LSE-') as code");
      const leaseCode = codeRes.rows[0].code;

      // The agreed area and rate come from the agreement: the area as given, or the
      // parcels' area; the rate as given, or the annual rent over the area. Nothing is assumed.
      let areaNum = Number(initial_area);
      if ((!areaNum || areaNum <= 0) && surveys.length > 0) {
        const sAreaRes = await client.query(
          'SELECT COALESCE(SUM(total_area), 0) AS total_area FROM lms.survey WHERE id = ANY($1::uuid[])',
          [surveys]
        );
        areaNum = Number(sAreaRes.rows[0]?.total_area || 0);
      }
      if (!(areaNum > 0)) throw new HttpError(400, 'Give the leased area (or the parcels it covers).', 'validation');

      let rateNum = Number(rate_per_acre);
      if (!(rateNum > 0)) {
        const rentNum = Number(annual_rent);
        if (!(rentNum > 0)) throw new HttpError(400, 'Give the rate per acre or the annual rent.', 'validation');
        rateNum = Math.round((rentNum / areaNum) * 100) / 100;
      }
      const esc = escalation_pct === undefined || escalation_pct === '' ? 10.0 : Number(escalation_pct);
      if (!(esc >= 0 && esc <= 100)) throw new HttpError(400, 'escalation_pct must be between 0 and 100.', 'validation');

      const normalizedKind = normalizeLeaseKind(kind);

      const leaseRes = await client.query(
        `INSERT INTO lms.lease (
          code, province_code, project_id, case_id, kind, registration_no,
          initial_area, subsequent_area, start_date, term_years, rate_per_acre,
          escalation_pct, auto_extend, renewal_clause, obligations, stage_code,
          created_by, updated_by
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10, $11,
          $12, $13, $14, $15, $16,
          $17, $17
        ) RETURNING *`,
        [
          leaseCode,
          prov,
          project_id,
          case_id || null,
          normalizedKind,
          registration_no || null,
          areaNum,
          subsequent_area ? Number(subsequent_area) : null,
          start_date,
          Number(term_years),
          rateNum,
          esc,
          Boolean(auto_extend),
          renewal_clause || null,
          obligations || null,
          'Draft',
          user.id,
        ]
      );
      const newLease = leaseRes.rows[0];
      await queueFirstStep(client, 'leases', newLease.id);
      if (fromRequest)
        await client.query(
          `UPDATE lms.land_request SET handed_over_record_id = $1, handed_over_record_code = $2, work_stage = $3, work_stage_at = now(),
                  updated_at = now(), updated_by = $4 WHERE id = $5`,
          [newLease.id, newLease.code, newLease.stage_code, user.id, fromRequest.id]);

      for (const lid of lessors) {
        await client.query(
          `INSERT INTO lms.lease_lessor (lease_id, landowner_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [newLease.id, lid]
        );
      }

      // A parcel is blocked against other leases only once this lease is approved.
      for (const sid of surveys) {
        await client.query(
          `INSERT INTO lms.lease_survey (lease_id, survey_id, is_blocking) VALUES ($1, $2, false) ON CONFLICT DO NOTHING`,
          [newLease.id, sid]
        );
      }

      return (await client.query('SELECT * FROM lms.lease WHERE id = $1', [newLease.id])).rows[0];
    });

    return NextResponse.json({ success: true, lease: created });
  } catch (error: any) {
    console.error('Lease create error:', error);
    return toResponse(error, ctx.correlationId);
  }
});

export const PUT = protect({ permission: ['leases', 'update'] }, async (ctx) => {
  const request = ctx.req;
  const { withTransaction } = ctx.db;
  const user = ctx.legacyUser;

  try {
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const body = await readJson(request);
    const {
      id,
      action,
      to_stage,
      note,
      registration_no,
      subsequent_area,
      rate_per_acre,
      escalation_pct,
      auto_extend,
      renewal_clause,
      obligations,
      terminated_on,
    } = body;

    if (!id) {
      return NextResponse.json({ error: 'Lease id is required' }, { status: 400 });
    }

    const updated = await withTransaction(async (client) => {
      const rec = await requireRecord(ctx, 'lease', id, ['leases', 'update'], { forUpdate: true });

      if (action === 'transition' && to_stage) {
        const res = await client.query(
          `SELECT api.advance_workflow('leases', $1, $2, $3, $4) AS stage`,
          // $4: the approval position acted in; NULL lets the database pick the caller's eligible one.
          [id, to_stage, note || null, typeof body.as_group === 'string' && body.as_group ? body.as_group : null]
        );
        return { id, stage_code: res.rows[0]?.stage };
      }

      // Terminating a lease frees its parcels for another lease, so it is a head-office decision:
      // Manager Land (HO), in the lease's province, with a date on or after the start date.
      if (terminated_on && String(terminated_on) !== String(rec.row.terminated_on ?? '')) {
        const held = await client.query(`SELECT 1 FROM lms.app_user_group WHERE user_id = $1 AND group_code = 'Manager Land (HO)'`, [ctx.user.id]);
        if (!held.rows.length) throw new HttpError(403, 'A lease is terminated by the Manager Land (HO).', 'forbidden');
        if (rec.row.start_date && new Date(terminated_on) < new Date(rec.row.start_date))
          throw new HttpError(400, 'The termination date cannot be before the lease start date.', 'validation');
      }

      // Approved terms change only by renewal (api.renew_lease) or a new lease; a lease
      // still in review that already has an approval is sent back first (AUTHZ-10).
      const changing = TERMS.filter((k) => num(body[k]) !== null && num(body[k]) !== num(rec.row[k]));
      if (changing.length && await termsFrozen(client, 'leases', rec.id, rec.row.stage_code, 'Under Review')) {
        if (rec.row.stage_code === 'Approved')
          throw new HttpError(409, 'An approved lease keeps its agreed terms; renew it (bounded escalation) or record a new lease.', 'state');
        const reason = typeof body.reopen_reason === 'string' && body.reopen_reason.trim().length >= 10
          ? body.reopen_reason : `Sent back for changes: ${changing.join(', ').replace(/_/g, ' ')} edited`;
        await reopenForChanges(client, 'leases', rec.id, reason);
      }

      const res = await client.query(
        `UPDATE lms.lease
         SET registration_no = COALESCE($2, registration_no),
             subsequent_area = COALESCE($3, subsequent_area),
             rate_per_acre = COALESCE($4, rate_per_acre),
             escalation_pct = COALESCE($5, escalation_pct),
             auto_extend = COALESCE($6, auto_extend),
             renewal_clause = COALESCE($7, renewal_clause),
             obligations = COALESCE($8, obligations),
             terminated_on = COALESCE($9, terminated_on),
             updated_by = $10,
             updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [
          id,
          registration_no ?? null,
          subsequent_area !== undefined && subsequent_area !== '' ? Number(subsequent_area) : null,
          rate_per_acre !== undefined && rate_per_acre !== '' ? Number(rate_per_acre) : null,
          escalation_pct !== undefined && escalation_pct !== '' ? Number(escalation_pct) : null,
          auto_extend !== undefined ? Boolean(auto_extend) : null,
          renewal_clause ?? null,
          obligations ?? null,
          terminated_on || null,
          user.id,
        ]
      );
      if (res.rows.length === 0) throw new HttpError(404, 'Lease not found', 'not_found');
      return res.rows[0];
    });

    return NextResponse.json({ success: true, lease: updated });
  } catch (error: any) {
    console.error('Lease update error:', error);
    return toResponse(error, ctx.correlationId);
  }
});
