import { likeOf, pageOf, paged, summarize, type Page } from '@/lib/paging';
import { NextResponse } from 'next/server';
import { HttpError, protect, readJson, requireLinked, requireRecord, toResponse } from '@/lib/iam/http';
import { redact } from '@/lib/iam/pii';
import { queueFirstStep } from '@/lib/workflow';

export const GET = protect({ permission: ['grievances', 'read'] }, async (ctx) => {
  const request = ctx.req;
  const { query } = ctx.db;

  try {
    const { searchParams } = new URL(request.url);
    const province = searchParams.get('province');

    let sql = `
      SELECT gs.*,
             g.complainant_cnic, g.mobile, g.channel, g.description, g.resolution,
             g.project_id, g.survey_id, g.landowner_id, g.category_code
      FROM api.v_grievance_status gs
      JOIN lms.grievance g ON g.id = gs.grievance_id
      WHERE 1=1
    `;
    const params: any[] = [];
    if (province && province !== 'ALL') {
      params.push(province);
      sql += ` AND gs.province_code = $1`;
    }
    // Register totals for the KPI tiles: the whole register in scope, before the search narrows it.
    const summary = await summarize(query, sql, params, { total: `count(*)`, open: `count(*) FILTER (WHERE stage_code NOT IN ('Resolved','Closed'))`, overdue: `count(*) FILTER (WHERE is_overdue)`, high: `count(*) FILTER (WHERE severity IN ('High','Critical'))` });
    const q = (searchParams.get('q') ?? '').trim();
    if (q) { params.push(likeOf(q)); sql += ` AND (gs.grievance_code::text ILIKE $${params.length} OR g.complainant::text ILIKE $${params.length} OR g.description::text ILIKE $${params.length})`; }
    let page: Page | undefined;
    const [res, catRes] = await Promise.all([
      paged(query, sql, params, `gs.is_overdue DESC, gs.received_date DESC`, pageOf(searchParams)).then((r) => { page = r.page; return { rows: r.rows }; }),
      query('SELECT * FROM lms.grievance_category ORDER BY display_order ASC'),
    ]);

    // The complainant's CNIC and mobile are masked without pii:read.
    return NextResponse.json(redact({ page, summary,
      grievances: res.rows,
      categories: catRes.rows,
    }, ctx));
  } catch (error: any) {
    return toResponse(error, ctx.correlationId);
  }
});

export const POST = protect({ permission: ['grievances', 'create'] }, async (ctx) => {
  const request = ctx.req;
  const { withTransaction } = ctx.db;
  const user = ctx.legacyUser;

  try {
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await readJson(request);
    const {
      province_code,
      grievance_type,
      landowner_id,
      complainant,
      complainant_cnic,
      mobile,
      project_id,
      survey_id,
      category_code,
      severity,
      channel,
      received_date,
      due_date,
      description,
    } = body;

    if (!complainant || !description || !grievance_type || !severity || !category_code) {
      return NextResponse.json({ error: 'Complainant, description, type, severity and category are required' }, { status: 400 });
    }

    const created = await withTransaction(async (client) => {
      // The province is the project's when one is named; linked records must be in it (AUTHZ-15).
      let prov: string | null = null;
      if (project_id) prov = (await requireRecord(ctx, 'project', project_id, ['grievances', 'create'])).province;
      else if (typeof province_code === 'string' && /^[A-Z]{3}$/.test(province_code)) prov = province_code;
      if (!prov) throw new HttpError(400, 'Province is required: give province_code or a linked record it can be taken from.', 'validation');
      if (province_code && province_code !== prov) throw new HttpError(400, 'province_code does not match the project.', 'validation');
      if (!ctx.can('grievances', 'create', { province: prov })) throw new HttpError(403, 'You may not register grievances in that province.', 'forbidden');
      if (survey_id) await requireLinked(ctx, 'survey', [survey_id], prov, 'parcel');
      if (landowner_id) await requireLinked(ctx, 'landowner', [landowner_id], prov, 'landowner');

      let cat = category_code;
      if (!cat) {
        const cRes = await client.query('SELECT code FROM lms.grievance_category ORDER BY display_order ASC LIMIT 1');
        cat = cRes.rows[0]?.code;
      }

      const codeRes = await client.query("SELECT lms.next_code_year('GRV') as code");
      const grvCode = codeRes.rows[0].code;

      const recvDate = received_date || new Date().toISOString().split('T')[0];
      const defaultDue = new Date(recvDate);
      defaultDue.setDate(defaultDue.getDate() + 14);

      const insRes = await client.query(
        `INSERT INTO lms.grievance (
          code, province_code, grievance_type, landowner_id, complainant,
          complainant_cnic, mobile, project_id, survey_id, category_code,
          severity, channel, received_date, due_date, assigned_to,
          description, stage_code, created_by, updated_by
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15,
          $16, 'Registered', $15, $15
        ) RETURNING *`,
        [
          grvCode,
          prov,
          grievance_type,
          landowner_id || null,
          complainant.trim(),
          complainant_cnic || null,
          mobile || null,
          project_id || null,
          survey_id || null,
          cat,
          severity,
          channel || null,
          recvDate,
          due_date || defaultDue.toISOString().split('T')[0],
          user.id,
          description.trim(),
        ]
      );
      await queueFirstStep(client, 'grievances', insRes.rows[0].id);
      return insRes.rows[0];
    });

    return NextResponse.json(redact({ success: true, grievance: created }, ctx));
  } catch (error: any) {
    console.error('Grievance create error:', error);
    return toResponse(error, ctx.correlationId);
  }
});

