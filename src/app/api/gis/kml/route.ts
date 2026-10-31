import { NextResponse } from 'next/server';
import AdmZip from 'adm-zip';
import { HttpError, protect, requireRecord, toResponse } from '@/lib/iam/http';
import { parseKmlOrKmzBuffer } from '@/lib/kml';

// A KMZ is a zip archive, so its stated size says nothing about what it expands
// to (AUTHZ-18). Before anything is decompressed: few entries, each and all of
// them small once expanded, and no archive inside the archive.
const KMZ_MAX_ENTRIES = 100;
const KMZ_MAX_ENTRY_BYTES = 50 * 1024 * 1024;
const KMZ_MAX_TOTAL_BYTES = 100 * 1024 * 1024;
function assertSafeKmz(buffer: Buffer): void {
  let entries: AdmZip.IZipEntry[];
  try { entries = new AdmZip(buffer).getEntries(); } catch {
    throw new HttpError(400, 'Invalid KMZ: the file is not a readable archive', 'invalid_file');
  }
  if (entries.length > KMZ_MAX_ENTRIES) throw new HttpError(400, `Invalid KMZ: more than ${KMZ_MAX_ENTRIES} files in the archive`, 'invalid_file');
  let total = 0;
  for (const e of entries) {
    const size = Number(e.header.size);   // uncompressed size, from the central directory
    if (!Number.isFinite(size) || size < 0 || size > KMZ_MAX_ENTRY_BYTES)
      throw new HttpError(400, 'Invalid KMZ: a file in the archive is too large once expanded', 'invalid_file');
    total += size;
    if (/\.(zip|kmz|gz|7z|rar|tar)$/i.test(e.entryName)) throw new HttpError(400, 'Invalid KMZ: nested archives are not accepted', 'invalid_file');
  }
  if (total > KMZ_MAX_TOTAL_BYTES) throw new HttpError(400, 'Invalid KMZ: the archive is too large once expanded', 'invalid_file');
}

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
    const importId = searchParams.get('importId') || searchParams.get('import_id');

    // 1. Fetch KML imports
    let importSql = `
      SELECT ki.id, ki.project_id, p.name as project_name, ki.filename, ki.file_size,
             ki.layer_name, ki.feature_count, ki.status, ki.created_at
      FROM lms.project_kml_import ki
      JOIN lms.project p ON p.id = ki.project_id
      WHERE 1=1
    `;
    const importParams: any[] = [];
    if (projectId) {
      importParams.push(projectId);
      importSql += ` AND ki.project_id = $${importParams.length}`;
    }
    if (importId) {
      importParams.push(importId);
      importSql += ` AND ki.id = $${importParams.length}`;
    }
    importSql += ` ORDER BY ki.created_at DESC LIMIT 200`;
    const importRes = await query(importSql, importParams);

    // 2. Fetch spatial features
    let featSql = `
      SELECT sf.id, sf.import_id, sf.project_id, sf.survey_id, sf.feature_name,
             sf.geometry_type, sf.coordinates, sf.area_sqm, sf.area_acres,
             sf.is_merged, sf.source_file, sf.metadata, sf.created_at,
             s.survey_no, s.code as survey_code, s.land_class, s.status_code as survey_status
      FROM lms.project_spatial_feature sf
      LEFT JOIN lms.survey s ON s.id = sf.survey_id
      WHERE 1=1
    `;
    const featParams: any[] = [];
    if (projectId) {
      featParams.push(projectId);
      featSql += ` AND sf.project_id = $${featParams.length}`;
    }
    if (importId) {
      featParams.push(importId);
      featSql += ` AND sf.import_id = $${featParams.length}`;
    }
    featSql += ` ORDER BY sf.created_at ASC LIMIT 1000`;
    const featRes = await query(featSql, featParams);

    return NextResponse.json({
      success: true,
      imports: importRes.rows,
      features: featRes.rows,
      count: featRes.rows.length,
    });
  } catch (error: any) {
    console.error('KML fetch error:', error);
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
    const formData = await request.formData().catch(() => { throw new HttpError(400, 'Send the KML or KMZ file as multipart/form-data.', 'validation'); });
    const file = formData.get('file') as File | null;
    const projectId = formData.get('projectId') as string | null;
    const customLayerName = formData.get('layerName') as string | null;

    if (!file) {
      return NextResponse.json({ error: 'No KML/KMZ file uploaded' }, { status: 400 });
    }
    if (!projectId) {
      return NextResponse.json({ error: 'Project ID is required' }, { status: 400 });
    }

    const filename = file.name;
    const ext = filename.toLowerCase().split('.').pop();
    if (ext !== 'kml' && ext !== 'kmz') {
      return NextResponse.json({ error: 'Unsupported file type. Only .kml and .kmz files are accepted.' }, { status: 400 });
    }

    // Check size limit: 25MB
    if (file.size > 25 * 1024 * 1024) {
      return NextResponse.json({ error: 'File size exceeds 25MB limit' }, { status: 400 });
    }

    // The project, read under the uploader's row-level security; gis:create must cover its province.
    await requireRecord(ctx, 'project', projectId, ['gis', 'create']);

    // Convert file to Buffer
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (ext === 'kmz') assertSafeKmz(buffer);

    // Parse KML/KMZ safely
    const parseResult = parseKmlOrKmzBuffer(buffer, filename);
    const layerName = customLayerName || parseResult.layerName || filename;

    if (parseResult.features.length === 0) {
      return NextResponse.json({
        error: 'No valid spatial features (Point, LineString, Polygon) could be extracted from this KML/KMZ file.',
        details: parseResult.errors,
      }, { status: 422 });
    }

    await client.query('BEGIN');

    // 1. Insert KML Import record
    const insertImportSql = `
      INSERT INTO lms.project_kml_import (
        project_id, filename, file_size, layer_name, feature_count, status, metadata
      ) VALUES ($1, $2, $3, $4, $5, 'Active', $6)
      RETURNING id, created_at
    `;
    const importMeta = {
      errors: parseResult.errors,
      valid_features: parseResult.features.filter(f => f.isValid).length,
      invalid_features: parseResult.features.filter(f => !f.isValid).length,
    };
    const importRes = await client.query(insertImportSql, [
      projectId,
      filename,
      file.size,
      layerName,
      parseResult.features.length,
      JSON.stringify(importMeta),
    ]);
    const importId = importRes.rows[0].id;

    // 2. Fetch existing surveys in this project (or project province) for automatic linking
    const surveyRes = await client.query(
      `SELECT s.id, s.survey_no, s.code
       FROM lms.survey s
       LEFT JOIN lms.project_survey ps ON ps.survey_id = s.id AND ps.project_id = $1
       WHERE ps.project_id = $1
          OR s.province_code = (SELECT province_code FROM lms.project WHERE id = $1)`,
      [projectId]
    );
    const surveyMap = new Map<string, string>();
    for (const s of surveyRes.rows) {
      surveyMap.set(s.survey_no.toLowerCase().trim(), s.id);
      surveyMap.set(s.code.toLowerCase().trim(), s.id);
    }

    // 3. Insert features
    const insertFeatSql = `
      INSERT INTO lms.project_spatial_feature (
        import_id, project_id, survey_id, feature_name, geometry_type,
        coordinates, area_sqm, area_acres, source_file, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `;

    for (const feat of parseResult.features) {
      // Find matching survey
      const cleanName = feat.name.toLowerCase().trim();
      const matchedSurveyId = surveyMap.get(cleanName) || null;

      await client.query(insertFeatSql, [
        importId,
        projectId,
        matchedSurveyId,
        feat.name,
        feat.geometryType,
        JSON.stringify(feat.coordinates),
        feat.areaSqm,
        feat.areaAcres,
        filename,
        JSON.stringify({
          ...feat.metadata,
          isValid: feat.isValid,
          validationError: feat.validationError,
        }),
      ]);
    }

    await client.query('COMMIT');

    return NextResponse.json({
      success: true,
      importId,
      filename,
      layerName,
      featureCount: parseResult.features.length,
      errors: parseResult.errors,
      message: `Successfully ingested ${parseResult.features.length} spatial features into project GIS repository.`,
    });
  } catch (error: any) {
    await client.query('ROLLBACK');
    console.error('KML upload error:', error);
    return toResponse(error, ctx.correlationId);
  } finally {
    client.release();
  }
});
