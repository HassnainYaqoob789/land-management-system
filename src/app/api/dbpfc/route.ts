import { likeOf, pageOf, paged, summarize } from '@/lib/paging';
import { NextResponse } from 'next/server';
import { HttpError, protect, readJson, requireLinked, requireRecord, toResponse } from '@/lib/iam/http';
import { queueFirstStep, reopenForChanges, termsFrozen } from '@/lib/workflow';

export const GET = protect({ permission: ['dbpfc', 'read'] }, async (ctx) => {
  const request = ctx.req;
  const { query } = ctx.db;

  try {
    const { searchParams } = new URL(request.url);
    const province = searchParams.get('province');

    let sql = `
      SELECT v.*, d.project_id, d.district_id, d.remarks
      FROM api.v_dbpfc_summary v
      JOIN lms.dbpfc_estimate d ON d.id = v.dbpfc_id
      WHERE 1=1
    `;
    const params: any[] = [];
    if (province && province !== 'ALL') {
      params.push(province);
      sql += ` AND d.province_code = $1`;
    }
    // Register totals for the KPI tiles: the whole register in scope, before the search narrows it.
    const summary = await summarize(query, sql, params, { total: `count(*)`, pending: `count(*) FILTER (WHERE NOT rate_is_fixed)`, annual_amount: `coalesce(sum(annual_amount),0)`, paid_amount: `coalesce(sum(paid_amount),0)` });
    const q = (searchParams.get('q') ?? '').trim();
    if (q) { params.push(likeOf(q)); sql += ` AND (v.dbpfc_code::text ILIKE $${params.length} OR d.committee_ref::text ILIKE $${params.length})`; }
    const { rows: resRows, page } = await paged(query, sql, params, `v.dbpfc_code ASC`, pageOf(searchParams));
    const res = { rows: resRows };
    const historyRes = await query(
      `SELECT h.*, d.code as dbpfc_code, lms.user_full_name(h.changed_by) as changed_by_name
       FROM lms.dbpfc_rate_history h
       JOIN lms.dbpfc_estimate d ON d.id = h.dbpfc_id
       ORDER BY h.changed_at DESC
       LIMIT 50`
    );

    return NextResponse.json({ page, summary,
      dbpfc: res.rows,
      rate_history: historyRes.rows,
    });
  } catch (error: any) {
    return toResponse(error, ctx.correlationId);
  }
});

