import { likeOf, pageOf, paged, summarize } from '@/lib/paging';
import { NextResponse } from 'next/server';
import type { PoolClient } from 'pg';
import { HttpError, protect, readJson, requireLinked, requireRecord, toResponse } from '@/lib/iam/http';
import { canSeePii, redact } from '@/lib/iam/pii';
import { queueFirstStep, reopenForChanges, termsFrozen, writeCaseLines } from '@/lib/workflow';

const LINE_KINDS = ['lease_lines', 'crop_lines', 'tree_lines', 'misc_lines'] as const;

/** Owners and parcels named on a case must be in its province and visible to the caller (AUTHZ-15). */
async function checkCaseLinks(ctx: Parameters<typeof requireLinked>[0], client: PoolClient, province: string, owners: unknown, lines: Record<string, unknown>) {
  if (owners !== undefined && owners !== null && !Array.isArray(owners)) throw new HttpError(400, 'owners must be a list.', 'validation');
  const ownerIds = Array.isArray(owners) ? owners.map((o: any) => o?.landowner_id).filter(Boolean) : [];
  await requireLinked(ctx, 'landowner', ownerIds, province, 'landowner');
  if (ownerIds.length) {
    const dead = await client.query(`SELECT full_name FROM lms.landowner WHERE id = ANY($1::uuid[]) AND status = 'Deceased' LIMIT 1`, [ownerIds]);
    if (dead.rows.length) throw new HttpError(400, `Cannot add deceased owner ${dead.rows[0].full_name} to case compensation.`, 'validation');
  }
  const surveyIds: unknown[] = [];
  for (const k of LINE_KINDS) {
    const v = lines[k];
    if (v === undefined || v === null) continue;
    if (!Array.isArray(v)) throw new HttpError(400, `${k} must be a list.`, 'validation');
    for (const l of v) if (l?.survey_id) surveyIds.push(l.survey_id);
  }
  await requireLinked(ctx, 'survey', surveyIds, province, 'survey');
}

