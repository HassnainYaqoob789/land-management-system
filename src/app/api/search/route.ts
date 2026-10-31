import { protect, json, HttpError } from '@/lib/iam/http';
import type { Ctx } from '@/lib/iam/http';
import { likeOf } from '@/lib/paging';
import { canSeePii, maskCnic } from '@/lib/iam/pii';

// Global search for the top bar (UX-05). One request, grouped results, at most
// five per group, and only from what the caller may read:
//   - a group is searched only when the caller holds <module>:read;
//   - row-level security (the actor-scoped transaction from protect) limits the
//     rows, and each row is checked again against the grant's province/project
//     scope (ctx.can) before it is returned;
//   - search text is bound as a parameter (ILIKE with wildcards escaped; the
//     pg_trgm indexes serve the landowner name columns);
//   - a CNIC is matched only when the text looks like one AND the caller holds
//     pii:read (otherwise the search itself would confirm whose CNIC it is);
//     CNICs shown in results are masked unless the caller may see them in full.
// Each result links to the page that lists the record, filtered to it.

const PROVINCES = new Set(['SND', 'PNJ', 'BAL', 'KPK']);
const PER_GROUP = 5;
const FETCH = 25;          // rows read per group before the per-row scope check trims to PER_GROUP

interface Row { id: string; code: string; title: string | null; sub: string | null; tag: string | null; province_code: string | null; project_id: string | null; cnic?: string | null }
interface Item { id: string; code: string; title: string; sub: string; tag: string | null; href: string }
interface Group { key: string; label: string; module: string; href: (r: Row) => string; sql: string }

const byQ = (path: string) => (r: Row) => `${path}?q=${encodeURIComponent(r.code)}`;

