import { likeOf, pageOf, paged, summarize } from '@/lib/paging';
import { NextResponse } from 'next/server';
import { HttpError, protect, readJson, requireRecord, toResponse, type Ctx } from '@/lib/iam/http';
import { canSeePii, guardPiiWrite, redact } from '@/lib/iam/pii';
import { isValidCNIC } from '@/lib/domain';

const PII = ['cnic', 'phone', 'iban', 'address'] as const;

// Statement lines that are money paid out; with the balance and paid-to-date they
// are finance data (UI-09) and leave the server only with payments:read for the
// owner's province. Hiding them in the page alone is not enough.
const PAYMENT_ENTRIES = new Set(['Compensation paid', 'Payment reversed', 'Other payment (not compensation)']);
const seesPayments = (ctx: Ctx, province: string | null | undefined) =>
  ctx.can('payments', 'read', { province: province ?? null });
const withoutPayments = <T extends Record<string, any>>(row: T): T => { const { paid_to_date: _p, ...rest } = row; return rest as T; };

export const GET = protect({ permission: ['landowners', 'read'] }, async (ctx) => {
  const request = ctx.req;
  const { query } = ctx.db;

  try {
    const { searchParams } = new URL(request.url);
    const search = searchParams.get('search') || searchParams.get('q');
    const province = searchParams.get('province');
    const status = searchParams.get('status');
    const statementFor = searchParams.get('statement_for');
    const id = searchParams.get('id');

    if (statementFor) {
      const loRes = await query(
        `SELECT lo.*, s.holding_count, s.owned_area_acres, s.active_lease_count, s.paid_to_date, s.is_on_hold
         FROM lms.landowner lo
         LEFT JOIN api.v_landowner_summary s ON s.landowner_id = lo.id
         WHERE lo.id = $1`,
        [statementFor]
      );
      if (loRes.rows.length === 0) {
        return NextResponse.json({ error: 'Landowner not found', code: 'not_found' }, { status: 404 });
      }
      const owner = loRes.rows[0];
      const pay = seesPayments(ctx, owner.province_code);
      const stmtRes = await query('SELECT * FROM api.report_landowner_statement($1)', [statementFor]);
      // Without payments:read: approved compensation and adjustments only, no running balance.
      const lines = stmtRes.rows
        .filter((r: any) => pay || !PAYMENT_ENTRIES.has(r.entry_type))
        .map((r: any) => {
          const line = { province_code: owner.province_code, ...r };
          if (!pay) delete line.running_total;
          return line;
        });
      // The statement repeats the owner's identity on every line; all of it is masked without pii:read.
      return NextResponse.json(redact({
        landowner: pay ? owner : withoutPayments(owner),
        statement: lines,
        payments_shown: pay,
      }, ctx));
    }

    if (id) {
      const loRes = await query(
        `SELECT lo.*, s.holding_count as total_parcels, s.owned_area_acres as total_acres, s.paid_to_date, s.is_on_hold
         FROM lms.landowner lo
         LEFT JOIN api.v_landowner_summary s ON s.landowner_id = lo.id
         WHERE lo.id = $1`,
        [id]
      );
      if (loRes.rows.length === 0) {
        return NextResponse.json({ error: 'Landowner not found', code: 'not_found' }, { status: 404 });
      }
      const owner = loRes.rows[0];
      return NextResponse.json(redact({ landowner: seesPayments(ctx, owner.province_code) ? owner : withoutPayments(owner) }, ctx));
    }

    // Filter, count and page on lms.landowner; read the per-owner aggregates
    // (holdings, payments, holds) from api.v_landowner_summary for the page only.
    let sql = `
      SELECT lo.id, lo.full_name, lo.tax_status, lo.status,
             EXISTS (SELECT 1 FROM lms.payment_hold h WHERE h.scope = 'landowner' AND h.landowner_id = lo.id AND h.lifted_at IS NULL) AS is_on_hold
        FROM lms.landowner lo
       WHERE true`;
    const params: any[] = [];
    if (province && province !== 'ALL') { params.push(province); sql += ` AND lo.province_code = $${params.length}`; }
    if (status) { params.push(status); sql += ` AND lo.status = $${params.length}`; }

    // Register totals for the KPI tiles: the whole register in scope, before the search narrows it.
    const summary = await summarize(query, sql, params, { total: `count(*)`, non_filers: `count(*) FILTER (WHERE tax_status <> 'Filer')`,
      deceased: `count(*) FILTER (WHERE status = 'Deceased')`, on_hold: `count(*) FILTER (WHERE is_on_hold)` });

    if (search) {
      params.push(likeOf(search));
      const n = params.length;
      // Searching by CNIC would confirm a number the caller may not see; it needs pii:read.
      const byCnic = canSeePii(ctx) ? ` OR lo.cnic::text ILIKE $${n}` : '';
      sql += ` AND (lo.full_name ILIKE $${n}${byCnic} OR lo.code::text ILIKE $${n} OR lo.father_name ILIKE $${n})`;
    }

    const { rows: ids, page } = await paged(query, sql, params, `full_name ASC, id`, pageOf(searchParams));
    const result = { rows: ids.length ? (await query(
      `SELECT s.landowner_id as id, s.landowner_code as code, s.province_code, s.full_name, s.father_name,
              s.cnic, s.phone, s.owner_type, s.status, s.tax_status, s.bank_branch,
              s.tax_status as filer_status,
              s.holding_count as total_parcels, s.owned_area_acres as total_acres,
              s.active_lease_count, s.paid_to_date,
              (s.status = 'Deceased') as is_deceased, s.is_on_hold,
              lo.iban, lo.address
         FROM api.v_landowner_summary s
         JOIN lms.landowner lo ON lo.id = s.landowner_id
        WHERE s.landowner_id = ANY($1::uuid[])
        ORDER BY s.full_name ASC, s.landowner_id`, [ids.map((r: any) => r.id)])).rows : [] };
    const landowners = result.rows.map((r: any) => (seesPayments(ctx, r.province_code) ? r : withoutPayments(r)));
    return NextResponse.json(redact({ page, summary, landowners }, ctx));
  } catch (error: any) {
    return toResponse(error, ctx.correlationId);
  }
});

