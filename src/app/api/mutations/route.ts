import { likeOf, pageOf, paged, summarize } from '@/lib/paging';
import { NextResponse } from 'next/server';
import { HttpError, protect, readJson, requireLinked, requireRecord, toResponse } from '@/lib/iam/http';
import { canSeePii, redact } from '@/lib/iam/pii';
import { queueFirstStep, reopenForChanges, termsFrozen } from '@/lib/workflow';

const RECORD_FIELDS = ['death_date', 'revenue_mutation_no', 'mutation_date', 'revenue_office', 'certificate_no'] as const;
const same = (a: unknown, b: unknown) => (a instanceof Date ? a.toISOString().slice(0, 10) : a ?? null) === (b ?? null);

export const GET = protect({ permission: ['mutations', 'read'] }, async (ctx) => {
  const request = ctx.req;
  const { query } = ctx.db;

  try {
    const { searchParams } = new URL(request.url);
    const province = searchParams.get('province');
    const id = searchParams.get('id');

    if (id) {
      const mutRes = await query(
        `SELECT m.*,
                lo.full_name as transferor_name, lo.code as transferor_code, lo.cnic as transferor_cnic, lo.status as transferor_status,
                lms.user_full_name(m.created_by) as created_by_name
         FROM lms.mutation m
         JOIN lms.landowner lo ON lo.id = m.transferor_id
         WHERE m.id = $1`,
        [id]
      );
      if (mutRes.rows.length === 0) {
        return NextResponse.json({ error: 'Mutation not found' }, { status: 404 });
      }

      const [surveysRes, heirsRes, historyRes, transitionsRes, repointRes] = await Promise.all([
        query(
          `SELECT ms.*, s.code as survey_code, s.survey_no, s.total_area, so.location_path
           FROM lms.mutation_survey ms
           JOIN lms.survey s ON s.id = ms.survey_id
           LEFT JOIN api.v_survey_ownership so ON so.survey_id = s.id
           WHERE ms.mutation_id = $1`,
          [id]
        ),
        query(
          `SELECT mh.*, lo.full_name as heir_name, lo.code as heir_code, lo.cnic as heir_cnic, lo.tax_status
           FROM lms.mutation_heir mh
           JOIN lms.landowner lo ON lo.id = mh.landowner_id
           WHERE mh.mutation_id = $1
           ORDER BY mh.share_pct DESC`,
          [id]
        ),
        query(
          `SELECT h.*, s.survey_no, lo.full_name as landowner_name
           FROM lms.survey_ownership_history h
           JOIN lms.survey s ON s.id = h.survey_id
           JOIN lms.landowner lo ON lo.id = h.landowner_id
           WHERE h.mutation_id = $1
           ORDER BY h.recorded_at DESC`,
          [id]
        ),
        query(
          `SELECT wt.*, lms.user_full_name(wt.acted_by) as acted_by_name
           FROM lms.workflow_transition wt
           WHERE wt.workflow_code = 'mutations' AND wt.record_id = $1
           ORDER BY wt.acted_at ASC`,
          [id]
        ),
        // Open compensation and lease rent moved to the heirs / buyers when the
        // mutation was applied (migration 0061). Province-scoped by RLS.
        query(
          `SELECT r.id, r.kind, r.record_id, r.record_code,
                  r.from_landowner_id, r.from_code, r.from_name,
                  r.to_landowner_id, r.to_code, r.to_name,
                  r.share_moved, r.share_kept, r.paid_amount, r.note, r.created_at, r.created_by_name
           FROM api.v_mutation_repoint r
           WHERE r.mutation_id = $1
           ORDER BY r.kind, r.record_code, r.created_at`,
          [id]
        ),
      ]);

      return NextResponse.json(redact({
        mutation: mutRes.rows[0],
        surveys: surveysRes.rows,
        heirs: heirsRes.rows,
        ownership_history: historyRes.rows,
        transitions: transitionsRes.rows,
        repointed: repointRes.rows,
      }, ctx));
    }

    let sql = `
      SELECT m.*,
             lo.full_name as transferor_name, lo.code as transferor_code, lo.cnic as transferor_cnic,
             (SELECT count(*) FROM lms.mutation_survey ms WHERE ms.mutation_id = m.id)::int as survey_count,
             (SELECT count(*) FROM lms.mutation_heir mh WHERE mh.mutation_id = m.id)::int as heir_count,
             (SELECT COALESCE(sum(mh.share_pct), 0) FROM lms.mutation_heir mh WHERE mh.mutation_id = m.id) as heir_share_total,
             (SELECT string_agg(s.survey_no, ', ') FROM lms.mutation_survey ms JOIN lms.survey s ON s.id = ms.survey_id WHERE ms.mutation_id = m.id) as survey_numbers
      FROM lms.mutation m
      JOIN lms.landowner lo ON lo.id = m.transferor_id
      WHERE 1=1
    `;
    const params: any[] = [];
    if (province && province !== 'ALL') {
      params.push(province);
      sql += ` AND m.province_code = $1`;
    }
    // Register totals for the KPI tiles: the whole register in scope, before the search narrows it.
    const summary = await summarize(query, sql, params, { total: `count(*)`, pending: `count(*) FILTER (WHERE stage_code NOT IN ('Approved & Applied','Cancelled'))`, applied: `count(*) FILTER (WHERE stage_code = 'Approved & Applied')` });
    const q = (searchParams.get('q') ?? '').trim();
    if (q) {
      params.push(likeOf(q));
      const n = params.length;
      // What the search box offers: code, transferor, CNIC, type, revenue no. A CNIC only for
      // pii:read holders (a hit would confirm whose number it is).
      const byCnic = canSeePii(ctx) ? ` OR lo.cnic::text ILIKE $${n}` : '';
      sql += ` AND (m.code::text ILIKE $${n} OR lo.full_name::text ILIKE $${n}${byCnic}
                    OR m.mutation_type ILIKE $${n} OR m.revenue_mutation_no ILIKE $${n})`;
    }
    const { rows: resRows, page } = await paged(query, sql, params, `m.created_at DESC`, pageOf(searchParams));
    const res = { rows: resRows };
    return NextResponse.json(redact({ page, summary, mutations: res.rows }, ctx));
  } catch (error: any) {
    return toResponse(error, ctx.correlationId);
  }
});

