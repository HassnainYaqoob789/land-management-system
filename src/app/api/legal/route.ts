import { likeOf, pageOf, paged, summarize, type Page } from '@/lib/paging';
import { NextResponse } from 'next/server';
import { HttpError, protect, readJson, requireLinked, requireReauth, requireRecord, toResponse } from '@/lib/iam/http';
import { redact } from '@/lib/iam/pii';

const CLOSED = ['Decided — In Favour', 'Decided — Against', 'Settled', 'Withdrawn'];
const inForce = (stay: boolean, status: string) => stay && !CLOSED.includes(status);

export const GET = protect({ permission: ['legal', 'read'] }, async (ctx) => {
  const request = ctx.req;
  const { query } = ctx.db;

  try {
    const { searchParams } = new URL(request.url);
    const province = searchParams.get('province');
    const id = searchParams.get('id');

    if (id) {
      const lcRes = await query(
        `SELECT lc.*, p.code as project_code, p.name as project_name, cc.code as case_code
         FROM lms.legal_case lc
         LEFT JOIN lms.project p ON p.id = lc.project_id
         LEFT JOIN lms.compensation_case cc ON cc.id = lc.case_id
         WHERE lc.id = $1`,
        [id]
      );
      if (lcRes.rows.length === 0) {
        return NextResponse.json({ error: 'Legal case not found' }, { status: 404 });
      }
      const [hearingsRes, surveysRes, landownersRes] = await Promise.all([
        query(
          `SELECT lh.*, lms.user_full_name(lh.recorded_by) as recorded_by_name
           FROM lms.legal_hearing lh
           WHERE lh.legal_case_id = $1
           ORDER BY lh.hearing_date DESC`,
          [id]
        ),
        query(
          `SELECT lcs.survey_id, s.code as survey_code, s.survey_no, s.total_area
           FROM lms.legal_case_survey lcs
           JOIN lms.survey s ON s.id = lcs.survey_id
           WHERE lcs.legal_case_id = $1`,
          [id]
        ),
        query(
          `SELECT lcl.landowner_id, lo.code as landowner_code, lo.full_name, lo.cnic, lo.province_code
           FROM lms.legal_case_landowner lcl
           JOIN lms.landowner lo ON lo.id = lcl.landowner_id
           WHERE lcl.legal_case_id = $1`,
          [id]
        ),
      ]);
      return NextResponse.json(redact({
        legal_case: lcRes.rows[0],
        hearings: hearingsRes.rows,
        surveys: surveysRes.rows,
        landowners: landownersRes.rows,
      }, ctx));
    }

    let sql = `
      SELECT lc.*,
             p.code as project_code, p.name as project_name,
             cc.code as case_code,
             (SELECT count(*) FROM lms.legal_hearing lh WHERE lh.legal_case_id = lc.id)::int as hearing_count,
             (SELECT string_agg(s.survey_no, ', ') FROM lms.legal_case_survey lcs JOIN lms.survey s ON s.id = lcs.survey_id WHERE lcs.legal_case_id = lc.id) as survey_numbers,
             (SELECT string_agg(lo.full_name, ', ') FROM lms.legal_case_landowner lcl JOIN lms.landowner lo ON lo.id = lcl.landowner_id WHERE lcl.legal_case_id = lc.id) as landowner_names
      FROM lms.legal_case lc
      LEFT JOIN lms.project p ON p.id = lc.project_id
      LEFT JOIN lms.compensation_case cc ON cc.id = lc.case_id
      WHERE 1=1
    `;
    const params: any[] = [];
    if (province && province !== 'ALL') {
      params.push(province);
      sql += ` AND lc.province_code = $1`;
    }
    // Register totals for the KPI tiles: the whole register in scope, before the search narrows it.
    const summary = await summarize(query, sql, params, { total: `count(*)`, stay_orders: `count(*) FILTER (WHERE stay_order)`, hearings_14d: `count(*) FILTER (WHERE next_hearing BETWEEN current_date AND current_date + 14)`, exposure: `coalesce(sum(financial_exposure),0)` });
    const q = (searchParams.get('q') ?? '').trim();
    if (q) { params.push(likeOf(q)); sql += ` AND (lc.code::text ILIKE $${params.length} OR lc.court_case_no::text ILIKE $${params.length} OR lc.parties::text ILIKE $${params.length} OR lc.court::text ILIKE $${params.length})`; }
    let page: Page | undefined;
    const [casesRes, hearingsRes] = await Promise.all([
      paged(query, sql, params, `lc.stay_order DESC, lc.next_hearing ASC NULLS LAST, lc.filing_date DESC`, pageOf(searchParams)).then((r) => { page = r.page; return { rows: r.rows }; }),
      query(
        `SELECT lh.*, lc.code as legal_code, lc.court_case_no, lc.court, lc.parties, lc.province_code
         FROM lms.legal_hearing lh
         JOIN lms.legal_case lc ON lc.id = lh.legal_case_id
         ORDER BY lh.hearing_date DESC LIMIT 100`
      ),
    ]);

    return NextResponse.json(redact({ page, summary,
      legal_cases: casesRes.rows,
      hearings: hearingsRes.rows,
    }, ctx));
  } catch (error: any) {
    return toResponse(error, ctx.correlationId);
  }
});

