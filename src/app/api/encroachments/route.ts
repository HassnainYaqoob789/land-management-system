import { likeOf, pageOf, paged, summarize, type Page } from '@/lib/paging';
import { NextResponse } from 'next/server';
import { HttpError, protect, readJson, requireLinked, requireRecord, toResponse } from '@/lib/iam/http';
import { redact } from '@/lib/iam/pii';
import { queueFirstStep } from '@/lib/workflow';

export const GET = protect({ permission: ['encroachments', 'read'] }, async (ctx) => {
  const request = ctx.req;
  const { query } = ctx.db;

  try {
    const { searchParams } = new URL(request.url);
    const province = searchParams.get('province');

    let sql = `
      SELECT es.*,
             e.project_id, e.survey_id, e.row_id, e.category_code,
             e.description, e.impact, e.corrective_action
      FROM api.v_encroachment_status es
      JOIN lms.encroachment e ON e.id = es.encroachment_id
      WHERE 1=1
    `;
    const params: any[] = [];
    if (province && province !== 'ALL') {
      params.push(province);
      sql += ` AND es.province_code = $1`;
    }
    // Register totals for the KPI tiles: the whole register in scope, before the search narrows it.
    const summary = await summarize(query, sql, params, { total: `count(*)`, open: `count(*) FILTER (WHERE stage_code <> 'Resolved')`, open_high: `count(*) FILTER (WHERE stage_code <> 'Resolved' AND risk IN ('High','Critical'))` });
    const q = (searchParams.get('q') ?? '').trim();
    if (q) { params.push(likeOf(q)); sql += ` AND (es.encroachment_code::text ILIKE $${params.length} OR e.description::text ILIKE $${params.length})`; }
    let page: Page | undefined;
    const [res, catRes] = await Promise.all([
      paged(query, sql, params, `es.detected_on DESC`, pageOf(searchParams)).then((r) => { page = r.page; return { rows: r.rows }; }),
      query('SELECT * FROM lms.encroachment_category ORDER BY display_order ASC'),
    ]);

    return NextResponse.json(redact({ page, summary,
      encroachments: res.rows,
      categories: catRes.rows,
    }, ctx));
  } catch (error: any) {
    return toResponse(error, ctx.correlationId);
  }
});

export const POST = protect({ permission: ['encroachments', 'create'] }, async (ctx) => {
  const request = ctx.req;
  const { withTransaction } = ctx.db;
  const user = ctx.legacyUser;

  try {
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await readJson(request);
    const {
      project_id,
      survey_id,
      row_id,
      category_code,
      lat,
      lng,
      detected_on,
      encroacher,
      area_affected,
      risk,
      description,
      impact,
      corrective_action,
    } = body;

    if (!project_id || !description || !risk || !detected_on || (!survey_id && !row_id)) {
      return NextResponse.json(
        { error: 'Project, description, and either a Survey parcel or ROW corridor are required' },
        { status: 400 }
      );
    }

    const created = await withTransaction(async (client) => {
      // Reported in the project's province; the parcel or corridor must be there too (AUTHZ-15).
      const prov = (await requireRecord(ctx, 'project', project_id, ['encroachments', 'create'])).province as string;
      if (survey_id) await requireLinked(ctx, 'survey', [survey_id], prov, 'parcel');
      if (row_id) await requireLinked(ctx, 'row_corridor', [row_id], prov, 'ROW corridor');

      let cat = category_code;
      if (!cat) {
        const cRes = await client.query('SELECT code FROM lms.encroachment_category ORDER BY display_order ASC LIMIT 1');
        cat = cRes.rows[0]?.code;
      }

      // Where it is: the coordinates given, else the survey parcel's recorded ones. Never a guess.
      let coords = { lat: lat !== undefined && lat !== '' ? Number(lat) : null, lng: lng !== undefined && lng !== '' ? Number(lng) : null };
      if ((coords.lat === null || coords.lng === null) && survey_id) {
        const sv = await client.query('SELECT lat, lng FROM lms.survey WHERE id = $1', [survey_id]);
        if (sv.rows[0]?.lat != null) coords = { lat: Number(sv.rows[0].lat), lng: Number(sv.rows[0].lng) };
      }
      if (coords.lat === null || coords.lng === null) throw new HttpError(400, 'Give the location (latitude and longitude); the corridor or parcel has none recorded.');
      const codeRes = await client.query("SELECT lms.next_code_year('ENC') as code");
      const encCode = codeRes.rows[0].code;

      const insRes = await client.query(
        `INSERT INTO lms.encroachment (
          code, province_code, category_code, project_id, survey_id, row_id,
          lat, lng, detected_on, reported_by, encroacher, area_affected,
          risk, description, impact, corrective_action, stage_code,
          created_by, updated_by
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10, $11, $12,
          $13, $14, $15, $16, 'Reported',
          $10, $10
        ) RETURNING *`,
        [
          encCode,
          prov,
          cat,
          project_id,
          survey_id || null,
          row_id || null,
          coords.lat,
          coords.lng,
          detected_on,
          user.id,
          encroacher || null,
          area_affected ? Number(area_affected) : null,
          risk,
          description.trim(),
          impact || null,
          corrective_action || null,
        ]
      );
      await queueFirstStep(client, 'encroachments', insRes.rows[0].id);
      return insRes.rows[0];
    });

    return NextResponse.json({ success: true, encroachment: created });
  } catch (error: any) {
    console.error('Encroachment create error:', error);
    return toResponse(error, ctx.correlationId);
  }
});