export const POST = protect({ permission: ['dbpfc', 'create'] }, async (ctx) => {
  const request = ctx.req;
  const { withTransaction } = ctx.db;
  const user = ctx.legacyUser;

  try {
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await readJson(request);
    const {
      project_id,
      district_id,
      area_acres,
      estimated_rate,
      fixed_rate,
      committee_ref,
      meeting_date,
      remarks,
      survey_ids,
    } = body;

    if (!project_id || !area_acres || !estimated_rate) {
      return NextResponse.json(
        { error: 'Project, area (acres), and estimated rate are required' },
        { status: 400 }
      );
    }

    const created = await withTransaction(async (client) => {
      // The committee rate (fixed_rate) is accepted only from the position that fixes
      // DBPFC rates; the database refuses it from anyone else (AUTHZ-10).
      const proj = (await requireRecord(ctx, 'project', project_id, ['dbpfc', 'create'])).row;
      const surveys = await requireLinked(ctx, 'survey', survey_ids, proj.province_code, 'parcel');
      if (proj.province_code !== 'SND') {
        throw new HttpError(400, 'DBPFC Government land estimates apply only to Sindh (SND) projects');
      }

      let resolvedDistrictId = district_id || proj.district_id;
      if (!resolvedDistrictId) {
        throw new HttpError(400, 'Valid Sindh District is required for DBPFC estimate');
      }

      const codeRes = await client.query("SELECT lms.next_code('DBP-') as code");
      const dbpCode = codeRes.rows[0].code;

      const insRes = await client.query(
        `INSERT INTO lms.dbpfc_estimate (
          code, province_code, project_id, district_id, area_acres,
          estimated_rate, fixed_rate, committee_ref, meeting_date,
          remarks, stage_code, created_by, updated_by
        ) VALUES (
          $1, 'SND', $2, $3, $4,
          $5, $6, $7, $8,
          $9, 'Estimated', $10, $10
        ) RETURNING *`,
        [
          dbpCode,
          project_id,
          resolvedDistrictId,
          Number(area_acres),
          Number(estimated_rate),
          fixed_rate !== undefined && fixed_rate !== '' ? Number(fixed_rate) : null,
          committee_ref || null,
          meeting_date || null,
          remarks || null,
          user.id,
        ]
      );
      const dbpfc = insRes.rows[0];
      await queueFirstStep(client, 'dbpfc', dbpfc.id);

      for (const sid of surveys) {
        await client.query(`INSERT INTO lms.dbpfc_survey (dbpfc_id, survey_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [dbpfc.id, sid]);
      }

      return dbpfc;
    });

    return NextResponse.json({ success: true, dbpfc: created });
  } catch (error: any) {
    console.error('DBPFC create error:', error);
    return toResponse(error, ctx.correlationId);
  }
});

export const PUT = protect({ permission: ['dbpfc', 'update'] }, async (ctx) => {
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
      area_acres,
      estimated_rate,
      fixed_rate,
      committee_ref,
      meeting_date,
      remarks,
    } = body;

    if (!id) return NextResponse.json({ error: 'DBPFC id is required' }, { status: 400 });

    const updated = await withTransaction(async (client) => {
      const rec = await requireRecord(ctx, 'dbpfc_estimate', id, ['dbpfc', 'update'], { forUpdate: true });
      if (action === 'transition' && to_stage) {
        if (fixed_rate !== undefined && fixed_rate !== '') {
          await client.query(
            `UPDATE lms.dbpfc_estimate
             SET fixed_rate = $2,
                 committee_ref = COALESCE($3, committee_ref),
                 meeting_date = COALESCE($4, meeting_date),
                 updated_by = $5,
                 updated_at = now()
             WHERE id = $1`,
            [id, Number(fixed_rate), committee_ref || null, meeting_date || null, user.id]
          );
        }
        const wfRes = await client.query(
          `SELECT api.advance_workflow('dbpfc', $1, $2, $3, $4) AS stage`,
          // $4: the approval position acted in; NULL lets the database pick the caller's eligible one.
          [id, to_stage, note || null, typeof body.as_group === 'string' && body.as_group ? body.as_group : null]
        );
        return { id, stage_code: wfRes.rows[0]?.stage };
      }

      // The estimate (area, estimated rate) is what was referred to the committee; changing
      // it after referral sends the estimate back to be referred again (AUTHZ-10).
      const changing = (['area_acres', 'estimated_rate'] as const)
        .filter((k) => body[k] !== undefined && body[k] !== '' && body[k] !== null && Number(body[k]) !== Number(rec.row[k]));
      if (changing.length && await termsFrozen(client, 'dbpfc', rec.id, rec.row.stage_code, 'Referred to DBPFC')) {
        const reason = typeof body.reopen_reason === 'string' && body.reopen_reason.trim().length >= 10
          ? body.reopen_reason : `Sent back for changes: ${changing.join(', ').replace(/_/g, ' ')} edited`;
        await reopenForChanges(client, 'dbpfc', rec.id, reason);
      }
      const res = await client.query(
        `UPDATE lms.dbpfc_estimate
         SET area_acres = COALESCE($2, area_acres),
             estimated_rate = COALESCE($3, estimated_rate),
             fixed_rate = COALESCE($4, fixed_rate),
             committee_ref = COALESCE($5, committee_ref),
             meeting_date = COALESCE($6, meeting_date),
             remarks = COALESCE($7, remarks),
             updated_by = $8,
             updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [
          id,
          area_acres ? Number(area_acres) : null,
          estimated_rate ? Number(estimated_rate) : null,
          fixed_rate !== undefined && fixed_rate !== '' ? Number(fixed_rate) : null,
          committee_ref ?? null,
          meeting_date || null,
          remarks ?? null,
          user.id,
        ]
      );
      if (res.rows.length === 0) throw new HttpError(404, 'DBPFC record not found', 'not_found');
      return res.rows[0];
    });

    return NextResponse.json({ success: true, dbpfc: updated });
  } catch (error: any) {
    console.error('DBPFC update error:', error);
    return toResponse(error, ctx.correlationId);
  }
});
