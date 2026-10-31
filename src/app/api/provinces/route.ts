import { NextResponse } from 'next/server';
import { protect, toResponse } from '@/lib/iam/http';

// Every signed-in user may list their provinces (the province chooser needs
// it) and the administrative-unit tree (forms need it). The figures per
// province aggregate other registers, so each one is returned only to a caller
// who holds reports:read and the register's own read permission for that
// province (AUTHZ-24, UI-09); the others are omitted, not zeroed.
const FIGURES: [string, string[]][] = [
  ['projects', ['projects', 'active_projects']],
  ['surveys', ['parcels', 'total_area_acres']],
  ['landowners', ['landowners']],
  ['cases', ['live_cases', 'approved_cases', 'approved_compensation']],
  ['payments', ['released_amount']],
  ['leases', ['active_leases', 'leases_expiring_90d']],
  ['grievances', ['open_grievances']],
  ['encroachments', ['open_encroachments']],
  ['legal', ['active_stay_orders']],
];

export const GET = protect({ authenticatedOnly: true }, async (ctx) => {
  const { query } = ctx.db;
  try {
    const { searchParams } = new URL(ctx.req.url);
    const getUnits = searchParams.get('units');
    const province = searchParams.get('province');

    if (getUnits === 'true') {
      let sql = `SELECT admin_unit_id, code, province_code, level, name, path, district_id FROM api.v_admin_unit_path WHERE 1=1`;
      const params: any[] = [];
      if (province && province !== 'ALL') {
        params.push(province);
        sql += ` AND province_code = $1`;
      }
      sql += ` ORDER BY path ASC`;
      const unitsRes = await query(sql, params);
      return NextResponse.json({ adminUnits: unitsRes.rows });
    }

    const result = await query(
      `SELECT province_code, province_name, display_order, projects, active_projects,
              parcels, total_area_acres, landowners, live_cases, approved_cases,
              approved_compensation, released_amount, active_leases, leases_expiring_90d,
              open_grievances, open_encroachments, active_stay_orders
       FROM api.v_province_summary
       ORDER BY display_order ASC`
    );
    const mine = (r: any) => ctx.provinces.includes(r.province_code) || ctx.user.dbRole === 'Admin';
    const provinces = result.rows.filter(mine).map((r: any) => {
      const out: Record<string, unknown> = {
        province_code: r.province_code,
        province_name: r.province_name,
        display_order: r.display_order,
        projects: r.projects,
        parcels: r.parcels,
        landowners: r.landowners,
        active_leases: r.active_leases,
      };
      if (!ctx.can('reports', 'read', { province: r.province_code })) return out;
      for (const [resource, keys] of FIGURES)
        if (ctx.can(resource, 'read', { province: r.province_code })) for (const k of keys) out[k] = r[k];
      return out;
    });
    return NextResponse.json({ provinces });
  } catch (error: any) {
    return toResponse(error, ctx.correlationId);
  }
});
