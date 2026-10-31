import { NextResponse } from 'next/server';
import { HttpError, json, protect, requireReauth, requireRecord, toResponse, type Ctx, type ScopedTable } from '@/lib/iam/http';
import {
  DOCUMENT_ENTITIES, DOCUMENT_RESOURCE, MAX_DOCUMENT_BYTES, IntegrityError, cleanFileName, readVerified, sniffMime, storeBytes,
} from '@/lib/documents';

// Documents attached to land records. Bytes go to the content-addressed store
// (src/lib/documents.ts); the row records who uploaded what, its true type,
// size and SHA-256, and which record it belongs to. Province comes from that
// record, read under the uploader's own row-level security, so nobody can file
// a document against a record they cannot see.
//
// A document is evidence of its record: seeing it needs the record's module
// permission as well as documents:read (UI-09), for the record's province.

/** Entities whose documents this caller may see at all. */
const readableEntities = (ctx: Ctx) => Object.keys(DOCUMENT_RESOURCE).filter((e) => ctx.has(DOCUMENT_RESOURCE[e], 'read'));
/** And for one document's province. */
const mayRead = (ctx: Ctx, entity: string, province: string | null) =>
  !!DOCUMENT_RESOURCE[entity] && ctx.can('documents', 'read', { province }) && ctx.can(DOCUMENT_RESOURCE[entity], 'read', { province });

export const GET = protect({ permission: ['documents', 'read'] }, async (ctx) => {
  try {
    const sp = new URL(ctx.req.url).searchParams;

    // Download: GET /api/documents?download=<id>
    const download = sp.get('download');
    if (download) {
      const d = (await requireRecord(ctx, 'document', download, ['documents', 'read'])).row;
      if (d.deleted_at || !mayRead(ctx, d.entity, d.province_code)) throw new HttpError(404, 'Document not found', 'not_found');
      let bytes: Buffer;
      try { bytes = await readVerified(d.storage_ref, d.content_sha256); } catch (e) {
        if (e instanceof IntegrityError) throw new HttpError(409, e.message, 'integrity');
        throw e;
      }
      await ctx.client.query(`INSERT INTO lms.document_access_log (document_id, accessed_by, action) VALUES ($1, $2, 'download')`,
        [d.id, ctx.user.id]);
      return new NextResponse(new Uint8Array(bytes), {
        headers: {
          'Content-Type': d.mime_type,
          'Content-Length': String(bytes.length),
          'Content-Disposition': `attachment; filename="${cleanFileName(d.file_name)}"`,
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'private, no-store',
        },
      });
    }

    const entities = readableEntities(ctx);
    const params: unknown[] = [entities];
    let where = 'd.deleted_at IS NULL AND d.entity = ANY($1::text[])';
    const province = sp.get('province');
    if (province && province !== 'ALL') { params.push(province); where += ` AND d.province_code = $${params.length}`; }
    const entity = sp.get('entity');
    if (entity) { params.push(entity); where += ` AND d.entity = $${params.length}`; }
    const recordId = sp.get('record_id');
    if (recordId) { params.push(recordId); where += ` AND d.record_id = $${params.length}`; }

    const [docs, cats, logs] = await Promise.all([
      ctx.client.query(
        `SELECT d.id, d.code, d.entity, d.record_id, d.record_code, d.province_code, d.file_name, d.mime_type,
                d.size_bytes, d.category_code, d.version, encode(d.content_sha256, 'hex') AS sha256_hex,
                d.uploaded_at, dc.name AS category_name, lms.user_full_name(d.uploaded_by) AS uploaded_by_name,
                (SELECT count(*) FROM lms.document_access_log l WHERE l.document_id = d.id)::int AS access_count
           FROM lms.document d
           JOIN lms.document_category dc ON dc.code = d.category_code
          WHERE ${where}
          ORDER BY d.uploaded_at DESC
          LIMIT 500`, params),
      ctx.client.query('SELECT code, name, retention_years FROM lms.document_category ORDER BY display_order'),
      ctx.client.query(
        `SELECT l.id, l.document_id, l.action, l.accessed_at, d.code AS doc_code, d.file_name, d.entity, d.province_code,
                lms.user_full_name(l.accessed_by) AS user_name
           FROM lms.document_access_log l
           JOIN lms.document d ON d.id = l.document_id
          WHERE d.entity = ANY($1::text[])
          ORDER BY l.accessed_at DESC LIMIT 50`, [entities]),
    ]);
    // A grant limited to one province covers that province's documents only.
    return json({
      documents: docs.rows.filter((d: any) => mayRead(ctx, d.entity, d.province_code)),
      categories: cats.rows,
      access_logs: logs.rows.filter((l: any) => mayRead(ctx, l.entity, l.province_code)),
    });
  } catch (e) {
    return toResponse(e, ctx.correlationId);
  }
});

