import { likeOf, pageOf, paged, summarize } from '@/lib/paging';
import { NextResponse } from 'next/server';
import type { PoolClient } from 'pg';
import { HttpError, protect, readJson, requireLinked, requireRecord, toResponse } from '@/lib/iam/http';
import { redact } from '@/lib/iam/pii';

/**
 * The area as the surveyor recorded it: a positive decimal and a unit known to
 * lms.uom_code. The database derives total_area (acres) from the pair. A
 * request that gives only total_area is taken as acres.
 */
async function recordedArea(client: PoolClient, body: Record<string, any>): Promise<{ area: string; unit: string } | null> {
  const { recorded_area, recorded_unit, total_area } = body;
  const given = recorded_area !== undefined && recorded_area !== null && recorded_area !== '';
  const raw = given ? recorded_area : total_area;
  if (raw === undefined || raw === null || raw === '') return null;
  const area = String(raw).trim();
  if (!/^\d{1,14}(\.\d{1,4})?$/.test(area) || Number(area) <= 0)
    throw new HttpError(400, 'recorded_area must be a positive number with at most 4 decimals.', 'validation');
  const unitIn = given ? recorded_unit : 'Acre';
  if (typeof unitIn !== 'string' || !unitIn.trim()) throw new HttpError(400, 'recorded_unit is required with recorded_area.', 'validation');
  const r = await client.query(
    `SELECT u.code FROM lms.measurement_unit u WHERE u.code = lms.uom_code($1)`, [unitIn]);
  if (!r.rows.length) throw new HttpError(400, `recorded_unit "${unitIn.slice(0, 40)}" is not a known land measurement unit.`, 'validation');
  return { area, unit: r.rows[0].code };
}

/** Shares must name landowners with positive shares totalling exactly 100%. */
function checkShares(shares: unknown): any[] | null {
  if (shares === undefined || shares === null) return null;
  if (!Array.isArray(shares)) throw new HttpError(400, 'shares must be a list.', 'validation');
  if (shares.length === 0) return null;
  const sum = shares.reduce((acc: number, s: any) => acc + Number(s?.share_pct || 0), 0);
  if (Math.abs(sum - 100.0) > 0.001)
    throw new HttpError(400, `Co-ownership shares must total exactly 100.0%. Current sum: ${sum.toFixed(2)}%`, 'validation');
  return shares.map((s: any) => ({ landowner_id: s?.landowner_id, share_pct: s?.share_pct, revenue_doc_ref: s?.revenue_doc_ref ?? null }));
}

