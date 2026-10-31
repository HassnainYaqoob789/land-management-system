import { json, protect } from '@/lib/iam/http';
import { canReadDataset, DATASETS, datasetInfo, EXPORT_LIMITS, QUICK_REPORTS, RETIRED } from '@/lib/reporting/catalog';
import type { CatalogResult } from '@/lib/reporting/types';

// The report catalogue for the caller: only the datasets (and quick reports)
// they may run, the units with their confirmation status, the provincial
// reporting units, and what they may do with a report.
export const GET = protect({ permission: ['reports', 'read'] }, async (ctx) => {
  const datasets = DATASETS.filter((d) => canReadDataset(d, ctx.has));
  const allowed = new Set(datasets.map((d) => d.key));
  const units = (await ctx.client.query(
    `SELECT mu.code, mu.name, coalesce(uc.is_confirmed, false) AS confirmed
       FROM lms.measurement_unit mu
       JOIN lms.unit_conversion uc ON uc.unit_code = mu.code AND uc.valid_range @> CURRENT_DATE
      WHERE mu.is_area ORDER BY mu.display_order`)).rows;
  const provinceUnits = (await ctx.client.query(
    `SELECT province_code::text AS province, land_class AS "landClass", unit_code AS unit, approved
       FROM lms.report_unit_default
      WHERE province_code::text = ANY($1::text[]) OR $2::boolean
      ORDER BY province_code, land_class NULLS FIRST`, [ctx.provinces, ctx.provinces.length === 0])).rows;
  const body: CatalogResult = {
    datasets: datasets.map(datasetInfo),
    units,
    provinceUnits,
    quickReports: QUICK_REPORTS.filter((q) => allowed.has(q.config.dataset)),
    retired: RETIRED,
    exportLimits: EXPORT_LIMITS,
    can: {
      export: ctx.has('reports', 'export'),
      share: ctx.has('reports', 'share'),
      seePii: ctx.has('pii', 'read'),
      manageUnits: ctx.has('settings', 'update'),
    },
  };
  return json(body);
});
