import { NextResponse } from 'next/server';
import { HttpError, protect, readJson, requireLinked, requireRecord, toResponse, type Ctx } from '@/lib/iam/http';

// A project row aggregates other registers (UI-09): case counts and the approved
// compensation need cases:read, released money payments:read, for the project's
// province. Without them the figures are omitted, not zeroed.
const SECTIONS: [string, string[]][] = [
  ['cases', ['live_cases', 'approved_cases', 'approved_compensation']],
  ['payments', ['released_amount', 'total_released']],
  ['leases', ['active_leases']],
  ['gis', ['spatial_feature_count']],
];
function withReadableFigures(ctx: Ctx, row: Record<string, any>) {
  const out = { ...row };
  for (const [resource, keys] of SECTIONS)
    if (!ctx.can(resource, 'read', { province: row.province_code })) for (const k of keys) delete out[k];
  return out;
}

export const GET = protect({ permission: ['projects', 'read'] }, async (ctx) => {
  const request = ctx.req;
  const { query } = ctx.db;

  try {
    const { searchParams } = new URL(request.url);
    const province = searchParams.get('province');
    const id = searchParams.get('id');

    if (id) {
      const projRes = await query(
        `SELECT pls.*, p.district_id, p.description,
                pls.linked_area AS total_acres,
                pls.released_amount AS total_released,
                (coalesce(vp.lease_count, 0) - coalesce(vp.expired_lease_count, 0))::int AS active_leases,
                coalesce(vp.gis_feature_count, 0)::int AS spatial_feature_count
         FROM api.v_project_land_status pls
         JOIN lms.project p ON p.id = pls.project_id
         LEFT JOIN api.v_project_portfolio vp ON vp.project_id = pls.project_id
         WHERE pls.project_id = $1`,
        [id]
      );
      if (projRes.rows.length === 0) {
        return NextResponse.json({ error: 'Project not found' }, { status: 404 });
      }
      const surveysRes = await query(
        `SELECT so.*
         FROM lms.project_survey ps
         JOIN api.v_survey_ownership so ON so.survey_id = ps.survey_id
         WHERE ps.project_id = $1
         ORDER BY so.survey_code ASC`,
        [id]
      );
      return NextResponse.json({
        project: withReadableFigures(ctx, projRes.rows[0]),
        surveys: ctx.can('surveys', 'read', { province: projRes.rows[0].province_code }) ? surveysRes.rows : [],
      });
    }

    let sql = `
      SELECT pls.project_id, pls.project_code, pls.project_name, pls.type_code, pls.block,
             pls.province_code, pls.status, pls.district_name, pls.required_area, pls.linked_parcels,
             pls.linked_area, pls.parcels_held, pls.live_cases, pls.approved_cases,
             pls.approved_compensation, pls.released_amount,
             p.district_id, p.description
      FROM api.v_project_land_status pls
      JOIN lms.project p ON p.id = pls.project_id
    `;
    const params: any[] = [];

    if (province && province !== 'ALL') {
      sql += ` WHERE pls.province_code = $1`;
      params.push(province);
    }

    sql += ` ORDER BY pls.project_code ASC`;

    const result = await query(sql, params);
    return NextResponse.json({ projects: result.rows.map((r: any) => withReadableFigures(ctx, r)) });
  } catch (error: any) {
    return toResponse(error, ctx.correlationId);
  }
});

export const POST = protect({ permission: ['projects', 'create'] }, async (ctx) => {
  const request = ctx.req;
  const { withTransaction } = ctx.db;
  const user = ctx.legacyUser;

  try {
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await readJson(request);
    const { code, name, type_code, block, province_code, district_id, required_area, description, survey_ids } = body;

    if (!code || !name || !type_code || !block || !province_code || !district_id) {
      return NextResponse.json({ error: 'All mandatory fields must be provided' }, { status: 400 });
    }

    if (typeof code !== 'string' || typeof name !== 'string' || typeof block !== 'string' || typeof province_code !== 'string' || !/^[A-Z]{3}$/.test(province_code))
      return NextResponse.json({ error: 'code, name, block and a province code are required as text', code: 'validation' }, { status: 400 });
    if (!ctx.can('projects', 'create', { province: province_code }))
      return NextResponse.json({ error: 'You may not create projects in that province.', code: 'forbidden', correlationId: ctx.correlationId }, { status: 403 });

    const created = await withTransaction(async (client) => {
      // The district and the linked parcels must be in the project's province (AUTHZ-15).
      await requireLinked(ctx, 'admin_unit', [district_id], province_code, 'district');
      const surveys = await requireLinked(ctx, 'survey', survey_ids, province_code, 'parcel');
      const res = await client.query(
        `INSERT INTO lms.project (
          code, name, type_code, block, province_code, district_id, required_area, description, status, created_by
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Active', $9)
        RETURNING *`,
        [code.trim().toUpperCase(), name.trim(), type_code, block.trim(), province_code, district_id, required_area || null, description || null, user.id]
      );
      const proj = res.rows[0];

      for (const sid of surveys) {
        await client.query(`INSERT INTO lms.project_survey (project_id, survey_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [proj.id, sid]);
      }
      return proj;
    });

    return NextResponse.json({ success: true, project: created });
  } catch (error: any) {
    console.error('Project creation error:', error);
    return toResponse(error, ctx.correlationId);
  }
});

export const PUT = protect({ permission: ['projects', 'update'] }, async (ctx) => {
  const request = ctx.req;
  const { withTransaction } = ctx.db;
  const user = ctx.legacyUser;

  try {
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await readJson(request);
    const {
      id,
      project_id,
      name,
      type_code,
      block,
      district_id,
      required_area,
      description,
      status,
      survey_ids,
    } = body;

    const targetId = id || project_id;
    if (!targetId) {
      return NextResponse.json({ error: 'Project ID is required' }, { status: 400 });
    }

    const updated = await withTransaction(async (client) => {
      const rec = await requireRecord(ctx, 'project', targetId, ['projects', 'update'], { forUpdate: true });
      if (district_id) await requireLinked(ctx, 'admin_unit', [district_id], rec.province, 'district');
      const surveys = Array.isArray(survey_ids) ? await requireLinked(ctx, 'survey', survey_ids, rec.province, 'parcel') : null;
      const res = await client.query(
        `UPDATE lms.project
         SET name = COALESCE($2, name),
             type_code = COALESCE($3, type_code),
             block = COALESCE($4, block),
             district_id = COALESCE($5, district_id),
             required_area = COALESCE($6, required_area),
             description = COALESCE($7, description),
             status = COALESCE($8, status),
             updated_by = $9,
             updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [
          targetId,
          name ? name.trim() : null,
          type_code || null,
          block ? block.trim() : null,
          district_id || null,
          required_area !== undefined && required_area !== '' ? Number(required_area) : null,
          description ?? null,
          status || null,
          user.id,
        ]
      );

      if (res.rows.length === 0) throw new HttpError(404, 'Project not found', 'not_found');
      if (surveys) {
        await client.query('DELETE FROM lms.project_survey WHERE project_id = $1', [rec.id]);
        for (const sid of surveys) {
          await client.query(`INSERT INTO lms.project_survey (project_id, survey_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [rec.id, sid]);
        }
      }

      return res.rows[0];
    });

    return NextResponse.json({ success: true, project: updated });
  } catch (error: any) {
    console.error('Project update error:', error);
    return toResponse(error, ctx.correlationId);
  }
});
