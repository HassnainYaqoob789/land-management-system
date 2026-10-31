import { json, logDenied, protect, readJson } from '@/lib/iam/http';
import { EXPORT_LIMITS } from '@/lib/reporting/catalog';
import { exportFileName, MIME, renderExport } from '@/lib/reporting/render';
import { runReport } from '@/lib/reporting/run';
import { audit, auditMeta, prepareRun, reportError, reportReference } from '@/lib/reporting/service';
import type { ExportFormat } from '@/lib/reporting/types';

const FORMATS: ExportFormat[] = ['pdf', 'xlsx', 'csv', 'html'];

// Exports a whole report (the same compiled query as the screen, unpaged, up
// to the format's row cap) as PDF, Excel, CSV or a print-ready HTML page.
// Body: { config, format, title?, disposition?: 'inline' (html only) }.
// Needs reports:export; refusals and exports are audited.
export const POST = protect({ permission: ['reports', 'read'] }, async (ctx) => {
  try {
    const body = await readJson(ctx.req);
    const format = body.format as ExportFormat;
    if (!FORMATS.includes(format)) return json({ error: 'format must be pdf, xlsx, csv or html', code: 'invalid_config', field: 'format', correlationId: ctx.correlationId }, 400);
    if (!ctx.has('reports', 'export')) {
      const dataset = typeof body.config?.dataset === 'string' ? String(body.config.dataset).slice(0, 40) : null;
      await logDenied(ctx.session, ctx.req, 'missing_permission', ctx.correlationId, { permission: 'reports:export', dataset, format });
      await audit(ctx, 'report_export', 'denied', { dataset, format });
      return json({ error: 'You do not have permission to export reports.', code: 'forbidden', correlationId: ctx.correlationId }, 403);
    }
    const { def, config } = await prepareRun(ctx, body.config);
    const title = (typeof body.title === 'string' && body.title.trim() ? body.title.trim() : def.label).slice(0, 120);
    const result = await runReport(ctx, def, config, { paged: false, maxRows: EXPORT_LIMITS[format], format, title });
    const header = { title, reference: reportReference(), generatedBy: ctx.user.fullName || ctx.user.username, generatedAt: new Date() };
    const file = await renderExport(format, result, header);
    await audit(ctx, 'report_export', 'success', auditMeta(def, config, result, { format, reference: header.reference, bytes: file.length }));
    const inline = format === 'html' && body.disposition === 'inline';
    return new Response(new Uint8Array(file), {
      headers: {
        'Content-Type': MIME[format],
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${exportFileName(title, header.reference, format)}"`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Report-Reference': header.reference,
        'X-Report-Rows': String(result.page.total),
      },
    });
  } catch (e) {
    return reportError(e, ctx.correlationId);
  }
});