export const GET = protect({ permission: ['cases', 'read'] }, async (ctx) => {
  const request = ctx.req;
  const { query } = ctx.db;

  try {
    const { searchParams } = new URL(request.url);
    const province = searchParams.get('province');
    const stage = searchParams.get('stage');
    const caseId = searchParams.get('id');

    if (caseId) {
      const caseRes = await query(
        `SELECT cs.*, cc.project_id, cc.case_remarks, cc.crop_remarks, cc.tree_remarks, cc.misc_remarks,
                cc.lease_rate, cc.lease_term_months, cc.created_at, cc.created_by,
                lms.user_full_name(cc.created_by) as created_by_name
         FROM api.v_case_status cs
         JOIN lms.compensation_case cc ON cc.id = cs.case_id
         WHERE cs.case_id = $1`,
        [caseId]
      );

      if (caseRes.rows.length === 0) {
        return NextResponse.json({ error: 'Case not found' }, { status: 404 });
      }

      const ownersRes = await query(
        `SELECT co.id, co.landowner_id, co.owner_status, co.share_pct,
                lo.code as landowner_code, lo.full_name, lo.cnic, lo.tax_status, lo.status as landowner_record_status, lo.province_code
         FROM lms.case_owner co
         JOIN lms.landowner lo ON lo.id = co.landowner_id
         WHERE co.case_id = $1
         ORDER BY co.share_pct DESC`,
        [caseId]
      );

      const leaseLinesRes = await query(
        `SELECT cl.*, s.code as survey_code, s.survey_no, s.total_area as survey_total_area
         FROM lms.case_lease_line cl
         JOIN lms.survey s ON s.id = cl.survey_id
         WHERE cl.case_id = $1
         ORDER BY cl.line_no ASC`,
        [caseId]
      );

      const cropLinesRes = await query(
        `SELECT cl.*, s.survey_no
         FROM lms.case_crop_line cl
         LEFT JOIN lms.survey s ON s.id = cl.survey_id
         WHERE cl.case_id = $1`,
        [caseId]
      );

      const treeLinesRes = await query(
        `SELECT tl.*, ts.name as species_name, s.survey_no
         FROM lms.case_tree_line tl
         JOIN lms.tree_species ts ON ts.code = tl.species_code
         LEFT JOIN lms.survey s ON s.id = tl.survey_id
         WHERE tl.case_id = $1`,
        [caseId]
      );

      const miscLinesRes = await query(
        `SELECT ml.*, s.survey_no
         FROM lms.case_misc_line ml
         LEFT JOIN lms.survey s ON s.id = ml.survey_id
         WHERE ml.case_id = $1`,
        [caseId]
      );

      const docChecksRes = await query(
        `SELECT di.code, di.name, di.required_when,
                dc.checked_at, dc.checked_by, lms.user_full_name(dc.checked_by) as checked_by_name
         FROM lms.case_document_item di
         LEFT JOIN lms.case_document_check dc ON dc.item_code = di.code AND dc.case_id = $1
         ORDER BY di.display_order ASC`,
        [caseId]
      );

      const transitionsRes = await query(
        `SELECT wt.*, lms.user_full_name(wt.acted_by) as acted_by_name
         FROM lms.workflow_transition wt
         WHERE wt.workflow_code = 'cases' AND wt.record_id = $1
         ORDER BY wt.acted_at ASC`,
        [caseId]
      );

      const assignRes = await query(
        `SELECT * FROM lms.workflow_assignment
         WHERE workflow_code = 'cases' AND record_id = $1 AND closed_at IS NULL`,
        [caseId]
      );

      const speciesRes = await query('SELECT * FROM lms.tree_species ORDER BY display_order ASC');

      return NextResponse.json(redact({
        case: caseRes.rows[0],
        owners: ownersRes.rows,
        lease_lines: leaseLinesRes.rows,
        crop_lines: cropLinesRes.rows,
        tree_lines: treeLinesRes.rows,
        misc_lines: miscLinesRes.rows,
        document_checks: docChecksRes.rows,
        tree_species: speciesRes.rows,
        transitions: transitionsRes.rows,
        currentAssignment: assignRes.rows[0] || null,
      }, ctx));
    }

    // Filter, count and page on the base table, then read api.v_case_status
    // (settlement, owners, waiting position — costly per case) for the page only.
    // On 30,000 cases this is the difference between ~0.1 s and ~4.5 s.
    let sql = `
      SELECT c.id, c.case_date, c.code, c.stage_code, c.total_amount
        FROM lms.compensation_case c
        JOIN lms.project p ON p.id = c.project_id
       WHERE true`;
    const params: any[] = [];
    if (province && province !== 'ALL') { params.push(province); sql += ` AND c.province_code = $${params.length}`; }
    if (stage) { params.push(stage); sql += ` AND c.stage_code = $${params.length}`; }
    const project = searchParams.get('project');
    if (project) { params.push(project); sql += ` AND p.code = $${params.length}`; }

    // Register totals for the KPI tiles: the whole register in scope, before the search narrows it.
    const summary = await summarize(query, sql, params, { total: `count(*)`, total_amount: `coalesce(sum(total_amount),0)`,
      prepared: `count(*) FILTER (WHERE stage_code = 'Prepared')`, ho_approved: `count(*) FILTER (WHERE stage_code = 'HO Approved')`,
      in_workflow: `count(*) FILTER (WHERE stage_code NOT IN ('HO Approved', 'Cancelled'))` });

    const q = (searchParams.get('q') ?? '').trim();
    if (q) {
      params.push(likeOf(q));
      const n = params.length;
      sql += ` AND (c.code::text ILIKE $${n} OR p.code::text ILIKE $${n} OR p.name ILIKE $${n} OR c.land_use_code ILIKE $${n}
               OR c.lease_no::text ILIKE $${n}
               OR EXISTS (SELECT 1 FROM lms.case_owner co JOIN lms.landowner lo ON lo.id = co.landowner_id
                           WHERE co.case_id = c.id AND (lo.code::text ILIKE $${n} OR lo.full_name ILIKE $${n}${canSeePii(ctx) ? ` OR lo.cnic::text ILIKE $${n}` : ''})))`;
    }

    const { rows: ids, page } = await paged(query, sql, params, `case_date DESC, code DESC`, pageOf(searchParams));
    const result = { rows: ids.length ? (await query(
      `SELECT case_id, case_code, lease_no, province_code, project_code, project_name,
              land_use_code, case_date, effective_date, stage_code, stage_seq,
              approved_at, total_lease_area, total_lease_amount, total_crop_amount,
              total_tree_amount, total_misc_amount, total_amount, lease_area_acre_ghunta,
              owner_count, owner_codes, days_at_stage, waiting_on_group, allocated_amount,
              released_amount, outstanding_amount
         FROM api.v_case_status WHERE case_id = ANY($1::uuid[])
        ORDER BY case_date DESC, case_code DESC`, [ids.map((r: any) => r.id)])).rows : [] };
    const speciesRes = await query('SELECT * FROM lms.tree_species ORDER BY display_order ASC');
    const docItemsRes = await query('SELECT * FROM lms.case_document_item ORDER BY display_order ASC');

    return NextResponse.json({ page, summary,
      cases: result.rows,
      tree_species: speciesRes.rows,
      document_items: docItemsRes.rows,
    });
  } catch (error: any) {
    return toResponse(error, ctx.correlationId);
  }
});

