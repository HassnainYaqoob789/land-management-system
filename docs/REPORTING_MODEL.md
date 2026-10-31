# Reporting model

The reporting module turns validated report *configurations* into
parameterised SQL over a fixed catalogue of *datasets*. No user-supplied SQL,
field name or expression ever reaches the database: every field, operator,
grouping and sort key is looked up in the catalogue and rejected if absent.

## 1. Authoritative sources

| Figure | Source | Notes |
|:---|:---|:---|
| Land area | `lms.survey.total_area` (acres, the primary unit) | `recorded_area`/`recorded_unit` keep the unit a surveyor used (from 0040; older rows have none) |
| Owned area | `total_area × survey_ownership_share.share_pct / 100` | per owner per parcel |
| Lease area | `lms.case_lease_line.lease_area` (acres), `lms.lease.initial_area`/`subsequent_area` (acres) | |
| Unit factors | `lms.unit_conversion` (m² per unit, validity, `is_confirmed`) | the only source; `lms.uom_convert`, `lms.convert_area` read it |
| Province reporting unit | `lms.report_unit_default` (province, optional land class) via `lms.report_unit()` | proposals until `approved` |
| Ownership | `lms.survey_ownership_share` | shares per parcel total 100% (deferred trigger) |
| Person | `lms.landowner` (CNIC is unique and mandatory) | |
| Acquisition status | `lms.acquisition.stage_code` (workflow), `lms.survey.status_code` | never a report label |
| Assessed compensation | `lms.compensation_case.total_amount` while the case is not `HO Approved` or `Cancelled` | computed by the database from the case lines |
| Approved compensation | `total_amount` of `HO Approved` cases | |
| Attributed to an owner | approved × `case_owner.share_pct / 100` | |
| Allocated | `lms.payment_allocation.amount` on vouchers not `Cancelled`/`Stopped` | a voucher can be split across cases and owners |
| Paid (disbursed) | allocations whose voucher has a `payment_release` | gross of withholding tax |
| Withholding tax | `payment_request.wht_amount` (deduction from gross) | |
| Net paid to payee | `payment_request.net_amount` of released vouchers | |
| Outstanding | approved − paid (per case: `lms.case_settlement_totals`) | |
| Holds | `lms.payment_hold` with `lifted_at IS NULL` | |

Reversals and adjustments: the schema has none. A voucher can be cancelled or
stopped *before* release (and then counts nowhere); a released voucher cannot
be reversed. Reports state this rather than inventing a reversal figure.

Double counting is prevented by grain: each dataset has one row per entity
(parcel, ownership share, person, case, case-owner, voucher, allocation,
acquisition) and money is attributed at that grain, never by joining a
one-to-many relation and summing the parent's total.

## 2. Units of measure

- **Province mode** (default for one province): each row is shown in the
  unit of its province (and land class, if a land-class row exists).
- **Consolidated without a common unit**: each row keeps its province unit,
  the unit is printed beside every quantity, subtotals are per unit, and there
  is no grand total across different units.
- **Common unit** ("Convert to"): every eligible quantity is converted with
  the factors in `lms.unit_conversion`; grand totals are valid.
- **Original**: the recorded area and unit where kept; otherwise the stored
  acres, flagged "unit as recorded not kept".
- **Flags** (per row and counted in the footer): `provisional factor`
  (Jireb, Bigha are unconfirmed), `unit not supported`, `area missing`,
  `recorded unit not kept`, `province unit not yet approved`.
- Conversion is exact `numeric`; rounding happens only when formatting.

## 3. Engine contract (`src/lib/reporting`)

```ts
type ReportConfig = {
  dataset: string;                       // catalogue key
  columns: string[];                     // field keys, in display order
  filters: { field: string; op: 'eq'|'neq'|'in'|'contains'|'starts'|'gte'|'lte'|'between'|'is_null'|'not_null'; value?: unknown }[];
  groupBy: string[];                     // up to 3 groupable field keys
  sort: { field: string; dir: 'asc'|'desc' }[];
  totals: boolean;                       // subtotals per group level + grand total
  uom: { mode: 'province'|'common'|'original'; unit?: string };
  page?: { limit: number; offset: number };
};
```

`POST /api/reports/run` → `{ columns:[{key,label,type,unit?}], rows, groups,
totals:{ grand, byUnit }, flags:{ key:count }, page, meta:{ dataset, uom,
generatedAt, scope, filtersApplied } }`.

Exports (`POST /api/reports/export {config, format:'pdf'|'xlsx'|'csv'|'html'}`)
run the same compiled query without paging (up to a row limit; larger
requests become an export job). They carry the Mari Energies logo,
organisation and department, title, reference, generation time, reporting
period, scope, applied filters, unit mode, page numbers, repeated table
headers, totals and a confidentiality footer.

## 4. Access

- Running a report needs `reports:read` **and** the read permission of every
  dataset it touches (e.g. the payments dataset needs `payments:read`).
- Rows are limited by row-level security to the user's provinces.
- `pii:read` decides whether CNIC, phone, IBAN and address are returned in
  full; without it they are masked in the screen and in every export.
- Exporting needs `reports:export`. Every run of a dataset with personal or
  financial data, and every export, is written to `audit.auth_event`
  (`report_run`, `report_export`).
- Templates: private to their owner; sharing needs `reports:share`
  (optionally limited to a department). Template changes are audited.