export const PUT = protect({ permission: ['encroachments', 'update'] }, async (ctx) => {
  const request = ctx.req;
  const { withTransaction } = ctx.db;
  const user = ctx.legacyUser;

  try {
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await readJson(request);
    const { id, action, to_stage, note, risk, impact, corrective_action, escalation_level } = body;

    if (!id) return NextResponse.json({ error: 'Encroachment ID is required' }, { status: 400 });

    const updated = await withTransaction(async (client) => {
      await requireRecord(ctx, 'encroachment', id, ['encroachments', 'update'], { forUpdate: true });

      if (risk || impact !== undefined || corrective_action !== undefined || escalation_level !== undefined) {
        await client.query(
          `UPDATE lms.encroachment
           SET risk = COALESCE($2, risk),
               impact = COALESCE($3, impact),
               corrective_action = COALESCE($4, corrective_action),
               escalation_level = COALESCE($5, escalation_level),
               resolved_on = CASE WHEN $6 = 'Resolved' THEN COALESCE(resolved_on, CURRENT_DATE) ELSE resolved_on END,
               updated_by = $7,
               updated_at = now()
           WHERE id = $1`,
          [
            id,
            risk || null,
            impact ?? null,
            corrective_action ?? null,
            escalation_level !== undefined ? Number(escalation_level) : null,
            to_stage || null,
            user.id,
          ]
        );
      }

      if (action === 'transition' && to_stage) {
        if (to_stage === 'Resolved') {
          await client.query(`UPDATE lms.encroachment SET resolved_on = COALESCE(resolved_on, CURRENT_DATE) WHERE id = $1`, [id]);
        }
        const wfRes = await client.query(
          `SELECT api.advance_workflow('encroachments', $1, $2, $3, $4) AS stage`,
          // $4: the approval position acted in; NULL lets the database pick the caller's eligible one.
          [id, to_stage, note || corrective_action || null, typeof body.as_group === 'string' && body.as_group ? body.as_group : null]
        );
        return { id, stage_code: wfRes.rows[0]?.stage };
      }

      const res = await client.query('SELECT * FROM lms.encroachment WHERE id = $1', [id]);
      if (res.rows.length === 0) throw new HttpError(404, 'Encroachment not found', 'not_found');
      return res.rows[0];
    });

    return NextResponse.json({ success: true, encroachment: updated });
  } catch (error: any) {
    console.error('Encroachment update error:', error);
    return toResponse(error, ctx.correlationId);
  }
});

