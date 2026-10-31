// The controlled metadata layer: every dataset a report can use, every field
// it offers, and what a caller needs to read it. The compiler takes column
// names ONLY from here — a config can name a field key, never a column.
//
// Each dataset is one database view (api.rpt_* and two api.v_* views) with
// one row per entity, so money and area are attributed at that grain and a
// one-to-many join can never inflate a total (RPT-01, DSP-02).
import type { Aggregate, DatasetInfo, FieldInfo, FieldType, FilterOp, ReportConfig, SortSpec } from './types';

export interface FieldDef extends FieldInfo {
  /** View column. For unit-aware fields: the quantity in acres. */
  column: string;
  /** Unit-aware fields: the same quantity in the unit it was recorded in, where the view keeps it. */
  recordedColumn?: string;
  /** A timestamptz column shown as a date in Pakistan time. */
  tz?: boolean;
}

export interface DatasetDef extends Omit<DatasetInfo, 'fields'> {
  view: string;
  fields: FieldDef[];
  /** Permissions needed besides reports:read. */
  needs: [string, string][];
  /** Personal data (names with CNIC) — runs are audited. */
  personal: boolean;
  /** Financial data — runs are audited. */
  financial: boolean;
  /** Columns that make the order stable (and the drill-down key first). */
  rowKey: string[];
  provinceColumn?: string;
  landClassColumn?: string;
  recordedUnitColumn?: string;
  /** Data-quality flags the view computes: flag key -> boolean column. */
  flags?: Record<string, string>;
  /** Field whose absence raises missing_area. */
  primaryArea?: string;
  /** Plain-language definitions printed with the report. */
  definitions?: string[];
}

const NUMERIC_OPS: FilterOp[] = ['eq', 'neq', 'gte', 'lte', 'between', 'is_null', 'not_null'];
const OPS: Record<FieldType, FilterOp[]> = {
  text: ['eq', 'neq', 'in', 'contains', 'starts', 'is_null', 'not_null'],
  code: ['eq', 'neq', 'in', 'contains', 'starts', 'is_null', 'not_null'],
  cnic: ['eq', 'in', 'contains', 'starts'],
  enum: ['eq', 'neq', 'in', 'is_null', 'not_null'],
  integer: NUMERIC_OPS, number: NUMERIC_OPS, money: NUMERIC_OPS, area: NUMERIC_OPS, percent: NUMERIC_OPS,
  date: ['eq', 'gte', 'lte', 'between', 'is_null', 'not_null'],
  boolean: ['eq'],
};
const AGG: Partial<Record<FieldType, Aggregate[]>> = {
  integer: ['sum', 'avg', 'min', 'max'], number: ['sum', 'avg', 'min', 'max'],
  money: ['sum', 'avg', 'min', 'max'], area: ['sum', 'avg', 'min', 'max'], percent: ['sum', 'avg', 'min', 'max'],
};
const GROUPABLE: FieldType[] = ['text', 'code', 'enum', 'date', 'boolean'];

function f(key: string, label: string, type: FieldType, o: Partial<FieldDef> = {}): FieldDef {
  return {
    key, label, type, column: key, ops: OPS[type], groupable: GROUPABLE.includes(type), sortable: true,
    aggregates: AGG[type] ?? [], ...(type === 'area' ? { unitAware: true } : {}), ...(type === 'cnic' ? { sensitive: true, groupable: false } : {}), ...o,
  };
}
const opt = (xs: (string | [string, string])[]) => xs.map((x) => (Array.isArray(x) ? { value: x[0], label: x[1] } : { value: x, label: x }));

const PROVINCES = opt([['SND', 'Sindh'], ['BAL', 'Balochistan'], ['PNJ', 'Punjab'], ['KPK', 'Khyber Pakhtunkhwa']]);
const LAND_CLASS = opt(['Private', 'Government']);
const LAND_STATUS = opt(['Proposed', 'Under Acquisition', 'Acquired', 'Leased', 'Released', 'Disputed']);
const CASE_STAGES = opt(['Prepared', 'Checked', 'Reviewed', 'Verified', 'Field Approved', 'HO Approved', 'Cancelled']);
const PAY_STAGES = opt(['Requested', 'Verified', 'Released', 'Cancelled', 'Stopped']);
const ACQ_STAGES = opt(['Identification', 'Negotiation', 'Approval', 'Acquisition / Lease', 'Handover', 'Cancelled']);
const LEASE_STAGES = opt(['Draft', 'Under Review', 'Approved']);
const SETTLEMENT = opt(['Not approved', 'Unpaid', 'Part paid', 'Settled', 'Overpaid', 'Cancelled']);
const CATEGORIES = opt(['Lease Rent', 'Crop Compensation', 'Tree Compensation', 'Land Purchase', 'ROW Compensation', 'Government Lease', 'Structure / Misc', 'Court Deposit']);
const AGING = opt(['0-30 Days', '31-60 Days', '61-90 Days', 'Over 90 Days']);
const OWNER_TYPE = opt([['O', 'Owner'], ['B', 'Owner and attorney'], ['A', 'Attorney']]);   // as the landowner form says

const prov = () => f('province_code', 'Province', 'enum', { options: PROVINCES });
const money = (key: string, label: string, description?: string) => f(key, label, 'money', description ? { description } : {});

const MONEY_DEFS = [
  'Assessed: the case total while the case is not yet HO Approved (or cancelled).',
  'Approved: the total of HO Approved cases. Payable: approved plus signed adjustments.',
  'Paid: allocations on released, unreversed vouchers on the gross basis — an allocation settles allocation × gross ÷ net of its voucher, so withholding tax deducted from the cheque counts toward the award (basis awaiting client confirmation).',
  'WHT: paid (gross) less paid net. Outstanding: payable less paid, per approved case; an over-payment is negative and flagged, never shown as zero.',
  'A reversed release is not paid; a cancelled or stopped voucher counts nowhere.',
];
const AREA_DEFS = [
  'Areas are stored in acres (the primary unit) and shown in the report\'s unit mode with factors from lms.unit_conversion; Jireb and Bigha factors are provisional.',
];