export const POST = protect({ permission: ['legal', 'create'] }, async (ctx) => {
  const request = ctx.req;
  const { withTransaction } = ctx.db;
  const user = ctx.legacyUser;

  try {
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await readJson(request);
    const {
      province_code,
      court_case_no,
      court,
      case_type,
      company_role,
      parties,
      project_id,
      case_id,
      filing_date,
      next_hearing,
      counsel,
      financial_exposure,
      stay_order,
      status,
      remarks,
      survey_ids,
      landowner_ids,
    } = body;

    if (!court_case_no || !court || !parties || !case_type || !company_role || !status || !filing_date) {
      return NextResponse.json({ error: 'Court case number, court, parties, case type, company role, status and filing date are required' }, { status: 400 });
    }

    const created = await withTransaction(async (client) => {
      // The province is the project's when one is named; every linked record must be in it (AUTHZ-15).
      let prov: string | null = null;
      if (project_id) prov = (await requireRecord(ctx, 'project', project_id, ['legal', 'create'])).province;
      else if (typeof province_code === 'string' && /^[A-Z]{3}$/.test(province_code)) prov = province_code;
      if (!prov) throw new HttpError(400, 'Province is required: give province_code or a linked record it can be taken from.', 'validation');
      if (province_code && province_code !== prov) throw new HttpError(400, 'province_code does not match the project.', 'validation');
      if (!ctx.can('legal', 'create', { province: prov })) throw new HttpError(403, 'You may not register legal cases in that province.', 'forbidden');
      if (case_id) await requireLinked(ctx, 'compensation_case', [case_id], prov, 'compensation case');
      const surveys = await requireLinked(ctx, 'survey', survey_ids, prov, 'parcel');
      const landowners = await requireLinked(ctx, 'landowner', landowner_ids, prov, 'landowner');

      const codeRes = await client.query("SELECT lms.next_code('LIT-') as code");
      const litCode = codeRes.rows[0].code;

      const insRes = await client.query(
        `INSERT INTO lms.legal_case (
          code, province_code, court_case_no, court, case_type, company_role,
          parties, project_id, case_id, filing_date, next_hearing, counsel,
          officer_id, financial_exposure, stay_order, status, remarks,
          created_by, updated_by
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10, $11, $12,
          $13, $14, $15, $16, $17,
          $13, $13
        ) RETURNING *`,
        [
          litCode,
          prov,
          court_case_no.trim(),
          court.trim(),
          case_type,
          company_role,
          parties.trim(),
          project_id || null,
          case_id || null,
          filing_date,
          next_hearing || null,
          counsel || null,
          user.id,
          financial_exposure !== undefined && financial_exposure !== '' ? Number(financial_exposure) : 0,
          Boolean(stay_order),
          status,
          remarks || null,
        ]
      );
      const legalCase = insRes.rows[0];

      for (const sid of surveys) {
        await client.query(
          `INSERT INTO lms.legal_case_survey (legal_case_id, survey_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [legalCase.id, sid]
        );
      }
      for (const lid of landowners) {
        await client.query(
          `INSERT INTO lms.legal_case_landowner (legal_case_id, landowner_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [legalCase.id, lid]
        );
      }
      // A stay recorded on a new case holds its landowners and parcels now that they are linked.
      // (lms.tg_legal_case_stay fires on stay_order; the insert ran before the links existed.)
      if (legalCase.stay_order) await client.query('UPDATE lms.legal_case SET stay_order = stay_order WHERE id = $1', [legalCase.id]);

      return legalCase;
    });

    return NextResponse.json({ success: true, legal_case: created });
  } catch (error: any) {
    console.error('Legal case create error:', error);
    return toResponse(error, ctx.correlationId);
  }
});

export const PUT = protect({ permission: ['legal', 'update'] }, async (ctx) => {
  const request = ctx.req;
  const { withTransaction } = ctx.db;
  const user = ctx.legacyUser;

  try {
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await readJson(request);
    const {
      id,
      action,
      hearing_date,
      proceedings,
      next_date,
      status,
      stay_order,
      next_hearing,
      counsel,
      financial_exposure,
      remarks,
    } = body;

    if (!id) return NextResponse.json({ error: 'Legal case ID is required' }, { status: 400 });

    // Lifting a court stay releases held payments (AUTHZ-05): it is recorded through
    // api.lift_stay, which needs the payment-hold authority as well as legal:update,
    // with the court's order as the reason, after a fresh proof of identity.
    const probe = await withTransaction(async () => (await requireRecord(ctx, 'legal_case', id, ['legal', 'update'])).row);
    const nextStay = stay_order !== undefined ? Boolean(stay_order) : probe.stay_order;
    const nextStatus = typeof status === 'string' && status ? status : probe.status;
    const lifting = action !== 'add_hearing' && inForce(probe.stay_order, probe.status) && !inForce(nextStay, nextStatus);
    if (lifting) await requireReauth(ctx);

    const updated = await withTransaction(async (client) => {
      const rec = await requireRecord(ctx, 'legal_case', id, ['legal', 'update'], { forUpdate: true });

      if (action === 'add_hearing') {
        if (!hearing_date) throw new HttpError(400, 'hearing_date is required');
        const hRes = await client.query(
          `INSERT INTO lms.legal_hearing (legal_case_id, hearing_date, proceedings, next_date, recorded_by)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (legal_case_id, hearing_date) DO UPDATE
           SET proceedings = EXCLUDED.proceedings, next_date = EXCLUDED.next_date
           RETURNING *`,
          [id, hearing_date, proceedings || null, next_date || null, user.id]
        );
        if (next_date) {
          await client.query(
            `UPDATE lms.legal_case SET next_hearing = $2, updated_by = $3, updated_at = now() WHERE id = $1`,
            [id, next_date, user.id]
          );
        }
        return hRes.rows[0];
      }

      if (lifting) {
        const order = typeof body.lift_reason === 'string' ? body.lift_reason.trim() : '';
        if (order.length < 10) throw new HttpError(400, "Record the court's order that lifts the stay (lift_reason, at least 10 characters).", 'validation');
        await client.query('SELECT api.lift_stay($1, $2, $3)', [rec.id, order.slice(0, 500), nextStatus !== rec.row.status ? nextStatus : null]);
      }

      const res = await client.query(
        `UPDATE lms.legal_case
         SET status = COALESCE($2, status),
             stay_order = COALESCE($3, stay_order),
             next_hearing = COALESCE($4, next_hearing),
             counsel = COALESCE($5, counsel),
             financial_exposure = COALESCE($6, financial_exposure),
             remarks = COALESCE($7, remarks),
             updated_by = $8,
             updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [
          rec.id,
          lifting ? null : status || null,
          lifting || stay_order === undefined ? null : Boolean(stay_order),
          next_hearing || null,
          counsel ?? null,
          financial_exposure !== undefined && financial_exposure !== '' ? Number(financial_exposure) : null,
          remarks ?? null,
          user.id,
        ]
      );
      if (res.rows.length === 0) throw new HttpError(404, 'Legal case not found', 'not_found');
      return res.rows[0];
    });

    return NextResponse.json({ success: true, legal_case: updated });
  } catch (error: any) {
    console.error('Legal case update error:', error);
    return toResponse(error, ctx.correlationId);
  }
});

