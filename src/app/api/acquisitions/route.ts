import { likeOf, pageOf, paged, summarize } from '@/lib/paging';
import { NextResponse } from 'next/server';
import { HttpError, protect, readJson, requireLinked, requireRecord, toResponse } from '@/lib/iam/http';
import { queueFirstStep, reopenForChanges, termsFrozen } from '@/lib/workflow';

export const GET = protect({ permission: ['acquisitions', 'read'] }, async (ctx) => {
  const request = ctx.req;
  const { query } = ctx.db;

  try {
    const { searchParams } = new URL(request.url);
    const province = searchParams.get('province');
    const id = searchParams.get('id');

    const titleItemsRes = await query('SELECT * FROM lms.title_check_item ORDER BY display_order ASC');

    if (id) {
      const acqRes = await query(
        `SELECT a.*, p.code as project_code, p.name as project_name, lms.user_full_name(a.negotiator_id) as negotiator_name
         FROM lms.acquisition a
         JOIN lms.project p ON p.id = a.project_id
         WHERE a.id = $1`,
        [id]
      );
      if (acqRes.rows.length === 0) {
        return NextResponse.json({ error: 'Acquisition not found' }, { status: 404 });
      }
      const [surveysRes, checksRes, transitionsRes] = await Promise.all([
        query(
          `SELECT aqs.survey_id, s.code as survey_code, s.survey_no, s.total_area, s.land_class
           FROM lms.acquisition_survey aqs
           JOIN lms.survey s ON s.id = aqs.survey_id
           WHERE aqs.acquisition_id = $1`,
          [id]
        ),
        query(
          `SELECT ti.code, ti.name, ti.display_order,
                  atc.checked_at, atc.checked_by, lms.user_full_name(atc.checked_by) as checked_by_name
           FROM lms.title_check_item ti
           LEFT JOIN lms.acquisition_title_check atc ON atc.item_code = ti.code AND atc.acquisition_id = $1
           ORDER BY ti.display_order ASC`,
          [id]
        ),
        query(
          `SELECT wt.*, lms.user_full_name(wt.acted_by) as acted_by_name
           FROM lms.workflow_transition wt
           WHERE wt.workflow_code = 'acquisitions' AND wt.record_id = $1
           ORDER BY wt.acted_at ASC`,
          [id]
        ),
      ]);

      return NextResponse.json({
        acquisition: acqRes.rows[0],
        surveys: surveysRes.rows,
        title_checks: checksRes.rows,
        transitions: transitionsRes.rows,
        title_items: titleItemsRes.rows,
      });
    }

    let sql = `
      SELECT a.*,
             p.code as project_code, p.name as project_name,
             lms.user_full_name(a.negotiator_id) as negotiator_name,
             (SELECT count(*) FROM lms.acquisition_survey aqs WHERE aqs.acquisition_id = a.id)::int as survey_count,
             (SELECT string_agg(s.survey_no, ', ') FROM lms.acquisition_survey aqs JOIN lms.survey s ON s.id = aqs.survey_id WHERE aqs.acquisition_id = a.id) as survey_numbers,
             (SELECT count(*) FROM lms.acquisition_title_check atc WHERE atc.acquisition_id = a.id)::int as title_checks_done,
             (SELECT count(*) FROM lms.title_check_item)::int as title_checks_total,
             (SELECT json_agg(atc.item_code) FROM lms.acquisition_title_check atc WHERE atc.acquisition_id = a.id) as checked_items
      FROM lms.acquisition a
      JOIN lms.project p ON p.id = a.project_id
      WHERE 1=1
    `;
    const params: any[] = [];
    if (province && province !== 'ALL') {
      params.push(province);
      sql += ` AND a.province_code = $1`;
    }
    // Register totals for the KPI tiles: the whole register in scope, before the search narrows it.
    const summary = await summarize(query, sql, params, { total: `count(*)`, open: `count(*) FILTER (WHERE stage_code IN ('Negotiation','Approval'))`, handed_over: `count(*) FILTER (WHERE stage_code = 'Handover')`, area_required: `coalesce(sum(area_required),0)` });
    const q = (searchParams.get('q') ?? '').trim();
    if (q) { params.push(likeOf(q)); sql += ` AND (a.code::text ILIKE $${params.length} OR p.name::text ILIKE $${params.length})`; }
    const { rows: resRows, page } = await paged(query, sql, params, `a.created_at DESC`, pageOf(searchParams));
    const res = { rows: resRows };
    return NextResponse.json({ page, summary,
      acquisitions: res.rows,
      title_items: titleItemsRes.rows,
    });
  } catch (error: any) {
    return toResponse(error, ctx.correlationId);
  }
});

