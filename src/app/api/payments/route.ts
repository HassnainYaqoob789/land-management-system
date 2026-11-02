import { NextResponse } from 'next/server';
import { HttpError, isUuid, json, protect, readJson, requireReauth, requireRecord, toResponse, type Ctx, type ScopedTable } from '@/lib/iam/http';
import { canSeePii, redact } from '@/lib/iam/pii';
import { amountInWords } from '@/lib/domain';
import { queueFirstStep } from '@/lib/workflow';
import { likeOf, pageOf, paged } from '@/lib/paging';

const FINANCE: [string, string][] = [['payments', 'verify'], ['payments', 'release']];
// What a hold may target, and the table its id is read from (under the caller's row-level security).
const HOLD_TARGET: Record<string, { table: ScopedTable; field: string }> = {
  payment: { table: 'payment_request', field: 'payment_id' }, case: { table: 'compensation_case', field: 'case_id' },
  landowner: { table: 'landowner', field: 'landowner_id' }, project: { table: 'project', field: 'project_id' },
  survey: { table: 'survey', field: 'survey_id' },
};

export const GET = protect({ permission: ['payments', 'read'] }, async (ctx) => {
  const request = ctx.req;
  const { query } = ctx.db;

  try {
    const { searchParams } = new URL(request.url);
    const province = searchParams.get('province');
    const prov = province && province !== 'ALL' ? province : null;
    const view = searchParams.get('view') || 'vouchers';
    const q = (searchParams.get('q') ?? '').trim();
    const pg = pageOf(searchParams);
    const like = q ? likeOf(q) : null;
    // A CNIC is searched only for pii:read holders: a hit would otherwise confirm whose number it is.
    const cnicOr = (col: string) => (canSeePii(ctx) ? ` OR ${col}::text ILIKE $2` : '');

    // One receipt as the printable "Receipt of Payment" document (REQ-65).
    const receiptId = searchParams.get('receipt');
    if (receiptId) return await receiptDocument(ctx, receiptId);

    // Each tab is its own bounded, searchable list. $1 is the province (or NULL), $2 the search (or NULL).
    const LISTS: Record<string, { sql: string; order: string }> = {
      vouchers: {
        sql: `SELECT pr.id, pr.code, pr.province_code, pr.landowner_id, pr.project_id, pr.case_id, pr.lease_id,
                     pr.category_code, pr.pay_type, pr.land_class, pr.created_at,
                     pr.gross_amount, pr.wht_pct, pr.wht_amount, pr.net_amount,
                     pr.stage_code, pr.payment_mode, pr.remarks, pr.period_from, pr.period_to,
                     p.code as project_code, p.name as project_name,
                     coalesce(lo.full_name, pr.payee_name) as payee, lo.cnic, lo.tax_status,
                     cc.code as case_code,
                     rel.id as release_id, rel.cheque_no, rel.cheque_date, rel.released_at,
                     (SELECT count(*) FROM lms.payment_receipt rc WHERE rc.release_id = rel.id)::int as receipt_count,
                     EXISTS (SELECT 1 FROM lms.payment_hold ph WHERE ph.lifted_at IS NULL AND (
                       (ph.scope = 'payment' AND ph.payment_id = pr.id) OR (ph.scope = 'case' AND ph.case_id = pr.case_id)
                       OR (ph.scope = 'landowner' AND ph.landowner_id = pr.landowner_id) OR (ph.scope = 'project' AND ph.project_id = pr.project_id))) as is_on_hold
                FROM lms.payment_request pr
                LEFT JOIN lms.project p ON p.id = pr.project_id
                LEFT JOIN lms.landowner lo ON lo.id = pr.landowner_id
                LEFT JOIN lms.compensation_case cc ON cc.id = pr.case_id
                LEFT JOIN lms.payment_release rel ON rel.payment_id = pr.id
               WHERE ($1::text IS NULL OR pr.province_code = $1)
                 AND ($2::text IS NULL OR pr.code::text ILIKE $2 OR coalesce(lo.full_name, pr.payee_name) ILIKE $2
                      ${cnicOr('lo.cnic')} OR p.code::text ILIKE $2 OR cc.code::text ILIKE $2 OR pr.stage_code ILIKE $2)
                 AND ($3::text IS NULL OR p.code::text = $3)`,
        order: 'created_at DESC',
      },
      releases: {
        sql: `SELECT * FROM api.v_payment_release WHERE ($1::text IS NULL OR province_code = $1)
                AND ($2::text IS NULL OR cheque_no::text ILIKE $2 OR voucher_code::text ILIKE $2 OR payee ILIKE $2${cnicOr('cnic')})`,
        order: 'released_at DESC',
      },
      liabilities: {
        sql: `SELECT * FROM api.v_outstanding_liability WHERE ($1::text IS NULL OR province_code = $1)
                AND ($2::text IS NULL OR case_code::text ILIKE $2 OR project_name ILIKE $2 OR payees ILIKE $2)`,
        order: 'outstanding_amount DESC',
      },
      holds: {
        sql: `SELECT ph.*, p.code as project_code, p.name as project_name, lo.full_name as landowner_name,
                     cc.code as case_code, pr.code as payment_code, s.code as survey_code,
                     lms.user_full_name(ph.placed_by) as placed_by_name, lms.user_full_name(ph.lifted_by) as lifted_by_name
                FROM lms.payment_hold ph
                LEFT JOIN lms.project p ON p.id = ph.project_id
                LEFT JOIN lms.landowner lo ON lo.id = ph.landowner_id
                LEFT JOIN lms.compensation_case cc ON cc.id = ph.case_id
                LEFT JOIN lms.payment_request pr ON pr.id = ph.payment_id
                LEFT JOIN lms.survey s ON s.id = ph.survey_id
               WHERE ($1::text IS NULL OR ph.province_code = $1)
                 AND ($2::text IS NULL OR ph.reason ILIKE $2 OR p.code::text ILIKE $2 OR lo.full_name ILIKE $2 OR cc.code::text ILIKE $2 OR pr.code::text ILIKE $2)`,
        order: '(lifted_at IS NULL) DESC, placed_at DESC',
      },
      allocations: {
        sql: `SELECT pa.*, pa.created_at AS allocated_at, pr.code as payment_code, cc.code as case_code,
                     lo.full_name as landowner_name, lms.user_full_name(pa.created_by) as allocated_by_name
                FROM lms.payment_allocation pa
                JOIN lms.payment_request pr ON pr.id = pa.payment_id
                JOIN lms.compensation_case cc ON cc.id = pa.case_id
                LEFT JOIN lms.landowner lo ON lo.id = pa.landowner_id
               WHERE ($1::text IS NULL OR pr.province_code = $1)
                 AND ($2::text IS NULL OR pr.code::text ILIKE $2 OR cc.code::text ILIKE $2 OR lo.full_name ILIKE $2)`,
        order: 'allocated_at DESC',
      },
      receipts: {
        sql: `SELECT rc.*, rc.received_on AS received_date, rc.acknowledged_cnic AS received_by_cnic,
                     rc.note AS remarks, rel.cheque_no, pr.code as voucher_code, lms.user_full_name(rc.recorded_by) as verified_by_name
                FROM lms.payment_receipt rc
                JOIN lms.payment_release rel ON rel.id = rc.release_id
                JOIN lms.payment_request pr ON pr.id = rel.payment_id
               WHERE ($1::text IS NULL OR pr.province_code = $1)
                 AND ($2::text IS NULL OR rc.receipt_no::text ILIKE $2 OR rel.cheque_no::text ILIKE $2 OR pr.code::text ILIKE $2)`,
        order: 'received_date DESC',
      },
    };

    // The KPI tiles: counts over the whole register in scope.
    const summary = (await query(
      `SELECT count(*) FILTER (WHERE stage_code = 'Requested')::int AS requested,
              count(*) FILTER (WHERE stage_code = 'Verified')::int AS verified,
              coalesce(sum(net_amount) FILTER (WHERE stage_code = 'Released'), 0)::numeric AS released_net,
              (SELECT count(*) FROM lms.payment_hold ph WHERE ph.lifted_at IS NULL AND ($1::text IS NULL OR ph.province_code = $1))::int AS active_holds,
              (SELECT coalesce(sum(outstanding_amount), 0) FROM api.v_outstanding_liability WHERE ($1::text IS NULL OR province_code = $1))::numeric AS outstanding
         FROM lms.payment_request WHERE ($1::text IS NULL OR province_code = $1)`, [prov])).rows[0];

    if (view === 'reconciliation') {
      const [runs, exc] = await Promise.all([
        query(`SELECT * FROM lms.reconciliation_run ORDER BY started_at DESC LIMIT 20`),
        query(`SELECT *, as_of AS run_date FROM api.v_reconciliation_exception ORDER BY as_of DESC LIMIT 50`),
      ]);
      return NextResponse.json(redact({ summary, reconciliation_runs: runs.rows, reconciliation_exceptions: exc.rows }, ctx));
    }
    const list = LISTS[view];
    if (!list) throw new HttpError(400, 'Unknown view');
    const params: unknown[] = [prov, like];
    if (view === 'vouchers') params.push(searchParams.get('project') || null);   // vouchers of one project (allocation picker)
    const { rows, page } = await paged(query, list.sql, params, list.order, pg);
    const categories = await query(`SELECT * FROM lms.payment_category ORDER BY display_order ASC`);
    // CNICs of payees and of whoever acknowledged a receipt are masked without pii:read.
    return NextResponse.json(redact({ [view]: rows, page, summary, payment_categories: categories.rows }, ctx));
  } catch (error: any) {
    console.error('Payments fetch error:', error);
    return toResponse(error, ctx.correlationId);
  }
});

