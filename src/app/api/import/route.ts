import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { HttpError, json, protect, readJson, requireRecord, toResponse } from '@/lib/iam/http';
import { redact } from '@/lib/iam/pii';

const MAX_ROWS = 10_000;
const MAX_BODY = 8 * 1024 * 1024;

// A validation message must not tell the uploader which landowner (and so which
// province) already holds a CNIC (AUTHZ-13).
const sanitize = (e: any) => ({ ...e, message: typeof e.message === 'string'
  ? e.message.replace(/(already registered)\s+as\s+\S+/gi, '$1') : e.message });

export const GET = protect({ permission: ['import', 'read'] }, async (ctx) => {
  const { query } = ctx.db;

  try {
    const { searchParams } = new URL(ctx.req.url);
    const batchId = searchParams.get('id');

    if (batchId) {
      const batch = (await requireRecord(ctx, 'import_batch', batchId, ['import', 'read'])).row;
      const [batchRes, rowsRes, errRes] = await Promise.all([
        query(
          `SELECT ib.*, encode(ib.source_sha256, 'hex') as sha256_hex, lms.user_full_name(ib.uploaded_by) as uploaded_by_name
           FROM lms.import_batch ib
           WHERE ib.id = $1`,
          [batch.id]
        ),
        query(`SELECT * FROM lms.import_row WHERE batch_id = $1 ORDER BY source_line ASC LIMIT 200`, [batch.id]),
        query(`SELECT * FROM lms.import_validation_error WHERE batch_id = $1 ORDER BY source_line ASC LIMIT 1000`, [batch.id]),
      ]);
      // Staged rows carry CNICs, phones and bank details as typed; masked without pii:read.
      return NextResponse.json(redact({
        batch: batchRes.rows[0],
        rows: rowsRes.rows.map((r: any) => ({ province_code: batch.province_code, ...r })),
        errors: errRes.rows.map(sanitize),
      }, ctx));
    }

    const [batchesRes, migReconRes] = await Promise.all([
      query(
        `SELECT ib.*, encode(ib.source_sha256, 'hex') as sha256_hex,
                lms.user_full_name(ib.uploaded_by) as uploaded_by_name,
                lms.user_full_name(ib.promoted_by) as promoted_by_name
         FROM lms.import_batch ib
         ORDER BY ib.uploaded_at DESC LIMIT 200`
      ),
      query(`SELECT *, run_label AS source_sheet FROM lms.migration_reconciliation ORDER BY checked_at DESC LIMIT 200`),
    ]);

    return NextResponse.json({
      batches: batchesRes.rows.filter((b: any) => ctx.can('import', 'read', { province: b.province_code })),
      migration_reconciliations: migReconRes.rows,
    });
  } catch (error: any) {
    return toResponse(error, ctx.correlationId);
  }
});

// Staging needs import:create; checking a batch and loading it into the
// registers is a separate decision, import:update, in the batch's province, by
// someone other than the uploader (UI-16, AUTHZ-13).
export const POST = protect({ authenticatedOnly: true }, async (ctx) => {
  const { withTransaction } = ctx.db;
  try {
    const body = await readJson(ctx.req, MAX_BODY);
    const { action, batch_id, target_entity, province_code, source_file, note, rows } = body;

    if (action === 'validate' || action === 'promote') {
      if (!ctx.has('import', 'update'))
        return json({ error: 'You do not have permission to do that.', code: 'forbidden', correlationId: ctx.correlationId }, 403);
      if (!batch_id) return NextResponse.json({ error: 'batch_id is required', code: 'validation' }, { status: 400 });
      const result = await withTransaction(async (client) => {
        const batch = (await requireRecord(ctx, 'import_batch', batch_id, ['import', 'update'], { forUpdate: true })).row;
        if (action === 'validate') return (await client.query('SELECT * FROM api.validate_import_batch($1)', [batch.id])).rows[0];
        if (batch.uploaded_by === ctx.user.id)
          throw new HttpError(403, 'Segregation of duties: a batch is loaded by someone other than the person who staged it.', 'forbidden');
        return (await client.query('SELECT api.promote_import_batch($1) AS promoted_count', [batch.id])).rows[0]?.promoted_count;
      });
      return action === 'validate'
        ? NextResponse.json({ success: true, validation: result })
        : NextResponse.json({ success: true, promoted_count: result });
    }

    // Stage a new batch.
    if (!ctx.has('import', 'create'))
      return json({ error: 'You do not have permission to do that.', code: 'forbidden', correlationId: ctx.correlationId }, 403);
    if (typeof target_entity !== 'string' || typeof source_file !== 'string' || !source_file.trim() || !Array.isArray(rows) || rows.length === 0) {
      return NextResponse.json({ error: 'target_entity, province_code, source_file and a non-empty rows array are required', code: 'validation' }, { status: 400 });
    }
    // The batch is filed in one real province; nothing is assumed for the uploader.
    if (typeof province_code !== 'string' || !/^[A-Z]{3}$/.test(province_code))
      return NextResponse.json({ error: 'province_code must name the province the rows belong to', code: 'validation' }, { status: 400 });
    if (rows.length > MAX_ROWS) return NextResponse.json({ error: `A batch holds at most ${MAX_ROWS} rows.`, code: 'validation' }, { status: 400 });
    if (!ctx.can('import', 'create', { province: province_code }))
      return json({ error: 'You may not import records into that province.', code: 'forbidden', correlationId: ctx.correlationId }, 403);
    // Every row belongs to the batch's province (AUTHZ-13).
    const stray = rows.findIndex((r: any) => !r || typeof r !== 'object' || Array.isArray(r)
      || (r.province_code !== undefined && r.province_code !== null && r.province_code !== '' && String(r.province_code).toUpperCase() !== province_code));
    if (stray >= 0) return NextResponse.json({ error: `Row ${stray + 1} is not an object in province ${province_code}.`, code: 'validation' }, { status: 400 });

    const created = await withTransaction(async (client) => {
      const codeRes = await client.query("SELECT lms.next_code('IMP-') as code");
      const impCode = codeRes.rows[0].code;

      const hashBuf = crypto
        .createHash('sha256')
        // A fingerprint of the staged content: the same rows give the same hash, so a re-import is recognisable.
        .update(JSON.stringify(rows))
        .digest();

      const batchIns = await client.query(
        `INSERT INTO lms.import_batch (
          code, target_entity, province_code, source_file, source_sha256,
          row_count, status, uploaded_by, note
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, 'staged', $7, $8
        ) RETURNING *`,
        [impCode, target_entity, province_code, source_file.trim().slice(0, 300), hashBuf, rows.length, ctx.user.id,
         typeof note === 'string' && note.trim() ? note.trim().slice(0, 1000) : 'Staged via Bulk Import Wizard']
      );
      const batch = batchIns.rows[0];

      for (let i = 0; i < rows.length; i++) {
        await client.query(
          `INSERT INTO lms.import_row (batch_id, source_line, raw, status)
           VALUES ($1, $2, $3, 'pending')`,
          [batch.id, i + 1, JSON.stringify({ ...rows[i], province_code })]
        );
      }

      // Immediately run validation so the user gets instant feedback
      const valRes = await client.query('SELECT * FROM api.validate_import_batch($1)', [batch.id]);
      const refreshed = await client.query('SELECT * FROM lms.import_batch WHERE id = $1', [batch.id]);

      return {
        batch: refreshed.rows[0],
        validation: valRes.rows[0],
      };
    });

    return NextResponse.json({ success: true, ...created });
  } catch (error: any) {
    return toResponse(error, ctx.correlationId);
  }
});
