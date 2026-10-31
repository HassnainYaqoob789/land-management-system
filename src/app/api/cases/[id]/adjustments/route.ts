import { HttpError, json, protect, readJson, str, toResponse } from '@/lib/iam/http';

// Award adjustments on an approved case (enhancement, court decree,
// correction): a signed amount and a reason. The database routine
// api.adjust_case enforces cases:approve in the case's province, separation of
// duties (not the person who prepared the case), the approved state and a
// non-negative award; the ledger is append-only and audited.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AMOUNT = /^-?\d{1,13}(\.\d{1,2})?$/;

const MONEY_SQL = `SELECT case_code::text AS case_code, stage_code, approved_amount, adjustment_amount, payable_amount,
                          paid_amount, wht_amount, paid_net_amount, outstanding_amount, settlement_status
                     FROM lms.case_money WHERE case_id = $1`;

function caseId(params: any): string {
  const id = String(params?.id ?? '');
  if (!UUID.test(id)) throw new HttpError(404, 'No such compensation case.', 'not_found');
  return id;
}

export const GET = protect({ permission: ['cases', 'read'] }, async (ctx) => {
  const id = caseId(ctx.params);
  const money = (await ctx.client.query(MONEY_SQL, [id])).rows[0];
  if (!money) throw new HttpError(404, 'No such compensation case.', 'not_found');
  const adjustments = (await ctx.client.query(
    `SELECT id, amount, reason, created_at, lms.user_full_name(created_by) AS created_by
       FROM lms.case_adjustment WHERE case_id = $1 ORDER BY created_at`, [id])).rows;
  return json({ case: money, adjustments });
});

export const POST = protect({ permission: ['cases', 'approve'], reauth: true }, async (ctx) => {
  const id = caseId(ctx.params);
  const body = await readJson(ctx.req, 10_000);
  const raw = body.amount;
  const amount = typeof raw === 'string' ? raw.trim() : typeof raw === 'number' && Number.isFinite(raw) && !/e/i.test(String(raw)) ? String(raw) : '';
  if (!AMOUNT.test(amount) || !/[1-9]/.test(amount)) throw new HttpError(400, 'amount must be a non-zero amount in rupees, with at most 2 decimal places (negative to reduce the award).', 'validation');
  const reason = str(body, 'reason', { max: 1000 }).trim();
  if (reason.length < 10) throw new HttpError(400, 'Give a reason of at least 10 characters.', 'validation');
  try {
    await ctx.client.query('SAVEPOINT adjust');
    const r = await ctx.client.query('SELECT api.adjust_case($1, $2::numeric, $3) AS id', [id, amount, reason]);
    await ctx.client.query('RELEASE SAVEPOINT adjust');
    const money = (await ctx.client.query(MONEY_SQL, [id])).rows[0];
    return json({ id: r.rows[0].id, case: money }, 201);
  } catch (e: any) {
    await ctx.client.query('ROLLBACK TO SAVEPOINT adjust').catch(() => {});
    if (e?.code === 'P0002') return json({ error: 'No such compensation case.', code: 'not_found', correlationId: ctx.correlationId }, 404);
    if (e?.code === '55000') return json({ error: e.message, code: 'conflict', correlationId: ctx.correlationId }, 409);
    return toResponse(e, ctx.correlationId);
  }
});