export const POST = protect({ permission: ['mutations', 'create'] }, async (ctx) => {
  const request = ctx.req;
  const { withTransaction } = ctx.db;
  const user = ctx.legacyUser;

  try {
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await readJson(request);
    const {
      mutation_type,
      transferor_id,
      death_date,
      revenue_mutation_no,
      mutation_date,
      revenue_office,
      certificate_no,
      remarks,
      survey_ids,
      heirs, // Array<{ landowner_id, relation, share_pct }>
    } = body;

    if (!transferor_id || !mutation_type) {
      return NextResponse.json({ error: 'Transferor and mutation type are required' }, { status: 400 });
    }

    if (Array.isArray(heirs) && heirs.some((h: any) => !h.landowner_id || !h.relation || !(Number(h.share_pct) > 0))) {
      return NextResponse.json({ error: 'Each heir or transferee needs a landowner, a relation and a share' }, { status: 400 });
    }
    if (Array.isArray(heirs) && heirs.length > 0) {
      const totalPct = heirs.reduce((acc: number, h: any) => acc + Number(h.share_pct || 0), 0);
      if (Math.abs(totalPct - 100.0) > 0.01) {
        return NextResponse.json(
          { error: `Heir / transferee shares must sum to exactly 100.0%. Current sum: ${totalPct.toFixed(2)}%` },
          { status: 400 }
        );
      }
    }

    const created = await withTransaction(async (client) => {
      // A mutation is filed in the transferor's province, where the caller must hold mutations:create;
      // its parcels and heirs must be in that province too (AUTHZ-04/15).
      const transferor = await requireRecord(ctx, 'landowner', transferor_id, ['mutations', 'create']);
      const prov = transferor.province as string;
      await requireLinked(ctx, 'survey', survey_ids, prov, 'parcel');
      await requireLinked(ctx, 'landowner', Array.isArray(heirs) ? heirs.map((h: any) => h?.landowner_id) : heirs, prov, 'heir');

      const codeRes = await client.query("SELECT lms.next_code('MUT-') as code");
      const mutCode = codeRes.rows[0].code;

      const insRes = await client.query(
        `INSERT INTO lms.mutation (
          code, province_code, mutation_type, transferor_id, death_date,
          revenue_mutation_no, mutation_date, revenue_office, certificate_no,
          remarks, stage_code, created_by, updated_by
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8, $9,
          $10, 'Initiated', $11, $11
        ) RETURNING *`,
        [
          mutCode,
          prov,
          mutation_type,
          transferor_id,
          death_date || null,
          revenue_mutation_no || null,
          mutation_date || null,
          revenue_office || null,
          certificate_no || null,
          remarks || null,
          user.id,
        ]
      );
      const mut = insRes.rows[0];
      await queueFirstStep(client, 'mutations', mut.id);

      if (Array.isArray(survey_ids) && survey_ids.length > 0) {
        for (const sid of survey_ids) {
          if (!sid) continue;
          await client.query(
            `INSERT INTO lms.mutation_survey (mutation_id, survey_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [mut.id, sid]
          );
        }
      } else {
        // Default: include all surveys where transferor currently holds shares
        await client.query(
          `INSERT INTO lms.mutation_survey (mutation_id, survey_id)
           SELECT $1, survey_id FROM lms.survey_ownership_share WHERE landowner_id = $2
           ON CONFLICT DO NOTHING`,
          [mut.id, transferor_id]
        );
      }

      if (Array.isArray(heirs) && heirs.length > 0) {
        for (const h of heirs) {
          if (!h.landowner_id) continue;
          await client.query(
            `INSERT INTO lms.mutation_heir (mutation_id, landowner_id, relation, share_pct)
             VALUES ($1, $2, $3, $4)`,
            [mut.id, h.landowner_id, h.relation, Number(h.share_pct)]
          );
        }
      }

      return mut;
    });

    return NextResponse.json(redact({ success: true, mutation: created }, ctx));
  } catch (error: any) {
    console.error('Mutation create error:', error);
    return toResponse(error, ctx.correlationId);
  }
});

export const PUT = protect({ permission: ['mutations', 'update'] }, async (ctx) => {
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
      death_date,
      revenue_mutation_no,
      mutation_date,
      revenue_office,
      certificate_no,
      remarks,
      survey_ids,
      heirs,
    } = body;

    if (!id) return NextResponse.json({ error: 'Mutation ID is required' }, { status: 400 });

    const updated = await withTransaction(async (client) => {
      const rec = await requireRecord(ctx, 'mutation', id, ['mutations', 'update'], { forUpdate: true });
      if (Array.isArray(survey_ids)) await requireLinked(ctx, 'survey', survey_ids, rec.province, 'parcel');
      if (Array.isArray(heirs)) await requireLinked(ctx, 'landowner', heirs.map((h: any) => h?.landowner_id), rec.province, 'heir');

      // Once Revenue has verified the mutation, its record, parcels and heirs are what
      // Legal and head office approve. Changing them sends it back to the start, so
      // nobody approves data they did not see (AUTHZ-04); an applied mutation is final.
      const parts = [
        ...RECORD_FIELDS.filter((k) => body[k] !== undefined && body[k] !== '' && !same(rec.row[k], body[k])).map((k) => k.replace(/_/g, ' ')),
        ...(Array.isArray(survey_ids) ? ['parcels'] : []),
        ...(Array.isArray(heirs) && heirs.length > 0 ? ['heirs'] : []),
      ];
      if (parts.length && await termsFrozen(client, 'mutations', rec.id, rec.row.stage_code, 'Revenue Verified')) {
        const reason = typeof body.reopen_reason === 'string' && body.reopen_reason.trim().length >= 10
          ? body.reopen_reason : `Sent back for changes: ${parts.join(', ')} edited`;
        await reopenForChanges(client, 'mutations', rec.id, reason);
      }

      if (
        revenue_mutation_no !== undefined ||
        mutation_date !== undefined ||
        revenue_office !== undefined ||
        certificate_no !== undefined ||
        death_date !== undefined ||
        remarks !== undefined
      ) {
        await client.query(
          `UPDATE lms.mutation
           SET revenue_mutation_no = COALESCE($2, revenue_mutation_no),
               mutation_date = COALESCE($3, mutation_date),
               revenue_office = COALESCE($4, revenue_office),
               certificate_no = COALESCE($5, certificate_no),
               death_date = COALESCE($6, death_date),
               remarks = COALESCE($7, remarks),
               updated_by = $8,
               updated_at = now()
           WHERE id = $1`,
          [
            id,
            revenue_mutation_no || null,
            mutation_date || null,
            revenue_office || null,
            certificate_no || null,
            death_date || null,
            remarks ?? null,
            user.id,
          ]
        );
      }

      if (Array.isArray(survey_ids)) {
        await client.query('DELETE FROM lms.mutation_survey WHERE mutation_id = $1', [id]);
        for (const sid of survey_ids) {
          if (!sid) continue;
          await client.query(
            `INSERT INTO lms.mutation_survey (mutation_id, survey_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [id, sid]
          );
        }
      }

      if (Array.isArray(heirs) && heirs.length > 0) {
        const totalPct = heirs.reduce((acc: number, h: any) => acc + Number(h.share_pct || 0), 0);
        if (Math.abs(totalPct - 100.0) > 0.01) {
          throw new HttpError(400, `Heir shares must total 100.0% (current: ${totalPct.toFixed(2)}%)`);
        }
        await client.query('DELETE FROM lms.mutation_heir WHERE mutation_id = $1', [id]);
        for (const h of heirs) {
          if (!h.landowner_id) continue;
          await client.query(
            `INSERT INTO lms.mutation_heir (mutation_id, landowner_id, relation, share_pct)
             VALUES ($1, $2, $3, $4)`,
            [id, h.landowner_id, h.relation, Number(h.share_pct)]
          );
        }
      }

      if (action === 'transition' && to_stage) {
        const wfRes = await client.query(
          `SELECT api.advance_workflow('mutations', $1, $2, $3, $4) AS stage`,
          // $4: the approval position acted in; NULL lets the database pick the caller's eligible one.
          [id, to_stage, note || null, typeof body.as_group === 'string' && body.as_group ? body.as_group : null]
        );
        return { id, stage_code: wfRes.rows[0]?.stage };
      }

      const res = await client.query('SELECT * FROM lms.mutation WHERE id = $1', [id]);
      if (res.rows.length === 0) throw new HttpError(404, 'Mutation not found', 'not_found');
      return res.rows[0];
    });

    return NextResponse.json(redact({ success: true, mutation: updated }, ctx));
  } catch (error: any) {
    console.error('Mutation update error:', error);
    return toResponse(error, ctx.correlationId);
  }
});

