import { json, logDenied, protect, type Ctx } from '@/lib/iam/http';
import { dataset, EXPORT_LIMITS, field, QUICK_REPORTS } from '@/lib/reporting/catalog';
import { exportFileName, MIME, renderExport, textTable } from '@/lib/reporting/render';
import { runReport } from '@/lib/reporting/run';
import { audit, auditMeta, prepareRun, reportError, reportReference } from '@/lib/reporting/service';
import type { ExportFormat, FilterSpec, ReportConfig } from '@/lib/reporting/types';
import { ReportConfigError } from '@/lib/reporting/validate';

// The legacy reports r1–r15, now quick reports on the reporting engine
// (src/lib/reporting/catalog.ts QUICK_REPORTS) returned in the old JSON shape:
// { report_id, title, description, cols, rows, foot, note, total_rows,
//   truncated, reporting_unit, timestamp } plus flags and filters_applied.
// Each one was rebuilt because the old SQL was wrong (RPT-01..RPT-35): the
// engine attributes money and area at one row per entity, applies every
// filter it is given in SQL and refuses one it cannot apply, keeps each
// province in its unit unless ?unit= converts, never clamps a balance, and
// masks CNICs. ?format=csv|xlsx|pdf|html exports (reports:export, audited).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const FORMATS: ExportFormat[] = ['csv', 'xlsx', 'pdf', 'html'];
// Which date a from/to range means for each dataset.
const PERIOD_FIELD: Record<string, string> = {
  cases: 'case_date', case_owners: '', vouchers: 'cheque_date', allocations: 'cheque_date', leases: 'end_date',
  acquisitions: 'created_on', ownership: 'effective_from', parcels: 'created_on', persons: 'created_on', exceptions: 'detected_on',
  dbpfc: 'meeting_date', project_parcels: '', executive_province: '', executive_project: '', units: '', gis_coverage: '',
};

async function legacyConfig(ctx: Ctx, base: ReportConfig, sp: URLSearchParams): Promise<ReportConfig> {
  const def = dataset(base.dataset)!;
  const filters: FilterSpec[] = [...base.filters];
  const need = (param: string, key: string) => {
    if (!field(def, key)) throw new ReportConfigError(param, `The ${def.label} report cannot be filtered by ${param.replace('_', ' ')}.`);
  };
  const province = (sp.get('province') || '').toUpperCase();
  if (province && province !== 'ALL') { need('province', 'province_code'); filters.push({ field: 'province_code', op: 'eq', value: province }); }
  const landClass = sp.get('land_class');
  if (landClass) { need('land_class', 'land_class'); filters.push({ field: 'land_class', op: 'eq', value: landClass }); }
  const status = sp.get('status');
  if (status) { need('status', 'stage_code'); filters.push({ field: 'stage_code', op: 'eq', value: status }); }
  const project = sp.get('project');
  if (project) {
    if (!UUID.test(project)) throw new ReportConfigError('project', 'project must be a project id');
    need('project', 'project_code');
    const code = (await ctx.client.query('SELECT code::text AS code FROM lms.project WHERE id = $1', [project])).rows[0]?.code;
    filters.push({ field: 'project_code', op: 'eq', value: code ?? '(no such project)' });
  }
  const landowner = sp.get('landowner');
  if (landowner) {
    if (!UUID.test(landowner)) throw new ReportConfigError('landowner', 'landowner must be a landowner id');
    const key = field(def, 'owner_code') ? 'owner_code' : field(def, 'payee_code') ? 'payee_code' : null;
    if (!key) throw new ReportConfigError('landowner', `The ${def.label} report cannot be filtered by landowner.`);
    const code = (await ctx.client.query('SELECT code::text AS code FROM lms.landowner WHERE id = $1', [landowner])).rows[0]?.code;
    filters.push({ field: key, op: 'eq', value: code ?? '(no such landowner)' });
  }
  const from = sp.get('from'), to = sp.get('to');
  if (from || to) {
    const pf = PERIOD_FIELD[def.key];
    if (!pf) throw new ReportConfigError('from', `The ${def.label} report has no date to filter by.`);
    if ((from && !DATE.test(from)) || (to && !DATE.test(to))) throw new ReportConfigError('from', 'from and to are dates as YYYY-MM-DD');
    if (from) filters.push({ field: pf, op: 'gte', value: from });
    if (to) filters.push({ field: pf, op: 'lte', value: to });
  }
  const unit = sp.get('unit');
  return { ...base, filters, uom: unit ? { mode: 'common', unit } : { mode: 'province' }, page: { limit: 500, offset: 0 } };
}

