import { HttpError, json, protect, readJson, requireRecord, toResponse, type Ctx } from '@/lib/iam/http';
import { overlappingRequests, parcelsInside, readArea, ringOf, saveAreaVersion, warningsFor } from '@/lib/landRequestArea';
import { centroid } from '@/lib/geo';

// Land requests (migration 0024; polygons and the Draft / Handed over stages
// from 0057). Row-level security limits every reader to their provinces; a
// draft is seen only by the person who saved it.

const LIST_SQL = `
  SELECT lr.*, p.name AS project_name, p.code AS project_code,
         lms.user_full_name(lr.created_by) AS created_by_name,
         lms.user_full_name(lr.director_ops_id) AS director_ops_name,
         lms.user_full_name(lr.regional_mgr_id) AS regional_mgr_name,
         lms.user_full_name(lr.land_affairs_id) AS land_affairs_name,
         lms.user_full_name(lr.handed_over_by) AS handed_over_by_name,
         lms.user_full_name(lr.completed_by) AS completed_by_name,
         (lr.created_by = $1) AS is_mine,
         a.version AS area_version, a.area_acres AS polygon_acres, a.centroid_lat, a.centroid_lng
    FROM lms.land_request lr
    JOIN lms.project p ON p.id = lr.project_id
    LEFT JOIN LATERAL (SELECT version, area_acres, centroid_lat, centroid_lng FROM lms.land_request_area x
                        WHERE x.land_request_id = lr.id ORDER BY version DESC LIMIT 1) a ON true
   WHERE (lr.stage_code <> 'Draft' OR lr.created_by = $1)`;

export const GET = protect({ permission: ['requests', 'read'] }, async (ctx) => {
  try {
    const sp = new URL(ctx.req.url).searchParams;
    const id = sp.get('id');
    if (id) return await detail(ctx, id);
    if (sp.get('geo')) return await layer(ctx, sp);

    const province = sp.get('province');
    const stage = sp.get('stage');
    const params: any[] = [ctx.user.id];
    let sql = LIST_SQL;
    if (province && province !== 'ALL') { params.push(province); sql += ` AND lr.province_code = $${params.length}`; }
    if (stage && stage !== 'ALL') { params.push(stage); sql += ` AND lr.stage_code = $${params.length}`; }
    if (sp.get('mine')) sql += ' AND lr.created_by = $1';
    sql += ' ORDER BY lr.created_at DESC LIMIT 500';   // bounded: the 500 most recent requests

    const result = await ctx.client.query(sql, params);
    const counts = await ctx.client.query(`
      SELECT count(*) AS total,
             count(*) FILTER (WHERE stage_code = 'Draft') AS drafts,
             count(*) FILTER (WHERE stage_code IN ('Submitted', 'Under Review - Ops')) AS pending_ops,
             count(*) FILTER (WHERE stage_code = 'Under Review - Ops') AS in_ops_review,
             count(*) FILTER (WHERE stage_code = 'Under Review - Regional') AS pending_regional,
             count(*) FILTER (WHERE stage_code = 'Under Review - Land Affairs') AS pending_land_affairs,
             count(*) FILTER (WHERE stage_code = 'Returned') AS returned,
             count(*) FILTER (WHERE stage_code = 'Approved') AS approved,
             count(*) FILTER (WHERE stage_code = 'Handed over') AS handed_over,
             count(*) FILTER (WHERE stage_code = 'Completed') AS completed,
             count(*) FILTER (WHERE stage_code = 'Rejected') AS rejected
        FROM lms.land_request
       WHERE (stage_code <> 'Draft' OR created_by = $1)${province && province !== 'ALL' ? ' AND province_code = $2' : ''}`,
      province && province !== 'ALL' ? [ctx.user.id, province] : [ctx.user.id]);

    return json({ requests: result.rows, summary: counts.rows[0] || {} });
  } catch (e) {
    return toResponse(e, ctx.correlationId);
  }
});

