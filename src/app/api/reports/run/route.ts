import { json, protect, readJson } from '@/lib/iam/http';
import { runReport } from '@/lib/reporting/run';
import { audit, auditMeta, prepareRun, reportError } from '@/lib/reporting/service';

// Runs one page of a report. Body: { config: ReportConfig, title? }.
// A run over personal or financial data is written to the audit trail
// (dataset, columns, filters without free-text or CNIC values, unit mode, rows).
export const POST = protect({ permission: ['reports', 'read'] }, async (ctx) => {
  try {
    const body = await readJson(ctx.req);
    const { def, config } = await prepareRun(ctx, body.config);
    const title = typeof body.title === 'string' ? body.title.trim().slice(0, 120) : undefined;
    const result = await runReport(ctx, def, config, { paged: true, title });
    if (def.personal || def.financial) await audit(ctx, 'report_run', 'success', auditMeta(def, config, result));
    return json(result);
  } catch (e) {
    return reportError(e, ctx.correlationId);
  }
});