// $1 = %q% (escaped), $2 = q% (escaped), $3 = province or NULL, $4 = row limit.
const GROUPS: Group[] = [
  {
    key: 'landowners', label: 'Landowners', module: 'landowners', href: byQ('/landowners'),
    // $5 = CNIC digits prefix (only set for pii:read holders typing a CNIC).
    sql: `SELECT lo.id, lo.code::text AS code, lo.full_name AS title,
                 concat_ws(' · ', 'S/o ' || nullif(lo.father_name, ''), lo.province_code) AS sub,
                 lo.status AS tag, lo.province_code, NULL::uuid AS project_id, lo.cnic::text AS cnic
            FROM lms.landowner lo
           WHERE ($3::text IS NULL OR lo.province_code = $3)
             AND (lo.full_name ILIKE $1 OR lo.father_name ILIKE $1 OR lo.code::text ILIKE $1
                  OR ($5::text IS NOT NULL AND replace(lo.cnic::text, '-', '') LIKE $5))
           ORDER BY (lo.code::text ILIKE $2 OR lo.full_name ILIKE $2) DESC, lo.full_name, lo.code
           LIMIT $4`,
  },
  {
    key: 'surveys', label: 'Survey / Khasra', module: 'surveys', href: byQ('/surveys'),
    sql: `SELECT s.id, s.code::text AS code, 'Survey / Khasra ' || coalesce(nullif(s.survey_no, ''), s.code::text) AS title,
                 concat_ws(' · ', 'Block ' || nullif(s.block_no, ''), s.khasra_type, s.province_code) AS sub,
                 s.land_class AS tag, s.province_code, NULL::uuid AS project_id
            FROM lms.survey s
           WHERE ($3::text IS NULL OR s.province_code = $3)
             AND (s.survey_no ILIKE $1 OR s.block_no ILIKE $1 OR s.code::text ILIKE $1)
           ORDER BY (s.survey_no ILIKE $2 OR s.code::text ILIKE $2) DESC, s.code
           LIMIT $4`,
  },
  {
    key: 'leases', label: 'Leases', module: 'leases', href: byQ('/leases'),
    sql: `SELECT l.id, l.code::text AS code, coalesce(p.name, 'Lease ' || l.code::text) AS title,
                 concat_ws(' · ', 'Reg. ' || nullif(l.registration_no, ''), l.province_code) AS sub,
                 l.stage_code AS tag, l.province_code, l.project_id
            FROM lms.lease l LEFT JOIN lms.project p ON p.id = l.project_id
           WHERE ($3::text IS NULL OR l.province_code = $3)
             AND (l.code::text ILIKE $1 OR l.registration_no ILIKE $1 OR p.name ILIKE $1)
           ORDER BY (l.code::text ILIKE $2) DESC, l.code
           LIMIT $4`,
  },
  {
    key: 'cases', label: 'Compensation cases', module: 'cases', href: byQ('/cases'),
    sql: `SELECT c.id, c.code::text AS code, coalesce(p.name, 'Case ' || c.code::text) AS title,
                 concat_ws(' · ', 'Lease no. ' || nullif(c.lease_no::text, ''), c.province_code) AS sub,
                 c.stage_code AS tag, c.province_code, c.project_id
            FROM lms.compensation_case c LEFT JOIN lms.project p ON p.id = c.project_id
           WHERE ($3::text IS NULL OR c.province_code = $3)
             AND (c.code::text ILIKE $1 OR c.lease_no::text ILIKE $1 OR p.name ILIKE $1)
           ORDER BY (c.code::text ILIKE $2) DESC, c.code
           LIMIT $4`,
  },
  {
    key: 'rows', label: 'Pipelines & ROW', module: 'rows', href: byQ('/rows'),
    sql: `SELECT r.id, r.code::text AS code, coalesce(nullif(r.name, ''), 'ROW ' || r.code::text) AS title,
                 concat_ws(' · ', r.row_type, r.province_code) AS sub,
                 r.stage_code AS tag, r.province_code, r.project_id
            FROM lms.row_corridor r
           WHERE ($3::text IS NULL OR r.province_code = $3)
             AND (r.code::text ILIKE $1 OR r.name ILIKE $1)
           ORDER BY (r.code::text ILIKE $2) DESC, r.code
           LIMIT $4`,
  },
  {
    key: 'payments', label: 'Payments', module: 'payments', href: byQ('/payments'),
    sql: `SELECT pr.id, pr.code::text AS code, coalesce(lo.full_name, pr.payee_name, 'Voucher ' || pr.code::text) AS title,
                 concat_ws(' · ', 'Voucher ' || pr.code::text, pr.province_code) AS sub,
                 pr.stage_code AS tag, pr.province_code, pr.project_id
            FROM lms.payment_request pr LEFT JOIN lms.landowner lo ON lo.id = pr.landowner_id
           WHERE ($3::text IS NULL OR pr.province_code = $3)
             AND (pr.code::text ILIKE $1 OR pr.payee_name ILIKE $1 OR lo.full_name ILIKE $1)
           ORDER BY (pr.code::text ILIKE $2) DESC, pr.code
           LIMIT $4`,
  },
  {
    key: 'projects', label: 'Projects / wells', module: 'projects', href: (r) => `/projdash?id=${encodeURIComponent(r.id)}`,
    sql: `SELECT p.id, p.code::text AS code, p.name AS title,
                 concat_ws(' · ', 'Block ' || nullif(p.block, ''), p.province_code) AS sub,
                 p.status AS tag, p.province_code, p.id AS project_id
            FROM lms.project p
           WHERE ($3::text IS NULL OR p.province_code = $3)
             AND (p.code::text ILIKE $1 OR p.name ILIKE $1 OR p.block ILIKE $1)
           ORDER BY (p.code::text ILIKE $2 OR p.name ILIKE $2) DESC, p.name
           LIMIT $4`,
  },
  {
    key: 'grievances', label: 'Grievances', module: 'grievances', href: byQ('/grievances'),
    sql: `SELECT g.id, g.code::text AS code, 'Grievance ' || g.code::text AS title,
                 concat_ws(' · ', g.category_code, g.severity, g.province_code) AS sub,
                 g.stage_code AS tag, g.province_code, g.project_id
            FROM lms.grievance g
           WHERE ($3::text IS NULL OR g.province_code = $3)
             AND (g.code::text ILIKE $1 OR g.complainant ILIKE $1)
           ORDER BY (g.code::text ILIKE $2) DESC, g.code
           LIMIT $4`,
  },
  {
    key: 'legal', label: 'Legal cases', module: 'legal', href: byQ('/legal'),
    sql: `SELECT lc.id, lc.code::text AS code, coalesce(nullif(lc.court_case_no, ''), 'Legal case ' || lc.code::text) AS title,
                 concat_ws(' · ', lc.court, lc.province_code) AS sub,
                 lc.status AS tag, lc.province_code, lc.project_id
            FROM lms.legal_case lc
           WHERE ($3::text IS NULL OR lc.province_code = $3)
             AND (lc.code::text ILIKE $1 OR lc.court_case_no ILIKE $1 OR lc.court ILIKE $1)
           ORDER BY (lc.code::text ILIKE $2) DESC, lc.code
           LIMIT $4`,
  },
];