export const POST = protect({ permission: ['acquisitions', 'create'] }, async (ctx) => {
  const request = ctx.req;
  const { withTransaction } = ctx.db;
  const user = ctx.legacyUser;

  try {
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await readJson(request);
    const {
      project_id,
      mode,
      area_required,
      negotiated_rate,
      target_handover_date,
      remarks,
      survey_ids,
      checked_items,
      land_request_id,
    } = body;

    if (!project_id || !area_required || !mode) {
      return NextResponse.json({ error: 'Project, mode and required area are mandatory' }, { status: 400 });
    }

    const created = await withTransaction(async (client) => {
      const prov = (await requireRecord(ctx, 'project', project_id, ['acquisitions', 'create'])).province as string;
      const surveys = await requireLinked(ctx, 'survey', survey_ids, prov, 'parcel');
      // Created from a land request that was handed over for acquisition (0057/0058): link both ways, once.
      let fromRequest: any = null;
      if (land_request_id) {
        fromRequest = (await requireRecord(ctx, 'land_request', land_request_id, ['requests', 'read'], { forUpdate: true })).row;
        if (fromRequest.stage_code !== 'Handed over' || fromRequest.handed_over_kind !== 'Acquisition')
          throw new HttpError(409, 'That land request was not handed over for acquisition.', 'state');
        if (fromRequest.handed_over_record_id) throw new HttpError(409, `An acquisition (${fromRequest.handed_over_record_code}) was already created from that land request.`, 'state');
        if (fromRequest.province_code !== prov) throw new HttpError(400, "The project must be in the land request's province.", 'validation');
      }

      const codeRes = await client.query("SELECT lms.next_code_year('ACQ') as code");
      const acqCode = codeRes.rows[0].code;

      const insRes = await client.query(
        `INSERT INTO lms.acquisition (
          code, province_code, project_id, mode, area_required,
          negotiated_rate, target_handover_date, negotiator_id,
          stage_code, remarks, created_by, updated_by, land_request_id
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8,
          'Identification', $9, $8, $8, $10
        ) RETURNING *`,
        [
          acqCode,
          prov,
          project_id,
          mode,
          Number(area_required),
          negotiated_rate !== undefined && negotiated_rate !== '' ? Number(negotiated_rate) : null,
          target_handover_date || null,
          user.id,
          remarks || null,
          fromRequest?.id ?? null,
        ]
      );
      const acq = insRes.rows[0];
      if (fromRequest)
        await client.query('UPDATE lms.land_request SET handed_over_record_id = $1, handed_over_record_code = $2, updated_at = now(), updated_by = $3 WHERE id = $4',
          [acq.id, acq.code, user.id, fromRequest.id]);
      await queueFirstStep(client, 'acquisitions', acq.id);

      for (const sid of surveys) {
        await client.query(`INSERT INTO lms.acquisition_survey (acquisition_id, survey_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [acq.id, sid]);
      }

      if (Array.isArray(checked_items)) {
        for (const itemCode of checked_items) {
          if (!itemCode) continue;
          await client.query(
            `INSERT INTO lms.acquisition_title_check (acquisition_id, item_code, checked_at, checked_by)
             VALUES ($1, $2, clock_timestamp(), $3) ON CONFLICT DO NOTHING`,
            [acq.id, itemCode, user.id]
          );
        }
      }

      return acq;
    });

    return NextResponse.json({ success: true, acquisition: created });
  } catch (error: any) {
    console.error('Acquisition create error:', error);
    return toResponse(error, ctx.correlationId);
  }
});

export const PUT = protect({ permission: ['acquisitions', 'update'] }, async (ctx) => {
  const request = ctx.req;
  const { withTransaction } = ctx.db;
  const user = ctx.legacyUser;

  try {
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await readJson(request);
    const {
      id,
      action,
      item_code,
      checked,
      note,
      to_stage,
      mode,
      area_required,
      negotiated_rate,
      target_handover_date,
      remarks,
    } = body;

    if (!id) return NextResponse.json({ error: 'Acquisition ID is required' }, { status: 400 });

    const updated = await withTransaction(async (client) => {
      const rec = await requireRecord(ctx, 'acquisition', id, ['acquisitions', 'update'], { forUpdate: true });
      if (action === 'toggle_check' && item_code) {
        if (checked) {
          await client.query(
            `INSERT INTO lms.acquisition_title_check (acquisition_id, item_code, checked_at, checked_by)
             VALUES ($1, $2, clock_timestamp(), $3)
             ON CONFLICT (acquisition_id, item_code)
             DO UPDATE SET checked_at = clock_timestamp(), checked_by = $3`,
            [id, item_code, user.id]
          );
        } else {
          await client.query(
            `DELETE FROM lms.acquisition_title_check WHERE acquisition_id = $1 AND item_code = $2`,
            [id, item_code]
          );
        }
        return { id, item_code, checked };
      }

      if (action === 'transition' && to_stage) {
        const wfRes = await client.query(
          `SELECT api.advance_workflow('acquisitions', $1, $2, $3, $4) AS stage`,
          // $4: the approval position acted in; NULL lets the database pick the caller's eligible one.
          [id, to_stage, note || null, typeof body.as_group === 'string' && body.as_group ? body.as_group : null]
        );
        return { id, stage_code: wfRes.rows[0]?.stage };
      }

      // The rate and area the Approval step agreed are fixed from then on; changing them
      // before handover sends the acquisition back to be approved again (AUTHZ-10).
      const changing = [
        ...(['area_required', 'negotiated_rate'] as const)
          .filter((k) => body[k] !== undefined && body[k] !== '' && body[k] !== null && Number(body[k]) !== Number(rec.row[k])),
        ...(mode && mode !== rec.row.mode ? ['mode'] : []),
      ];
      if (changing.length && await termsFrozen(client, 'acquisitions', rec.id, rec.row.stage_code, 'Approval')) {
        const reason = typeof body.reopen_reason === 'string' && body.reopen_reason.trim().length >= 10
          ? body.reopen_reason : `Sent back for changes: ${changing.join(', ').replace(/_/g, ' ')} edited`;
        await reopenForChanges(client, 'acquisitions', rec.id, reason);
      }
      const res = await client.query(
        `UPDATE lms.acquisition
         SET mode = COALESCE($2, mode),
             area_required = COALESCE($3, area_required),
             negotiated_rate = COALESCE($4, negotiated_rate),
             target_handover_date = COALESCE($5, target_handover_date),
             remarks = COALESCE($6, remarks),
             updated_by = $7,
             updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [
          id,
          mode || null,
          area_required ? Number(area_required) : null,
          negotiated_rate !== undefined && negotiated_rate !== '' ? Number(negotiated_rate) : null,
          target_handover_date || null,
          remarks ?? null,
          user.id,
        ]
      );
      if (res.rows.length === 0) throw new HttpError(404, 'Acquisition not found', 'not_found');
      return res.rows[0];
    });

    return NextResponse.json({ success: true, acquisition: updated });
  } catch (error: any) {
    console.error('Acquisition update error:', error);
    return toResponse(error, ctx.correlationId);
  }
});