export const PUT = protect({ permission: ['grievances', 'update'] }, async (ctx) => {
  const request = ctx.req;
  const { withTransaction } = ctx.db;
  const user = ctx.legacyUser;

  try {
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await readJson(request);
    const { id, action, to_stage, note, resolution, severity, escalation_level, due_date } = body;

    if (!id) return NextResponse.json({ error: 'Grievance ID is required' }, { status: 400 });

    const updated = await withTransaction(async (client) => {
      await requireRecord(ctx, 'grievance', id, ['grievances', 'update'], { forUpdate: true });

      if (resolution !== undefined || severity || escalation_level !== undefined || due_date) {
        const isResolving = to_stage === 'Resolved' || to_stage === 'Closed';
        await client.query(
          `UPDATE lms.grievance
           SET resolution = COALESCE($2, resolution),
               severity = COALESCE($3, severity),
               escalation_level = COALESCE($4, escalation_level),
               due_date = COALESCE($5, due_date),
               resolved_on = CASE WHEN $6 THEN COALESCE(resolved_on, CURRENT_DATE) ELSE resolved_on END,
               updated_by = $7,
               updated_at = now()
           WHERE id = $1`,
          [
            id,
            resolution || null,
            severity || null,
            escalation_level !== undefined ? Number(escalation_level) : null,
            due_date || null,
            isResolving,
            user.id,
          ]
        );
      }

      if (action === 'transition' && to_stage) {
        if (to_stage === 'Resolved' || to_stage === 'Closed') {
          // A resolved grievance must say how it was resolved (grievance_resolution_required_ck).
          // The workflow dialog sends only a note, so the note becomes the resolution when none
          // is recorded yet; an explicit `resolution` always wins.
          const explicit = typeof resolution === 'string' && resolution.trim() ? resolution.trim() : null;
          const fromNote = typeof note === 'string' && note.trim() ? note.trim() : null;
          if (explicit || fromNote) {
            await client.query(
              `UPDATE lms.grievance
                  SET resolution = CASE WHEN $3 THEN $2 ELSE COALESCE(NULLIF(btrim(resolution), ''), $2) END,
                      resolved_on = COALESCE(resolved_on, CURRENT_DATE)
                WHERE id = $1`,
              [id, explicit ?? fromNote, !!explicit]
            );
          } else {
            const has = await client.query(`SELECT btrim(coalesce(resolution, '')) <> '' AS ok FROM lms.grievance WHERE id = $1`, [id]);
            if (!has.rows[0]?.ok) throw new HttpError(400, 'Write how the grievance was resolved in the note.', 'validation');
          }
        }
        const wfRes = await client.query(
          `SELECT api.advance_workflow('grievances', $1, $2, $3, $4) AS stage`,
          // $4: the approval position acted in; NULL lets the database pick the caller's eligible one.
          [id, to_stage, note || resolution || null, typeof body.as_group === 'string' && body.as_group ? body.as_group : null]
        );
        return { id, stage_code: wfRes.rows[0]?.stage };
      }

      const res = await client.query('SELECT * FROM lms.grievance WHERE id = $1', [id]);
      if (res.rows.length === 0) throw new HttpError(404, 'Grievance not found', 'not_found');
      return res.rows[0];
    });

    return NextResponse.json(redact({ success: true, grievance: updated }, ctx));
  } catch (error: any) {
    console.error('Grievance update error:', error);
    return toResponse(error, ctx.correlationId);
  }
});

