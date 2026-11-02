import { protect, json, toResponse } from '@/lib/iam/http';
import { parseEnumCheck, type Reference } from '@/lib/reference';

// Every list the screens offer — workflow stages, lookup codes and the values
// a CHECK constraint allows — read from PostgreSQL, so the UI can never offer a
// value the database will refuse. None of these tables carries row-level
// security or per-user data, so one cached copy serves everyone; it is
// re-read after REFERENCE_TTL_MS, or at once when a client asks with ?fresh=1.

const REFERENCE_TTL_MS = 5 * 60 * 1000;
const LOOKUPS = ['land_use', 'land_status', 'project_type', 'payment_category', 'grievance_category',
  'encroachment_category', 'document_category', 'measurement_unit'] as const;

let cached: { at: number; value: Reference } | null = null;

export const GET = protect({ authenticatedOnly: true }, async (ctx) => {
  try {
    const fresh = new URL(ctx.req.url).searchParams.get('fresh') === '1';
    if (!cached || fresh || Date.now() - cached.at > REFERENCE_TTL_MS) {
      const q = (sql: string) => ctx.client.query(sql).then((r) => r.rows);
      const lookups: Reference['lookups'] = {};
      for (const t of LOOKUPS) lookups[t] = await q(`SELECT code, name FROM lms.${t} ORDER BY display_order, code`);

      const wf = await q(`SELECT w.code AS wf, w.label AS wf_label, w.allows_cancel, w.allows_stop, w.lock_at_stage,
                                 s.code, s.label, s.seq, s.is_terminal, s.step_note,
                                 coalesce((SELECT array_agg(g.group_code ORDER BY g.group_code) FROM lms.workflow_step_group g
                                            WHERE g.workflow_code = s.workflow_code AND g.to_stage = s.code), '{}') AS step_groups
                            FROM lms.workflow w JOIN lms.workflow_stage s ON s.workflow_code = w.code
                           ORDER BY w.code, s.seq`);
      const workflows: Reference['workflows'] = {};
      for (const r of wf) {
        workflows[r.wf] ??= { label: r.wf_label, stages: [], allowsCancel: r.allows_cancel, allowsStop: r.allows_stop, lockAt: r.lock_at_stage };
        workflows[r.wf].stages.push({ code: r.code, label: r.label, seq: r.seq, terminal: r.is_terminal, note: r.step_note, groups: r.step_groups ?? [] });
      }

      const checks = await q(`SELECT c.conrelid::regclass::text AS tbl, pg_get_constraintdef(c.oid) AS def
                                FROM pg_constraint c
                               WHERE c.contype = 'c' AND c.connamespace = 'lms'::regnamespace`);
      const enums: Reference['enums'] = {};
      for (const c of checks) {
        const parsed = parseEnumCheck(c.def);
        if (parsed) enums[`${String(c.tbl).replace(/^lms\./, '')}.${parsed[0]}`] = parsed[1];
      }

      const provinces = await q(`SELECT code, name FROM lms.province ORDER BY display_order, code`);
      cached = { at: Date.now(), value: { lookups, workflows, enums, provinces, loadedAt: new Date().toISOString() } };
    }
    const res = json(cached.value);
    res.headers.set('Cache-Control', 'private, max-age=300');
    return res;
  } catch (e) {
    return toResponse(e, ctx.correlationId);
  }
});
