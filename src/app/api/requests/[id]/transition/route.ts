import { HttpError, json, protect, readJson, requireLinked, requireRecord, toResponse } from '@/lib/iam/http';
import { parcelsInside, ringOf } from '@/lib/landRequestArea';

// A land request moves Initiator → Director Operations → Regional Manager →
// DM / TL Land Affairs → (Land Officer) hand-over. Each tier is an approval
// position (migration 0042); only a holder of the position for the request's
// current tier decides it, in their own name, for a request in a province they
// may approve in (AUTHZ-03). A draft or returned request is sent on (or
// withdrawn) only by the person who raised it. The database also refuses the
// requester and anyone deciding two tiers (lms.tg_land_request_sod), a tier
// decided by someone who does not hold its position (lms.tg_land_request_tier),
// and a hand-over by anyone but a Land Officer (Field) (0057).
//
// Actions:
//   SUBMIT    requester: Draft / Returned → Submitted (APPROVE is accepted for this too)
//   WITHDRAW  requester: Draft / Returned → Withdrawn (REJECT is accepted for this too)
//   APPROVE / RETURN / REJECT   the tier's position holder
//   HANDOVER  Land Officer (Field): Approved → Handed over
const TIERS: Record<string, { group: string; prefix: string; next: string; nextRole: string }> = {
  'Submitted': { group: 'Director Operations', prefix: 'director_ops', next: 'Under Review - Regional', nextRole: 'Regional Manager' },
  'Under Review - Ops': { group: 'Director Operations', prefix: 'director_ops', next: 'Under Review - Regional', nextRole: 'Regional Manager' },
  'Under Review - Regional': { group: 'Regional Manager', prefix: 'regional_mgr', next: 'Under Review - Land Affairs', nextRole: 'DM / TL Land Affairs' },
  'Under Review - Land Affairs': { group: 'DM / TL Land Affairs', prefix: 'land_affairs', next: 'Approved', nextRole: 'Land Officer (Field)' },
};
const ACTIONS = ['APPROVE', 'REJECT', 'RETURN', 'SUBMIT', 'WITHDRAW', 'HANDOVER'];
const HANDOVER_KINDS = ['Acquisition', 'Lease', 'Compensation case', 'DBPFC'];
const CLOSED = ['Rejected', 'Withdrawn', 'Handed over'];