export const POST = protect({ permission: ['cases', 'create'] }, async (ctx) => {
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
      land_use_code,
      case_remarks,
      crop_remarks,
      tree_remarks,
      misc_remarks,
      lease_rate,
      lease_term_months,
      owners,
      lease_lines,
      crop_lines,
      tree_lines,
      misc_lines,
      checked_documents,
    } = body;

    if (!project_id) {
      return NextResponse.json({ error: 'Project is required', error_code: 'MISSING_PROJECT' }, { status: 400 });
    }
    if (!land_use_code) {
      return NextResponse.json({ error: 'Land use is required' }, { status: 400 });
    }
    if (Array.isArray(owners) && owners.some((o: any) => !o.landowner_id || !(Number(o.share_pct) > 0))) {
      return NextResponse.json({ error: 'Each landowner on a case needs a share' }, { status: 400 });
    }

    const created = await withTransaction(async (client) => {
      // The case is raised in its project's province, where the caller must hold cases:create.
      const proj = await requireRecord(ctx, 'project', project_id, ['cases', 'create']);
      const province_code = proj.province as string;
      await checkCaseLinks(ctx, client, province_code, owners, { lease_lines, crop_lines, tree_lines, misc_lines });

      const codeRes = await client.query("SELECT lms.next_code_year('CC') as code, lms.next_code('LN-') as lease_no");
      const caseCode = codeRes.rows[0].code;
      const leaseNo = codeRes.rows[0].lease_no;

      const caseInsert = await client.query(
        `INSERT INTO lms.compensation_case (
          code, lease_no, province_code, project_id, land_use_code,
          case_date, effective_date, case_remarks, crop_remarks, tree_remarks, misc_remarks,
          lease_rate, lease_term_months,
          stage_code, created_by, updated_by
        ) VALUES (
          $1, $2, $3, $4, $5,
          CURRENT_DATE, CURRENT_DATE, $6, $7, $8, $9,
          $10, $11,
          'Prepared', $12, $12
        ) RETURNING *`,
        [
          caseCode,
          leaseNo,
          province_code,
          project_id,
          land_use_code,
          case_remarks || null,
          crop_remarks || null,
          tree_remarks || null,
          misc_remarks || null,
          lease_rate !== undefined && lease_rate !== '' ? Number(lease_rate) : null,
          lease_term_months !== undefined && lease_term_months !== '' ? Number(lease_term_months) : null,
          user.id,
        ]
      );
      const newCase = caseInsert.rows[0];

      if (owners && Array.isArray(owners)) {
        for (const o of owners) {
          if (!o.landowner_id) continue;
          await client.query(
            `INSERT INTO lms.case_owner (case_id, landowner_id, share_pct, owner_status)
             VALUES ($1, $2, $3, $4)`,
            [newCase.id, o.landowner_id, Number(o.share_pct), o.owner_status || 'O']
          );
        }
      }

      // Valuation comes only from line items; totals are derived from them in the database.
      await writeCaseLines(client, newCase.id, { lease_lines, crop_lines, tree_lines, misc_lines });
      // Into the queue for its first approval step, as the approval matrix routes it.
      await queueFirstStep(client, 'cases', newCase.id);

      // A document is ticked only when the person creating the case says they have seen it.
      if (Array.isArray(checked_documents)) {
        for (const itemCode of checked_documents) {
          await client.query(
            `INSERT INTO lms.case_document_check (case_id, item_code, checked_at, checked_by)
             VALUES ($1, $2, clock_timestamp(), $3) ON CONFLICT DO NOTHING`,
            [newCase.id, itemCode, user.id]
          );
        }
      }

      const refreshed = await client.query('SELECT * FROM lms.compensation_case WHERE id = $1', [newCase.id]);
      return refreshed.rows[0];
    });

    return NextResponse.json({ success: true, case: created });
  } catch (error: any) {
    console.error('Case create error:', error);
    return toResponse(error, ctx.correlationId);
  }
});

