import { NextResponse } from 'next/server';
import { protect, toResponse } from '@/lib/iam/http';

export const GET = protect({ permission: ['gis', 'read'] }, async (ctx) => {
    const request = ctx.req;
    // ---- bound to the authenticated request (scripts/iam/convert_routes.py) ----
    const { query, withTransaction, getClient } = ctx.db;
    const user = ctx.legacyUser;
    const getCurrentUser = async () => user;
    void query; void withTransaction; void getClient; void getCurrentUser;

  try {
    const { searchParams } = new URL(request.url);
    const province = searchParams.get('province');

    let sql = `
      SELECT s.id, s.code, s.province_code, s.survey_no, s.block_no, s.khasra_type,
             s.total_area, s.land_class, s.status_code, s.lat, s.lng, s.remarks,
             p.name as province_name,
             so.location_path, so.share_total_pct, so.owner_count, so.apportionment, so.committed_area
      FROM lms.survey s
      JOIN lms.province p ON p.code = s.province_code
      LEFT JOIN api.v_survey_ownership so ON so.survey_id = s.id
      WHERE s.lat IS NOT NULL AND s.lng IS NOT NULL
    `;
    const params: any[] = [];

    if (province && province !== 'ALL') {
      params.push(province);
      sql += ` AND s.province_code = $${params.length}`;
    }

    const result = await query(sql, params);

    // Transform into GeoJSON FeatureCollection
    const features = result.rows.map((row) => ({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [Number(row.lng), Number(row.lat)],
      },
      properties: {
        id: row.id,
        code: row.code,
        province_code: row.province_code,
        province_name: row.province_name,
        survey_no: row.survey_no,
        block_no: row.block_no,
        location: row.location_path,
        total_area_acres: Number(row.total_area),
        land_class: row.land_class,
        status: row.status_code,
        share_total_pct: Number(row.share_total_pct || 0),
        owner_count: Number(row.owner_count || 0),
        apportionment: row.apportionment,
        committed_area: Number(row.committed_area || 0),
      },
    }));

    return NextResponse.json({
      type: 'FeatureCollection',
      features,
    });
  } catch (error: any) {
    return toResponse(error, ctx.correlationId);
  }
});
