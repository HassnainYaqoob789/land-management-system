import { NextResponse } from 'next/server';
import { protect, readJson, requireRecord, toResponse } from '@/lib/iam/http';

// Advance a compensation case one step. cases:approve must cover this case's
// province and project (a grant limited to another province does not); the
// database then applies the approval matrix and separation of duties.
export const POST = protect({ permission: ['cases', 'approve'] }, async (ctx) => {
  try {
    const { id: caseId } = ctx.params ?? {};
    const body = await readJson(ctx.req);
    const { to_stage, note, as_group } = body;

    const transitioned = await ctx.db.withTransaction(async (client) => {
      await requireRecord(ctx, 'compensation_case', caseId, ['cases', 'approve'], { forUpdate: true });
      const res = await client.query(
        'SELECT api.advance_workflow($1, $2, $3, $4, $5) as new_stage',
        ['cases', caseId, typeof to_stage === 'string' && to_stage ? to_stage : null,
         typeof note === 'string' && note.trim() ? note.trim() : null,
         typeof as_group === 'string' && as_group ? as_group : null]
      );
      return res.rows[0];
    });

    return NextResponse.json({
      success: true,
      new_stage: transitioned.new_stage,
      message: `Case advanced successfully to ${transitioned.new_stage}`,
    });
  } catch (error: any) {
    return toResponse(error, ctx.correlationId);
  }
});