export const DATASETS: DatasetDef[] = [
  {
    key: 'parcels', label: 'Land parcels', category: 'Land & ownership', view: 'api.rpt_parcel',
    description: 'Survey / khasra parcels with their location, land class, status, area and ownership coverage.',
    grain: 'one row per land parcel', needs: [['surveys', 'read']], personal: false, financial: false,
    rowKey: ['parcel_code'], provinceColumn: 'province_code', landClassColumn: 'land_class', recordedUnitColumn: 'recorded_unit',
    primaryArea: 'area', flags: { shares_not_100: 'flag_shares_not_100', area_over_committed: 'flag_area_over_committed', recorded_provisional: 'flag_recorded_provisional' },
    fields: [
      f('parcel_code', 'Parcel code', 'code'), f('survey_no', 'Survey / khasra no.', 'text'), f('block_no', 'Block no.', 'text'),
      prov(), f('province_name', 'Province name', 'text'), f('district', 'District', 'text'), f('tehsil', 'Tehsil / taluka', 'text'),
      f('village', 'Village (deh / mouza)', 'text'), f('admin_path', 'Revenue hierarchy', 'text', { groupable: false }),
      f('land_class', 'Land class', 'enum', { options: LAND_CLASS }), f('status_code', 'Land status', 'enum', { options: LAND_STATUS }),
      f('area', 'Area', 'area', { column: 'area_acres', recordedColumn: 'area_recorded' }),
      f('recorded_unit', 'Unit as recorded', 'code'),
      f('committed_area', 'Committed to live cases', 'area', { column: 'committed_area_acres', description: 'Area of live compensation cases in force today' }),
      f('owner_count', 'Owners', 'integer'), f('share_total_pct', 'Shares total %', 'percent', { aggregates: ['avg', 'min', 'max'] }),
      f('project_count', 'Projects', 'integer'), f('project_codes', 'Project codes', 'text', { groupable: false }),
      f('case_count', 'Live cases', 'integer'), f('created_on', 'Registered on', 'date'), f('updated_on', 'Last changed', 'date'),
    ],
    defaultColumns: ['parcel_code', 'survey_no', 'province_code', 'district', 'village', 'land_class', 'status_code', 'area', 'owner_count', 'project_codes'],
    defaultSort: [{ field: 'province_code', dir: 'asc' }, { field: 'parcel_code', dir: 'asc' }],
    drillDown: { label: 'Parcel register', href: '/surveys?q={key}' }, definitions: AREA_DEFS,
  },
  {
    key: 'project_parcels', label: 'Project land by parcel', category: 'Land & ownership', view: 'api.rpt_project_parcel',
    description: 'Each parcel of each project (linked to the project or under one of its live cases), with its share of the project\'s land.',
    grain: 'one row per project and parcel', needs: [['surveys', 'read'], ['projects', 'read']], personal: false, financial: false,
    rowKey: ['project_code', 'parcel_code'], provinceColumn: 'province_code', landClassColumn: 'land_class', recordedUnitColumn: 'recorded_unit',
    primaryArea: 'area', flags: { recorded_provisional: 'flag_recorded_provisional' },
    fields: [
      f('project_code', 'Project code', 'code'), f('project_name', 'Project', 'text'), prov(), f('district', 'District', 'text'),
      f('tehsil', 'Tehsil / taluka', 'text'), f('village', 'Village (deh / mouza)', 'text'),
      f('parcel_code', 'Parcel code', 'code'), f('survey_no', 'Survey / khasra no.', 'text'),
      f('land_class', 'Land class', 'enum', { options: LAND_CLASS }), f('status_code', 'Land status', 'enum', { options: LAND_STATUS }),
      f('link_kind', 'Linked how', 'enum', { options: opt(['Linked', 'Under a case only', 'Linked and under a case']) }),
      f('area', 'Area', 'area', { column: 'area_acres', recordedColumn: 'area_recorded' }), f('recorded_unit', 'Unit as recorded', 'code'),
      f('pct_of_project', '% of project land', 'percent', { description: 'Share of the project\'s parcel area; sums to 100 per project' }),
    ],
    defaultColumns: ['project_code', 'province_code', 'land_class', 'parcel_code', 'area', 'pct_of_project'],
    defaultSort: [{ field: 'project_code', dir: 'asc' }, { field: 'land_class', dir: 'asc' }],
    drillDown: { label: 'Parcel register', href: '/surveys?q={key}' }, definitions: AREA_DEFS,
  },
  {
    key: 'ownership', label: 'Ownership shares', category: 'Persons & CNIC', view: 'api.rpt_ownership',
    description: 'Who owns which parcel and what share: the owner, their CNIC, the parcel and the area their share represents.',
    grain: 'one row per owner per parcel', needs: [['landowners', 'read'], ['surveys', 'read']], personal: true, financial: false,
    rowKey: ['owner_code', 'parcel_code'], provinceColumn: 'province_code', landClassColumn: 'land_class', recordedUnitColumn: 'recorded_unit',
    primaryArea: 'parcel_area', flags: { shares_not_100: 'flag_shares_not_100', recorded_provisional: 'flag_recorded_provisional' },
    fields: [
      f('owner_code', 'Owner code', 'code'), f('owner_name', 'Owner', 'text'), f('father_name', 'Father / husband', 'text'),
      f('cnic', 'CNIC', 'cnic'), f('owner_type', 'Owner type', 'enum', { options: OWNER_TYPE }),
      f('owner_status', 'Owner status', 'enum', { options: opt(['Active', 'Deceased', 'Inactive']) }),
      prov(), f('district', 'District', 'text'), f('tehsil', 'Tehsil / taluka', 'text'), f('village', 'Village (deh / mouza)', 'text'),
      f('parcel_code', 'Parcel code', 'code'), f('survey_no', 'Survey / khasra no.', 'text'),
      f('land_class', 'Land class', 'enum', { options: LAND_CLASS }), f('parcel_status', 'Land status', 'enum', { options: LAND_STATUS }),
      f('share_pct', 'Share %', 'percent', { aggregates: ['avg', 'min', 'max'] }),
      f('parcel_area', 'Parcel area', 'area', { column: 'parcel_area_acres', recordedColumn: 'parcel_area_recorded' }),
      f('owned_area', 'Owned area', 'area', { column: 'owned_area_acres', recordedColumn: 'owned_area_recorded', description: 'Parcel area × share' }),
      f('effective_from', 'Share effective from', 'date'), f('revenue_doc_ref', 'Revenue document', 'text', { groupable: false }),
    ],
    defaultColumns: ['owner_code', 'owner_name', 'cnic', 'parcel_code', 'survey_no', 'village', 'share_pct', 'parcel_area', 'owned_area'],
    defaultSort: [{ field: 'owner_code', dir: 'asc' }, { field: 'parcel_code', dir: 'asc' }],
    drillDown: { label: 'Landowner register', href: '/landowners?q={key}' }, definitions: AREA_DEFS,
  },
  {
    // 0056: the read-only landowner register for the overseeing roles (system
    // administrator, Manager Land HO, security auditor, finance). It needs only
    // landowner_report:read, not the registers' own permissions, so it opens no
    // Landowners or Survey screen and allows no change. CNIC is masked without
    // pii:read; row-level security keeps every reader to their provinces.
    key: 'landowner_register', label: 'Landowner register', category: 'Persons & CNIC', view: 'api.rpt_ownership',
    description: "Every landowner with each parcel (khasra) they hold: province, district, taluka/tehsil, deh/mouza, share and the area of that share, in the province's unit, a common unit or as recorded.",
    grain: 'one row per owner per parcel', needs: [['landowner_report', 'read']], personal: true, financial: false,
    rowKey: ['owner_code', 'parcel_code'], provinceColumn: 'province_code', landClassColumn: 'land_class', recordedUnitColumn: 'recorded_unit',
    primaryArea: 'owned_area', flags: { shares_not_100: 'flag_shares_not_100', recorded_provisional: 'flag_recorded_provisional' },
    fields: [
      f('owner_code', 'Owner code', 'code'), f('owner_name', 'Owner', 'text'), f('father_name', 'Father / husband', 'text'),
      f('cnic', 'CNIC', 'cnic'), f('owner_type', 'Owner type', 'enum', { options: OWNER_TYPE }),
      f('owner_status', 'Owner status', 'enum', { options: opt(['Active', 'Deceased', 'Inactive']) }),
      f('tax_status', 'Tax status', 'enum', { options: opt(['Filer', 'Non-Filer']) }),
      f('owner_on_hold', 'Payment hold on owner', 'boolean'),
      prov(), f('district', 'District', 'text'), f('tehsil', 'Tehsil / taluka', 'text'), f('village', 'Village (deh / mouza)', 'text'),
      f('parcel_code', 'Parcel code', 'code'), f('survey_no', 'Survey / khasra no.', 'text'),
      f('land_class', 'Land class', 'enum', { options: LAND_CLASS }), f('parcel_status', 'Land status', 'enum', { options: LAND_STATUS }),
      f('share_pct', 'Share %', 'percent', { aggregates: ['avg', 'min', 'max'] }),
      f('parcel_area', 'Parcel area', 'area', { column: 'parcel_area_acres', recordedColumn: 'parcel_area_recorded' }),
      f('owned_area', 'Owned area', 'area', { column: 'owned_area_acres', recordedColumn: 'owned_area_recorded', description: 'Parcel area × share' }),
      f('recorded_unit', 'Unit as recorded', 'code'),
      f('effective_from', 'Share effective from', 'date'), f('revenue_doc_ref', 'Revenue document', 'text', { groupable: false }),
    ],
    defaultColumns: ['owner_code', 'owner_name', 'father_name', 'cnic', 'province_code', 'district', 'tehsil', 'village',
      'survey_no', 'share_pct', 'parcel_area', 'owned_area', 'owner_status', 'tax_status'],
    defaultSort: [{ field: 'province_code', dir: 'asc' }, { field: 'owner_code', dir: 'asc' }, { field: 'parcel_code', dir: 'asc' }],
    definitions: AREA_DEFS,
  },
  {
    key: 'persons', label: 'Persons and CNIC', category: 'Persons & CNIC', view: 'api.rpt_person',
    description: 'Every landowner with their land holding, cases, what is owed to them, paid (gross, WHT, net) and outstanding.',
    grain: 'one row per person (landowner)', needs: [['landowners', 'read'], ['cases', 'read'], ['payments', 'read']], personal: true, financial: true,
    rowKey: ['owner_code'], provinceColumn: 'province_code', primaryArea: undefined,
    flags: { no_shares: 'flag_no_shares', possible_duplicate: 'flag_possible_duplicate', unattributed_payment: 'flag_unattributed_payment', overpaid: 'flag_overpaid' },
    fields: [
      f('owner_code', 'Owner code', 'code'), f('full_name', 'Name', 'text'), f('father_name', 'Father / husband', 'text'), f('cnic', 'CNIC', 'cnic'),
      f('owner_type', 'Owner type', 'enum', { options: OWNER_TYPE }), f('status', 'Status', 'enum', { options: opt(['Active', 'Deceased', 'Inactive']) }),
      f('tax_status', 'Tax status', 'enum', { options: opt(['Filer', 'Non-Filer']) }), prov(),
      f('parcel_count', 'Parcels', 'integer'), f('owned_area', 'Land owned', 'area', { column: 'owned_area_acres' }),
      f('case_count', 'Cases', 'integer'),
      money('payable_amount', 'Award attributed (payable)', 'Share × payable award of approved cases'),
      money('paid_amount', 'Paid (gross)'), money('wht_amount', 'WHT'), money('paid_net_amount', 'Paid net'),
      money('outstanding_amount', 'Outstanding'), money('other_payments_net', 'Other payments (not compensation)', 'Released to this person but not allocated to a compensation case, e.g. lease rent'),
      f('created_on', 'Registered on', 'date'),
    ],
    defaultColumns: ['owner_code', 'full_name', 'cnic', 'province_code', 'parcel_count', 'owned_area', 'case_count', 'payable_amount', 'paid_amount', 'outstanding_amount'],
    defaultSort: [{ field: 'owner_code', dir: 'asc' }],
    drillDown: { label: 'Person statement', href: '/landowners?q={key}' }, definitions: [...MONEY_DEFS, ...AREA_DEFS],
  },
  {
    key: 'acquisitions', label: 'Land acquisitions', category: 'Acquisition', view: 'api.rpt_acquisition',
    description: 'Acquisition files by mode and workflow stage, with the area required and the parcels involved.',
    grain: 'one row per acquisition', needs: [['acquisitions', 'read']], personal: false, financial: false,
    rowKey: ['acquisition_code'], provinceColumn: 'province_code', primaryArea: 'area_required',
    fields: [
      f('acquisition_code', 'Acquisition', 'code'), prov(), f('project_code', 'Project code', 'code'), f('project_name', 'Project', 'text'),
      f('district', 'District', 'text'),
      f('mode', 'Mode', 'enum', { options: opt(['Private Lease', 'Direct Purchase', 'Government Land (Lease / Allotment)', 'LAA 1894 Acquisition', 'ROW / Easement']) }),
      f('stage_code', 'Workflow stage', 'enum', { options: ACQ_STAGES }), f('stage_seq', 'Stage order', 'integer', { aggregates: [] }),
      f('acquisition_status', 'Status', 'enum', { options: opt(['In progress', 'Acquired', 'Cancelled']), description: 'From the workflow stage: Handover = acquired' }),
      f('area_required', 'Area required', 'area', { column: 'area_required_acres' }),
      f('parcel_count', 'Parcels', 'integer'), f('parcel_area', 'Parcel area', 'area', { column: 'parcel_area_acres' }),
      money('negotiated_rate', 'Negotiated rate (per acre)'), f('target_handover_date', 'Target handover', 'date'),
      f('days_at_stage', 'Days at stage', 'integer', { aggregates: ['avg', 'max'] }), f('negotiator', 'Negotiator', 'text'),
      f('created_on', 'Opened on', 'date'),
    ],
    defaultColumns: ['acquisition_code', 'province_code', 'project_name', 'mode', 'stage_code', 'acquisition_status', 'area_required', 'parcel_count', 'days_at_stage'],
    defaultSort: [{ field: 'province_code', dir: 'asc' }, { field: 'acquisition_code', dir: 'asc' }],
    drillDown: { label: 'Acquisitions', href: '/acquisitions?q={key}' }, definitions: AREA_DEFS,
  },
  {
    key: 'cases', label: 'Compensation cases', category: 'Compensation & payments', view: 'api.rpt_case',
    description: 'Each compensation case with its assessed, approved, adjusted, paid (gross, WHT, net) and outstanding amounts.',
    grain: 'one row per compensation case', needs: [['cases', 'read']], personal: false, financial: true,
    rowKey: ['case_code'], provinceColumn: 'province_code', primaryArea: 'lease_area',
    flags: { overpaid: 'flag_overpaid', unattributed_payment: 'flag_unattributed_payment' },
    fields: [
      f('case_code', 'Case', 'code'), f('lease_no', 'Lease no.', 'code'), prov(), f('district', 'District', 'text'),
      f('project_code', 'Project code', 'code'), f('project_name', 'Project', 'text'),
      f('land_use_code', 'Land use', 'enum', { options: opt(['Well Location', 'Access Road', 'Pipeline ROW', 'Flowline', 'Camp', 'Water Pond', 'Compressor Station', 'Other']) }),
      f('stage_code', 'Workflow stage', 'enum', { options: CASE_STAGES }), f('stage_seq', 'Stage order', 'integer', { aggregates: [] }),
      f('case_date', 'Case date', 'date'), f('effective_date', 'Effective date', 'date'), f('approved_on', 'Approved on', 'date'),
      f('approved_month', 'Approval month', 'code'), f('lease_term_months', 'Term (months)', 'integer', { aggregates: ['avg', 'min', 'max'] }),
      f('lease_area', 'Lease area', 'area', { column: 'lease_area_acres' }),
      f('owner_count', 'Owners', 'integer'), f('owner_codes', 'Owner codes', 'text', { groupable: false }),
      money('assessed_amount', 'Assessed'), money('approved_amount', 'Approved'), money('adjustment_amount', 'Adjustments'),
      money('payable_amount', 'Payable'), money('allocated_amount', 'Allocated (gross)'), money('paid_amount', 'Paid (gross)'),
      money('wht_amount', 'WHT'), money('paid_net_amount', 'Paid net'), money('reversed_amount', 'Reversed'),
      money('outstanding_amount', 'Outstanding', 'Payable − paid; negative = over-paid'), money('overpaid_amount', 'Over-paid'),
      f('settlement_status', 'Settlement', 'enum', { options: SETTLEMENT }),
      f('days_at_stage', 'Days at stage', 'integer', { aggregates: ['avg', 'max'] }), f('waiting_on_group', 'Waiting on', 'text'),
      f('prepared_by', 'Prepared by', 'text'), f('created_on', 'Created on', 'date'),
    ],
    defaultColumns: ['case_code', 'province_code', 'project_name', 'stage_code', 'assessed_amount', 'approved_amount', 'adjustment_amount', 'payable_amount', 'paid_amount', 'wht_amount', 'paid_net_amount', 'outstanding_amount', 'settlement_status'],
    defaultSort: [{ field: 'province_code', dir: 'asc' }, { field: 'case_code', dir: 'asc' }],
    drillDown: { label: 'Compensation cases', href: '/cases?q={key}' }, definitions: MONEY_DEFS,
  },
  {
    key: 'case_owners', label: 'Case owners', category: 'Compensation & payments', view: 'api.rpt_case_owner',
    description: 'Each owner\'s part of each case: their share of the payable award, what was paid to them and what remains.',
    grain: 'one row per owner per case', needs: [['cases', 'read'], ['landowners', 'read']], personal: true, financial: true,
    rowKey: ['case_code', 'owner_code'], provinceColumn: 'province_code',
    flags: { unattributed_payment: 'flag_unattributed_payment', overpaid: 'flag_overpaid' },
    fields: [
      f('case_code', 'Case', 'code'), prov(), f('project_code', 'Project code', 'code'),
      f('stage_code', 'Workflow stage', 'enum', { options: CASE_STAGES }),
      f('owner_code', 'Owner code', 'code'), f('owner_name', 'Owner', 'text'), f('cnic', 'CNIC', 'cnic'),
      f('share_pct', 'Share %', 'percent', { aggregates: ['avg', 'min', 'max'] }), f('owner_count', 'Owners on case', 'integer', { aggregates: [] }),
      money('payable_amount', 'Award attributed (payable)', 'Share × payable; rounding residue goes to the largest remainders so every paisa is attributed'),
      money('allocated_amount', 'Allocated (gross)'), money('paid_amount', 'Paid (gross)'), money('wht_amount', 'WHT'),
      money('paid_net_amount', 'Paid net'), money('outstanding_amount', 'Outstanding'),
      f('settlement_status', 'Settlement', 'enum', { options: SETTLEMENT }),
      money('case_unattributed_paid', 'Paid on the case without naming an owner'),
    ],
    defaultColumns: ['case_code', 'owner_code', 'owner_name', 'cnic', 'share_pct', 'payable_amount', 'paid_amount', 'wht_amount', 'paid_net_amount', 'outstanding_amount', 'settlement_status'],
    defaultSort: [{ field: 'case_code', dir: 'asc' }, { field: 'owner_code', dir: 'asc' }],
    drillDown: { label: 'Compensation cases', href: '/cases?q={key}' }, definitions: MONEY_DEFS,
  },
  {
    key: 'vouchers', label: 'Payment vouchers', category: 'Compensation & payments', view: 'api.rpt_voucher',
    description: 'Payment vouchers with gross, WHT and net, release (cheque) date and period, reversal, allocation and aging.',
    grain: 'one row per payment voucher', needs: [['payments', 'read']], personal: true, financial: true,
    rowKey: ['voucher_code'], provinceColumn: 'province_code', flags: { unallocated_payment: 'flag_unallocated_payment' },
    fields: [
      f('voucher_code', 'Voucher', 'code'), prov(), f('project_code', 'Project code', 'code'), f('project_name', 'Project', 'text'),
      f('category_code', 'Category', 'enum', { options: CATEGORIES }),
      f('pay_type', 'Pay type', 'enum', { options: opt(['One-time', 'Yearly Lease', 'Advance Lease (multi-year)']) }),
      f('payment_mode', 'Mode', 'enum', { options: opt(['Cross Cheque', 'Pay Order', 'Direct Credit (IBFT)']) }),
      f('payee_name', 'Payee', 'text'), f('payee_code', 'Payee code', 'code'), f('payee_cnic', 'Payee CNIC', 'cnic'),
      f('case_code', 'Case', 'code'), f('lease_code', 'Lease', 'code'),
      f('period_from', 'Period from', 'date'), f('period_to', 'Period to', 'date'),
      money('gross_amount', 'Gross'), f('wht_pct', 'WHT %', 'percent', { aggregates: ['avg', 'min', 'max'] }), money('wht_amount', 'WHT'), money('net_amount', 'Net'),
      f('stage_code', 'Workflow stage', 'enum', { options: PAY_STAGES }),
      f('is_released', 'Released (not reversed)', 'boolean'), f('is_reversed', 'Reversed', 'boolean'),
      f('cheque_no', 'Cheque no.', 'text'), f('cheque_date', 'Cheque date', 'date'), money('released_amount', 'Released'),
      f('release_month', 'Release month', 'code'), f('release_quarter', 'Release quarter', 'code'), f('release_fiscal_year', 'Release fiscal year', 'code'),
      f('released_on', 'Released on', 'date'), f('reversed_on', 'Reversed on', 'date'),
      money('allocated_net', 'Allocated to cases (net)'), money('unallocated_net', 'Not allocated (net)'),
      f('days_pending', 'Days pending', 'integer', { aggregates: ['avg', 'max'] }), f('aging_bracket', 'Aging', 'enum', { options: AGING }),
      f('on_hold', 'On hold', 'boolean'), f('hold_reason', 'Hold reason', 'text', { groupable: false }), f('requested_on', 'Requested on', 'date'),
    ],
    defaultColumns: ['voucher_code', 'province_code', 'project_name', 'category_code', 'payee_name', 'case_code', 'gross_amount', 'wht_amount', 'net_amount', 'stage_code', 'cheque_date'],
    defaultSort: [{ field: 'voucher_code', dir: 'asc' }],
    drillDown: { label: 'Payments', href: '/payments?q={key}' }, definitions: MONEY_DEFS,
  },
  {
    key: 'allocations', label: 'Payment allocations', category: 'Compensation & payments', view: 'api.rpt_allocation',
    description: 'How each voucher is split across cases and owners, and what each part settles against the award (gross basis).',
    grain: 'one row per allocation of a voucher to a case (and owner)', needs: [['payments', 'read'], ['cases', 'read']], personal: true, financial: true,
    rowKey: ['voucher_code', 'case_code', 'owner_code'], provinceColumn: 'province_code', flags: { unattributed_payment: 'flag_unattributed_payment' },
    fields: [
      f('voucher_code', 'Voucher', 'code'), f('case_code', 'Case', 'code'), prov(), f('project_code', 'Project code', 'code'),
      f('category_code', 'Category', 'enum', { options: CATEGORIES }),
      f('owner_code', 'Owner code', 'code'), f('owner_name', 'Owner', 'text'), f('cnic', 'CNIC', 'cnic'),
      money('allocated_net', 'Allocated (net)'), money('settled_gross', 'Settles (gross)'), money('wht_share', 'WHT share'),
      f('voucher_stage', 'Voucher stage', 'enum', { options: PAY_STAGES }),
      f('is_live', 'Live', 'boolean'), f('is_paid', 'Paid', 'boolean'), f('is_reversed', 'Reversed', 'boolean'),
      f('cheque_no', 'Cheque no.', 'text'), f('cheque_date', 'Cheque date', 'date'), f('release_month', 'Release month', 'code'),
      f('allocated_on', 'Allocated on', 'date'),
    ],
    defaultColumns: ['voucher_code', 'case_code', 'owner_code', 'owner_name', 'allocated_net', 'settled_gross', 'wht_share', 'is_paid', 'cheque_date'],
    defaultSort: [{ field: 'voucher_code', dir: 'asc' }],
    drillDown: { label: 'Payments', href: '/payments?q={key}' }, definitions: MONEY_DEFS,
  },
  {
    key: 'leases', label: 'Lease register', category: 'Land & ownership', view: 'api.rpt_lease',
    description: 'Leases from the canonical register: status (draft, under review, active, expiring, expired, on hold, terminated), area, rent and renewals.',
    grain: 'one row per lease', needs: [['leases', 'read']], personal: false, financial: true,
    rowKey: ['lease_code'], provinceColumn: 'province_code', primaryArea: 'current_area',
    fields: [
      f('lease_code', 'Lease', 'code'), prov(), f('project_code', 'Project code', 'code'), f('project_name', 'Project', 'text'),
      f('district', 'District', 'text'), f('case_code', 'Case', 'code'),
      f('kind', 'Kind', 'enum', { options: opt(['Private Land', 'Government Land', 'ROW / Easement']) }), f('registration_no', 'Registration no.', 'text'),
      f('initial_area', 'Initial area', 'area', { column: 'initial_area_acres' }), f('current_area', 'Current area', 'area', { column: 'current_area_acres' }),
      f('start_date', 'Start', 'date'), f('term_years', 'Term (years)', 'integer', { aggregates: ['avg', 'min', 'max'] }), f('end_date', 'Expiry', 'date'),
      f('terminated_on', 'Terminated on', 'date'), money('rate_per_acre', 'Rate per acre'), f('escalation_pct', 'Escalation %', 'percent', { aggregates: ['avg', 'min', 'max'] }),
      money('annual_rent', 'Annual rent (current rate)', 'Current rate × current area; escalation applies at renewal'),
      f('stage_code', 'Workflow stage', 'enum', { options: LEASE_STAGES }),
      f('lease_status', 'Status', 'enum', { options: opt(['Draft', 'Under Review', 'Active', 'Expiring ≤ 30 days', 'Expiring ≤ 60 days', 'Expiring ≤ 90 days', 'Expiring ≤ 180 days', 'Expired', 'On Hold', 'Terminated']) }),
      f('days_to_expiry', 'Days to expiry', 'integer', { aggregates: ['min', 'max'] }), f('renewal_count', 'Renewals', 'integer'),
      f('lessors', 'Lessors', 'text', { groupable: false }), f('parcels', 'Parcels', 'text', { groupable: false }),
      f('is_on_hold', 'On hold', 'boolean'), f('hold_reason', 'Hold reason', 'text', { groupable: false }),
    ],
    defaultColumns: ['lease_code', 'province_code', 'project_name', 'lessors', 'current_area', 'start_date', 'end_date', 'annual_rent', 'renewal_count', 'lease_status'],
    defaultSort: [{ field: 'end_date', dir: 'asc' }],
    drillDown: { label: 'Leases', href: '/leases?q={key}' }, definitions: AREA_DEFS,
  },
  {
    key: 'executive_province', label: 'Executive summary by province', category: 'Executive', view: 'api.rpt_exec_province',
    description: 'Physical and financial progress per province, built from the registers (never by adding up projects).',
    grain: 'one row per province in your scope', needs: [['surveys', 'read'], ['cases', 'read'], ['payments', 'read']], personal: false, financial: true,
    rowKey: ['province_code'], provinceColumn: 'province_code', primaryArea: 'area', flags: { overpaid: 'flag_overpaid', unallocated_payment: 'flag_unallocated_payment' },
    fields: [
      prov(), f('province_name', 'Province name', 'text'), f('projects', 'Projects', 'integer'), f('active_projects', 'Active projects', 'integer'),
      f('parcels', 'Parcels', 'integer'), f('area', 'Land managed', 'area', { column: 'area_acres' }),
      f('gov_area', 'Government land', 'area', { column: 'gov_area_acres' }), f('private_area', 'Private land', 'area', { column: 'private_area_acres' }),
      f('acquired_area', 'Acquired (handed over)', 'area', { column: 'acquired_area_acres' }), f('leased_area', 'Leased (in force)', 'area', { column: 'leased_area_acres' }),
      f('landowners', 'Persons', 'integer'), f('cases', 'Cases', 'integer'), f('pending_cases', 'Cases pending approval', 'integer'),
      f('approved_cases', 'Approved cases', 'integer'), f('open_acquisitions', 'Acquisitions in progress', 'integer'),
      money('assessed_amount', 'Assessed'), money('approved_amount', 'Approved'), money('adjustment_amount', 'Adjustments'), money('payable_amount', 'Payable'),
      money('paid_amount', 'Paid (gross)'), money('wht_amount', 'WHT'), money('paid_net_amount', 'Paid net'),
      money('outstanding_amount', 'Outstanding liability', 'Sum of what each approved case still owes; over-payments are not netted off'),
      money('overpaid_amount', 'Over-paid'), f('overpaid_cases', 'Over-paid cases', 'integer'), money('net_outstanding_amount', 'Payable − paid (net of over-payments)'),
      money('pending_vouchers_net', 'Vouchers awaiting release (net)'), money('unallocated_released_net', 'Released, not allocated to a case'),
      money('lease_and_other_released_net', 'Released under leases / DBPFC'),
      f('leases', 'Leases (register)', 'integer'), f('leases_in_force', 'Leases in force', 'integer'), f('leases_expired', 'Leases expired', 'integer'),
      f('leases_expiring_90d', 'Expiring ≤ 90 days', 'integer'), f('leases_on_hold', 'Leases on hold', 'integer'),
      f('open_grievances', 'Open grievances', 'integer'), f('active_stay_orders', 'Stay orders in force', 'integer'),
    ],
    defaultColumns: ['province_code', 'province_name', 'parcels', 'area', 'acquired_area', 'leased_area', 'cases', 'approved_amount', 'paid_amount', 'wht_amount', 'outstanding_amount', 'overpaid_amount'],
    defaultSort: [{ field: 'province_code', dir: 'asc' }],
    definitions: [...MONEY_DEFS, ...AREA_DEFS, 'Acquired area is the area of acquisitions handed over; leased area is the current area of leases in force.'],
  },
  {
    key: 'executive_project', label: 'Executive summary by project', category: 'Executive', view: 'api.rpt_exec_project',
    description: 'Physical and financial progress per project, with reconciliation status (Overpaid / Unpaid / Part paid / Balanced / No activity).',
    grain: 'one row per project', needs: [['projects', 'read'], ['cases', 'read'], ['payments', 'read']], personal: false, financial: true,
    rowKey: ['project_code'], provinceColumn: 'province_code', primaryArea: 'area', flags: { overpaid: 'flag_overpaid' },
    fields: [
      f('project_code', 'Project code', 'code'), f('project_name', 'Project', 'text'), prov(), f('district', 'District', 'text'),
      f('type_code', 'Type', 'enum', { options: opt(['Well Location', 'Pipeline', 'Access Road', 'Camp / Base', 'Compressor Station', 'Processing Facility', 'Seismic Survey', 'Other']) }),
      f('project_status', 'Status', 'enum', { options: opt(['Active', 'Completed', 'On Hold', 'Planned', 'Closed']) }),
      f('parcels', 'Parcels', 'integer'), f('linked_parcels', 'Linked parcels', 'integer'), f('case_parcels', 'Parcels under cases', 'integer'),
      f('area', 'Land', 'area', { column: 'area_acres', description: 'Each parcel once (linked, or under a live case)' }),
      f('gov_area', 'Government land', 'area', { column: 'gov_area_acres' }), f('acquired_area', 'Acquired (handed over)', 'area', { column: 'acquired_area_acres' }),
      f('leased_area', 'Leased (in force)', 'area', { column: 'leased_area_acres' }), f('required_area', 'Required', 'area', { column: 'required_area_acres' }),
      f('landowners', 'Persons', 'integer'), f('cases', 'Cases', 'integer'), f('pending_cases', 'Cases pending approval', 'integer'),
      f('approved_cases', 'Approved cases', 'integer'), f('open_acquisitions', 'Acquisitions in progress', 'integer'),
      money('assessed_amount', 'Assessed'), money('approved_amount', 'Approved'), money('adjustment_amount', 'Adjustments'), money('payable_amount', 'Payable'),
      money('paid_amount', 'Paid (gross)'), money('wht_amount', 'WHT'), money('paid_net_amount', 'Paid net'),
      money('outstanding_amount', 'Outstanding liability'), money('overpaid_amount', 'Over-paid'), money('net_outstanding_amount', 'Payable − paid'),
      f('reconciliation_status', 'Reconciliation', 'enum', { options: opt(['Overpaid', 'Unpaid', 'Part paid', 'Balanced', 'No activity']) }),
      f('leases', 'Leases', 'integer'), f('leases_expired', 'Leases expired', 'integer'), f('leases_expiring_90d', 'Expiring ≤ 90 days', 'integer'),
    ],
    defaultColumns: ['project_code', 'project_name', 'province_code', 'parcels', 'area', 'cases', 'payable_amount', 'paid_amount', 'outstanding_amount', 'overpaid_amount', 'reconciliation_status'],
    defaultSort: [{ field: 'province_code', dir: 'asc' }, { field: 'project_code', dir: 'asc' }],
    drillDown: { label: 'Project dashboard', href: '/projects?q={key}' }, definitions: [...MONEY_DEFS, ...AREA_DEFS],
  },
  {
    key: 'dbpfc', label: 'Government land rate fixation (DBPFC)', category: 'Acquisition', view: 'api.rpt_dbpfc',
    description: 'Sindh DBPFC estimates: area, estimated, fixed and applied rates, annual amount and committee stage.',
    grain: 'one row per DBPFC estimate', needs: [['dbpfc', 'read']], personal: false, financial: true,
    rowKey: ['dbpfc_code'], provinceColumn: 'province_code', primaryArea: 'area',
    fields: [
      f('dbpfc_code', 'DBPFC ref', 'code'), prov(), f('project_code', 'Project code', 'code'), f('project_name', 'Project', 'text'),
      f('district', 'District', 'text'), f('area', 'Area', 'area', { column: 'area_acres' }),
      money('estimated_rate', 'Estimated rate (per acre)'), money('fixed_rate', 'Fixed rate (per acre)'), money('applied_rate', 'Applied rate (per acre)'),
      money('annual_amount', 'Annual amount'), f('committee_ref', 'Committee ref', 'text'), f('meeting_date', 'Meeting date', 'date'),
      f('stage_code', 'Stage', 'enum', { options: opt(['Estimated', 'Referred to DBPFC', 'Rate Fixed', 'Stopped']) }),
      f('rate_pending', 'Rate not yet fixed', 'boolean'), f('remarks', 'Remarks', 'text', { groupable: false }),
    ],
    defaultColumns: ['dbpfc_code', 'project_name', 'district', 'area', 'estimated_rate', 'fixed_rate', 'applied_rate', 'annual_amount', 'meeting_date', 'stage_code'],
    defaultSort: [{ field: 'dbpfc_code', dir: 'asc' }], definitions: AREA_DEFS,
  },
  {
    key: 'gis_coverage', label: 'GIS coverage by project', category: 'Land & ownership', view: 'api.v_gis_coverage',
    description: 'Parcels linked to each project and how many have a mapped polygon of that project.',
    grain: 'one row per project', needs: [['projects', 'read'], ['gis', 'read']], personal: false, financial: false,
    rowKey: ['project_code'], provinceColumn: 'province_code',
    fields: [
      f('project_code', 'Project code', 'code'), f('project_name', 'Project', 'text'), prov(),
      f('total_surveys', 'Linked parcels', 'integer'), f('mapped_features', 'Mapped features', 'integer'),
      f('unmapped_surveys', 'Parcels not mapped', 'integer'), f('coverage_percentage', 'Coverage %', 'percent', { aggregates: ['avg', 'min', 'max'] }),
    ],
    defaultColumns: ['project_code', 'project_name', 'province_code', 'total_surveys', 'mapped_features', 'unmapped_surveys', 'coverage_percentage'],
    defaultSort: [{ field: 'coverage_percentage', dir: 'desc' }, { field: 'project_code', dir: 'asc' }],
  },
  {
    key: 'units', label: 'Units of measure', category: 'Land & ownership', view: 'api.rpt_unit',
    description: 'Every area unit with the factor in force, whether the Land Department has confirmed it, and the provinces that use it.',
    grain: 'one row per unit of area', needs: [], personal: false, financial: false, rowKey: ['display_order'],
    flags: { unsupported_unit: 'flag_unsupported_unit', provisional_factor: 'flag_provisional_factor' },
    fields: [
      f('unit_code', 'Unit', 'code'), f('unit_name', 'Name', 'text'), f('display_order', 'Order', 'integer', { aggregates: [] }),
      f('sqm_per_unit', 'Square metres', 'number', { aggregates: [] }), f('units_per_acre', 'Per acre', 'number', { aggregates: [] }),
      f('acres_per_unit', 'Acres', 'number', { aggregates: [] }), f('is_confirmed', 'Factor confirmed', 'boolean'),
      f('source_ref', 'Source', 'text'), f('note', 'Note', 'text', { groupable: false }), f('valid_from', 'Valid from', 'date'),
      f('provinces', 'Provinces', 'text'), f('provinces_confirmed', 'Province list confirmed', 'boolean'),
    ],
    defaultColumns: ['unit_code', 'unit_name', 'sqm_per_unit', 'units_per_acre', 'is_confirmed', 'source_ref', 'provinces'],
    defaultSort: [{ field: 'display_order', dir: 'asc' }],
  },
  {
    key: 'exceptions', label: 'Exceptions and data quality', category: 'Executive', view: 'api.rpt_exception',
    description: 'Records needing action: over-payments, unallocated releases, allocation errors, over-committed parcels, share discrepancies, likely duplicates, missing receipts, holds, stay orders and open grievances.',
    grain: 'one row per finding', needs: [['surveys', 'read'], ['cases', 'read'], ['payments', 'read'], ['landowners', 'read']], personal: false, financial: true,
    rowKey: ['rule', 'record_code', 'record_id'], provinceColumn: 'province_code',
    fields: [
      f('rule', 'Rule', 'code'), f('issue', 'Issue', 'text'),
      f('severity', 'Severity', 'enum', { options: opt(['error', 'warning', 'intervention']) }), prov(),
      f('entity', 'Record type', 'enum', { options: opt(['survey', 'compensation_case', 'payment_request', 'payment_allocation', 'payment_release', 'landowner', 'lease', 'legal_case', 'payment_hold', 'grievance']) }),
      f('record_code', 'Record', 'code'), f('description', 'Details', 'text', { groupable: false }), money('amount', 'Amount'),
      f('detected_on', 'Date', 'date', { column: 'detected_at', tz: true }),
    ],
    defaultColumns: ['severity', 'issue', 'province_code', 'record_code', 'description', 'amount', 'detected_on'],
    defaultSort: [{ field: 'severity', dir: 'asc' }, { field: 'issue', dir: 'asc' }],
  },
];

