import { NextResponse } from 'next/server';
import { protect, toResponse } from '@/lib/iam/http';
import { redact } from '@/lib/iam/pii';
import { pageOf } from '@/lib/paging';

// The audit trail. Row diffs and record snapshots carry whatever the audited
// row held, including CNICs, phones, bank accounts and addresses: those are
// masked for a reader without pii:read (an auditor sees who changed what and
// when, not the identity documents themselves).
export const GET = protect({ permission: ['audit_logs', 'read'] }, async (ctx) => {
  const { query } = ctx.db;

  try {
    const { searchParams } = new URL(ctx.req.url);
    const { limit } = pageOf(searchParams, { def: 100, max: 500 });
    const entity = searchParams.get('entity');
    const action = searchParams.get('action');
    const province = searchParams.get('province');

    let sql = `
      SELECT id, occurred_at, actor_username, actor_role, db_role, entity,
             record_id, record_code, province_code, action, changed_fields, note, txid, changes
      FROM api.v_audit_trail
      WHERE 1=1
    `;
    const params: any[] = [];

    if (entity) {
      params.push(entity);
      sql += ` AND entity = $${params.length}`;
    }

    if (action) {
      params.push(action);
      sql += ` AND action = $${params.length}`;
    }

    if (province && province !== 'ALL') {
      params.push(province);
      sql += ` AND province_code = $${params.length}`;
    }

    params.push(limit);
    sql += ` ORDER BY occurred_at DESC LIMIT $${params.length}`;

    const [auditRes, versionsRes, authEventsRes, docLogsRes, entitiesRes] = await Promise.all([
      query(sql, params),
      query(`SELECT *, valid_from AS captured_at FROM api.v_record_version_history ORDER BY valid_from DESC LIMIT 100`),
      query(`SELECT * FROM audit.auth_event ORDER BY occurred_at DESC LIMIT 100`),
      query(
        `SELECT dal.*, d.code as doc_code, d.file_name, d.entity, d.record_code, lms.user_full_name(dal.accessed_by) as user_name, lms.user_username(dal.accessed_by) AS username
         FROM lms.document_access_log dal
         JOIN lms.document d ON d.id = dal.document_id
         ORDER BY dal.accessed_at DESC LIMIT 100`
      ),
      query(`SELECT DISTINCT entity FROM api.v_audit_trail ORDER BY entity ASC`),
    ]);

    return NextResponse.json(redact({
      auditEvents: auditRes.rows,
      recordVersions: versionsRes.rows,
      authEvents: authEventsRes.rows,
      documentAccessLogs: docLogsRes.rows,
      distinctEntities: entitiesRes.rows.map((r: any) => r.entity),
    }, ctx));
  } catch (error: any) {
    return toResponse(error, ctx.correlationId);
  }
});