export const GET = protect({ permission: ['surveys', 'read'] }, async (ctx) => {
  const request = ctx.req;
  const { query } = ctx.db;

  try {
    const { searchParams } = new URL(request.url);
    const province = searchParams.get('province');
    // Record pickers send `q`; the register screen sends `search` (UX-04).
    const search = (searchParams.get('search') ?? searchParams.get('q') ?? '').trim();
    const surveyId = searchParams.get('id');

    if (surveyId) {
      const surveyRes = await query(
        `SELECT s.*,
                so.location_path, so.share_total_pct, so.owner_count, so.apportionment, so.committed_area
         FROM api.v_survey_ownership so
         JOIN lms.survey s ON s.id = so.survey_id
         WHERE s.id = $1`,
        [surveyId]
      );

      if (surveyRes.rows.length === 0) {
        return NextResponse.json({ error: 'Survey not found', code: 'not_found' }, { status: 404 });
      }

      const sharesRes = await query(
        `SELECT sos.id as share_id, sos.survey_id, sos.landowner_id, sos.share_pct, sos.revenue_doc_ref,
                lo.code as landowner_code, lo.full_name, lo.cnic, lo.tax_status, lo.status as owner_status, lo.province_code
         FROM lms.survey_ownership_share sos
         JOIN lms.landowner lo ON lo.id = sos.landowner_id
         WHERE sos.survey_id = $1
         ORDER BY sos.share_pct DESC`,
        [surveyId]
      );

      const historyRes = await query(
        `SELECT h.*, lo.full_name, lo.code as landowner_code, m.code as mutation_code
         FROM lms.survey_ownership_history h
         JOIN lms.landowner lo ON lo.id = h.landowner_id
         LEFT JOIN lms.mutation m ON m.id = h.mutation_id
         WHERE h.survey_id = $1
         ORDER BY h.recorded_at DESC`,
        [surveyId]
      );

      const projectsRes = await query(
        `SELECT p.id, p.code, p.name
         FROM lms.project_survey ps
         JOIN lms.project p ON p.id = ps.project_id
         WHERE ps.survey_id = $1`,
        [surveyId]
      );

      // Owner names and shares are landowner data: only for landowners:read in the parcel's province
      // (the Exploration Planner, reviewers and viewers read parcels, not owners).
      const ownersOk = ctx.can('landowners', 'read', { province: surveyRes.rows[0].province_code });
      return NextResponse.json(redact({
        survey: surveyRes.rows[0],
        shares: ownersOk ? sharesRes.rows : [],
        history: ownersOk ? historyRes.rows : [],
        owners_shown: ownersOk,
        projects: projectsRes.rows,
      }, ctx));
    }

    // Filter, count and page on lms.survey; read ownership totals from
    // api.v_survey_ownership for the page only.
    let sql = `
      SELECT s.id, s.code, s.total_area,
             coalesce((SELECT sum(o.share_pct) FROM lms.survey_ownership_share o WHERE o.survey_id = s.id), 0) AS share_total_pct
        FROM lms.survey s
       WHERE true`;
    const params: any[] = [];
    if (province && province !== 'ALL') { params.push(province); sql += ` AND s.province_code = $${params.length}`; }

    // Register totals for the KPI tiles: the whole register in scope, before the search narrows it.
    const summary = await summarize(query, sql, params, { total: `count(*)`, area: `coalesce(sum(total_area),0)`,
      unbalanced: `count(*) FILTER (WHERE abs(share_total_pct - 100) >= 0.01)` });

    if (search) {
      params.push(likeOf(search));
      const n = params.length;
      // Survey number, block, code, or the mouza / location path.
      sql += ` AND (s.survey_no ILIKE $${n} OR s.block_no ILIKE $${n} OR s.code::text ILIKE $${n}
               OR s.id IN (SELECT v.survey_id FROM api.v_survey_ownership v WHERE v.location_path ILIKE $${n}))`;
    }

    const { rows: ids, page } = await paged(query, sql, params, `code ASC`, pageOf(searchParams));
    const result = { rows: ids.length ? (await query(
      `SELECT survey_id, survey_code, province_code, province_name, survey_no,
              block_no, khasra_type, location_path, total_area, land_class,
              status_code, share_total_pct, owner_count, apportionment, committed_area
         FROM api.v_survey_ownership WHERE survey_id = ANY($1::uuid[]) ORDER BY survey_code ASC`, [ids.map((r: any) => r.id)])).rows : [] };
    return NextResponse.json({ page, summary, surveys: result.rows });
  } catch (error: any) {
    return toResponse(error, ctx.correlationId);
  }
});