export const PUT = protect({ permission: ['cases', 'update'] }, async (ctx) => {
  const request = ctx.req;
  const { withTransaction } = ctx.db;
  const user = ctx.legacyUser;

  try {
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await readJson(request);
    const {
      id,
      case_id,
      action,
      item_code,
      checked,
      land_use_code,
      case_remarks,
      crop_remarks,
      tree_remarks,
      misc_remarks,
      lease_rate,
      lease_term_months,
      owners,
      lease_lines,
      crop_lines,
      tree_lines,
      misc_lines,
    } = body;

    const targetId = id || case_id;
    if (!targetId) {
      return NextResponse.json({ error: 'Case ID is required' }, { status: 400 });
    }

    const updated = await withTransaction(async (client) => {
      if (action === 'transition') {
        // The same permission the dedicated transition route requires, for this case's province and project.
        if (!ctx.has('cases', 'approve')) throw new HttpError(403, 'You are not permitted to approve compensation cases', 'forbidden');
        if (typeof body.to_stage !== 'string' || !body.to_stage) throw new HttpError(400, 'to_stage is required');
        await requireRecord(ctx, 'compensation_case', targetId, ['cases', 'approve']);
        const wf = await client.query(`SELECT api.advance_workflow('cases', $1, $2, $3, $4) AS stage`,
          [targetId, body.to_stage, typeof body.note === 'string' && body.note.trim() ? body.note.trim() : null,
            typeof body.as_group === 'string' && body.as_group ? body.as_group : null]);
        return { id: targetId, stage_code: wf.rows[0]?.stage };
      }

      const rec = await requireRecord(ctx, 'compensation_case', targetId, ['cases', 'update'], { forUpdate: true });

      if (action === 'toggle_doc') {
        if (typeof item_code !== 'string' || !item_code) throw new HttpError(400, 'item_code is required');
        if (checked) {
          await client.query(
            `INSERT INTO lms.case_document_check (case_id, item_code, checked_at, checked_by)
             VALUES ($1, $2, clock_timestamp(), $3)
             ON CONFLICT (case_id, item_code) DO UPDATE SET checked_at = clock_timestamp(), checked_by = $3`,
            [targetId, item_code, user.id]
          );
        } else {
          await client.query(
            `DELETE FROM lms.case_document_check WHERE case_id = $1 AND item_code = $2`,
            [targetId, item_code]
          );
        }
        const docsRes = await client.query(
          `SELECT di.code, di.name, di.required_when, dc.checked_at, dc.checked_by
           FROM lms.case_document_item di
           LEFT JOIN lms.case_document_check dc ON dc.item_code = di.code AND dc.case_id = $1
           ORDER BY di.display_order ASC`,
          [targetId]
        );
        return { id: targetId, document_checks: docsRes.rows };
      }

      // The valuation (owners, lines, rate, term, land use) is fixed by the first approval.
      // Changing it after that sends the case back to its first stage, so every
      // approval is given again on the new figures (AUTHZ-10); a locked case is refused.
      const parts = [
        ...(Array.isArray(owners) && owners.length > 0 ? ['owners'] : []),
        ...LINE_KINDS.filter((k) => Array.isArray(body[k])).map((k) => k.replace('_', ' ')),
        ...(lease_rate !== undefined && lease_rate !== '' && Number(lease_rate) !== Number(rec.row.lease_rate) ? ['lease rate'] : []),
        ...(lease_term_months !== undefined && lease_term_months !== '' && Number(lease_term_months) !== Number(rec.row.lease_term_months) ? ['lease term'] : []),
        ...(land_use_code && land_use_code !== rec.row.land_use_code ? ['land use'] : []),
      ];
      if (parts.length) {
        await checkCaseLinks(ctx, client, rec.province as string, owners, { lease_lines, crop_lines, tree_lines, misc_lines });
        if (await termsFrozen(client, 'cases', rec.id, rec.row.stage_code, 'Checked')) {
          const reason = typeof body.reopen_reason === 'string' && body.reopen_reason.trim().length >= 10
            ? body.reopen_reason : `Sent back for changes: ${parts.join(', ')} edited`;
          await reopenForChanges(client, 'cases', rec.id, reason);
        }
      }

      const res = await client.query(
        `UPDATE lms.compensation_case
         SET land_use_code = COALESCE($2, land_use_code),
             case_remarks = COALESCE($3, case_remarks),
             crop_remarks = COALESCE($4, crop_remarks),
             tree_remarks = COALESCE($5, tree_remarks),
             misc_remarks = COALESCE($6, misc_remarks),
             lease_rate = COALESCE($7, lease_rate),
             lease_term_months = COALESCE($8, lease_term_months),
             updated_by = $9,
             updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [
          targetId,
          land_use_code || null,
          case_remarks ?? null,
          crop_remarks ?? null,
          tree_remarks ?? null,
          misc_remarks ?? null,
          lease_rate !== undefined && lease_rate !== '' ? Number(lease_rate) : null,
          lease_term_months !== undefined && lease_term_months !== '' ? Number(lease_term_months) : null,
          user.id,
        ]
      );

      if (res.rows.length === 0) throw new HttpError(404, 'Case not found', 'not_found');

      if (Array.isArray(owners) && owners.length > 0) {
        await client.query('DELETE FROM lms.case_owner WHERE case_id = $1', [targetId]);
        for (const o of owners) {
          if (!o.landowner_id) continue;
          await client.query(
            `INSERT INTO lms.case_owner (case_id, landowner_id, share_pct, owner_status)
             VALUES ($1, $2, $3, $4)`,
            [targetId, o.landowner_id, Number(o.share_pct), o.owner_status || 'O']
          );
        }
      }

      // Lines, when given, replace the case's valuation; totals are always recomputed
      // (a change of lease rate or term changes the lease amount too).
      await writeCaseLines(client, targetId, { lease_lines, crop_lines, tree_lines, misc_lines });
      return (await client.query('SELECT * FROM lms.compensation_case WHERE id = $1', [targetId])).rows[0];
    });

    return NextResponse.json({ success: true, case: updated });
  } catch (error: any) {
    console.error('Case update error:', error);
    return toResponse(error, ctx.correlationId);
  }
});