export const POST = protect({ permission: ['landowners', 'create'] }, async (ctx) => {
  const request = ctx.req;
  const { withTransaction } = ctx.db;
  const user = ctx.legacyUser;

  try {
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await readJson(request);
    const {
      code,
      full_name,
      father_name,
      cnic,
      province_code,
      owner_type,
      tax_status,
      phone,
      iban,
      bank_branch,
      address,
      status,
      is_deceased,
    } = body;

    if (!full_name || !father_name || !cnic || !province_code || !owner_type || !tax_status) {
      return NextResponse.json({ error: 'Full name, father name, CNIC, province, owner type and tax status are required' }, { status: 400 });
    }

    if (typeof cnic !== 'string' || !isValidCNIC(cnic)) {
      return NextResponse.json({ error: 'CNIC must follow the valid format: XXXXX-XXXXXXX-X' }, { status: 400 });
    }
    if (typeof province_code !== 'string' || !/^[A-Z]{3}$/.test(province_code)) {
      return NextResponse.json({ error: 'province_code must be a province code', code: 'validation' }, { status: 400 });
    }
    // A record is created only where the caller holds the permission (a province-limited grant covers its province only).
    if (!ctx.can('landowners', 'create', { province: province_code })) {
      return NextResponse.json({ error: 'You may not register landowners in that province.', code: 'forbidden', correlationId: ctx.correlationId }, { status: 403 });
    }

    const created = await withTransaction(async (client) => {
      // CNICs are unique across provinces. The answer is the same whether or not the
      // existing record is visible to the caller, and names nobody.
      const existing = await client.query('SELECT 1 FROM lms.landowner WHERE cnic = $1', [cnic.trim()]);
      if (existing.rows.length > 0) {
        throw new HttpError(409, 'A landowner with this CNIC is already registered.', 'conflict');
      }

      let ownerCode = code;
      if (!ownerCode) {
        const codeRes = await client.query('SELECT lms.next_code($1) as code', [`${province_code}-`]);
        ownerCode = codeRes.rows[0].code;
      }

      const res = await client.query(
        `INSERT INTO lms.landowner (
          code, full_name, father_name, cnic, province_code, owner_type, tax_status,
          phone, iban, bank_branch, address, status, created_by, updated_by
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13)
        RETURNING *`,
        [
          ownerCode.trim().toUpperCase(),
          full_name.trim(),
          father_name?.trim() || null,
          cnic.trim(),
          province_code,
          owner_type,
          tax_status,
          phone?.trim() || null,
          iban?.trim() || null,
          bank_branch?.trim() || null,
          address?.trim() || null,
          is_deceased ? 'Deceased' : status || 'Active',
          user.id,
        ]
      );
      return res.rows[0];
    });

    return NextResponse.json(redact({ success: true, landowner: created }, ctx));
  } catch (error: any) {
    if (error?.code === '23505' && /cnic/i.test(String(error?.constraint ?? '')))
      return toResponse(new HttpError(409, 'A landowner with this CNIC is already registered.', 'conflict'), ctx.correlationId);
    return toResponse(error, ctx.correlationId);
  }
});

