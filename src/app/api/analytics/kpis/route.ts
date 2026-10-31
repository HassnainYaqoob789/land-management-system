import { HttpError, json, protect } from '@/lib/iam/http';
import { audit } from '@/lib/reporting/service';

// The KPI package behind the dashboard and the province page. Same JSON shape
// as before; the figures now come from the reporting definitions (0043):
//  * paid = allocations on released, unreversed vouchers on the gross basis —
//    never every released voucher in the province (PAY-C1, RPT-02);
//  * outstanding liability = what approved cases still owe, never netted
//    against over-payments, which are reported separately (PAY-H3);
//  * province totals come from the registers, not by adding up projects
//    (RPT-20, UOM-08); acquired/leased area is the acquired/leased portion (UOM-11);
//  * every area field is converted with the exact factor, or flagged when the
//    unit has none; *_acres fields stay in acres (UOM-12, RPT-09);
//  * leases from the live register (RPT-27); bottlenecks include assignments
//    with no transition yet (RPT-19).
// Money is returned as exact decimal strings. The audience selects sections
// (RPT-17); money needs cases:read and payments:read.
const SECTIONS: Record<string, string[]> = {
  all: ['portfolio', 'aging', 'quality_exceptions', 'gis_coverage', 'bottlenecks', 'lease_alerts'],
  c_level: ['quality_exceptions'],
  director: ['portfolio', 'gis_coverage', 'bottlenecks', 'lease_alerts', 'quality_exceptions'],
  finance: ['portfolio', 'aging', 'quality_exceptions'],
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const GET = protect({ permission: ['reports', 'read'] }, async (ctx) => {
  const sp = new URL(ctx.req.url).searchParams;
  const audience = (sp.get('role') || sp.get('audience') || 'all').toLowerCase();
  const sections = new Set(SECTIONS[audience] ?? SECTIONS.all);
  const rawProvince = (sp.get('province') || '').toUpperCase();
  const province = rawProvince && rawProvince !== 'ALL' ? rawProvince : null;
  if (province && !/^[A-Z]{3}$/.test(province)) throw new HttpError(400, 'province must be a province code.', 'validation');
  const projectId = sp.get('project_id');
  if (projectId && !UUID.test(projectId)) throw new HttpError(400, 'project_id must be a project id.', 'validation');
  const unitAsked = (sp.get('unit') || 'Acre').slice(0, 40);
  const caseMoney = ctx.has('cases', 'read');
  const money = caseMoney && ctx.has('payments', 'read');
  const { query } = ctx.db;

  const ex = (await query(
    `WITH u AS (
       SELECT lms.uom_code($2) AS code,
              (SELECT a.sqm_per_unit / t.sqm_per_unit FROM lms.unit_conversion a, lms.unit_conversion t
                WHERE a.unit_code = 'Acre' AND a.valid_range @> CURRENT_DATE
                  AND t.unit_code = lms.uom_code($2) AND t.valid_range @> CURRENT_DATE) AS ratio,
              (SELECT t.is_confirmed FROM lms.unit_conversion t WHERE t.unit_code = lms.uom_code($2) AND t.valid_range @> CURRENT_DATE) AS confirmed
     ), e AS (
       SELECT count(*)::int AS provinces,
              coalesce(sum(projects), 0)::int AS total_projects, coalesce(sum(active_projects), 0)::int AS active_projects,
              coalesce(sum(parcels), 0)::int AS total_parcels, coalesce(sum(area_acres), 0)::numeric AS total_acres,
              coalesce(sum(gov_parcels), 0)::int AS gov_parcels, coalesce(sum(gov_area_acres), 0)::numeric AS gov_acres,
              coalesce(sum(acquired_parcels), 0)::int AS acquired_parcels, coalesce(sum(acquired_area_acres), 0)::numeric AS acquired_acres,
              coalesce(sum(leased_parcels), 0)::int AS leased_parcels, coalesce(sum(leased_area_acres), 0)::numeric AS leased_acres,
              coalesce(sum(landowners), 0)::int AS total_landowners,
              coalesce(sum(cases), 0)::int AS total_cases, coalesce(sum(approved_cases), 0)::int AS approved_cases,
              coalesce(sum(pending_cases), 0)::int AS pending_cases,
              coalesce(sum(assessed_amount), 0)::numeric(18,2) AS assessed, coalesce(sum(approved_amount), 0)::numeric(18,2) AS approved,
              coalesce(sum(adjustment_amount), 0)::numeric(18,2) AS adjustments, coalesce(sum(payable_amount), 0)::numeric(18,2) AS payable,
              coalesce(sum(paid_amount), 0)::numeric(18,2) AS paid, coalesce(sum(wht_amount), 0)::numeric(18,2) AS wht,
              coalesce(sum(paid_net_amount), 0)::numeric(18,2) AS paid_net, coalesce(sum(outstanding_amount), 0)::numeric(18,2) AS outstanding,
              coalesce(sum(overpaid_amount), 0)::numeric(18,2) AS overpaid, coalesce(sum(overpaid_cases), 0)::int AS overpaid_cases,
              coalesce(sum(net_outstanding_amount), 0)::numeric(18,2) AS net_outstanding,
              coalesce(sum(pending_vouchers_net), 0)::numeric(18,2) AS pending_payments,
              coalesce(sum(unallocated_released_net), 0)::numeric(18,2) AS unallocated_released,
              coalesce(sum(lease_and_other_released_net), 0)::numeric(18,2) AS lease_and_other_released,
              coalesce(sum(leases), 0)::int AS total_leases, coalesce(sum(leases_expired), 0)::int AS expired_leases,
              coalesce(sum(leases_expiring_90d), 0)::int AS expiring_90d_leases, coalesce(sum(leases_on_hold), 0)::int AS hold_leases,
              coalesce(sum(open_grievances), 0)::int AS open_grievances, coalesce(sum(active_stay_orders), 0)::int AS active_stay_orders,
              coalesce(sum(mapped_features), 0)::int AS mapped_features
       FROM api.rpt_exec_province WHERE ($1::text IS NULL OR province_code = $1)
     )
     SELECT e.*, u.code AS unit_code, u.confirmed AS unit_confirmed,
            round(e.total_acres * u.ratio, 4) AS total_area, round(e.gov_acres * u.ratio, 4) AS gov_area,
            round(e.acquired_acres * u.ratio, 4) AS acquired_area, round(e.leased_acres * u.ratio, 4) AS leased_area
     FROM e, u`, [province, unitAsked])).rows[0];
  if (province && ex.provinces === 0) throw new HttpError(404, 'No such province in your scope.', 'not_found');
  const unsupported = ex.unit_code === null || ex.total_area === null;
  const cm = (v: string) => (caseMoney ? v : null);
  const m = (v: string) => (money ? v : null);

  const executive = {
    reporting_unit: ex.unit_code ?? unitAsked,
    area_unit_provisional: ex.unit_confirmed === false && ex.unit_code !== 'Acre',
    unsupported_unit: unsupported,
    total_projects: ex.total_projects, active_projects: ex.active_projects, total_parcels: ex.total_parcels,
    total_area: ex.total_area, total_area_normalized: ex.total_area, total_area_acres: ex.total_acres,
    gov_parcels: ex.gov_parcels, gov_area: ex.gov_area, gov_acres: ex.gov_acres,
    acquired_parcels: ex.acquired_parcels, acquired_area: ex.acquired_area, acquired_acres: ex.acquired_acres,
    leased_parcels: ex.leased_parcels, leased_area: ex.leased_area, leased_acres: ex.leased_acres,
    total_landowners: ex.total_landowners,
    // CNIC is mandatory for every landowner; this is "CNIC on file", not a verification.
    cnic_verified_owners: ex.total_landowners, cnic_on_file: ex.total_landowners,
    total_assessed_compensation: cm(ex.assessed),
    total_approved_compensation: cm(ex.approved), approved_compensation: cm(ex.approved),
    total_adjustments: cm(ex.adjustments), total_payable_compensation: cm(ex.payable),
    total_compensation_paid: m(ex.paid), total_released: m(ex.paid), total_wht_on_paid: m(ex.wht), total_net_paid: m(ex.paid_net),
    outstanding_liability: m(ex.outstanding), overpaid_amount: m(ex.overpaid), overpaid_cases: money ? ex.overpaid_cases : null,
    net_outstanding: m(ex.net_outstanding), pending_payments: m(ex.pending_payments),
    unallocated_released: m(ex.unallocated_released), lease_and_other_released: m(ex.lease_and_other_released),
    total_cases: ex.total_cases, approved_cases: ex.approved_cases, pending_cases: ex.pending_cases,
    total_leases: ex.total_leases, expired_leases: ex.expired_leases, expiring_90d_leases: ex.expiring_90d_leases, hold_leases: ex.hold_leases,
    open_grievances: ex.open_grievances, active_stay_orders: ex.active_stay_orders, mapped_features: ex.mapped_features,
    definitions: {
      paid: 'Allocations on released, unreversed vouchers; gross basis (WHT counts toward the award) — awaiting client confirmation',
      outstanding_liability: 'What approved cases still owe (payable − paid), summed per case; over-payments are in overpaid_amount',
      pending_payments: 'Net of vouchers requested or verified, all categories',
      acquired_area: 'Area of acquisitions handed over', leased_area: 'Current area of leases in force',
    },
  };

  const kpis: Record<string, unknown> = { executive };
  if (sections.has('portfolio') && ctx.has('projects', 'read')) {
    kpis.portfolio = (await query(
      `SELECT vp.*, vp.paid_compensation AS total_released, vp.project_status AS status
         FROM api.v_project_portfolio vp
        WHERE ($1::text IS NULL OR vp.province_code = $1) AND ($2::uuid IS NULL OR vp.project_id = $2)
        ORDER BY vp.parcel_count DESC, vp.project_code ASC`, [province, projectId])).rows
      .map((r: any) => (money ? r : caseMoney
        ? { ...r, paid_compensation: null, total_released: null, outstanding_liability: null, wht_on_paid: null, overpaid_amount: null }
        : { ...r, approved_compensation: null, paid_compensation: null, total_released: null, outstanding_liability: null,
            payable_compensation: null, wht_on_paid: null, overpaid_amount: null }));
  }
  if (sections.has('aging') && money) {
    kpis.aging = (await query(
      `SELECT aging_bracket, count(*)::int AS count, count(*)::int AS voucher_count,
              coalesce(sum(gross_amount), 0) AS gross_amount, coalesce(sum(wht_amount), 0) AS wht_amount,
              coalesce(sum(net_amount), 0) AS net_amount, coalesce(sum(net_amount), 0) AS total_net_liability,
              count(*) FILTER (WHERE is_on_hold)::int AS hold_count
         FROM api.v_finance_aging WHERE ($1::text IS NULL OR province_code = $1)
        GROUP BY aging_bracket
        ORDER BY CASE aging_bracket WHEN '0-30 Days' THEN 1 WHEN '31-60 Days' THEN 2 WHEN '61-90 Days' THEN 3 ELSE 4 END`, [province])).rows;
  }
  if (sections.has('quality_exceptions')) {
    kpis.quality_exceptions = (await query(
      `SELECT issue_type, count(*)::int AS count, (array_agg(description ORDER BY created_at DESC))[1:5] AS samples
         FROM api.v_data_quality_audit WHERE ($1::text IS NULL OR province_code = $1) GROUP BY issue_type ORDER BY count(*) DESC`, [province])).rows
      // Samples name people, vouchers and amounts: shown only to those who read every register they come from.
      .map((q: any) => (ctx.has('landowners', 'read') && ctx.has('payments', 'read') && ctx.has('surveys', 'read') ? q : { ...q, samples: [] }));
  }
  if (sections.has('gis_coverage') && ctx.has('surveys', 'read')) {
    kpis.gis_coverage = (await query(
      `SELECT * FROM api.v_gis_coverage WHERE ($1::text IS NULL OR province_code = $1) ORDER BY total_surveys DESC LIMIT 10`, [province])).rows;
  }
  if (sections.has('bottlenecks')) {
    kpis.bottlenecks = (await query(
      `SELECT *, waiting_count AS waiting_records FROM api.v_approval_bottleneck
        WHERE ($1::text IS NULL OR province_code = $1) ORDER BY waiting_count DESC, max_days_waiting DESC`, [province])).rows
      .filter((b: any) => b.workflow_code && ctx.has(b.workflow_code, 'read'));
  }
  if (sections.has('lease_alerts') && ctx.has('leases', 'read')) {
    kpis.lease_alerts = (await query(
      `SELECT * FROM api.v_lease_expiry_alert WHERE ($1::text IS NULL OR province_code = $1) ORDER BY days_to_expiry ASC LIMIT 10`, [province])).rows
      .map((l: any) => (ctx.has('payments', 'read') ? l : { ...l, annual_rent: null }));
  }

  // Area, parcels and approved compensation by province, from the registers.
  const provincial_breakdown = (await query(
    `SELECT province_code, parcels AS survey_count, area_acres AS acres, approved_amount AS comp_pkr
       FROM api.rpt_exec_province WHERE ($1::text IS NULL OR province_code = $1) ORDER BY province_code`, [province])).rows
    .map((r: any) => (caseMoney ? r : { ...r, comp_pkr: null }));

  if (caseMoney || money) await audit(ctx, 'report_run', 'success', { dataset: 'kpis', audience, province, unit: executive.reporting_unit });
  return json({
    success: true,
    role: audience,
    kpis,
    provincial_breakdown,
    metadata: { timestamp: new Date().toISOString(), client: 'Mari Energies Limited', money_basis: 'gross (awaiting client confirmation)' },
  });
});