// Upload: multipart/form-data with file, category_code, entity, record_id.
export const POST = protect({ permission: ['documents', 'create'] }, async (ctx) => {
  try {
    const form = await ctx.req.formData().catch(() => { throw new HttpError(400, 'Send the document as multipart/form-data.'); });
    const file = form.get('file');
    const category = String(form.get('category_code') || '');
    const entity = String(form.get('entity') || '');
    const recordId = String(form.get('record_id') || '');
    if (!(file instanceof File) || file.size === 0) throw new HttpError(400, 'Choose a file to upload.');
    if (file.size > MAX_DOCUMENT_BYTES) throw new HttpError(413, 'Documents are limited to 50 MB.');
    if (!category) throw new HttpError(400, 'Choose a document category.');
    const table = DOCUMENT_ENTITIES[entity];
    if (!table || !/^[0-9a-f-]{36}$/i.test(recordId)) throw new HttpError(400, 'Choose the record this document belongs to.');

    const name = cleanFileName(file.name);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const mime = sniffMime(bytes, name);
    if (!mime) throw new HttpError(415, 'Only PDF, JPEG, PNG, TIFF, Word (.docx) and Excel (.xlsx) files are accepted.');

    // The record, read with the uploader's own visibility: invisible, or outside the
    // provinces where the uploader may read that module and add documents, is refused.
    const rec = await requireRecord(ctx, table as ScopedTable, recordId, [DOCUMENT_RESOURCE[entity], 'read']);
    if (!ctx.can('documents', 'create', { province: rec.province }))
      throw new HttpError(404, 'That record does not exist or is outside your province access.', 'not_found');

    const stored = await storeBytes(bytes);
    const r = await ctx.client.query(
      `INSERT INTO lms.document (code, entity, record_id, record_code, province_code, file_name, mime_type, size_bytes,
                                 category_code, version, storage_ref, content_sha256, uploaded_by)
       SELECT lms.next_code('DOC-'), $1, $2, $3, $4, $5, $6, $7, $8,
              coalesce((SELECT max(version) FROM lms.document WHERE entity = $1 AND record_id = $2 AND file_name = $5), 0) + 1,
              $9, $10, $11
       RETURNING id, code, version, encode(content_sha256, 'hex') AS sha256_hex`,
      [entity, rec.id, rec.row.code, rec.province, name, mime, bytes.length, category, stored.ref, stored.sha256, ctx.user.id]);
    return json({ success: true, document: r.rows[0] }, 201);
  } catch (e) {
    return toResponse(e, ctx.correlationId);
  }
});

// Access logging and archiving.
export const PUT = protect({ permission: ['documents', 'read'] }, async (ctx) => {
  try {
    const body = await ctx.req.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'A JSON object body is required.');
    const { id, action, access_action = 'view', delete_reason } = body;
    if (!id) throw new HttpError(400, 'Document ID is required');

    if (action === 'log_access') {
      // Logged only for a document the caller can see (AUTHZ-20); the database checks the same.
      const d = (await requireRecord(ctx, 'document', id, ['documents', 'read'])).row;
      if (d.deleted_at || !mayRead(ctx, d.entity, d.province_code)) throw new HttpError(404, 'Document not found', 'not_found');
      const act = ['view', 'download', 'print'].includes(access_action) ? access_action : 'view';
      await ctx.client.query(`INSERT INTO lms.document_access_log (document_id, accessed_by, action) VALUES ($1, $2, $3)`, [d.id, ctx.user.id, act]);
      return json({ success: true, logged: act });
    }
    if (action === 'delete') {
      // Archiving removes evidence from everyone's view (AUTHZ-19): it needs documents:update
      // and the record's own update permission, a reason and a fresh proof of identity. The
      // database refuses the uploader and any record that is approved or closed.
      if (!ctx.has('documents', 'update')) throw new HttpError(403, 'You do not have permission to archive documents.', 'forbidden');
      if (typeof delete_reason !== 'string' || delete_reason.trim().length < 5) throw new HttpError(400, 'Give a reason for archiving (at least 5 characters).');
      const d = (await requireRecord(ctx, 'document', id, ['documents', 'update'], { forUpdate: true })).row;
      const resource = DOCUMENT_RESOURCE[d.entity];
      if (d.deleted_at || !resource || !ctx.can(resource, 'update', { province: d.province_code }))
        throw new HttpError(404, 'Document not found', 'not_found');
      await requireReauth(ctx);
      const r = await ctx.client.query(
        `UPDATE lms.document SET deleted_at = now(), deleted_by = $2, delete_reason = $3
          WHERE id = $1 AND deleted_at IS NULL RETURNING id, code, deleted_at`, [d.id, ctx.user.id, delete_reason.trim().slice(0, 500)]);
      if (!r.rows.length) throw new HttpError(404, 'Document not found', 'not_found');
      return json({ success: true, document: r.rows[0] });
    }
    throw new HttpError(400, 'Invalid action');
  } catch (e) {
    return toResponse(e, ctx.correlationId);
  }
});
