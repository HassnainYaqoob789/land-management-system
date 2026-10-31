import { NextResponse } from 'next/server';
import { HttpError, protect, readJson, requireRecord, toResponse } from '@/lib/iam/http';

const FINANCE: [string, string][] = [['payments', 'verify'], ['payments', 'release']];

// Put a lease on hold, or release it. A held lease holds its own vouchers: the
// database refuses to verify or release a payment against it
// (lms.wf_guard_payments). Freezing every payment of a project is a finance
// hold (POST /api/payments action=hold), never a side effect of a lease
// edit (AUTHZ-12).
export const POST = protect({ permission: ['leases', 'update'] }, async (ctx) => {
  try {
    const { id } = ctx.params ?? {};
    const body = await readJson(ctx.req);
    const { action, reason } = body;

    if (typeof action !== 'string' || !['HOLD', 'RELEASE'].includes(action.toUpperCase())) {
      return NextResponse.json({ error: 'Valid action (HOLD, RELEASE) is required', code: 'validation' }, { status: 400 });
    }
    if (typeof reason !== 'string' || reason.trim() === '') {
      return NextResponse.json({ error: 'A formal reason is mandatory for placing or releasing a lease hold', code: 'validation' }, { status: 400 });
    }
    const normalizedAction = action.toUpperCase();
    const why = reason.trim().slice(0, 1000);

    const updated = await ctx.db.withTransaction(async (client) => {
      const lease = (await requireRecord(ctx, 'lease', id, ['leases', 'update'], { forUpdate: true })).row;

      if (normalizedAction === 'HOLD') {
        if (lease.is_on_hold) throw new HttpError(409, 'Lease is already on hold', 'state');
        const updateRes = await client.query(
          `UPDATE lms.lease
           SET is_on_hold = true, hold_reason = $1, hold_placed_at = now(), hold_placed_by = $2,
               updated_by = $2, updated_at = now()
           WHERE id = $3
           RETURNING *`,
          [why, ctx.user.id, lease.id]
        );
        return { lease: updateRes.rows[0] };
      }

      if (!lease.is_on_hold) throw new HttpError(409, 'Lease is not currently on hold', 'state');
      const updateRes = await client.query(
        `UPDATE lms.lease
         SET is_on_hold = false, hold_lifted_at = now(), hold_lifted_by = $1, hold_lift_reason = $2,
             updated_by = $1, updated_at = now()
         WHERE id = $3
         RETURNING *`,
        [ctx.user.id, why, lease.id]
      );
      // Project-wide payment holds placed by earlier versions of this route are
      // finance holds; only finance lifts them (POST /api/payments action=lift_hold).
      let projectHoldsLifted = 0;
      let projectHoldsRemaining = 0;
      if (lease.project_id) {
        const pattern = `Lease ${String(lease.code).replace(/[\\%_]/g, (c) => `\\${c}`)} Hold:%`;
        if (FINANCE.some(([r, a]) => ctx.can(r, a, { province: lease.province_code, project: lease.project_id }))) {
          const lifted = await client.query(
            `UPDATE lms.payment_hold SET lifted_at = now(), lifted_by = $1, lift_reason = $2
              WHERE project_id = $3 AND lifted_at IS NULL AND legal_case_id IS NULL AND reason LIKE $4`,
            [ctx.user.id, why, lease.project_id, pattern]);
          projectHoldsLifted = lifted.rowCount ?? 0;
        } else {
          projectHoldsRemaining = Number((await client.query(
            `SELECT count(*) AS n FROM lms.payment_hold WHERE project_id = $1 AND lifted_at IS NULL AND reason LIKE $2`,
            [lease.project_id, pattern])).rows[0].n);
        }
      }
      return { lease: updateRes.rows[0], project_holds_lifted: projectHoldsLifted, project_holds_remaining: projectHoldsRemaining };
    });

    return NextResponse.json({ success: true, action: normalizedAction, ...updated });
  } catch (error: any) {
    return toResponse(error, ctx.correlationId);
  }
});
