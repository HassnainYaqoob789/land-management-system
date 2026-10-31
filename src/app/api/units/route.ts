import { randomBytes } from 'node:crypto';
import { HttpError, json, logDenied, protect, readJson, str, toResponse, type Ctx } from '@/lib/iam/http';
import { toDecimal } from '@/lib/reporting/decimal';

// Units of measure and the administrative hierarchy (reference data).
// Reading is open to every signed-in user (survey, project and DBPFC forms use
// it). Changing the hierarchy needs settings:update (UI-01, AUTHZ-06, DSP-16).
// Every factor comes from lms.unit_conversion, the one source: the factor in
// force whatever its source, with whether the Land Department has confirmed
// it; where a unit applies comes from lms.province_unit (UOM-05/06, RPT-12).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROVINCE = /^[A-Z]{3}$/;
const CODE = /^[A-Za-z0-9][A-Za-z0-9/-]{1,31}$/;

export const GET = protect({ authenticatedOnly: true }, async (ctx) => {
  const province = new URL(ctx.req.url).searchParams.get('province');
  const prov = province && province !== 'ALL' && PROVINCE.test(province) ? province : null;
  const units = (await ctx.client.query(
    `SELECT mu.code, mu.name, mu.is_area, mu.display_order,
            uc.sqm_per_unit, uc.note, uc.source_ref, coalesce(uc.is_confirmed, false) AS is_confirmed,
            (uc.id IS NOT NULL) AS has_factor,
            (SELECT a.sqm_per_unit / uc.sqm_per_unit FROM lms.unit_conversion a
              WHERE a.unit_code = 'Acre' AND a.valid_range @> CURRENT_DATE) AS units_per_acre,
            (SELECT string_agg(pu.province_code::text, ',' ORDER BY pu.province_code) FROM lms.province_unit pu WHERE pu.unit_code = mu.code) AS jurisdiction,
            (SELECT coalesce(bool_and(pu.confirmed), false) FROM lms.province_unit pu WHERE pu.unit_code = mu.code) AS jurisdiction_confirmed
       FROM lms.measurement_unit mu
       LEFT JOIN lms.unit_conversion uc ON uc.unit_code = mu.code AND uc.valid_range @> CURRENT_DATE
      ORDER BY mu.display_order, mu.code`)).rows;
  const adminUnits = (await ctx.client.query(
    `SELECT aup.admin_unit_id AS id, aup.admin_unit_id, aup.province_code,
            aup.level AS level_no, aup.level, aup.level AS level_label, pl.name AS level_name, aup.name, aup.code,
            aup.parent_id, aup.path AS full_path, aup.path, aup.district_id
       FROM api.v_admin_unit_path aup
       LEFT JOIN lms.province_level pl ON pl.province_code = aup.province_code AND pl.depth = aup.level
      WHERE ($1::text IS NULL OR aup.province_code = $1)
      ORDER BY aup.province_code ASC, aup.level ASC, aup.name ASC`, [prov])).rows;
  const levels = (await ctx.client.query(`SELECT *, depth AS level_no, name AS level_name FROM lms.province_level ORDER BY province_code ASC, depth ASC`)).rows;
  const provinceUnits = (await ctx.client.query(
    `SELECT province_code, unit_code, display_order, source, confirmed, note FROM lms.province_unit ORDER BY province_code, display_order`)).rows;
  const reportUnits = (await ctx.client.query(
    `SELECT province_code::text AS province, land_class AS "landClass", unit_code AS unit, approved, note FROM lms.report_unit_default ORDER BY province_code, land_class NULLS FIRST`)).rows;
  return json({
    units, admin_units: adminUnits, province_levels: levels, province_units: provinceUnits, report_units: reportUnits,
    canonical_base: 'Square Meter (m²)',
    authority: 'lms.unit_conversion — the factor in force for each unit; Jireb and Bigha are provisional until the Land Department confirms them',
    can: { manageUnits: ctx.has('settings', 'update') },
  });
});

async function requireManage(ctx: Ctx) {
  if (!ctx.has('settings', 'update')) {
    await logDenied(ctx.session, ctx.req, 'missing_permission', ctx.correlationId, { permission: 'settings:update', action: 'admin_unit' });
    throw new HttpError(403, 'Changing the administrative hierarchy needs the settings:update permission.', 'forbidden');
  }
}

