import { likeOf, pageOf, paged, summarize } from '@/lib/paging';
import { NextResponse } from 'next/server';
import { HttpError, protect, readJson, requireLinked, requireRecord, toResponse } from '@/lib/iam/http';
import { queueFirstStep, reopenForChanges, termsFrozen } from '@/lib/workflow';

// The terms an approval fixes (the database freezes the same list).
const TERMS = ['length_m', 'width_m', 'agreement_date', 'tenure_years', 'annual_rent'] as const;
const day = (v: any) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v));

const VALID_ROW_TYPES = [
  'Pipeline ROW',
  'Flowline ROW',
  'Access Road',
  'Junction / Valve Station',
  'Power Line',
];

function normalizeRowType(rt?: string): string {
  if (!rt) return 'Pipeline ROW';
  if (VALID_ROW_TYPES.includes(rt)) return rt;
  const lower = rt.toLowerCase();
  if (lower.includes('flow')) return 'Flowline ROW';
  if (lower.includes('road') || lower.includes('access')) return 'Access Road';
  if (lower.includes('valve') || lower.includes('junction')) return 'Junction / Valve Station';
  if (lower.includes('power') || lower.includes('electric')) return 'Power Line';
  return 'Pipeline ROW';
}

export const GET = protect({ permission: ['rows', 'read'] }, async (ctx) => {
  const request = ctx.req;
  const { query } = ctx.db;

  try {
    const { searchParams } = new URL(request.url);
    const province = searchParams.get('province');

    let sql = `
      SELECT rc.*, p.name as project_name, p.code as project_code, prov.name as province_name,
             (rc.agreement_date + make_interval(years => rc.tenure_years::int))::date as expiry_date,
             ((rc.agreement_date + make_interval(years => rc.tenure_years::int))::date - CURRENT_DATE) as days_to_expiry
      FROM lms.row_corridor rc
      JOIN lms.project p ON p.id = rc.project_id
      JOIN lms.province prov ON prov.code = rc.province_code
      WHERE 1=1
    `;
    const params: any[] = [];
    if (province && province !== 'ALL') {
      params.push(province);
      sql += ` AND rc.province_code = $1`;
    }
    const projectId = searchParams.get('project_id');
    if (projectId) {
      params.push(projectId);
      sql += ` AND rc.project_id = $${params.length}`;
    }
    // Register totals for the KPI tiles: the whole register in scope, before the search narrows it.
    const summary = await summarize(query, sql, params, { total: `count(*)`, length_m: `coalesce(sum(length_m),0)`, area_acres: `coalesce(sum(area_acres),0)` });
    const q = (searchParams.get('q') ?? '').trim();
    if (q) { params.push(likeOf(q)); sql += ` AND (rc.code::text ILIKE $${params.length} OR p.name::text ILIKE $${params.length} OR rc.row_type::text ILIKE $${params.length})`; }
    const { rows: resRows, page } = await paged(query, sql, params, `rc.created_at DESC`, pageOf(searchParams));
    const res = { rows: resRows };
    const scheduleRes = await query(
      `SELECT *, (next_renewal_date - CURRENT_DATE) AS days_to_expiry
       FROM api.v_row_renewal_schedule
       ORDER BY next_renewal_date ASC`
    );
    return NextResponse.json({ page, summary,
      rows: res.rows,
      renewal_schedule: scheduleRes.rows,
    });
  } catch (error: any) {
    return toResponse(error, ctx.correlationId);
  }
});