/** One request with every polygon version, the parcels inside its latest polygon and the warnings. */
async function detail(ctx: Ctx, id: string) {
  const rec = await requireRecord(ctx, 'land_request', id, ['requests', 'read']);
  const r = await ctx.client.query(`${LIST_SQL} AND lr.id = $2`, [ctx.user.id, rec.id]);
  const request = r.rows[0];
  if (!request) throw new HttpError(404, 'Land request not found.', 'not_found');
  const pr = await ctx.client.query(
    `SELECT s.code AS allocated_survey_no, l.code AS allocated_lease_code, p.lat AS project_lat, p.lng AS project_lng
       FROM lms.land_request lr JOIN lms.project p ON p.id = lr.project_id
       LEFT JOIN lms.survey s ON s.id = lr.allocated_survey_id
       LEFT JOIN lms.lease l ON l.id = lr.allocated_lease_id
      WHERE lr.id = $1`, [rec.id]);
  Object.assign(request, { allocated_survey_no: pr.rows[0]?.allocated_survey_no ?? null, allocated_lease_code: pr.rows[0]?.allocated_lease_code ?? null });

  const areas = (await ctx.client.query(
    `SELECT a.id, a.version, a.geometry, a.source, a.area_sqm, a.area_acres, a.centroid_lat, a.centroid_lng, a.note,
            a.drawn_at, lms.user_full_name(a.drawn_by) AS drawn_by_name
       FROM lms.land_request_area a WHERE a.land_request_id = $1 ORDER BY a.version DESC`, [rec.id])).rows;
  const latest = areas[0];
  const ring = latest ? ringOf(latest.geometry) : [];
  // Parcels and their land status need surveys:read; every role that reads requests here has it.
  const parcels = ring.length && ctx.can('surveys', 'read', { province: rec.province }) ? await parcelsInside(ctx.client, rec.province!, ring) : [];
  const overlaps = ring.length ? await overlappingRequests(ctx.client, rec.province!, ring, rec.id, ctx.user.id) : [];
  const warnings = warningsFor(parcels, overlaps, {
    polygonAcres: latest ? Number(latest.area_acres) : null,
    requestedAcres: Number(request.area_acres),
    project: { lat: pr.rows[0]?.project_lat ?? null, lng: pr.rows[0]?.project_lng ?? null, code: request.project_code },
    centroid: ring.length ? centroid(ring) : null,
  });
  // Progress of the land work. The stage itself is on the request (work_stage, 0060), so the
  // requester sees it without access to the acquisition register; the details below only
  // for a reader of acquisitions.
  let work: any = null;
  if (request.handed_over_kind === 'Acquisition') {
    const stages = (await ctx.client.query(
      `SELECT code, label FROM lms.workflow_stage WHERE workflow_code = 'acquisitions' AND NOT is_terminal ORDER BY seq`)).rows;
    let acquisition = null;
    if (request.handed_over_record_id && ctx.can('acquisitions', 'read', { province: rec.province }))
      acquisition = (await ctx.client.query(
        `SELECT a.id, a.code, a.mode, a.area_required, a.target_handover_date, a.stage_code, a.updated_at,
                (SELECT count(*) FROM lms.acquisition_survey x WHERE x.acquisition_id = a.id)::int AS parcels
           FROM lms.acquisition a WHERE a.id = $1`, [request.handed_over_record_id])).rows[0] ?? null;
    work = { kind: 'Acquisition', stages, acquisition };
  }
  return json({ request, areas, parcels, overlaps, warnings, work });
}