export const GET = protect({ permission: ['reports', 'read'] }, async (ctx) => {
  try {
    const sp = new URL(ctx.req.url).searchParams;
    const reportId = sp.get('report') || 'r1';
    const q = QUICK_REPORTS.find((x) => x.legacyId === reportId);
    if (!q) return json({ error: 'Unknown report identifier', code: 'not_found', correlationId: ctx.correlationId }, 404);
    const format = (sp.get('format') || 'json').toLowerCase();
    const isExport = FORMATS.includes(format as ExportFormat);
    if (!isExport && format !== 'json') return json({ error: 'format must be json, csv, xlsx, pdf or html', code: 'invalid_config', field: 'format', correlationId: ctx.correlationId }, 400);
    if (isExport && !ctx.has('reports', 'export')) {
      await logDenied(ctx.session, ctx.req, 'missing_permission', ctx.correlationId, { permission: 'reports:export', report: reportId, format });
      await audit(ctx, 'report_export', 'denied', { dataset: q.config.dataset, legacy_report: reportId, format });
      return json({ error: 'You are not permitted to export reports', code: 'forbidden', correlationId: ctx.correlationId }, 403);
    }
    const { def, config } = await prepareRun(ctx, await legacyConfig(ctx, q.config, sp));

    if (isExport) {
      const fmt = format as ExportFormat;
      const result = await runReport(ctx, def, config, { paged: false, maxRows: EXPORT_LIMITS[fmt], format: fmt, title: q.label });
      const header = { title: q.label, reference: reportReference(), generatedBy: ctx.user.fullName || ctx.user.username, generatedAt: new Date() };
      const file = await renderExport(fmt, result, header);
      await audit(ctx, 'report_export', 'success', auditMeta(def, config, result, { format: fmt, legacy_report: reportId, reference: header.reference }));
      return new Response(new Uint8Array(file), {
        headers: { 'Content-Type': MIME[fmt], 'Content-Disposition': `attachment; filename="${exportFileName(`${reportId} ${q.label}`, header.reference, fmt)}"`,
          'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
      });
    }

    const result = await runReport(ctx, def, config, { paged: true, title: q.label });
    if (def.personal || def.financial) await audit(ctx, 'report_run', 'success', auditMeta(def, config, result, { legacy_report: reportId }));
    const t = textTable(result);
    const bodyRows = t.rows.filter((_, i) => t.kinds[i] !== 'total');
    const footIdx = t.kinds.indexOf('total');
    return json({
      report_id: reportId,
      title: q.label,
      description: q.description,
      cols: t.headers,
      rows: bodyRows,
      foot: footIdx >= 0 ? t.rows[footIdx] : null,
      note: [result.meta.mixedUnits ? 'Areas are in different units by province, so there is no grand total of area.' : '',
        ...Object.entries(result.flags).map(([k, n]) => `${n} record(s): ${result.meta.flagText?.[k] ?? k}`)].filter(Boolean).join(' '),
      total_rows: result.page.total,
      truncated: result.page.total > result.page.limit,
      reporting_unit: result.meta.uom.mode === 'common' ? result.meta.uom.unit : 'Province reporting units',
      filters_applied: result.meta.filtersApplied,
      flags: result.flags,
      timestamp: result.meta.generatedAt,
      client: 'Mari Energies Limited',
    });
  } catch (e) {
    return reportError(e, ctx.correlationId);
  }
});