export const PUT = protect({ permission: ['landowners', 'update'] }, async (ctx) => {
  const request = ctx.req;
  const { withTransaction } = ctx.db;
  const user = ctx.legacyUser;

  try {
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await readJson(request);
    if (!body.id) {
      return NextResponse.json({ error: 'Landowner ID is required' }, { status: 400 });
    }

    const updated = await withTransaction(async (client) => {
      const rec = await requireRecord(ctx, 'landowner', body.id, ['landowners', 'update'], { forUpdate: true });
      // A masked value echoed back by an edit form is "unchanged"; a real change to
      // personal data needs pii:read for this landowner's province.
      guardPiiWrite(body, ctx, PII, rec.province);
      const {
        id, full_name, father_name, cnic, owner_type, tax_status, phone, iban, bank_branch, address, status, is_deceased, change_reason,
      } = body;
      for (const k of ['full_name', 'father_name', 'cnic', 'owner_type', 'tax_status', 'phone', 'iban', 'bank_branch', 'address', 'status'])
        if (body[k] !== undefined && body[k] !== null && typeof body[k] !== 'string') throw new HttpError(400, `${k} must be text.`, 'validation');
      if (cnic && !isValidCNIC(cnic)) {
        throw new HttpError(400, 'CNIC must follow the valid format: XXXXX-XXXXXXX-X', 'validation');
      }

      const resolvedStatus = is_deceased !== undefined ? (is_deceased ? 'Deceased' : 'Active') : status || null;
      // Tax status, bank details, CNIC and status decide who is paid and how much tax is withheld
      // (AUTHZ-14). The database attributes every such change; bringing a deceased owner back needs a reason.
      if (rec.row.status === 'Deceased' && resolvedStatus && resolvedStatus !== 'Deceased'
          && (typeof change_reason !== 'string' || change_reason.trim().length < 10)) {
        throw new HttpError(400, 'Give a reason (at least 10 characters) for recording this landowner as no longer deceased.', 'validation');
      }
      const reason = typeof change_reason === 'string' && change_reason.trim() ? change_reason.trim().slice(0, 500) : null;

      const res = await client.query(
        `UPDATE lms.landowner
         SET full_name = COALESCE($2, full_name),
             father_name = COALESCE($3, father_name),
             cnic = COALESCE($4, cnic),
             owner_type = COALESCE($5, owner_type),
             tax_status = COALESCE($6, tax_status),
             phone = COALESCE($7, phone),
             iban = COALESCE($8, iban),
             bank_branch = COALESCE($9, bank_branch),
             address = COALESCE($10, address),
             status = COALESCE($11, status),
             pay_details_change_reason = COALESCE($13, pay_details_change_reason),
             updated_by = $12,
             updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [
          id,
          full_name ? full_name.trim() : null,
          father_name !== undefined ? (father_name ? father_name.trim() : null) : null,
          cnic ? cnic.trim() : null,
          owner_type || null,
          tax_status || null,
          phone !== undefined ? (phone ? phone.trim() : null) : null,
          iban !== undefined ? (iban ? iban.trim() : null) : null,
          bank_branch !== undefined ? (bank_branch ? bank_branch.trim() : null) : null,
          address !== undefined ? (address ? address.trim() : null) : null,
          resolvedStatus,
          user.id,
          reason,
        ]
      );

      if (res.rows.length === 0) throw new HttpError(404, 'Landowner not found', 'not_found');
      return res.rows[0];
    });

    return NextResponse.json(redact({ success: true, landowner: updated }, ctx));
  } catch (error: any) {
    console.error('Landowner update error:', error);
    return toResponse(error, ctx.correlationId);
  }
});
