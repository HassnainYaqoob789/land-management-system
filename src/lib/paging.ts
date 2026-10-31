// Server-side paging for list endpoints. Every register is bounded: a list
// returns at most `limit` rows (default 100, never more than 500) from
// `offset`, plus the total that matched, so a screen can page through 30,000
// cases instead of downloading them all.

type Q = (text: string, params?: unknown[]) => Promise<{ rows: any[] }>;
export type Page = { limit: number; offset: number; total: number };

export function pageOf(sp: URLSearchParams, { def = 100, max = 500 } = {}): { limit: number; offset: number } {
  const int = (k: string) => { const v = sp.get(k); if (v === null || v.trim() === '') return NaN; const n = Number(v); return Number.isInteger(n) ? n : NaN; };
  const l = int('limit'), o = int('offset');
  return { limit: Math.min(max, Math.max(1, Number.isNaN(l) ? def : l)), offset: Math.max(0, Number.isNaN(o) ? 0 : o) };
}

/**
 * Run `sql` (a SELECT with no ORDER BY / LIMIT) for one page, ordered by
 * `orderBy` (fixed text from the route, never from the request), and count
 * every row it matches.
 */
export async function paged(query: Q, sql: string, params: unknown[], orderBy: string, p: { limit: number; offset: number }) {
  const n = params.length;
  const rows = (await query(`${sql} ORDER BY ${orderBy} LIMIT $${n + 1} OFFSET $${n + 2}`, [...params, p.limit, p.offset])).rows;
  const total = rows.length < p.limit && p.offset === 0 ? rows.length
    : Number((await query(`SELECT count(*)::bigint AS n FROM (${sql}) _c`, params)).rows[0].n);
  return { rows, page: { limit: p.limit, offset: p.offset, total } as Page };
}

/** An ILIKE pattern for a user's search text, with LIKE wildcards escaped. */
export const likeOf = (q: string) => `%${q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/**
 * Register totals for the KPI tiles, over everything `sql` matches (not just
 * the page). `exprs` are fixed aggregate expressions from the route over the
 * output columns of `sql`; values come back as numbers.
 */
export async function summarize(query: Q, sql: string, params: unknown[], exprs: Record<string, string>) {
  const cols = Object.entries(exprs).map(([k, e]) => `(${e})::numeric AS "${k}"`).join(', ');
  const row = (await query(`SELECT ${cols} FROM (${sql}) _s`, params)).rows[0] ?? {};
  return Object.fromEntries(Object.keys(exprs).map((k) => [k, row[k] == null ? 0 : Number(row[k])])) as Record<string, number>;
}