export const POST = protect({ authenticatedOnly: true }, async (ctx) => {
  try {
    if (!ctx.has('requests', 'approve') && !ctx.has('requests', 'create'))
      return json({ error: 'You do not have permission to do that.', code: 'forbidden', correlationId: ctx.correlationId }, 403);

    const { id } = ctx.params ?? {};
    const body = await readJson(ctx.req);
    const { action, comment, allocated_survey_id } = body;

    if (typeof action !== 'string' || !ACTIONS.includes(action.toUpperCase()))
      return json({ error: `Valid action (${ACTIONS.join(', ')}) is required`, code: 'validation' }, 400);
    const act = action.toUpperCase();
    const text = typeof comment === 'string' ? comment.trim() : '';
    // Sending your own request on needs no comment; every decision does.
    if (!text && act !== 'SUBMIT')
      return json({ error: 'Audit comment is mandatory for all workflow decisions', code: 'validation' }, 400);
    const note = (text || 'Submitted for review').slice(0, 2000);

    const rec = await requireRecord(ctx, 'land_request', id, [['requests', 'approve'], ['requests', 'create']], { forUpdate: true });
    const req = rec.row;
    if (req.stage_code === 'Draft' && req.created_by !== ctx.user.id) throw new HttpError(404, 'Land request not found.', 'not_found');
    if (CLOSED.includes(req.stage_code))
      throw new HttpError(409, `Cannot transition a closed request in stage ${req.stage_code}`, 'state');

    let newStage: string;
    let newRole: string;
    const extra: string[] = [];
    const vals: any[] = [];
    const add = (sql: string, v: any) => { vals.push(v); extra.push(sql.replace('?', `$${vals.length + 4}`)); };
    let marked: string[] = [];

    if (req.stage_code === 'Draft' || req.stage_code === 'Returned') {
      // The initiator sends it (again) or withdraws it.
      if (req.created_by !== ctx.user.id || !ctx.can('requests', 'create', { province: rec.province, project: rec.project }))
        throw new HttpError(403, 'Only the person who raised this request can send it on or withdraw it.', 'forbidden');
      if (act === 'RETURN' || act === 'HANDOVER') throw new HttpError(409, 'This request is still with its initiator.', 'state');
      if (act === 'APPROVE' || act === 'SUBMIT') {
        if (!String(req.justification ?? '').trim()) throw new HttpError(400, 'Add the justification before sending the request.', 'validation');
        if (!(Number(req.area_acres) > 0 || Number(req.area_ghunta) > 0)) throw new HttpError(400, 'Draw the land area or state the required area before sending the request.', 'validation');
        newStage = 'Submitted'; newRole = 'Director Operations';
        add('submitted_at = ?', new Date());
        // A new round: every tier decides again. The earlier decisions stay in the audit trail.
        if (req.stage_code === 'Returned')
          for (const p of ['director_ops', 'regional_mgr', 'land_affairs'])
            for (const c of ['id', 'action', 'comment', 'date']) extra.push(`${p}_${c} = NULL`);
      } else { newStage = 'Withdrawn'; newRole = 'None'; }
    } else if (req.stage_code === 'Approved') {
      if (act !== 'HANDOVER') throw new HttpError(409, 'This request is approved. The Land Officer takes it up with "Start land work".', 'state');
      if (!ctx.can('requests', 'create', { province: rec.province, project: rec.project }))
        throw new HttpError(403, 'You are not permitted to take up land requests in this province.', 'forbidden');
      const held = await ctx.client.query(`SELECT 1 FROM lms.app_user_group WHERE user_id = $1 AND group_code = 'Land Officer (Field)'`, [ctx.user.id]);
      if (!held.rows.length) throw new HttpError(403, 'An approved request is taken up by the Land Officer (Field) of its province.', 'forbidden');
      const kind = body.handover_kind;
      if (!HANDOVER_KINDS.includes(kind)) throw new HttpError(400, `Choose what the land work is: ${HANDOVER_KINDS.join(', ')}.`, 'validation');
      newStage = 'Handed over'; newRole = 'None';
      add('handed_over_by = ?', ctx.user.id);
      add('handed_over_at = ?', new Date());
      add('handed_over_kind = ?', kind);
      add('handed_over_comment = ?', note);

      // Optionally mark the recorded parcels inside the polygon "Under Acquisition" (only those still "Proposed").
      // Only for acquisition: a lease or DBPFC hand-over does not put the land under acquisition.
      if (body.mark_parcels === true && kind === 'Acquisition') {
        if (!ctx.can('surveys', 'update', { province: rec.province }))
          throw new HttpError(403, 'Marking parcels needs permission to update the survey register.', 'forbidden');
        const a = (await ctx.client.query(
          'SELECT geometry FROM lms.land_request_area WHERE land_request_id = $1 ORDER BY version DESC LIMIT 1', [rec.id])).rows[0];
        const inside = a ? await parcelsInside(ctx.client, rec.province!, ringOf(a.geometry)) : [];
        const ids = inside.filter((p) => p.status === 'Proposed').map((p) => p.id);
        if (ids.length) {
          const u = await ctx.client.query(
            `UPDATE lms.survey SET status_code = 'Under Acquisition', updated_by = $2, updated_at = now()
              WHERE id = ANY($1::uuid[]) AND status_code = 'Proposed' RETURNING code`, [ids, ctx.user.id]);
          marked = u.rows.map((x) => x.code);
        }
      }
    } else {
      const tier = TIERS[req.stage_code];
      if (!tier) throw new HttpError(409, `A request in stage ${req.stage_code} cannot be decided here.`, 'state');
      if (!['APPROVE', 'REJECT', 'RETURN'].includes(act)) throw new HttpError(409, 'This request is under review: approve, return or reject it.', 'state');
      if (!ctx.can('requests', 'approve', { province: rec.province, project: rec.project }))
        throw new HttpError(403, 'You are not permitted to decide land requests in this province.', 'forbidden');
      const held = await ctx.client.query('SELECT 1 FROM lms.app_user_group WHERE user_id = $1 AND group_code = $2', [ctx.user.id, tier.group]);
      if (!held.rows.length) throw new HttpError(403, `This tier is decided by the ${tier.group} position.`, 'forbidden');

      const decision = act === 'APPROVE' ? 'APPROVED' : act === 'REJECT' ? 'REJECTED' : 'RETURNED';
      let allocated: string | null = null;
      if (act === 'APPROVE' && tier.next === 'Approved' && allocated_survey_id)
        [allocated] = await requireLinked(ctx, 'survey', [allocated_survey_id], rec.province, 'parcel');
      // The prefix is one of three fixed column families above, never request input.
      await ctx.client.query(
        `UPDATE lms.land_request
            SET ${tier.prefix}_id = $1, ${tier.prefix}_action = $2, ${tier.prefix}_comment = $3, ${tier.prefix}_date = now(),
                allocated_survey_id = COALESCE($4, allocated_survey_id)
          WHERE id = $5`,
        [ctx.user.id, decision, note, allocated, rec.id]);

      if (act === 'APPROVE') { newStage = tier.next; newRole = tier.nextRole; }
      else if (act === 'REJECT') { newStage = 'Rejected'; newRole = 'None'; }
      else { newStage = 'Returned'; newRole = 'Initiator'; }
    }

    const upd = await ctx.client.query(
      `UPDATE lms.land_request
          SET stage_code = $1, pending_approver_role = $2, updated_by = $3, updated_at = now()${extra.length ? ', ' + extra.join(', ') : ''}
        WHERE id = $4
        RETURNING *`,
      [newStage, newRole, ctx.user.id, rec.id, ...vals]);
    const updated = upd.rows[0];

    return json({
      success: true,
      request: updated,
      parcels_marked: marked,
      message: `Land request successfully updated to ${updated.stage_code}`,
    });
  } catch (e) {
    return toResponse(e, ctx.correlationId);
  }
});