export const POST = protect({ permission: ['surveys', 'create'] }, async (ctx) => {
  const { withTransaction } = ctx.db;
  const user = ctx.legacyUser;

  try {
    const body = await readJson(ctx.req);
    const { province_code, admin_unit_id, project_id, survey_no, block_no, khasra_type, land_class, remarks, lat, lng } = body;

    const hasArea = ![body.recorded_area, body.total_area].every((v) => v === undefined || v === null || v === '');
    if (!province_code || !admin_unit_id || typeof survey_no !== 'string' || !survey_no.trim() || !hasArea || !land_class) {
      return NextResponse.json(
        { error: 'Mandatory fields missing: province, admin unit, survey number, recorded area (with its unit) and land class are required', code: 'validation' },
        { status: 400 }
      );
    }
    if (typeof province_code !== 'string' || !/^[A-Z]{3}$/.test(province_code)) {
      return NextResponse.json({ error: 'province_code must be a province code', code: 'validation' }, { status: 400 });
    }
    if (!ctx.can('surveys', 'create', { province: province_code })) {
      return NextResponse.json({ error: 'You may not register parcels in that province.', code: 'forbidden', correlationId: ctx.correlationId }, { status: 403 });
    }
    const shares = checkShares(body.shares);

    const created = await withTransaction(async (client) => {
      // The deh / taluka and the project must be in the parcel's province (AUTHZ-15).
      await requireLinked(ctx, 'admin_unit', [admin_unit_id], province_code, 'administrative unit');
      if (project_id) await requireLinked(ctx, 'project', [project_id], province_code, 'project');
      const area = await recordedArea(client, body);

      const codeRes = await client.query("SELECT lms.next_code('AREA-') as code");
      const sCode = codeRes.rows[0].code;

      const surveyRes = await client.query(
        `INSERT INTO lms.survey (
          code, province_code, admin_unit_id, survey_no, block_no, khasra_type,
          recorded_area, recorded_unit, land_class, status_code, lat, lng, remarks, created_by, updated_by
        ) VALUES ($1, $2, $3, $4, $5, $6, $7::numeric, $8, $9, 'Proposed', $10, $11, $12, $13, $13)
        RETURNING *`,
        [
          sCode,
          province_code,
          admin_unit_id,
          survey_no.trim(),
          typeof block_no === 'string' && block_no.trim() ? block_no.trim() : null,
          khasra_type || null,
          area!.area,
          area!.unit,
          land_class,
          lat || null,
          lng || null,
          remarks || null,
          user.id,
        ]
      );
      const newSurvey = surveyRes.rows[0];

      if (project_id) {
        await client.query(
          `INSERT INTO lms.project_survey (project_id, survey_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [project_id, newSurvey.id]
        );
      }

      // The first owners of a new parcel. Every later change of ownership is a
      // mutation; the database refuses any other write to the shares (AUTHZ-01).
      if (shares) await client.query('SELECT api.register_ownership($1, $2::jsonb)', [newSurvey.id, JSON.stringify(shares)]);

      return newSurvey;
    });

    return NextResponse.json({ success: true, survey: created });
  } catch (error: any) {
    console.error('Survey create error:', error);
    return toResponse(error, ctx.correlationId);
  }
});

export const PUT = protect({ permission: ['surveys', 'update'] }, async (ctx) => {
  const { withTransaction } = ctx.db;
  const user = ctx.legacyUser;

  try {
    const body = await readJson(ctx.req);
    const { survey_id, id, survey_no, block_no, khasra_type, land_class, status_code, lat, lng, remarks, project_id } = body;

    const targetId = survey_id || id;
    if (!targetId) {
      return NextResponse.json({ error: 'Survey ID is required', code: 'validation' }, { status: 400 });
    }
    const shares = checkShares(body.shares);

    await withTransaction(async (client) => {
      const rec = await requireRecord(ctx, 'survey', targetId, ['surveys', 'update'], { forUpdate: true });
      const area = await recordedArea(client, body);

      if (survey_no || block_no !== undefined || khasra_type !== undefined || area || land_class || status_code || lat !== undefined || lng !== undefined || remarks !== undefined) {
        await client.query(
          `UPDATE lms.survey
           SET survey_no = COALESCE($2, survey_no),
               block_no = COALESCE($3, block_no),
               khasra_type = COALESCE($4, khasra_type),
               recorded_area = COALESCE($5::numeric, recorded_area),
               recorded_unit = COALESCE($6, recorded_unit),
               land_class = COALESCE($7, land_class),
               status_code = COALESCE($8, status_code),
               lat = COALESCE($9, lat),
               lng = COALESCE($10, lng),
               remarks = COALESCE($11, remarks),
               updated_by = $12,
               updated_at = now()
           WHERE id = $1`,
          [
            rec.id,
            typeof survey_no === 'string' && survey_no.trim() ? survey_no.trim() : null,
            block_no !== undefined ? (typeof block_no === 'string' && block_no.trim() ? block_no.trim() : null) : null,
            khasra_type || null,
            area?.area ?? null,
            area?.unit ?? null,
            land_class || null,
            status_code || null,
            lat !== undefined && lat !== '' ? Number(lat) : null,
            lng !== undefined && lng !== '' ? Number(lng) : null,
            remarks ?? null,
            user.id,
          ]
        );
      }

      if (project_id) {
        await requireLinked(ctx, 'project', [project_id], rec.province, 'project');
        await client.query(
          `INSERT INTO lms.project_survey (project_id, survey_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [project_id, rec.id]
        );
      }

      if (shares) {
        // Owners can be given here only to a parcel that has none yet (its first
        // registration). A parcel that has owners changes hands through a mutation.
        const held = await client.query('SELECT 1 FROM lms.survey_ownership_share WHERE survey_id = $1 LIMIT 1', [rec.id]);
        if (held.rows.length)
          throw new HttpError(409, 'This parcel already has registered owners. A change of ownership is recorded as a mutation, which needs Revenue, Legal and head-office approval.', 'state');
        await client.query('SELECT api.register_ownership($1, $2::jsonb)', [rec.id, JSON.stringify(shares)]);
      }
    });

    return NextResponse.json({ success: true, message: 'Survey record updated' });
  } catch (error: any) {
    console.error('Survey update error:', error);
    return toResponse(error, ctx.correlationId);
  }
});
