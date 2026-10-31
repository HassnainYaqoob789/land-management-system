import { NextResponse } from 'next/server';
import { protect, requireRecord, toResponse } from '@/lib/iam/http';
import { generateMergedKmlXml } from '@/lib/kml';

export const GET = protect({ permission: ['gis', 'read'] }, async (ctx) => {
    const request = ctx.req;
    // ---- bound to the authenticated request (scripts/iam/convert_routes.py) ----
    const { query, withTransaction, getClient } = ctx.db;
    const user = ctx.legacyUser;
    const getCurrentUser = async () => user;
    void query; void withTransaction; void getClient; void getCurrentUser;

  try {
    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get('projectId') || searchParams.get('project_id');
    const mergeId = searchParams.get('mergeId') || searchParams.get('merge_id');
    const download = searchParams.get('download') === 'true';

    if (mergeId && download) {
      // Stream raw KML XML file for download
      const res = await query(
        `SELECT gm.merge_name, gm.merged_kml_xml, p.name as project_name 
         FROM lms.project_gis_merge gm
         JOIN lms.project p ON p.id = gm.project_id
         WHERE gm.id = $1`,
        [mergeId]
      );
      if (res.rows.length === 0 || !res.rows[0].merged_kml_xml) {
        return NextResponse.json({ error: 'Merged KML not found' }, { status: 404 });
      }

      const row = res.rows[0];
      const filename = `${row.merge_name.replace(/[^a-zA-Z0-9_-]/g, '_')}_merged.kml`;

      return new Response(row.merged_kml_xml, {
        headers: {
          'Content-Type': 'application/vnd.google-earth.kml+xml',
          'Content-Disposition': `attachment; filename="${filename}"`,
        },
      });
    }

    // List merges for project
    let sql = `
      SELECT gm.id, gm.project_id, p.name as project_name, gm.merge_name,
             gm.feature_count, gm.total_area_sqm, gm.total_area_acres,
             gm.source_import_ids, gm.created_at
      FROM lms.project_gis_merge gm
      JOIN lms.project p ON p.id = gm.project_id
      WHERE 1=1
    `;
    const params: any[] = [];
    if (projectId) {
      params.push(projectId);
      sql += ` AND gm.project_id = $${params.length}`;
    }
    sql += ` ORDER BY gm.created_at DESC`;
    const result = await query(sql, params);

    return NextResponse.json({
      success: true,
      merges: result.rows,
    });
  } catch (error: any) {
    console.error('GIS merge fetch error:', error);
    return toResponse(error, ctx.correlationId);
  }
});

export const POST = protect({ permission: ['gis', 'create'] }, async (ctx) => {
    const request = ctx.req;
    // ---- bound to the authenticated request (scripts/iam/convert_routes.py) ----
    const { query, withTransaction, getClient } = ctx.db;
    const user = ctx.legacyUser;
    const getCurrentUser = async () => user;
    void query; void withTransaction; void getClient; void getCurrentUser;

  const client = await getClient();
  try {
    const body = await request.json();
    const { projectId, importIds, mergeName } = body;

    if (!projectId) {
      return NextResponse.json({ error: 'Project ID is required' }, { status: 400 });
    }
    if (!importIds || !Array.isArray(importIds) || importIds.length === 0) {
      return NextResponse.json({ error: 'Please select at least one KML/KMZ layer to merge' }, { status: 400 });
    }

    // 1. The project, visible to the caller and in a province where gis:create applies.
    const project = (await requireRecord(ctx, 'project', projectId, ['gis', 'create'])).row;

    // 2. Fetch spatial features from the selected imports
    const featRes = await client.query(
      `SELECT sf.id, sf.feature_name, sf.geometry_type, sf.coordinates,
              sf.area_sqm, sf.area_acres, sf.source_file, s.survey_no
       FROM lms.project_spatial_feature sf
       LEFT JOIN lms.survey s ON s.id = sf.survey_id
       WHERE sf.project_id = $1 AND sf.import_id = ANY($2::uuid[])`,
      [projectId, importIds]
    );

    if (featRes.rows.length === 0) {
      return NextResponse.json({ error: 'No spatial features found in selected imports to merge' }, { status: 422 });
    }

    const features = featRes.rows;
    const totalAreaSqm = features.reduce((sum, f) => sum + (Number(f.area_sqm) || 0), 0);
    const totalAreaAcres = features.reduce((sum, f) => sum + (Number(f.area_acres) || 0), 0);

    const consolidatedName = mergeName || `${project.name} - Cadastral Merge (${features.length} Features)`;

    // 3. Generate Valid Merged KML XML Document
    const mergedKmlXml = generateMergedKmlXml(project.name, features);

    await client.query('BEGIN');

    // 4. Save to lms.project_gis_merge
    const mergeInsertSql = `
      INSERT INTO lms.project_gis_merge (
        project_id, merge_name, feature_count, total_area_sqm,
        total_area_acres, source_import_ids, merged_kml_xml
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id, created_at
    `;
    const mergeResult = await client.query(mergeInsertSql, [
      projectId,
      consolidatedName,
      features.length,
      Math.round(totalAreaSqm * 100) / 100,
      Math.round(totalAreaAcres * 10000) / 10000,
      importIds,
      mergedKmlXml,
    ]);
    const mergeId = mergeResult.rows[0].id;

    // 5. Update features and imports
    await client.query(
      `UPDATE lms.project_spatial_feature 
       SET is_merged = true 
       WHERE project_id = $1 AND import_id = ANY($2::uuid[])`,
      [projectId, importIds]
    );

    await client.query(
      `UPDATE lms.project_kml_import
       SET status = 'Merged'
       WHERE id = ANY($1::uuid[])`,
      [importIds]
    );

    await client.query('COMMIT');

    return NextResponse.json({
      success: true,
      mergeId,
      mergeName: consolidatedName,
      featureCount: features.length,
      totalAreaSqm: Math.round(totalAreaSqm * 100) / 100,
      totalAreaAcres: Math.round(totalAreaAcres * 10000) / 10000,
      downloadUrl: `/api/gis/kml/merge?mergeId=${mergeId}&download=true`,
      message: `Successfully merged ${features.length} spatial features across ${importIds.length} KML layers into consolidated GIS layer.`,
    });
  } catch (error: any) {
    await client.query('ROLLBACK');
    console.error('GIS merge error:', error);
    return toResponse(error, ctx.correlationId);
  } finally {
    client.release();
  }
});
