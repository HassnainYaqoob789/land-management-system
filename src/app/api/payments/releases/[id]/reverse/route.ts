import { HttpError, json, protect, readJson, str, toResponse } from '@/lib/iam/http';

// Reverse a released cheque (returned, stopped, stale). The database routine
// api.reverse_release enforces payments:release in the voucher's province and
// separation of duties (not the person who released it); the voucher's
// allocations stop counting as paid, a replacement voucher can be raised, and
// the reversal is append-only and audited. [id] is the release id (or the
// voucher id).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const POST = protect({ permission: ['payments', 'release'], reauth: true }, async (ctx) => {
  const id = String(ctx.params?.id ?? '');
  if (!UUID.test(id)) throw new HttpError(404, 'No such payment release.', 'not_found');
  const body = await readJson(ctx.req, 10_000);
  const reason = str(body, 'reason', { max: 1000 }).trim();
  if (reason.length < 10) throw new HttpError(400, 'Give a reason of at least 10 characters.', 'validation');
  try {
    await ctx.client.query('SAVEPOINT reverse');
    const r = await ctx.client.query('SELECT api.reverse_release($1, $2) AS id', [id, reason]);
    await ctx.client.query('RELEASE SAVEPOINT reverse');
    const v = (await ctx.client.query(
      `SELECT rv.id, rv.amount, rv.reversed_at, pr.code::text AS voucher_code, pr.case_id
         FROM lms.payment_release_reversal rv JOIN lms.payment_request pr ON pr.id = rv.payment_id WHERE rv.id = $1`, [r.rows[0].id])).rows[0];
    return json({ id: r.rows[0].id, reversal: v }, 201);
  } catch (e: any) {
    await ctx.client.query('ROLLBACK TO SAVEPOINT reverse').catch(() => {});
    if (e?.code === 'P0002') return json({ error: 'No such payment release.', code: 'not_found', correlationId: ctx.correlationId }, 404);
    if (e?.code === '55000') return json({ error: e.message, code: 'conflict', correlationId: ctx.correlationId }, 409);
    return toResponse(e, ctx.correlationId);
  }
});
