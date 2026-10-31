import { NextResponse } from 'next/server';
import { HttpError, protect, readJson, requireRecord, toResponse } from '@/lib/iam/http';

// Renew an approved lease: extend its term and escalate the agreed rate. The
// renewal is made by the position that approves leases, the escalation is
// bounded by policy (leases.max_renewal_escalation_pct) and a held,
// terminated or unapproved lease is refused, all in api.renew_lease (AUTHZ-10).
export const POST = protect({ permission: ['leases', 'update'] }, async (ctx) => {
  try {
    const { id } = ctx.params ?? {};
    const body = await readJson(ctx.req);
    const years = body.additional_years === undefined ? 1 : Number(body.additional_years);
    const escPct = body.escalation_pct === undefined ? 10.0 : Number(body.escalation_pct);
    const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim()
      : 'Annual renewal and escalation applied per agreement terms';
    if (!Number.isInteger(years)) throw new HttpError(400, 'additional_years must be a whole number of years.', 'validation');
    if (!Number.isFinite(escPct)) throw new HttpError(400, 'escalation_pct must be a number.', 'validation');

    const result = await ctx.db.withTransaction(async (client) => {
      await requireRecord(ctx, 'lease', id, ['leases', 'update']);
      const r = await client.query('SELECT api.renew_lease($1, $2, $3, $4) AS renewal', [id, years, escPct, note.slice(0, 500)]);
      const lease = (await client.query('SELECT * FROM lms.lease WHERE id = $1', [id])).rows[0];
      return { lease, ...r.rows[0].renewal };
    });

    return NextResponse.json({ success: true, ...result });
  } catch (error: any) {
    return toResponse(error, ctx.correlationId);
  }
});
