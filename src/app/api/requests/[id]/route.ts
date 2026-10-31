import { HttpError, json, protect, readJson, requireRecord, toResponse } from '@/lib/iam/http';
import { EDITABLE_STAGES, readArea, saveAreaVersion } from '@/lib/landRequestArea';

// The requester edits a draft or a returned request: the form fields and,
// when a polygon is sent, a new version of the land area (earlier versions
// are kept). Sending it on is a separate step (transition SUBMIT).
export const PATCH = protect({ permission: ['requests', 'create'] }, async (ctx) => {
  try {
    const body = await readJson(ctx.req, 200_000);
    const rec = await requireRecord(ctx, 'land_request', ctx.params?.id, ['requests', 'create'], { forUpdate: true });
    const req = rec.row;
    if (req.stage_code === 'Draft' && req.created_by !== ctx.user.id) throw new HttpError(404, 'Land request not found.', 'not_found');
    if (req.created_by !== ctx.user.id) throw new HttpError(403, 'Only the person who raised this request can change it.', 'forbidden');
    if (!EDITABLE_STAGES.includes(req.stage_code))
      throw new HttpError(409, `A request in stage ${req.stage_code} cannot be changed. It can be changed while it is a draft or returned.`, 'state');

    const area = readArea(body);
    const sets: string[] = [];
    const vals: any[] = [];
    const set = (col: string, v: any) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };

    if (body.project_id !== undefined && body.project_id !== req.project_id) {
      const p = await requireRecord(ctx, 'project', body.project_id, ['requests', 'create']);
      if (p.province !== req.province_code) throw new HttpError(400, 'The project must be in the same province as the request.', 'validation');
      set('project_id', p.id);
    }
    if (typeof body.purpose === 'string' && body.purpose.trim()) set('purpose', body.purpose.trim().slice(0, 200));
    if (typeof body.concession_name === 'string') set('concession_name', body.concession_name.trim() || 'Mari Concession');
    if (typeof body.target_deh === 'string') set('target_deh', body.target_deh.trim() || null);
    if (typeof body.justification === 'string') set('justification', body.justification.trim().slice(0, 4000));
    if (body.required_date) set('required_date', body.required_date);
    if (body.priority !== undefined) {
      if (!['Standard', 'Urgent', 'Emergency'].includes(body.priority)) throw new HttpError(400, 'Priority is not valid.', 'validation');
      set('priority', body.priority);
    }
    if (area) { set('area_acres', Math.round(area.areaAcres * 10000) / 10000); set('area_ghunta', 0); }
    else if (body.area_acres !== undefined) {
      const a = Number(body.area_acres);
      if (!(a > 0)) throw new HttpError(400, 'The required area must be more than zero.', 'validation');
      set('area_acres', a);
    }
    if (!sets.length && !area) throw new HttpError(400, 'Nothing to change.', 'validation');

    set('updated_by', ctx.user.id);
    vals.push(rec.id);
    const upd = await ctx.client.query(
      `UPDATE lms.land_request SET ${sets.join(', ')}, updated_at = now(), version = version + 1 WHERE id = $${vals.length} RETURNING *`, vals);
    const saved = area ? await saveAreaVersion(ctx.client, rec.id, area, ctx.user.id, typeof body.area_note === 'string' ? body.area_note.slice(0, 500) : null) : null;
    return json({ request: { ...upd.rows[0], area_version: saved?.version ?? null, polygon_acres: saved?.area_acres ?? null } });
  } catch (e) {
    return toResponse(e, ctx.correlationId);
  }
});