const BY_KEY = new Map(DATASETS.map((d) => [d.key, d]));
export const dataset = (key: string): DatasetDef | undefined => BY_KEY.get(key);
export const field = (d: DatasetDef, key: string): FieldDef | undefined => d.fields.find((x) => x.key === key);

// Identifiers reach SQL only from this file; refuse to load if one is not a plain identifier.
const IDENT = /^[a-z_][a-z0-9_]*$/;
for (const d of DATASETS) {
  if (!/^(api)\.[a-z_][a-z0-9_]*$/.test(d.view)) throw new Error(`bad view for ${d.key}`);
  for (const c of [...d.rowKey, d.provinceColumn, d.landClassColumn, d.recordedUnitColumn, ...Object.values(d.flags ?? {})])
    if (c !== undefined && !IDENT.test(c)) throw new Error(`bad column in ${d.key}: ${c}`);
  for (const x of d.fields) {
    if (!IDENT.test(x.key) || !IDENT.test(x.column) || (x.recordedColumn && !IDENT.test(x.recordedColumn))) throw new Error(`bad field ${d.key}.${x.key}`);
  }
}

/** The client-facing description of a dataset (no SQL internals). */
export function datasetInfo(d: DatasetDef): DatasetInfo {
  return {
    key: d.key, label: d.label, category: d.category, description: d.description, grain: d.grain,
    fields: d.fields.map(({ column: _c, recordedColumn: _r, tz: _t, ...fi }) => fi),
    defaultColumns: d.defaultColumns, defaultSort: d.defaultSort, drillDown: d.drillDown,
  };
}

