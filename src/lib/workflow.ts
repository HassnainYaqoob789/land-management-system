// Server-side workflow helpers shared by the create routes.
import type { PoolClient } from 'pg';
import { HttpError, type ScopedTable } from '@/lib/iam/http';

/** The permission resource that governs each workflow's records. */
export const WORKFLOW_RESOURCE: Record<string, string> = {
  cases: 'cases', acquisitions: 'acquisitions', mutations: 'mutations', leases: 'leases', rows: 'rows',
  payments: 'payments', dbpfc: 'dbpfc', grievances: 'grievances', encroachments: 'encroachments',
};

/** The table behind each workflow (lms.workflow.entity_table). */
export const WORKFLOW_TABLE: Record<string, ScopedTable> = {
  cases: 'compensation_case', acquisitions: 'acquisition', mutations: 'mutation', leases: 'lease', rows: 'row_corridor',
  payments: 'payment_request', dbpfc: 'dbpfc_estimate', grievances: 'grievance', encroachments: 'encroachment',
};

/**
 * Send a record back to its first stage so its approved terms can change
 * (AUTHZ-10). The database records a 'Reopened' transition, closes the open
 * queue entry, queues the first approval again and starts a new approval
 * round; it refuses closed or locked records. Returns the stage it is now at.
 */
export async function reopenForChanges(client: PoolClient, workflow: string, recordId: string, reason: unknown): Promise<string> {
  if (typeof reason !== 'string' || reason.trim().length < 10)
    throw new HttpError(400, 'This record has approvals. Give a reason (at least 10 characters) for sending it back for changes; it will need approval again.', 'reopen_reason_required');
  const r = await client.query('SELECT api.reopen_workflow($1, $2, $3) AS stage', [workflow, recordId, reason.trim().slice(0, 500)]);
  return r.rows[0].stage;
}

/** Has the record been approved (in its current round) into `from` or later, or is it closed? */
export async function termsFrozen(client: PoolClient, workflow: string, recordId: string, stage: string, from: string): Promise<boolean> {
  const r = await client.query('SELECT lms.wf_terms_frozen($1, $2, $3, $4) AS frozen', [workflow, recordId, stage, from]);
  return r.rows[0]?.frozen === true;
}

/**
 * Put a newly created record in the queue for its first approval step, routed
 * by the approval matrix exactly as api.advance_workflow routes every later
 * step (the first position, in code order, that approves the next stage).
 * Does nothing if the record is already queued.
 */
export async function queueFirstStep(client: PoolClient, workflow: string, recordId: string): Promise<void> {
  // Only while the record is still at its first stage (an idempotent retry can hand back an older record).
  const wf = (await client.query(
    `SELECT w.entity_table, (SELECT code FROM lms.workflow_stage WHERE workflow_code = w.code AND NOT is_terminal ORDER BY seq LIMIT 1) AS first
       FROM lms.workflow w WHERE w.code = $1`, [workflow])).rows[0];
  if (!wf) throw new Error(`unknown workflow ${workflow}`);
  // entity_table comes from lms.workflow, which no application role can write; still quoted as an identifier.
  const cur = (await client.query(`SELECT stage_code FROM lms."${String(wf.entity_table).replace(/"/g, '""')}" WHERE id = $1`, [recordId])).rows[0];
  if (!cur || cur.stage_code !== wf.first) return;
  await client.query(
    `INSERT INTO lms.workflow_assignment (workflow_code, record_id, stage_code, assigned_group)
     SELECT $1, $2, ns.code, sg.group_code
       FROM lms.workflow_stage ns
       JOIN lms.workflow_step_group sg ON sg.workflow_code = $1 AND sg.to_stage = ns.code
      WHERE ns.workflow_code = $1 AND NOT ns.is_terminal
        AND ns.seq = (SELECT min(seq) + 1 FROM lms.workflow_stage WHERE workflow_code = $1 AND NOT is_terminal)
        AND NOT EXISTS (SELECT 1 FROM lms.workflow_assignment a WHERE a.workflow_code = $1 AND a.record_id = $2 AND a.closed_at IS NULL)
      ORDER BY sg.group_code
      LIMIT 1`,
    [workflow, recordId]);
}

type Lines = { lease_lines?: any[]; crop_lines?: any[]; tree_lines?: any[]; misc_lines?: any[] };

const num = (v: unknown, what: string) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new HttpError(400, `${what} must be a positive number`);
  return n;
};

/**
 * Replace a compensation case's valuation lines with the ones given (only the
 * kinds present in `lines` are replaced) and recompute its totals from them.
 * The totals are never taken from the client: api.recalculate_case_totals
 * derives them from the lines, and refuses once the case is locked.
 */
export async function writeCaseLines(client: PoolClient, caseId: string, lines: Lines): Promise<void> {
  if (Array.isArray(lines.lease_lines)) {
    await client.query('DELETE FROM lms.case_lease_line WHERE case_id = $1', [caseId]);
    let n = 1;
    for (const l of lines.lease_lines) {
      if (!l.survey_id) throw new HttpError(400, 'Each lease line needs a survey');
      await client.query(
        `INSERT INTO lms.case_lease_line (case_id, survey_id, survey_share_pct, lease_area, subsequent_area, line_no) VALUES ($1, $2, $3, $4, $5, $6)`,
        [caseId, l.survey_id, l.survey_share_pct === undefined || l.survey_share_pct === '' ? null : Number(l.survey_share_pct),
          num(l.lease_area, 'Lease area'), l.subsequent_area === undefined || l.subsequent_area === '' ? null : Number(l.subsequent_area), n++]);
    }
  }
  if (Array.isArray(lines.crop_lines)) {
    await client.query('DELETE FROM lms.case_crop_line WHERE case_id = $1', [caseId]);
    for (const l of lines.crop_lines) {
      if (!l.crop_type) throw new HttpError(400, 'Each crop line needs a crop');
      await client.query(`INSERT INTO lms.case_crop_line (case_id, survey_id, crop_type, rate_per_acre, damage_area) VALUES ($1, $2, $3, $4, $5)`,
        [caseId, l.survey_id || null, String(l.crop_type).trim(), num(l.rate_per_acre, 'Crop rate'), num(l.damage_area, 'Damaged area')]);
    }
  }
  if (Array.isArray(lines.tree_lines)) {
    await client.query('DELETE FROM lms.case_tree_line WHERE case_id = $1', [caseId]);
    for (const l of lines.tree_lines) {
      if (!l.species_code || !l.size) throw new HttpError(400, 'Each tree line needs a species and a size');
      await client.query(`INSERT INTO lms.case_tree_line (case_id, survey_id, species_code, size, rate, qty) VALUES ($1, $2, $3, $4, $5, $6)`,
        [caseId, l.survey_id || null, l.species_code, l.size, num(l.rate, 'Tree rate'), num(l.qty, 'Tree count')]);
    }
  }
  if (Array.isArray(lines.misc_lines)) {
    await client.query('DELETE FROM lms.case_misc_line WHERE case_id = $1', [caseId]);
    for (const l of lines.misc_lines) {
      if (!l.payment_type) throw new HttpError(400, 'Each other-compensation line needs a description');
      await client.query(`INSERT INTO lms.case_misc_line (case_id, survey_id, payment_type, amount) VALUES ($1, $2, $3, $4)`,
        [caseId, l.survey_id || null, String(l.payment_type).trim(), num(l.amount, 'Amount')]);
    }
  }
  await client.query('SELECT api.recalculate_case_totals($1)', [caseId]);
}
