import { likeOf, pageOf, paged, summarize } from '@/lib/paging';
import { NextResponse } from 'next/server';
import { HttpError, protect, readJson, requireRecord, toResponse } from '@/lib/iam/http';

export const GET = protect({ permission: ['budgets', 'read'] }, async (ctx) => {
  const request = ctx.req;
  const { query } = ctx.db;

  try {
    const { searchParams } = new URL(request.url);
    const province = searchParams.get('province');
    const fiscalYear = searchParams.get('fiscal_year');
    const projectId = searchParams.get('project_id');

    let sql = `
      SELECT bu.*, b.project_id, b.remarks
      FROM api.v_budget_utilisation bu
      JOIN lms.budget b ON b.id = bu.budget_id
      WHERE 1=1
    `;
    const params: any[] = [];

    if (province && province !== 'ALL') {
      params.push(province);
      sql += ` AND bu.province_code = $${params.length}`;
    }

    if (projectId) {
      params.push(projectId);
      sql += ` AND b.project_id = $${params.length}`;
    }

    if (fiscalYear) {
      params.push(Number(fiscalYear));
      sql += ` AND bu.fiscal_year = $${params.length}`;
    }

    // Register totals for the KPI tiles: the whole register in scope, before the search narrows it.

    const summary = await summarize(query, sql, params, { approved_amount: `coalesce(sum(approved_amount),0)`, released_amount: `coalesce(sum(released_amount),0)`, committed_amount: `coalesce(sum(committed_amount),0)`, over_budget: `count(*) FILTER (WHERE balance_amount < 0)` });

    const q = (searchParams.get('q') ?? '').trim();

    if (q) { params.push(likeOf(q)); sql += ` AND (bu.project_code::text ILIKE $${params.length} OR bu.project_name::text ILIKE $${params.length})`; }

    const { rows: resRows, page } = await paged(query, sql, params, `bu.fiscal_year DESC, bu.project_code ASC`, pageOf(searchParams));

    const res = { rows: resRows };
    return NextResponse.json({ page, summary, fiscal_years: (await query(`SELECT DISTINCT fiscal_year FROM lms.budget ORDER BY fiscal_year DESC`)).rows.map((r) => r.fiscal_year), budgets: res.rows });
  } catch (error: any) {
    return toResponse(error, ctx.correlationId);
  }
});

export const POST = protect({ permission: ['budgets', 'create'] }, async (ctx) => {
  const request = ctx.req;
  const { withTransaction } = ctx.db;
  const user = ctx.legacyUser;

  try {
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await readJson(request);
    const { project_id, fiscal_year, approved_amount, approval_ref, remarks } = body;

    if (!project_id || !fiscal_year || approved_amount === undefined) {
      return NextResponse.json({ error: 'Project, fiscal year, and approved amount are required' }, { status: 400 });
    }

    if (!Number.isInteger(Number(fiscal_year)) || !Number.isFinite(Number(approved_amount)))
      return NextResponse.json({ error: 'fiscal_year must be a year and approved_amount a number', code: 'validation' }, { status: 400 });

    const created = await withTransaction(async (client) => {
      const prov = (await requireRecord(ctx, 'project', project_id, ['budgets', 'create'])).province;

      const codeRes = await client.query("SELECT lms.next_code('BGT-') as code");
      const bgtCode = codeRes.rows[0].code;

      const res = await client.query(
        `INSERT INTO lms.budget (
          code, province_code, project_id, fiscal_year, approved_amount, approval_ref, remarks, created_by, updated_by
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
        RETURNING *`,
        [
          bgtCode,
          prov,
          project_id,
          Number(fiscal_year),
          Number(approved_amount),
          approval_ref || null,
          remarks || null,
          user.id,
        ]
      );
      return res.rows[0];
    });

    return NextResponse.json({ success: true, budget: created });
  } catch (error: any) {
    console.error('Budget create error:', error);
    return toResponse(error, ctx.correlationId);
  }
});

export const PUT = protect({ permission: ['budgets', 'update'] }, async (ctx) => {
  const request = ctx.req;
  const { withTransaction } = ctx.db;
  const user = ctx.legacyUser;

  try {
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await readJson(request);
    const { id, approved_amount, approval_ref, remarks } = body;

    if (!id) return NextResponse.json({ error: 'Budget ID is required' }, { status: 400 });

    const updated = await withTransaction(async (client) => {
      await requireRecord(ctx, 'budget', id, ['budgets', 'update'], { forUpdate: true });

      const res = await client.query(
        `UPDATE lms.budget
         SET approved_amount = COALESCE($2, approved_amount),
             approval_ref = COALESCE($3, approval_ref),
             remarks = COALESCE($4, remarks),
             updated_by = $5,
             updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [
          id,
          approved_amount !== undefined && approved_amount !== '' ? Number(approved_amount) : null,
          approval_ref ?? null,
          remarks ?? null,
          user.id,
        ]
      );
      if (res.rows.length === 0) throw new HttpError(404, 'Budget not found', 'not_found');
      return res.rows[0];
    });

    return NextResponse.json({ success: true, budget: updated });
  } catch (error: any) {
    console.error('Budget update error:', error);
    return toResponse(error, ctx.correlationId);
  }
});

