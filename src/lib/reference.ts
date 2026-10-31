// Shared shape of /api/reference and the parser it uses. Kept outside the
// route file because a Next.js route module may only export route handlers.

export interface Reference {
  lookups: Record<string, { code: string; name: string }[]>;
  workflows: Record<string, { label: string; stages: { code: string; label: string; seq: number; terminal: boolean; note: string | null }[];
    allowsCancel: boolean; allowsStop: boolean; lockAt: string | null }>;
  enums: Record<string, string[]>;          // "table.column" -> allowed values
  provinces: { code: string; name: string }[];
  loadedAt: string;
}

// CHECK ((col = ANY (ARRAY['a'::text, 'b'::text]))) -> ['col', ['a','b']]
export function parseEnumCheck(def: string): [string, string[]] | null {
  const m = /^CHECK \(\(\(?(\w+)\)?(?:::\w+)? = ANY \(\(?ARRAY\[(.*)\]\)?(?:::\w+\[\])?\)\)\)$/.exec(def.trim());
  if (!m) return null;
  const values = [...m[2].matchAll(/'((?:[^']|'')*)'::/g)].map((v) => v[1].replace(/''/g, "'"));
  return values.length ? [m[1], values] : null;
}