export const POST = protect({ permission: ['rows', 'create'] }, async (ctx) => {
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
      name,
      row_type,
      from_point,
      to_point,
      length_m,
      width_m,
      agreement_date,
      tenure_years,
      annual_rent,
      obligations,
      path_wkt,
      survey_ids,
      landowner_ids,
    } = body;

    if (!project_id || !name || !row_type || !length_m || !width_m || !agreement_date || !tenure_years) {
      return NextResponse.json({ error: 'Project, name, type, length, width, agreement date and tenure are required' }, { status: 400 });
    }

    const created = await withTransaction(async (client) => {
      const prov = (await requireRecord(ctx, 'project', project_id, ['rows', 'create'])).province as string;
      const surveys = await requireLinked(ctx, 'survey', survey_ids, prov, 'parcel');
      const landowners = await requireLinked(ctx, 'landowner', landowner_ids, prov, 'landowner');

      const codeRes = await client.query("SELECT lms.next_code('ROW-') as code");
      const rowCode = codeRes.rows[0].code;

      const res = await client.query(
        `INSERT INTO lms.row_corridor (
          code, province_code, project_id, name, row_type, from_point, to_point,
          length_m, width_m, agreement_date, tenure_years, annual_rent,
          path_wkt, obligations, stage_code, created_by, updated_by
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7,
          $8, $9, $10, $11, $12,
          $13, $14, 'Draft', $15, $15
        ) RETURNING *`,
        [
          rowCode,
          prov,
          project_id,
          name.trim(),
          normalizeRowType(row_type),
          from_point || null,
          to_point || null,
          Number(length_m),
          Number(width_m),
          agreement_date,
          Number(tenure_years),
          annual_rent !== undefined && annual_rent !== '' ? Number(annual_rent) : 0,
          path_wkt || null,
          obligations || null,
          user.id,
        ]
      );
      const newRow = res.rows[0];
      await queueFirstStep(client, 'rows', newRow.id);

      for (const sid of surveys) {
        await client.query(`INSERT INTO lms.row_survey (row_id, survey_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [newRow.id, sid]);
      }
      for (const lid of landowners) {
        await client.query(`INSERT INTO lms.row_landowner (row_id, landowner_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [newRow.id, lid]);
      }

      return newRow;
    });

    return NextResponse.json({ success: true, row: created });
  } catch (error: any) {
    console.error('ROW create error:', error);
    return toResponse(error, ctx.correlationId);
  }
});

export const PUT = protect({ permission: ['rows', 'update'] }, async (ctx) => {
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
      name,
      row_type,
      from_point,
      to_point,
      length_m,
      width_m,
      agreement_date,
      tenure_years,
      annual_rent,
      obligations,
    } = body;

    if (!id) return NextResponse.json({ error: 'ROW corridor id is required' }, { status: 400 });

    const updated = await withTransaction(async (client) => {
      const rec = await requireRecord(ctx, 'row_corridor', id, ['rows', 'update'], { forUpdate: true });
      if (action === 'transition' && to_stage) {
        const res = await client.query(
          `SELECT api.advance_workflow('rows', $1, $2, $3, $4) AS stage`,
          // $4: the approval position acted in; NULL lets the database pick the caller's eligible one.
          [id, to_stage, note || null, typeof body.as_group === 'string' && body.as_group ? body.as_group : null]
        );
        return { id, stage_code: res.rows[0]?.stage };
      }

      // Approved terms (rent, tenure, size, agreement date) do not change in place; a corridor
      // still in review that already has an approval is sent back first (AUTHZ-10).
      const changing = TERMS.filter((k) => body[k] !== undefined && body[k] !== '' && body[k] !== null
        && (k === 'agreement_date' ? day(body[k]) !== day(rec.row[k]) : Number(body[k]) !== Number(rec.row[k])));
      if (changing.length && await termsFrozen(client, 'rows', rec.id, rec.row.stage_code, 'Under Review')) {
        const reason = typeof body.reopen_reason === 'string' && body.reopen_reason.trim().length >= 10
          ? body.reopen_reason : `Sent back for changes: ${changing.join(', ').replace(/_/g, ' ')} edited`;
        await reopenForChanges(client, 'rows', rec.id, reason);
      }
      const res = await client.query(
        `UPDATE lms.row_corridor
         SET name = COALESCE($2, name),
             row_type = COALESCE($3, row_type),
             from_point = COALESCE($4, from_point),
             to_point = COALESCE($5, to_point),
             length_m = COALESCE($6, length_m),
             width_m = COALESCE($7, width_m),
             agreement_date = COALESCE($8, agreement_date),
             tenure_years = COALESCE($9, tenure_years),
             annual_rent = COALESCE($10, annual_rent),
             obligations = COALESCE($11, obligations),
             updated_by = $12,
             updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [
          id,
          name ? name.trim() : null,
          row_type ? normalizeRowType(row_type) : null,
          from_point ?? null,
          to_point ?? null,
          length_m ? Number(length_m) : null,
          width_m ? Number(width_m) : null,
          agreement_date || null,
          tenure_years ? Number(tenure_years) : null,
          annual_rent !== undefined && annual_rent !== '' ? Number(annual_rent) : null,
          obligations ?? null,
          user.id,
        ]
      );
      if (res.rows.length === 0) throw new HttpError(404, 'ROW corridor not found', 'not_found');
      return res.rows[0];
    });

    return NextResponse.json({ success: true, row: updated });
  } catch (error: any) {
    console.error('ROW update error:', error);
    return toResponse(error, ctx.correlationId);
  }
});
