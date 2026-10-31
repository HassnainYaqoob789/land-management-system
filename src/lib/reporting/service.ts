// What every report route does the same way: validate the config, check the
// caller may read the dataset, audit the run or export (never PII values),
// and turn engine errors into clear 400 / 403 responses.
import { randomBytes } from 'node:crypto';
import { HttpError, json, logDenied, toResponse, type Ctx } from '../iam/http';
import { logEvent } from '../iam/login';
import { clientIp, userAgent } from '../iam/session';
import { canReadDataset, field, type DatasetDef } from './catalog';
import { ReportTooLargeError } from './run';
import type { ReportResult } from './types';
import { ReportConfigError, validateConfig, type ValidConfig } from './validate';

/** Validate a config and check the caller may run its dataset (403, audited, if not). */
export async function prepareRun(ctx: Ctx, raw: unknown): Promise<{ def: DatasetDef; config: ValidConfig }> {
  const { def, config } = validateConfig(raw, { canSeePii: ctx.has('pii', 'read') });
  if (!canReadDataset(def, ctx.has)) {
    await logDenied(ctx.session, ctx.req, 'missing_permission', ctx.correlationId, { dataset: def.key, permission: def.needs.map((n) => n.join(':')).join(',') });
    throw new HttpError(403, `You do not have permission to run the ${def.label} report.`, 'forbidden');
  }
  return { def, config };
}

// Values of free-text and CNIC filters are not written to the audit trail.
const LOGGED_TYPES = new Set(['enum', 'date', 'boolean', 'integer', 'number', 'money', 'area', 'percent', 'code']);

export function auditMeta(def: DatasetDef, cfg: ValidConfig, result?: ReportResult, extra: Record<string, unknown> = {}) {
  return {
    dataset: def.key,
    columns: cfg.columns,
    filters: cfg.filters.map((f) => {
      const fd = field(def, f.field);
      return { field: f.field, op: f.op, ...(fd && LOGGED_TYPES.has(fd.type) ? { value: f.value } : { value_withheld: true }), ...(f.unit ? { unit: f.unit } : {}) };
    }),
    group_by: cfg.groupBy,
    uom: cfg.uom,
    ...(result ? { rows: result.page.total, page_offset: result.page.offset, pii_unmasked: result.columns.some((c) => c.sensitive) && !result.meta.piiMasked } : {}),
    ...extra,
  };
}

export async function audit(ctx: Ctx, type: 'report_run' | 'report_export', outcome: 'success' | 'denied' | 'failure', meta: object) {
  await logEvent(type, outcome, {
    userId: ctx.user.id, username: ctx.user.username, actor: ctx.user.id, ip: clientIp(ctx.req), ua: userAgent(ctx.req),
    session: ctx.session.sessionId, corr: ctx.correlationId, meta,
  });
}

/** A human-quotable report reference, e.g. RPT-20261030-1405-3f9a. */
export function reportReference(now = new Date()): string {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(now).reduce<Record<string, string>>((a, x) => ((a[x.type] = x.value), a), {});
  return `RPT-${p.year}${p.month}${p.day}-${p.hour}${p.minute}-${randomBytes(2).toString('hex')}`;
}

/** Engine errors as responses; anything else goes to the shared translator. */
export function reportError(e: unknown, correlationId: string) {
  if (e instanceof ReportConfigError) return json({ error: e.message, code: 'invalid_config', field: e.field, correlationId }, 400);
  if (e instanceof ReportTooLargeError) return json({ error: e.message, code: 'export_too_large', rows: e.rows, limit: e.limit, correlationId }, 400);
  return toResponse(e, correlationId);
}