export const POST = protect({ authenticatedOnly: true }, async (ctx) => {
  const body = await readJson(ctx.req, 20_000);
  try {
    if (body.action === 'create_admin_unit') {
      await requireManage(ctx);
      const province = str(body, 'province_code', { max: 3 });
      if (!PROVINCE.test(province)) throw new HttpError(400, 'province_code must be a province code.', 'validation');
      const level = Number(body.level ?? body.level_no);
      if (!Number.isInteger(level) || level < 0 || level > 9) throw new HttpError(400, 'level must be the hierarchy depth (0 = district).', 'validation');
      const parent = body.parent_id ? String(body.parent_id) : null;
      if (level > 0 && (!parent || !UUID.test(parent))) throw new HttpError(400, 'parent_id is required below the district level.', 'validation');
      const name = str(body, 'name', { max: 120 }).trim();
      if (!name) throw new HttpError(400, 'name is required.', 'validation');
      const code = body.code ? String(body.code).trim().toUpperCase() : `${province}-L${level}-${randomBytes(3).toString('hex').toUpperCase()}`;
      if (!CODE.test(code)) throw new HttpError(400, 'code may use letters, digits, "/" and "-" (2 to 32 characters).', 'validation');
      const r = await ctx.client.query(
        `INSERT INTO lms.admin_unit (code, province_code, level, parent_id, name) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [code, province, level, level === 0 ? null : parent, name]);
      return json({ success: true, admin_unit: { ...r.rows[0], level_no: r.rows[0].level } }, 201);
    }
    if (body.action === 'update_admin_unit') {
      await requireManage(ctx);
      const id = String(body.id ?? '');
      if (!UUID.test(id)) throw new HttpError(404, 'Administrative unit not found.', 'not_found');
      const name = str(body, 'name', { max: 120 }).trim();
      if (!name) throw new HttpError(400, 'name is required.', 'validation');
      const code = body.code ? String(body.code).trim().toUpperCase() : null;
      if (code && !CODE.test(code)) throw new HttpError(400, 'code may use letters, digits, "/" and "-" (2 to 32 characters).', 'validation');
      const r = await ctx.client.query(`UPDATE lms.admin_unit SET name = $2, code = coalesce($3, code) WHERE id = $1 RETURNING *`, [id, name, code]);
      if (!r.rowCount) throw new HttpError(404, 'Administrative unit not found.', 'not_found');
      return json({ success: true, admin_unit: { ...r.rows[0], level_no: r.rows[0].level } });
    }
    if (body.action !== undefined && body.action !== 'convert') throw new HttpError(400, 'Unknown action.', 'validation');

    // Conversion: exact, from lms.unit_conversion, with whether the factor is confirmed.
    const value = toDecimal(body.value, 6);
    if (value === null) throw new HttpError(400, 'value must be a number (up to 6 decimal places).', 'validation');
    const from = String(body.from_unit ?? body.fromUnit ?? '').slice(0, 40);
    if (Array.isArray(body.to_units)) {
      // Several targets at once (the Units page converter).
      const targets = (body.to_units as unknown[]).slice(0, 20).map((x) => String(x).slice(0, 40));
      if (!from || !targets.length) throw new HttpError(400, 'from_unit and to_units are required.', 'validation');
      const rows = (await ctx.client.query(
        `SELECT t AS asked, d.to_unit, round(d.value, 6) AS converted_value, d.value AS exact_value, (d.confirmed IS FALSE) AS provisional
           FROM unnest($3::text[]) t CROSS JOIN LATERAL lms.uom_convert_detail($1::numeric, $2, t) d`, [value, from, targets])).rows;
      return json({ success: true, original_value: value, original_unit: from, conversions: rows });
    }
    const to = String(body.to_unit ?? body.toUnit ?? '').slice(0, 40);
    if (!from || !to) throw new HttpError(400, 'from_unit and to_unit are required.', 'validation');
    const r = (await ctx.client.query(
      `SELECT d.value, d.from_unit, d.to_unit, d.confirmed, round(d.value, 6) AS rounded,
              (SELECT value FROM lms.uom_convert_detail($1::numeric, $2, 'Square Meter')) AS sqm
         FROM lms.uom_convert_detail($1::numeric, $2, $3) d`, [value, from, to])).rows[0];
    if (!r || r.value === null) throw new HttpError(400, `There is no conversion factor for ${r?.from_unit ? to : from}.`, 'validation');
    return json({
      success: true,
      original_value: value, originalValue: value, original_unit: r.from_unit, originalUnit: r.from_unit,
      target_unit: r.to_unit, targetUnit: r.to_unit,
      converted_value: r.rounded, convertedValue: r.rounded, exact_value: r.value,
      canonical_sqm: r.sqm,
      provisional: r.confirmed === false,
      applied_rule: r.confirmed === false
        ? 'lms.unit_conversion — uses a provisional factor (awaiting Land Department confirmation)'
        : 'lms.unit_conversion — confirmed factors',
    });
  } catch (e) {
    return toResponse(e, ctx.correlationId);
  }
});