/** The latest polygon of every visible request, for the map's "Land requests" layer. */
async function layer(ctx: Ctx, sp: URLSearchParams) {
  const params: any[] = [ctx.user.id];
  let sql = `
    SELECT lr.id, lr.code, lr.stage_code, lr.purpose, lr.priority, lr.province_code, lr.required_date, lr.pending_approver_role,
           (lr.created_by = $1) AS is_mine, p.code AS project_code, p.name AS project_name,
           a.version, a.geometry, a.area_acres
      FROM lms.land_request lr
      JOIN lms.project p ON p.id = lr.project_id
      JOIN LATERAL (SELECT version, geometry, area_acres FROM lms.land_request_area x
                     WHERE x.land_request_id = lr.id ORDER BY version DESC LIMIT 1) a ON true
     WHERE (lr.stage_code <> 'Draft' OR lr.created_by = $1) AND lr.stage_code <> 'Withdrawn'`;
  const province = sp.get('province');
  if (province && province !== 'ALL') { params.push(province); sql += ` AND lr.province_code = $${params.length}`; }
  sql += ' ORDER BY lr.created_at DESC LIMIT 1000';
  const rows = (await ctx.client.query(sql, params)).rows;
  return json({
    type: 'FeatureCollection',
    features: rows.map((x) => ({
      type: 'Feature',
      geometry: x.geometry,
      properties: {
        id: x.id, code: x.code, stage: x.stage_code, purpose: x.purpose, priority: x.priority, province_code: x.province_code,
        project_code: x.project_code, project_name: x.project_name, version: x.version, area_acres: Number(x.area_acres),
        required_date: x.required_date, waiting_on: x.pending_approver_role, mine: x.is_mine,
      },
    })),
  });
}

export const POST = protect({ permission: ['requests', 'create'] }, async (ctx) => {
  try {
    const body = await readJson(ctx.req, 200_000);
    const draft = body.draft === true;
    const area = readArea(body);
    const { project_id, concession_name, purpose, target_deh, priority } = body;
    const justification = typeof body.justification === 'string' ? body.justification.trim() : '';
    const required_date = body.required_date || (draft ? new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10) : null);
    // The drawn area is the requested area; a request without a polygon states it.
    const area_acres = area ? Math.round(area.areaAcres * 10000) / 10000 : Number(body.area_acres);
    const area_ghunta = area ? 0 : Number(body.area_ghunta || 0);

    if (!project_id || !purpose) throw new HttpError(400, 'A project and a purpose are required.', 'validation');
    if (!draft && (!(area_acres > 0) && !(area_ghunta > 0) || !required_date || !justification))
      throw new HttpError(400, 'Missing mandatory fields (project, purpose, area, required date, justification)', 'validation');
    if (priority && !['Standard', 'Urgent', 'Emergency'].includes(priority)) throw new HttpError(400, 'Priority is not valid.', 'validation');
    if (draft && !area && !(area_acres > 0)) throw new HttpError(400, 'Draw the land area, or state the required area.', 'validation');

    const province_code = (await requireRecord(ctx, 'project', project_id, ['requests', 'create'])).province;
    const code = (await ctx.client.query("SELECT lms.next_code_year('REQ') AS code")).rows[0]?.code;
    if (!code) throw new Error('lms.next_code_year returned no code');

    const ins = await ctx.client.query(
      `INSERT INTO lms.land_request (
         code, province_code, project_id, concession_name, purpose,
         area_acres, area_ghunta, target_deh, required_date, priority, justification,
         stage_code, pending_approver_role, submitted_at, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $15)
       RETURNING *`,
      [code, province_code, project_id,
       // Blank means the column's own default (0024: 'Mari Concession').
       (typeof concession_name === 'string' && concession_name.trim()) || 'Mari Concession',
       String(purpose).slice(0, 200), area_acres, area_ghunta, (typeof target_deh === 'string' && target_deh.trim()) || null,
       required_date, priority || 'Standard', justification.slice(0, 4000),
       draft ? 'Draft' : 'Submitted', draft ? 'Initiator' : 'Director Operations', draft ? null : new Date(), ctx.user.id]);
    const created = ins.rows[0];
    let saved = null;
    if (area) saved = await saveAreaVersion(ctx.client, created.id, area, ctx.user.id, typeof body.area_note === 'string' ? body.area_note.slice(0, 500) : null);

    return json({ request: { ...created, area_version: saved?.version ?? null, polygon_acres: saved?.area_acres ?? null } }, 201);
  } catch (e) {
    return toResponse(e, ctx.correlationId);
  }
});
