import { HttpError, json, protect } from '@/lib/iam/http';
import { canSeePii, maskAddress, maskCnic, maskIban, maskPhone } from '@/lib/iam/pii';
import { dataset } from '@/lib/reporting/catalog';
import { runReport } from '@/lib/reporting/run';
import { audit, reportError } from '@/lib/reporting/service';
import { FLAG_TEXT, type UomMode } from '@/lib/reporting/types';
import { validateConfig } from '@/lib/reporting/validate';

// A person / CNIC statement: who the person is, the parcels and shares they
// hold (with units), each case they are an owner on and their part of it,
// every payment attributed to them (gross, WHT, net, cheque), adjustments,
// reversals, other money paid to them, the running balance and the flags.
// GET ?cnic=12345-1234567-1 | ?landowner=<id or code> [&uom=province|common|original&unit=]
// Exact match only (partial search is the persons report). Always audited.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CNIC = /^\d{5}-\d{7}-\d$/;
const CODE = /^[A-Za-z0-9][A-Za-z0-9/-]{1,31}$/;

export const GET = protect({ permission: ['reports', 'read'] }, async (ctx) => {
  try {
    if (!ctx.has('landowners', 'read')) throw new HttpError(403, 'You do not have permission to see landowner statements.', 'forbidden');
    const sp = new URL(ctx.req.url).searchParams;
    const cnic = sp.get('cnic')?.trim() ?? '';
    const lo = sp.get('landowner')?.trim() ?? '';
    let where: string; let arg: string; let lookup: string;
    if (cnic) {
      if (!CNIC.test(cnic)) throw new HttpError(400, 'A CNIC is written 12345-1234567-1.', 'validation');
      // Looking a person up by CNIC reveals whose number it is: needs pii:read, as global search does.
      if (!ctx.has('pii', 'read')) throw new HttpError(403, 'Searching by CNIC needs access to personal data. Use the landowner code instead.', 'forbidden');
      where = 'cnic = $1'; arg = cnic; lookup = 'cnic';
    } else if (UUID.test(lo)) { where = 'id = $1::uuid'; arg = lo; lookup = 'id'; }
    else if (CODE.test(lo)) { where = 'code = $1'; arg = lo; lookup = 'code'; }
    else throw new HttpError(400, 'Give a full CNIC (cnic=) or a landowner id or code (landowner=).', 'validation');

    const p = (await ctx.client.query(
      `SELECT id, code::text AS code, full_name, father_name, cnic::text AS cnic, phone, iban, address, bank_branch,
              owner_type::text AS owner_type, status, tax_status, province_code::text AS province_code
         FROM lms.landowner WHERE ${where}`, [arg])).rows[0];
    if (!p) throw new HttpError(404, 'No landowner with that CNIC or code in your provinces.', 'not_found');
    const seePii = canSeePii(ctx, p.province_code);
    const identity = {
      landownerId: p.id, code: p.code, fullName: p.full_name, fatherName: p.father_name,
      cnic: seePii ? p.cnic : maskCnic(p.cnic), phone: seePii ? p.phone : maskPhone(p.phone),
      iban: seePii ? p.iban : maskIban(p.iban), address: seePii ? p.address : maskAddress(p.address),
      bankBranch: p.bank_branch, ownerType: p.owner_type, status: p.status, taxStatus: p.tax_status, province: p.province_code,
    };

    const mode = (sp.get('uom') ?? 'province') as UomMode;
    const uom = mode === 'common' ? { mode, unit: sp.get('unit') ?? 'Acre' } : { mode };
    const ownerFilter = [{ field: 'owner_code', op: 'eq', value: p.code }];
    const run = async (key: string, columns: string[]) => {
      const { def, config } = validateConfig({ dataset: key, columns, filters: ownerFilter, uom, totals: true, page: { limit: 500, offset: 0 } },
        { canSeePii: ctx.has('pii', 'read') });
      return runReport(ctx, def, config, { paged: false, maxRows: 5000 });
    };
    const parcels = ctx.has('surveys', 'read')
      ? await run('ownership', ['parcel_code', 'survey_no', 'province_code', 'district', 'tehsil', 'village', 'land_class', 'parcel_status', 'share_pct', 'parcel_area', 'owned_area'])
      : null;

    const money = ctx.has('cases', 'read') && ctx.has('payments', 'read');
    let cases = null, payments = null, adjustments = null, otherPayments = null, statement = null, balances = null;
    if (money) {
      cases = await run('case_owners', ['case_code', 'province_code', 'project_code', 'stage_code', 'share_pct', 'payable_amount', 'paid_amount', 'wht_amount', 'paid_net_amount', 'outstanding_amount', 'settlement_status']);
      // Payments attributed to the person: named on the allocation, or the case's only owner.
      payments = (await ctx.client.query(
        `SELECT a.voucher_code::text AS voucher_code, a.case_code::text AS case_code, a.cheque_no, to_char(a.cheque_date, 'YYYY-MM-DD') AS cheque_date,
                a.allocated_net, a.settled_gross, a.wht_share, a.is_paid, a.is_reversed,
                CASE WHEN a.landowner_id = $1 THEN 'named on the allocation' ELSE 'only owner of the case' END AS attributed
           FROM api.rpt_allocation a
          WHERE a.landowner_id = $1
             OR (a.landowner_id IS NULL AND EXISTS (SELECT 1 FROM lms.case_owner co WHERE co.case_id = a.case_id AND co.landowner_id = $1)
                 AND (SELECT count(*) FROM lms.case_owner co WHERE co.case_id = a.case_id) = 1)
          ORDER BY a.cheque_date NULLS LAST, a.voucher_code`, [p.id])).rows;
      adjustments = (await ctx.client.query(
        `SELECT c.code::text AS case_code, to_char(a.created_at AT TIME ZONE 'Asia/Karachi', 'YYYY-MM-DD') AS adjusted_on, a.amount, co.share_pct,
                round(a.amount * co.share_pct / 100, 2) AS share_amount, a.reason
           FROM lms.case_adjustment a
           JOIN lms.case_owner co ON co.case_id = a.case_id AND co.landowner_id = $1
           JOIN lms.compensation_case c ON c.id = a.case_id
          ORDER BY a.created_at`, [p.id])).rows;
      otherPayments = (await ctx.client.query(
        `SELECT voucher_code::text AS voucher_code, category_code, lease_code::text AS lease_code, cheque_no, to_char(cheque_date, 'YYYY-MM-DD') AS cheque_date,
                net_amount, unallocated_net
           FROM api.rpt_voucher WHERE payee_code = $1 AND is_released AND unallocated_net > 0 ORDER BY cheque_date`, [p.code])).rows;
      statement = (await ctx.client.query(
        `SELECT to_char(entry_date, 'YYYY-MM-DD') AS entry_date, entry_type, reference::text AS reference, description, amount, running_total
           FROM api.report_landowner_statement($1)`, [p.id])).rows;
      balances = (await ctx.client.query(
        `SELECT coalesce(sum(payable_amount), 0)::numeric(18,2) AS payable, coalesce(sum(paid_amount), 0)::numeric(18,2) AS paid,
                coalesce(sum(wht_amount), 0)::numeric(18,2) AS wht, coalesce(sum(paid_net_amount), 0)::numeric(18,2) AS paid_net,
                coalesce(sum(outstanding_amount), 0)::numeric(18,2) AS outstanding,
                (SELECT coalesce(sum(unallocated_net), 0) FROM api.rpt_voucher WHERE payee_code = $2 AND is_released AND unallocated_net > 0)::numeric(18,2) AS other_payments_net
           FROM api.rpt_case_owner WHERE landowner_id = $1 AND stage_code = 'HO Approved'`, [p.id, p.code])).rows[0];
    }

    const flagRow = (await ctx.client.query(
      `SELECT flag_no_shares, flag_possible_duplicate, flag_unattributed_payment, flag_overpaid FROM api.rpt_person WHERE landowner_id = $1`, [p.id])).rows[0] ?? {};
    const flags = new Set<string>();
    if (flagRow.flag_no_shares) flags.add('no_shares');
    if (flagRow.flag_possible_duplicate) flags.add('possible_duplicate');
    if (money && flagRow.flag_unattributed_payment) flags.add('unattributed_payment');
    if (money && flagRow.flag_overpaid) flags.add('overpaid');
    for (const r of [parcels, cases]) for (const k of Object.keys(r?.flags ?? {})) flags.add(k);

    await audit(ctx, 'report_run', 'success', {
      dataset: 'person_statement', landowner: p.id, lookup, uom, pii_unmasked: seePii,
      sections: { parcels: !!parcels, money },
    });
    return json({
      identity, parcels, cases, payments, adjustments, otherPayments, statement, balances,
      flags: [...flags], flagText: Object.fromEntries([...flags].map((k) => [k, FLAG_TEXT[k] ?? k])),
      piiMasked: !seePii, generatedAt: new Date().toISOString(),
      definitions: dataset('case_owners')?.definitions ?? [],
    });
  } catch (e) {
    return reportError(e, ctx.correlationId);
  }
});
