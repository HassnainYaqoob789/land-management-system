import { HttpError, json, protect, readJson, str, type Ctx } from '@/lib/iam/http';
import { canReadDataset, dataset } from '@/lib/reporting/catalog';
import { prepareRun, reportError } from '@/lib/reporting/service';
import type { ExportFormat, TemplateInfo } from '@/lib/reporting/types';

// Saved report configurations (lms.report_template). Row-level security
// decides who sees, edits and deletes a template (own, shared, department);
// sharing needs reports:share, checked here first for a clear message.
// Template changes are written to the audit trail by the table's trigger.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FORMATS: ExportFormat[] = ['pdf', 'xlsx', 'csv', 'html'];

function toInfo(r: any): TemplateInfo {
  return {
    id: r.id, name: r.name, description: r.description, dataset: r.dataset, config: r.config,
    visibility: r.visibility, sharedDepartment: r.shared_department, isDefault: r.is_default,
    exportFormat: r.export_format, owner: r.owner_name ?? '', mine: r.mine, updatedAt: r.updated_at,
  };
}

const SELECT = `SELECT t.id, t.name, t.description, t.dataset, t.config, t.visibility, t.shared_department, t.is_default,
                       t.export_format, lms.user_full_name(t.owner_id) AS owner_name, (t.owner_id = $1) AS mine, t.updated_at
                FROM lms.report_template t`;

async function body(ctx: Ctx) {
  const b = await readJson(ctx.req, 40_000);
  const name = str(b, 'name', { max: 120 }).trim();
  if (!name) throw new HttpError(400, 'name is required.', 'validation');
  const description = str(b, 'description', { max: 500, optional: true }).trim() || null;
  const { def, config } = await prepareRun(ctx, b.config);
  const { page: _page, ...stored } = config;   // a template keeps the report, not the page being viewed
  const visibility = b.visibility === undefined ? 'private' : b.visibility;
  if (visibility !== 'private' && visibility !== 'shared') throw new HttpError(400, 'visibility must be private or shared.', 'validation');
  if (visibility === 'shared' && !ctx.has('reports', 'share')) throw new HttpError(403, 'Sharing a report template needs the reports:share permission.', 'forbidden');
  const sharedDepartment = visibility === 'shared' ? (str(b, 'sharedDepartment', { max: 120, optional: true }).trim() || null) : null;
  if (b.isDefault !== undefined && typeof b.isDefault !== 'boolean') throw new HttpError(400, 'isDefault must be true or false.', 'validation');
  const exportFormat = b.exportFormat === undefined || b.exportFormat === null ? null : b.exportFormat;
  if (exportFormat !== null && !FORMATS.includes(exportFormat)) throw new HttpError(400, 'exportFormat must be pdf, xlsx, csv or html.', 'validation');
  return { name, description, dataset: def.key, config: stored, visibility, sharedDepartment, isDefault: b.isDefault === true, exportFormat };
}

function idParam(ctx: Ctx): string {
  const id = new URL(ctx.req.url).searchParams.get('id') ?? '';
  if (!UUID.test(id)) throw new HttpError(404, 'No such template.', 'not_found');
  return id;
}

export const GET = protect({ permission: ['reports', 'read'] }, async (ctx) => {
  const ds = new URL(ctx.req.url).searchParams.get('dataset');
  const rows = (await ctx.client.query(`${SELECT} WHERE ($2::text IS NULL OR t.dataset = $2) ORDER BY t.updated_at DESC LIMIT 500`,
    [ctx.user.id, ds && /^[a-z_]{2,40}$/.test(ds) ? ds : null])).rows;
  // Only templates for datasets the caller may run.
  return json(rows.filter((r) => { const d = dataset(r.dataset); return d && canReadDataset(d, ctx.has); }).map(toInfo));
});

export const POST = protect({ permission: ['reports', 'read'] }, async (ctx) => {
  try {
    const t = await body(ctx);
    if (t.isDefault) await ctx.client.query(`UPDATE lms.report_template SET is_default = false WHERE owner_id = $1 AND dataset = $2 AND is_default`, [ctx.user.id, t.dataset]);
    const r = await ctx.client.query(
      `INSERT INTO lms.report_template (name, description, dataset, config, owner_id, visibility, shared_department, is_default, export_format)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [t.name, t.description, t.dataset, JSON.stringify(t.config), ctx.user.id, t.visibility, t.sharedDepartment, t.isDefault, t.exportFormat]);
    const row = (await ctx.client.query(`${SELECT} WHERE t.id = $2`, [ctx.user.id, r.rows[0].id])).rows[0];
    return json(toInfo(row), 201);
  } catch (e) {
    return reportError(e, ctx.correlationId);
  }
});

export const PUT = protect({ permission: ['reports', 'read'] }, async (ctx) => {
  try {
    const id = idParam(ctx);
    const t = await body(ctx);
    if (t.isDefault) await ctx.client.query(`UPDATE lms.report_template SET is_default = false WHERE owner_id = $1 AND dataset = $2 AND is_default AND id <> $3`, [ctx.user.id, t.dataset, id]);
    const r = await ctx.client.query(
      `UPDATE lms.report_template SET name = $2, description = $3, dataset = $4, config = $5, visibility = $6, shared_department = $7,
              is_default = $8, export_format = $9
        WHERE id = $1 AND owner_id = $10 RETURNING id`,
      [id, t.name, t.description, t.dataset, JSON.stringify(t.config), t.visibility, t.sharedDepartment, t.isDefault, t.exportFormat, ctx.user.id]);
    if (!r.rowCount) throw new HttpError(404, 'No such template, or it is not yours to change.', 'not_found');
    const row = (await ctx.client.query(`${SELECT} WHERE t.id = $2`, [ctx.user.id, id])).rows[0];
    return json(toInfo(row));
  } catch (e) {
    return reportError(e, ctx.correlationId);
  }
});

export const DELETE = protect({ permission: ['reports', 'read'] }, async (ctx) => {
  try {
    const id = idParam(ctx);
    const r = await ctx.client.query('DELETE FROM lms.report_template WHERE id = $1 RETURNING id', [id]);
    if (!r.rowCount) throw new HttpError(404, 'No such template, or it is not yours to delete.', 'not_found');
    return json({ ok: true, id });
  } catch (e) {
    return reportError(e, ctx.correlationId);
  }
});