/** May this caller run the dataset? reports:read plus every permission it needs. */
export function canReadDataset(d: DatasetDef, has: (r: string, a: string) => boolean): boolean {
  return has('reports', 'read') && d.needs.every(([r, a]) => has(r, a));
}

const cfg = (dataset: string, columns: string[], o: Partial<ReportConfig> = {}): ReportConfig => ({
  dataset, columns, filters: [], groupBy: [], sort: (BY_KEY.get(dataset)?.defaultSort ?? []) as SortSpec[], totals: true,
  uom: { mode: 'province' }, ...o,
});

/** Quick reports: ready-made configurations, including the reimplemented legacy reports r1–r15. */
export const QUICK_REPORTS: { key: string; label: string; category: DatasetInfo['category']; description: string; config: ReportConfig; legacyId?: string }[] = [
  { key: 'r1', legacyId: 'r1', label: 'Executive land portfolio by province', category: 'Executive',
    description: 'Land, approved compensation, paid (gross, WHT) and outstanding liability per province, each province in its own unit.',
    config: cfg('executive_province', ['province_code', 'province_name', 'active_projects', 'parcels', 'area', 'gov_area', 'approved_amount', 'paid_amount', 'wht_amount', 'outstanding_amount', 'overpaid_amount', 'unallocated_released_net']) },
  { key: 'r2', legacyId: 'r2', label: 'Project acquisition and registration status', category: 'Acquisition',
    description: 'Each project\'s parcels and land (each parcel once), acquired and leased area, cases pending and acquisitions in progress.',
    config: cfg('executive_project', ['project_code', 'project_name', 'province_code', 'project_status', 'parcels', 'area', 'acquired_area', 'leased_area', 'pending_cases', 'open_acquisitions']) },
  { key: 'r3', legacyId: 'r3', label: 'Land by project and land class', category: 'Land & ownership',
    description: 'Project land split by land class, with each class\'s share of the project\'s land.',
    config: cfg('project_parcels', ['project_code', 'land_class', 'area', 'pct_of_project'], { groupBy: ['project_code', 'land_class'], summaryOnly: true, aggregates: { pct_of_project: 'sum' } }) },
  { key: 'r4', legacyId: 'r4', label: 'Landowner and parcel register', category: 'Persons & CNIC',
    description: 'Owners, CNIC (masked unless you may see it), parcels, shares and owned area. Persons with no recorded share are listed in Persons and CNIC.',
    config: cfg('ownership', ['owner_code', 'owner_name', 'cnic', 'parcel_code', 'survey_no', 'village', 'share_pct', 'parcel_area', 'owned_area'], { totals: false }) },
  { key: 'r5', legacyId: 'r5', label: 'Compensation: assessed, approved, paid and outstanding', category: 'Compensation & payments',
    description: 'Every case with assessed (not yet approved), approved, adjustments, payable, paid gross / WHT / net and signed outstanding.',
    config: cfg('cases', ['case_code', 'project_name', 'province_code', 'stage_code', 'assessed_amount', 'approved_amount', 'adjustment_amount', 'payable_amount', 'paid_amount', 'wht_amount', 'paid_net_amount', 'outstanding_amount', 'settlement_status']) },
  { key: 'r6', legacyId: 'r6', label: 'Unpaid and partly paid approved cases', category: 'Compensation & payments',
    description: 'Approved cases with a balance still to pay, from the settlement ledger.',
    config: cfg('cases', ['case_code', 'project_name', 'province_code', 'payable_amount', 'paid_amount', 'wht_amount', 'paid_net_amount', 'outstanding_amount', 'settlement_status'],
      { filters: [{ field: 'settlement_status', op: 'in', value: ['Unpaid', 'Part paid'] }] }) },
  { key: 'r7', legacyId: 'r7', label: 'Government land rate fixation (DBPFC)', category: 'Acquisition',
    description: 'DBPFC estimates with estimated, fixed and applied rates and the annual amount.',
    config: cfg('dbpfc', ['dbpfc_code', 'project_name', 'district', 'area', 'estimated_rate', 'fixed_rate', 'applied_rate', 'annual_amount', 'meeting_date', 'stage_code']) },
  { key: 'r8', legacyId: 'r8', label: 'Lease register, expiry and renewal', category: 'Land & ownership',
    description: 'Leases by expiry with their canonical status (30/60/90/180-day bands), rent and renewals.',
    config: cfg('leases', ['lease_code', 'project_name', 'lessors', 'current_area', 'start_date', 'end_date', 'annual_rent', 'renewal_count', 'is_on_hold', 'lease_status'], { totals: false }) },
  { key: 'r9', legacyId: 'r9', label: 'Project financial exposure and reconciliation', category: 'Executive',
    description: 'Per project: payable, paid (gross, WHT), outstanding, over-paid and a reconciliation status that only says Balanced when it is.',
    config: cfg('executive_project', ['project_code', 'project_name', 'province_code', 'payable_amount', 'paid_amount', 'wht_amount', 'outstanding_amount', 'overpaid_amount', 'net_outstanding_amount', 'reconciliation_status'],
      { sort: [{ field: 'payable_amount', dir: 'desc' }, { field: 'project_code', dir: 'asc' }] }) },
  { key: 'r10', legacyId: 'r10', label: 'Unreleased voucher aging', category: 'Compensation & payments',
    description: 'Vouchers requested or verified but not released, by days pending and hold status. Case approval aging is in Compensation cases (days at stage).',
    config: cfg('vouchers', ['voucher_code', 'project_name', 'payee_name', 'category_code', 'net_amount', 'aging_bracket', 'days_pending', 'on_hold', 'hold_reason'],
      { filters: [{ field: 'stage_code', op: 'in', value: ['Requested', 'Verified'] }], sort: [{ field: 'days_pending', dir: 'desc' }] }) },
  { key: 'r11', legacyId: 'r11', label: 'Units of measure and conversion factors', category: 'Land & ownership',
    description: 'The factor in force for every unit, whether it is confirmed, and which provinces use it (from lms.province_unit).',
    config: cfg('units', ['unit_code', 'unit_name', 'sqm_per_unit', 'units_per_acre', 'acres_per_unit', 'is_confirmed', 'source_ref', 'provinces', 'provinces_confirmed'], { totals: false }) },
  { key: 'r12', legacyId: 'r12', label: 'Data-quality exceptions', category: 'Executive',
    description: 'Every data-quality rule: share discrepancies, over-committed parcels, over-payments, unallocated releases, allocation errors, missing receipts, unlinked parcels, likely duplicates.',
    config: cfg('exceptions', ['severity', 'issue', 'province_code', 'record_code', 'description', 'amount', 'detected_on'],
      { filters: [{ field: 'severity', op: 'in', value: ['error', 'warning'] }], groupBy: ['issue'] }) },
  { key: 'r13', legacyId: 'r13', label: 'GIS coverage by project', category: 'Land & ownership',
    description: 'Linked parcels per project and how many have a mapped polygon of that project.',
    config: cfg('gis_coverage', ['project_code', 'project_name', 'province_code', 'total_surveys', 'mapped_features', 'unmapped_surveys', 'coverage_percentage']) },
  { key: 'r14', legacyId: 'r14', label: 'Disbursements by release month', category: 'Compensation & payments',
    description: 'Released (unreversed) vouchers by the month of the cheque, with gross, WHT and net.',
    config: cfg('vouchers', ['release_month', 'gross_amount', 'wht_amount', 'net_amount'],
      { filters: [{ field: 'is_released', op: 'eq', value: true }], groupBy: ['release_month'], summaryOnly: true, sort: [{ field: 'release_month', dir: 'desc' }] }) },
  { key: 'r15', legacyId: 'r15', label: 'Exceptions needing management intervention', category: 'Executive',
    description: 'Stay orders in force, payment holds, open grievances and the error-level exceptions.',
    config: cfg('exceptions', ['severity', 'issue', 'province_code', 'record_code', 'description', 'amount', 'detected_on'],
      { filters: [{ field: 'severity', op: 'in', value: ['intervention', 'error'] }], groupBy: ['issue'] }) },
  { key: 'outstanding_by_province', label: 'Outstanding liability by province', category: 'Compensation & payments',
    description: 'Approved cases grouped by province with payable, paid and outstanding subtotals.',
    config: cfg('cases', ['province_code', 'case_code', 'project_name', 'payable_amount', 'paid_amount', 'wht_amount', 'outstanding_amount', 'settlement_status'],
      { filters: [{ field: 'stage_code', op: 'eq', value: 'HO Approved' }], groupBy: ['province_code'] }) },
  { key: 'persons_register', label: 'Persons and CNIC register', category: 'Persons & CNIC',
    description: 'Every person with land owned, cases, attributed award, paid and outstanding.',
    config: cfg('persons', ['owner_code', 'full_name', 'cnic', 'province_code', 'parcel_count', 'owned_area', 'case_count', 'payable_amount', 'paid_amount', 'outstanding_amount']) },
  { key: 'payment_history', label: 'Payment history by owner', category: 'Compensation & payments',
    description: 'Every allocation of every voucher to a case and owner, with what it settles (gross) and the cheque.',
    config: cfg('allocations', ['voucher_code', 'case_code', 'owner_code', 'owner_name', 'allocated_net', 'settled_gross', 'wht_share', 'is_paid', 'is_reversed', 'cheque_date']) },
  { key: 'acquisition_progress', label: 'Acquisition progress by province', category: 'Acquisition',
    description: 'Acquisitions grouped by province and status, with the area required.',
    config: cfg('acquisitions', ['province_code', 'acquisition_status', 'acquisition_code', 'project_name', 'mode', 'stage_code', 'area_required', 'days_at_stage'],
      { groupBy: ['province_code', 'acquisition_status'] }) },
];

/** Legacy reports with no engine equivalent. Empty: r1–r15 are all reimplemented above. */
export const RETIRED: { legacyId: string; label: string; reason: string }[] = [];

/** Row caps per export format; beyond them the export is refused with a clear message. */
export const EXPORT_LIMITS = { csv: 100_000, xlsx: 50_000, pdf: 5_000, html: 5_000 } as const;
export const SCREEN_MAX_PAGE = 500;