export const POST = protect({ authenticatedOnly: true }, async (ctx) => {
  const request = ctx.req;
  const { withTransaction } = ctx.db;
  const user = ctx.legacyUser;

  try {
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await readJson(request);
    const { action } = body;

    // Each action, and the permissions any one of which allows it. Holds and
    // reconciliation are finance controls: entering vouchers does not grant them.
    // A receipt is proof of payment, recorded by finance and never by the
    // voucher's raiser or releaser (AUTHZ-23; the database refuses those two).
    const allowed: Record<string, [string, string][]> = {
      request: [['payments', 'create']],
      allocate: [['payments', 'create'], ['payments', 'verify']],
      receipt: FINANCE,
      verify: [['payments', 'verify']],
      release: [['payments', 'release']],
      reconcile: FINANCE,
      hold: FINANCE,
      lift_hold: FINANCE,
      cancel: FINANCE,
    };
    const options = typeof action === 'string' ? allowed[action] : undefined;
    if (!options) return NextResponse.json({ error: 'Invalid action', code: 'validation' }, { status: 400 });
    const canProceed = options.some(([r, a]) => ctx.has(r, a));

    if (!canProceed) {
      return NextResponse.json({ error: 'You do not have permission to do that.', code: 'forbidden', correlationId: ctx.correlationId }, { status: 403 });
    }
    // Moving or freezing money needs a recent proof of identity (AUTHZ-17).
    if (action === 'release' || action === 'hold' || action === 'lift_hold' || action === 'cancel') await requireReauth(ctx);

    if (action === 'release') {
      const { payment_id, cheque_date, note } = body;
      if (!payment_id) {
        return NextResponse.json({ error: 'Payment ID is required' }, { status: 400 });
      }

      const releaseResult = await withTransaction(async (client) => {
        await requireRecord(ctx, 'payment_request', payment_id, ['payments', 'release'], { forUpdate: true });
        const idempotencyKey = `release-${payment_id}`;
        const res = await client.query(
          `SELECT api.release_payment($1, $2, $3, $4) as release_id`,
          [payment_id, idempotencyKey, cheque_date || null, note || null]
        );
        return res.rows[0];
      });

      return NextResponse.json({
        success: true,
        release_id: releaseResult.release_id,
        message: 'Payment released and cheque issued successfully',
      });
    }

    if (action === 'verify') {
      const { payment_id, note } = body;
      if (!payment_id) {
        return NextResponse.json({ error: 'Payment ID is required' }, { status: 400 });
      }

      await withTransaction(async (client) => {
        await requireRecord(ctx, 'payment_request', payment_id, ['payments', 'verify'], { forUpdate: true });
        await client.query(
          `SELECT api.advance_workflow('payments', $1, 'Verified', $2)`,
          [payment_id, note || null]
        );
      });

      return NextResponse.json({ success: true, message: 'Payment voucher verified for release' });
    }

    if (action === 'request') {
      const {
        project_id,
        category,
        pay_type,
        period_from,
        period_to,
        gross_amount,
        payment_mode,
        landowner_id,
        payee_name,
        case_id,
        lease_id,
        dbpfc_id,
        wht_pct,
        land_class,
        remarks,
      } = body;

      // Every figure that decides the cheque and its tax comes from the requester;
      // nothing is defaulted on their behalf.
      if (!project_id || !gross_amount || !category || !pay_type || !period_from || !payment_mode || !land_class) {
        return NextResponse.json({ error: 'Project, category, pay type, period start, payment mode, land class and gross amount are required' }, { status: 400 });
      }
      // The key makes a double-submitted form one voucher, not two; it must come from the form.
      if (typeof body.idempotency_key !== 'string' || !/^[A-Za-z0-9._:-]{16,128}$/.test(body.idempotency_key)) {
        return NextResponse.json({ error: 'idempotency_key (16–128 characters) is required' }, { status: 400 });
      }

      const requestResult = await withTransaction(async (client) => {
        // The voucher is raised in the project's province; the database checks every other id it names.
        await requireRecord(ctx, 'project', project_id, ['payments', 'create']);
        for (const [k, v] of [['landowner', landowner_id], ['case', case_id], ['lease', lease_id], ['DBPFC estimate', dbpfc_id]] as const)
          if (v && !isUuid(v)) throw new HttpError(400, `The ${k} id is not valid.`, 'validation');

        const idempotencyKey = body.idempotency_key;

        const res = await client.query(
          `SELECT api.request_payment(
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
          ) as payment_id`,
          [
            idempotencyKey,
            project_id,
            category,
            pay_type,
            period_from,
            gross_amount,
            payment_mode,
            landowner_id || null,
            landowner_id ? null : payee_name || null,
            case_id || null,
            lease_id || null,
            dbpfc_id || null,
            period_to || null,
            wht_pct !== undefined && wht_pct !== '' ? Number(wht_pct) : null,
            land_class,
            remarks || null,
          ]
        );
        await queueFirstStep(client, 'payments', res.rows[0].payment_id);
        return res.rows[0];
      });

      return NextResponse.json({
        success: true,
        payment_id: requestResult.payment_id,
        message: 'Payment voucher requested successfully',
      });
    }

    if (action === 'allocate') {
      const { payment_id, case_id, amount, landowner_id, note } = body;
      if (!payment_id || !case_id || !amount) {
        return NextResponse.json({ error: 'payment_id, case_id, and amount are required' }, { status: 400 });
      }

      const allocId = await withTransaction(async (client) => {
        await requireRecord(ctx, 'payment_request', payment_id, [['payments', 'create'], ['payments', 'verify']]);
        if (!isUuid(case_id) || (landowner_id && !isUuid(landowner_id))) throw new HttpError(400, 'The case or landowner id is not valid.', 'validation');
        const res = await client.query(
          `SELECT api.allocate_payment($1, $2, $3, $4, $5) AS alloc_id`,
          [payment_id, case_id, Number(amount), landowner_id || null, note || null]
        );
        return res.rows[0]?.alloc_id;
      });

      return NextResponse.json({ success: true, allocation_id: allocId, message: 'Payment allocated to case' });
    }

    if (action === 'reconcile') {
      const { scope_type = 'all', project_id, as_of_date } = body;
      const runId = await withTransaction(async (client) => {
        if (project_id) await requireRecord(ctx, 'project', project_id, FINANCE);
        const res = await client.query(
          `SELECT api.reconcile($1, $2, COALESCE($3::date, CURRENT_DATE)) AS run_id`,
          [scope_type, project_id || null, as_of_date || null]
        );
        return res.rows[0]?.run_id;
      });

      return NextResponse.json({ success: true, run_id: runId, message: 'Financial reconciliation completed' });
    }

    if (action === 'hold') {
      const { scope, reason } = body;
      const target = typeof scope === 'string' ? HOLD_TARGET[scope] : undefined;
      if (!target || typeof reason !== 'string' || !reason.trim()) {
        return NextResponse.json({ error: 'Hold scope (payment, case, landowner, project or survey) and reason are required' }, { status: 400 });
      }

      const holdRow = await withTransaction(async (client) => {
        // The hold's province is its target's, read under the caller's own row-level
        // security; a province in the body is ignored (AUTHZ-12; the database enforces it too).
        const rec = await requireRecord(ctx, target.table, body[target.field], FINANCE);
        const res = await client.query(
          `INSERT INTO lms.payment_hold (
            province_code, scope, project_id, survey_id, landowner_id, case_id, payment_id,
            reason, placed_at, placed_by
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), $9)
          RETURNING *`,
          [
            rec.province,
            scope,
            scope === 'project' ? rec.id : null,
            scope === 'survey' ? rec.id : null,
            scope === 'landowner' ? rec.id : null,
            scope === 'case' ? rec.id : null,
            scope === 'payment' ? rec.id : null,
            reason.trim().slice(0, 1000),
            user.id,
          ]
        );
        return res.rows[0];
      });

      return NextResponse.json({ success: true, hold: holdRow });
    }

    if (action === 'cancel') {
      // Finance cancels a voucher that will not be paid (e.g. held after a change of
      // ownership, 0062): it leaves the live stages, so a corrected voucher can be raised.
      const { payment_id, reason } = body;
      const why = typeof reason === 'string' ? reason.trim() : '';
      if (!payment_id || why.length < 5) return NextResponse.json({ error: 'payment_id and a reason (at least 5 characters) are required', code: 'validation' }, { status: 400 });
      await withTransaction(async (client) => {
        const cur = (await requireRecord(ctx, 'payment_request', payment_id, FINANCE, { forUpdate: true })).row;
        if (!['Requested', 'Verified'].includes(cur.stage_code))
          throw new HttpError(409, `A ${String(cur.stage_code).toLowerCase()} voucher cannot be cancelled${cur.stage_code === 'Released' ? '; reverse the release instead' : ''}.`, 'state');
        // Its own holds have nothing left to hold once it is cancelled; they are lifted first
        // because the database refuses any stage change of a held voucher. Holds on the case,
        // landowner or project (and court stays) stay and still block. One transaction: if the
        // cancellation is refused, the lift is undone too.
        await client.query(
          `UPDATE lms.payment_hold SET lifted_at = now(), lifted_by = $2, lift_reason = 'Voucher cancelled: ' || $3
            WHERE scope = 'payment' AND payment_id = $1 AND lifted_at IS NULL AND legal_case_id IS NULL`,
          [payment_id, user.id, why.slice(0, 900)]);
        await client.query(`SELECT api.advance_workflow('payments', $1, 'Cancelled', $2)`, [payment_id, why.slice(0, 1000)]);
      });
      return NextResponse.json({ success: true, message: 'Voucher cancelled' });
    }

    if (action === 'lift_hold') {
      const { hold_id, lift_reason } = body;
      if (!hold_id || typeof lift_reason !== 'string' || !lift_reason.trim()) {
        return NextResponse.json({ error: 'hold_id and lift_reason are required' }, { status: 400 });
      }

      const lifted = await withTransaction(async (client) => {
        const cur = (await requireRecord(ctx, 'payment_hold', hold_id, FINANCE, { forUpdate: true })).row;
        if (cur.lifted_at) throw new HttpError(409, 'This hold has already been lifted', 'state');
        // A court stay is lifted by recording the court's order on the legal case,
        // which releases its holds; it is not a finance decision.
        if (cur.legal_case_id) throw new HttpError(409, 'This hold comes from a court stay order. Lift the stay on the legal case instead.', 'state');
        const res = await client.query(
          `UPDATE lms.payment_hold
           SET lifted_at = now(),
               lifted_by = $2,
               lift_reason = $3
           WHERE id = $1 AND lifted_at IS NULL
           RETURNING *`,
          [hold_id, user.id, lift_reason.trim().slice(0, 1000)]
        );
        return res.rows[0];
      });

      return NextResponse.json({ success: true, hold: lifted });
    }

    if (action === 'receipt') {
      const { release_id, receipt_no, received_date, received_by_cnic, acknowledged_by, remarks } = body;
      if (!release_id || typeof receipt_no !== 'string' || !receipt_no.trim() || typeof acknowledged_by !== 'string'
          || !acknowledged_by.trim() || !received_date) {
        return NextResponse.json({ error: 'Release, receipt number, received date and who acknowledged it are required' }, { status: 400 });
      }

      const receipt = await withTransaction(async (client) => {
        if (!isUuid(release_id)) throw new HttpError(400, 'The release id is not valid.', 'validation');
        const rel = await client.query('SELECT payment_id FROM lms.payment_release WHERE id = $1', [release_id]);
        if (!rel.rows.length) throw new HttpError(404, 'Release not found.', 'not_found');
        await requireRecord(ctx, 'payment_request', rel.rows[0].payment_id, FINANCE);
        const res = await client.query(
          `INSERT INTO lms.payment_receipt (
            release_id, receipt_no, received_on, acknowledged_by, acknowledged_cnic, note, recorded_by
          ) VALUES ($1, $2, COALESCE($3::date, CURRENT_DATE), $4, $5, $6, $7)
          RETURNING *`,
          [
            release_id,
            receipt_no.trim(),
            received_date || null,
            acknowledged_by,
            received_by_cnic || null,
            remarks || null,
            user.id,
          ]
        );
        return res.rows[0];
      });

      return NextResponse.json(redact({ success: true, receipt }, ctx));
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  } catch (error: any) {
    console.error('Payment operation error:', error);
    return toResponse(error, ctx.correlationId);
  }
});

// ---------------------------------------------------------------------------
// The printable receipt (REQ-65, client sample "Sample Payment Receipt.png").
// One document for every kind of payment the system makes:
//   * a compensation case (lease / crop / tree / miscellaneous lines), for its
//     only owner or for one owner's share of a jointly owned case;
//   * a lease agreement's rent;  * a DBPFC (government land) payment;
//   * a stand-alone voucher (no case, lease or estimate).
// It states what the money was for from the records themselves (the leased
// area, each crop's damaged area, trees by species, other items), never the
// whole parcel; the payee's share; part or full settlement; and a reversal.
// Everything is read under the caller's row-level security; the voucher must
// be within their payments:read scope. CNICs are masked without pii:read.
// ---------------------------------------------------------------------------
type Head = 'rental' | 'crop' | 'tree' | 'misc' | 'other';
const HEAD_OF_CATEGORY: Record<string, Head> = {
  'Lease Rent': 'rental', 'Government Lease': 'rental', 'Crop Compensation': 'crop', 'Tree Compensation': 'tree',
  'Structure / Misc': 'misc',
};
const INSTRUMENT: Record<string, string> = { 'Cross Cheque': 'Cheque', 'Pay Order': 'Pay Order', 'Direct Credit (IBFT)': 'Direct credit (IBFT) reference' };
const num = (v: unknown) => (v === null || v === undefined || v === '' ? 0 : Number(v));
const fix = (v: number, d = 2) => (Math.round(v * 10 ** d) / 10 ** d).toFixed(d);
/** A rate as text: 185,000.00 (thousands separated). */
const rs = (v: number) => v.toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function receiptDocument(ctx: Ctx, receiptId: string): Promise<Response> {
  if (!isUuid(receiptId)) throw new HttpError(404, 'Receipt not found.', 'not_found');
  const c = ctx.client;
  const r = (await c.query(
    `SELECT rc.id, rc.receipt_no, rc.received_on, rc.acknowledged_by, rc.acknowledged_cnic, rc.note,
            rel.id AS release_id, rel.cheque_no, rel.cheque_date, rel.released_amount,
            pr.id AS payment_id, pr.code AS voucher_code, pr.province_code, pr.category_code, pr.pay_type, pr.payment_mode,
            pr.land_class, pr.period_from, pr.period_to, pr.gross_amount, pr.wht_pct, pr.wht_amount, pr.net_amount,
            pr.case_id, pr.lease_id, pr.dbpfc_id, pr.landowner_id, pr.payee_tax_status,
            coalesce(lo.full_name, pr.payee_name) AS payee_name, lo.father_name AS payee_father, lo.cnic AS payee_cnic,
            lo.code AS payee_code,
            p.code AS project_code, p.name AS project_name,
            cc.code AS case_code, cc.land_use_code, cc.lease_rate AS case_lease_rate, cc.lease_term_months AS case_term_months,
            cc.total_lease_area, cc.total_lease_amount, cc.total_crop_amount, cc.total_tree_amount, cc.total_misc_amount,
            cc.total_amount AS case_total,
            l.code AS lease_code, l.registration_no AS lease_registration, l.initial_area, l.subsequent_area,
            l.rate_per_acre AS lease_rate, l.term_years, l.start_date AS lease_start, l.end_date AS lease_end,
            d.code AS dbpfc_code, d.area_acres AS dbpfc_area, coalesce(d.applied_rate, d.fixed_rate, d.estimated_rate) AS dbpfc_rate,
            d.committee_ref,
            rev.reversed_at, rev.reason AS reversal_reason
       FROM lms.payment_receipt rc
       JOIN lms.payment_release rel ON rel.id = rc.release_id
       JOIN lms.payment_request pr ON pr.id = rel.payment_id
       LEFT JOIN lms.landowner lo ON lo.id = pr.landowner_id
       LEFT JOIN lms.project p ON p.id = pr.project_id
       LEFT JOIN lms.compensation_case cc ON cc.id = pr.case_id
       LEFT JOIN lms.lease l ON l.id = pr.lease_id
       LEFT JOIN lms.dbpfc_estimate d ON d.id = pr.dbpfc_id
       LEFT JOIN lms.payment_release_reversal rev ON rev.release_id = rel.id
      WHERE rc.id = $1`, [receiptId])).rows[0];
  if (!r) throw new HttpError(404, 'Receipt not found.', 'not_found');
  await requireRecord(ctx, 'payment_request', r.payment_id, ['payments', 'read']);

  // ---- the land: every parcel of the case, lease or DBPFC estimate, each with its revenue location
  const parcels = (await c.query(
    `WITH ids AS (
       SELECT survey_id FROM lms.case_lease_line WHERE case_id = $1
       UNION SELECT survey_id FROM lms.case_crop_line WHERE case_id = $1 AND survey_id IS NOT NULL
       UNION SELECT survey_id FROM lms.case_tree_line WHERE case_id = $1 AND survey_id IS NOT NULL
       UNION SELECT survey_id FROM lms.case_misc_line WHERE case_id = $1 AND survey_id IS NOT NULL
       UNION SELECT survey_id FROM lms.lease_survey WHERE lease_id = $2
       UNION SELECT survey_id FROM lms.dbpfc_survey WHERE dbpfc_id = $3)
     SELECT s.id, s.code, s.survey_no, s.block_no, s.total_area, s.admin_unit_id
       FROM lms.survey s JOIN ids ON ids.survey_id = s.id
      ORDER BY s.survey_no`, [r.case_id, r.lease_id, r.dbpfc_id])).rows;
  const locations = new Map<string, string>();
  for (const unit of new Set(parcels.map((s: any) => s.admin_unit_id).filter(Boolean))) {
    const chain = (await c.query(
      `WITH RECURSIVE up AS (
         SELECT id, parent_id, name, level, province_code FROM lms.admin_unit WHERE id = $1
         UNION ALL SELECT a.id, a.parent_id, a.name, a.level, a.province_code FROM lms.admin_unit a JOIN up ON a.id = up.parent_id)
       SELECT coalesce(pl.name, 'Level ' || up.level) AS level, up.name
         FROM up LEFT JOIN lms.province_level pl ON pl.province_code = up.province_code AND pl.depth = up.level
        ORDER BY up.level DESC`, [unit])).rows;
    locations.set(String(unit), chain.map((x: any) => `${x.level} ${x.name}`).join(', '));
  }
  // Parcels grouped by place: "999/1, 1000/2 in Deh X, Taluka Y, District Z".
  const byPlace = new Map<string, any[]>();
  for (const s of parcels) {
    const k = locations.get(String(s.admin_unit_id)) ?? '';
    byPlace.set(k, [...(byPlace.get(k) ?? []), s]);
  }
  const land = {
    groups: [...byPlace.entries()].map(([place, list]) => ({
      place, parcels: list.map((s: any) => ({ survey_no: s.survey_no, block_no: s.block_no, acres: fix(num(s.total_area), 4) })),
    })),
    recorded_acres: parcels.length ? fix(parcels.reduce((t: number, s: any) => t + num(s.total_area), 0), 4) : null,
  };

  // ---- what the money was for, by head, with the records' own quantities.
  // `basis` holds the "in respect of …" clauses; the part in [[ ]] is printed bold.
  const details: Record<Head, string[]> = { rental: [], crop: [], tree: [], misc: [], other: [] };
  const basis: string[] = [];
  let kind: 'case' | 'lease' | 'dbpfc' | 'standalone' = 'standalone';
  if (r.case_id) {
    kind = 'case';
    const [crops, trees, misc] = await Promise.all([
      c.query(`SELECT crop_type, sum(damage_area) AS acres, min(rate_per_acre) AS rmin, max(rate_per_acre) AS rmax
                 FROM lms.case_crop_line WHERE case_id = $1 GROUP BY crop_type ORDER BY crop_type`, [r.case_id]),
      c.query(`SELECT coalesce(ts.name, t.species_code) AS species, t.size, sum(t.qty)::int AS qty, min(t.rate) AS rmin, max(t.rate) AS rmax
                 FROM lms.case_tree_line t LEFT JOIN lms.tree_species ts ON ts.code = t.species_code
                WHERE t.case_id = $1 GROUP BY 1, 2 ORDER BY 1, 2`, [r.case_id]),
      c.query(`SELECT payment_type FROM lms.case_misc_line WHERE case_id = $1 GROUP BY 1 ORDER BY 1`, [r.case_id]),
    ]);
    const leaseArea = num(r.total_lease_area);
    if (leaseArea > 0) {
      const term = num(r.case_term_months);
      details.rental.push(`${fix(leaseArea)} ac${num(r.case_lease_rate) ? ` × Rs ${rs(num(r.case_lease_rate))}/ac/yr` : ''}${term ? ` for ${term} months` : ''}`);
      basis.push(`the lease of [[${fix(leaseArea)} acres]]`);
    }
    for (const x of crops.rows) {
      details.crop.push(`${x.crop_type}, ${fix(num(x.acres))} ac${num(x.rmin) === num(x.rmax) ? ` × Rs ${rs(num(x.rmin))}/ac` : ''}`);
    }
    if (crops.rows.length) basis.push(`crop compensation for [[${crops.rows.map((x: any) => `${fix(num(x.acres))} acres of damaged ${x.crop_type}`).join(', ')}]]`);
    const treeRows = trees.rows.filter((x: any) => num(x.qty) > 0);
    for (const x of treeRows) details.tree.push(`${x.qty} ${x.species} (${x.size})${num(x.rmin) === num(x.rmax) ? ` × Rs ${rs(num(x.rmin))}` : ''}`);
    const treeCount = treeRows.reduce((t: number, x: any) => t + num(x.qty), 0);
    if (treeCount) basis.push(`[[${treeCount} tree(s)]]`);
    for (const x of misc.rows) details.misc.push(String(x.payment_type));
    if (misc.rows.length) basis.push(`[[${misc.rows.map((x: any) => x.payment_type).join(', ')}]]`);
  } else if (r.lease_id) {
    kind = 'lease';
    const area = num(r.initial_area) + num(r.subsequent_area);
    details.rental.push(`${fix(area)} ac${num(r.lease_rate) ? ` × Rs ${rs(num(r.lease_rate))}/ac/yr` : ''}${num(r.term_years) ? `, lease term ${num(r.term_years)} year(s)` : ''}`);
    const lessors = num((await c.query('SELECT count(*) FROM lms.lease_lessor WHERE lease_id = $1', [r.lease_id])).rows[0].count);
    basis.push(`rent of [[${fix(area)} acres]]${lessors > 1 && r.landowner_id ? `, paid to ${r.payee_name} as one of ${lessors} lessors` : ''}`);
  } else if (r.dbpfc_id) {
    kind = 'dbpfc';
    details.rental.push(`${fix(num(r.dbpfc_area))} ac${num(r.dbpfc_rate) ? ` × Rs ${rs(num(r.dbpfc_rate))}/ac (DBPFC rate)` : ''}`);
    basis.push(`[[${fix(num(r.dbpfc_area))} acres]] of government land${r.committee_ref ? ` (committee reference ${r.committee_ref})` : ''}`);
  } else {
    basis.push(`[[${r.category_code}]]`);
  }

  // ---- the gross split by head. A case voucher is spread over the case's own heads in
  // proportion (whatever its category); lease and DBPFC are rent; otherwise the category's head.
  const gross = Math.round(num(r.gross_amount) * 100);
  const heads: Record<Head, number> = { rental: 0, crop: 0, tree: 0, misc: 0, other: 0 };
  const caseTotal = num(r.case_total);
  if (kind === 'case' && caseTotal > 0) {
    const parts: [Head, number][] = [['rental', num(r.total_lease_amount)], ['crop', num(r.total_crop_amount)],
      ['tree', num(r.total_tree_amount)], ['misc', num(r.total_misc_amount)]];
    let used = 0;
    for (const [h, v] of parts) { heads[h] = Math.floor(gross * v / caseTotal); used += heads[h]; }
    heads[parts.reduce((a, b) => (b[1] > a[1] ? b : a))[0]] += gross - used;
  } else {
    heads[kind === 'lease' || kind === 'dbpfc' ? 'rental' : HEAD_OF_CATEGORY[r.category_code] ?? 'other'] = gross;
  }
  // A head this voucher does not pay for carries no quantities.
  for (const h of Object.keys(details) as Head[]) if (!heads[h]) details[h] = [];

  // ---- the payee's position on the case: share, capacity, and whether this settles it
  let share: { pct: string; owners: number; capacity: string } | null = null;
  let settlement: { payable: string; paid_before: string; this_payment: string; balance: string; full: boolean } | null = null;
  if (kind === 'case' && r.landowner_id) {
    const o = (await c.query(
      `SELECT m.share_pct, m.owner_count, m.payable_amount, m.paid_amount, co.owner_status,
              (SELECT coalesce(sum(s.settled_gross), 0) FROM lms.allocation_settlement s
                WHERE s.payment_id = $3 AND s.is_paid) AS this_settled
         FROM api.rpt_case_owner m JOIN lms.case_owner co ON co.id = m.case_owner_id
        WHERE m.case_id = $1 AND m.landowner_id = $2`, [r.case_id, r.landowner_id, r.payment_id])).rows[0];
    if (o) {
      const capacity: Record<string, string> = { O: 'owner', A: 'attorney', B: 'owner and attorney' };
      share = { pct: fix(num(o.share_pct), 4), owners: num(o.owner_count), capacity: capacity[String(o.owner_status).trim()] ?? 'owner' };
      // paid_amount counts this voucher once it is allocated; before that it is added here.
      const paidAfter = num(o.paid_amount) + (num(o.this_settled) > 0 ? 0 : gross / 100);
      const balance = num(o.payable_amount) - paidAfter;
      settlement = { payable: fix(num(o.payable_amount)), paid_before: fix(paidAfter - gross / 100), this_payment: fix(gross / 100),
        balance: fix(Math.max(balance, 0)), full: balance <= 0.005 && !r.reversed_at };
    }
  }

  return json(redact({
    receipt: {
      id: r.id, receipt_no: r.receipt_no, received_on: r.received_on, acknowledged_by: r.acknowledged_by,
      acknowledged_cnic: r.acknowledged_cnic, note: r.note, province_code: r.province_code,
      reference: `REF-${r.voucher_code} - ${r.receipt_no}`, kind,
      instrument: INSTRUMENT[r.payment_mode] ?? 'Cheque', cheque_no: r.cheque_no, cheque_date: r.cheque_date, payment_mode: r.payment_mode,
      amount: r.released_amount, amount_words: amountInWords(r.released_amount),
      voucher_code: r.voucher_code, category: r.category_code, pay_type: r.pay_type, land_class: r.land_class,
      period_from: r.period_from, period_to: r.period_to,
      gross_amount: r.gross_amount, wht_pct: r.wht_pct, wht_amount: r.wht_amount, net_amount: r.net_amount,
      tax_status: r.payee_tax_status,
      heads: Object.fromEntries(Object.entries(heads).map(([k, v]) => [k, (v / 100).toFixed(2)])), details, basis,
      payee_name: r.payee_name, payee_father: r.payee_father, payee_cnic: r.payee_cnic, payee_code: r.payee_code,
      payee_is_landowner: !!r.landowner_id, share, settlement,
      project_code: r.project_code, project_name: r.project_name, case_code: r.case_code, land_use: r.land_use_code,
      lease_code: r.lease_registration || r.lease_code, lease_start: r.lease_start, lease_end: r.lease_end,
      dbpfc_code: r.dbpfc_code, land,
      reversed: r.reversed_at ? { at: r.reversed_at, reason: r.reversal_reason } : null,
    },
  }, ctx));
}