/** Digits of a CNIC-shaped query (5–13 digits, optional dashes), else null. */
function cnicDigits(q: string): string | null {
  if (!/^[\d-]+$/.test(q)) return null;
  const d = q.replace(/-/g, '');
  return /^\d{5,13}$/.test(d) ? d : null;
}

/** Validated search text: 2–100 characters, no control characters. */
function searchText(raw: string | null): string {
  const q = (raw ?? '').trim().replace(/\s+/g, ' ');
  if (q.length < 2) throw new HttpError(400, 'Type at least 2 characters to search.');
  if (q.length > 100) throw new HttpError(400, 'Search text must be at most 100 characters.');
  if (/[\u0000-\u001f\u007f]/.test(q)) throw new HttpError(400, 'Search text contains characters that are not allowed.');
  return q;
}

function itemOf(g: Group, r: Row, ctx: Ctx): Item {
  let sub = r.sub ?? '';
  if (g.key === 'landowners' && r.cnic) {
    const shown = canSeePii(ctx, r.province_code) ? r.cnic : maskCnic(r.cnic);
    sub = sub ? `${sub} · CNIC ${shown}` : `CNIC ${shown}`;
  }
  return { id: r.id, code: r.code, title: r.title ?? r.code, sub, tag: r.tag ?? null, href: g.href(r) };
}

export const GET = protect({ authenticatedOnly: true }, async (ctx) => {
  const sp = new URL(ctx.req.url).searchParams;
  const q = searchText(sp.get('q'));
  const prov = (sp.get('province') ?? '').trim().toUpperCase();
  if (prov && prov !== 'ALL' && !PROVINCES.has(prov)) throw new HttpError(400, 'Unknown province.');
  const province = prov && prov !== 'ALL' ? prov : null;

  const digits = cnicDigits(q);
  const cnicAllowed = !!digits && ctx.has('pii', 'read');
  const params = [likeOf(q), `${likeOf(q).slice(1)}`, province, FETCH];

  const groups: { key: string; label: string; items: Item[] }[] = [];
  for (const g of GROUPS) {
    if (!ctx.has(g.module, 'read')) continue;   // not searched at all without <module>:read
    const args = g.key === 'landowners' ? [...params, cnicAllowed ? `${digits}%` : null] : params;
    const rows: Row[] = (await ctx.client.query(g.sql, args)).rows;
    const items = rows
      .filter((r) => ctx.can(g.module, 'read', { province: r.province_code, project: r.project_id }))
      .slice(0, PER_GROUP)
      .map((r) => itemOf(g, r, ctx));
    if (items.length) groups.push({ key: g.key, label: g.label, items });
  }

  return json({
    q,
    province,
    total: groups.reduce((n, g) => n + g.items.length, 0),
    groups,
    // Tells the UI why a CNIC-shaped search did not look at CNICs.
    cnic: digits ? (cnicAllowed ? 'searched' : 'not_permitted') : 'not_applicable',
  });
});
