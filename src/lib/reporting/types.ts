// The reporting contract shared by the engine (server), the API and the
// reports screen. Nothing here is executable; it is the shape of what moves
// between them. See docs/REPORTING_MODEL.md for the rules behind it.

export type FieldType = 'text' | 'code' | 'cnic' | 'enum' | 'integer' | 'number' | 'money' | 'area' | 'percent' | 'date' | 'boolean';
export type FilterOp = 'eq' | 'neq' | 'in' | 'contains' | 'starts' | 'gte' | 'lte' | 'between' | 'is_null' | 'not_null';
export type Aggregate = 'sum' | 'count' | 'avg' | 'min' | 'max';
export type UomMode = 'province' | 'common' | 'original';
export type ExportFormat = 'pdf' | 'xlsx' | 'csv' | 'html';

/** One column a dataset offers. Keys are stable identifiers; never SQL. */
export interface FieldInfo {
  key: string;
  label: string;
  type: FieldType;
  /** Operators the filter builder may offer for this field. */
  ops: FilterOp[];
  groupable: boolean;
  sortable: boolean;
  /** Aggregates allowed in subtotals and grouped summaries. */
  aggregates: Aggregate[];
  /** Choices for enum fields (e.g. workflow stages, provinces). */
  options?: { value: string; label: string }[];
  /** Personal data: masked unless the viewer holds pii:read. */
  sensitive?: boolean;
  /** Land quantity: shown in the report's unit mode, with its unit. */
  unitAware?: boolean;
  description?: string;
}

export interface DatasetInfo {
  key: string;
  label: string;
  category: 'Land & ownership' | 'Persons & CNIC' | 'Acquisition' | 'Compensation & payments' | 'Executive';
  description: string;
  /** What one row is, e.g. "one row per compensation case". */
  grain: string;
  fields: FieldInfo[];
  defaultColumns: string[];
  defaultSort: SortSpec[];
  /** Field keys that link a row to its source record, when the viewer may open it. */
  drillDown?: { label: string; href: string };
}

export interface FilterSpec {
  field: string; op: FilterOp; value?: unknown;
  /** Unit of an area filter value (default: the report's common unit, else acres). */
  unit?: string;
}
export interface SortSpec { field: string; dir: 'asc' | 'desc' }

export interface ReportConfig {
  dataset: string;
  columns: string[];
  filters: FilterSpec[];
  /** Up to three groupable fields; groups are subtotalled in order. */
  groupBy: string[];
  sort: SortSpec[];
  /** Include subtotal rows per group level and the grand total. */
  totals: boolean;
  /** Collapse to one row per group (aggregates only, no detail rows). */
  summaryOnly?: boolean;
  uom: { mode: UomMode; unit?: string };
  page?: { limit: number; offset: number };
  /** Aggregate per column in subtotal/total rows (default: the field's first allowed aggregate). */
  aggregates?: Record<string, Aggregate>;
}

export interface ColumnOut {
  key: string; label: string; type: FieldType;
  /** The unit of an area column when every row shares one (common mode); otherwise each row carries its own. */
  unit?: string;
  /** Aggregate shown for this column in subtotal and total rows, if any. */
  aggregate?: Aggregate;
  sensitive?: boolean;
}

export interface RowOut {
  /** 'detail' rows are records; 'subtotal' rows close a group (level 0 = outermost); 'total' is the grand total. */
  kind: 'detail' | 'subtotal' | 'total';
  level?: number;
  cells: Record<string, string | number | boolean | null>;
  /** Unit of every unit-aware cell in this row (province mode can differ per row). */
  unit?: string | null;
  /** Per-row data-quality flags (see FLAG_TEXT). */
  flags?: string[];
  /** Link to the source record when the viewer may open it. */
  href?: string | null;
}

export interface ReportResult {
  columns: ColumnOut[];
  rows: RowOut[];
  page: { limit: number; offset: number; total: number };
  /** Counts of flagged rows across the whole result (not just this page). */
  flags: Record<string, number>;
  /** Totals of the whole result per unit (province/original mode can mix units; there is no grand total across units). */
  unitTotals?: { unit: string; rows: number; cells: Record<string, string | number | boolean | null> }[];
  meta: {
    dataset: string; title: string; grain: string;
    uom: { mode: UomMode; unit?: string; provinceUnits?: { province: string; landClass: string | null; unit: string; approved: boolean }[] };
    filtersApplied: string[]; scope: string; generatedAt: string; piiMasked: boolean;
    definitions: string[];
    /** Plain-language explanation of each flag present in the result. */
    flagText?: Record<string, string>;
    /** When a grand total is withheld because rows are in different units. */
    mixedUnits?: boolean;
    reference?: string;
  };
}

export interface CatalogResult {
  datasets: DatasetInfo[];
  units: { code: string; name: string; confirmed: boolean }[];
  provinceUnits: { province: string; landClass: string | null; unit: string; approved: boolean }[];
  quickReports: { key: string; label: string; category: DatasetInfo['category']; description: string; config: ReportConfig; legacyId?: string }[];
  /** Legacy reports r1–r15 that were retired, and why. */
  retired?: { legacyId: string; label: string; reason: string }[];
  exportLimits?: Record<ExportFormat, number>;
  can: { export: boolean; share: boolean; seePii: boolean; manageUnits: boolean };
}

export interface TemplateInfo {
  id: string; name: string; description: string | null; dataset: string; config: ReportConfig;
  visibility: 'private' | 'shared'; sharedDepartment: string | null; isDefault: boolean; exportFormat: ExportFormat | null;
  owner: string; mine: boolean; updatedAt: string;
}

export const FLAG_TEXT: Record<string, string> = {
  provisional_factor: 'Converted with a provisional factor (awaiting Land Department confirmation)',
  unsupported_unit: 'Unit has no conversion factor; quantity not converted',
  missing_area: 'Area not recorded',
  recorded_unit_unknown: 'Unit as originally recorded was not kept; stored in acres (the primary unit)',
  province_unit_unapproved: 'Province reporting unit is a proposed default, not yet approved',
  shares_not_100: 'Ownership shares do not total 100%',
  unattributed_payment: 'Payment allocated to the case but not to a specific owner',
  overpaid: 'Paid exceeds the approved amount',
  unallocated_payment: 'Voucher not fully allocated to cases',
  area_over_committed: 'Area committed to live cases in force exceeds the parcel area',
  recorded_provisional: 'Stored acres were derived from the recorded unit with a provisional factor',
  no_shares: 'No ownership share is recorded for this person',
  possible_duplicate: 'Another person has the same name and father\'s name (possible duplicate)',
  mixed_units: 'Rows in this group are in different units; see the per-unit subtotals',
};
