#!/usr/bin/env python3
"""Put every legacy API route behind protect().

Mechanical and deliberately minimal: each exported handler becomes
`export const METHOD = protect({ permission }, async (ctx) => { ... })`, and
inside it `query`, `withTransaction`, `getClient` and `getCurrentUser` are
shadowed by versions bound to ctx — the authenticated user's actor-scoped
transaction. Handler bodies are otherwise untouched, so the diff is reviewable
and existing business logic is preserved. The one behavioural change is the
point: every statement now runs as the real user under row-level security.

Usage: scripts/iam/convert_routes.py [--check]
"""
import re, sys, pathlib

ROOT = pathlib.Path(__file__).resolve().parents[2]
API = ROOT / 'src/app/api'

# route (relative to src/app/api) -> method -> permission (resource, action)
# None = any signed-in user (reference data that every screen needs).
PERMS = {
 'analytics/kpis':            {'GET': ('reports','read')},
 'analytics/reports':         {'GET': ('reports','read'), 'POST': ('reports','export')},
 'audit':                     {'GET': ('audit_logs','read')},
 'cases':                     {'GET': ('cases','read'), 'POST': ('cases','create')},
 'cases/[id]/transition':     {'POST': ('cases','approve')},
 'dbpfc':                     {'GET': ('dbpfc','read')},
 'gis':                       {'GET': ('gis','read')},
 'gis/kml':                   {'GET': ('gis','read'), 'POST': ('gis','create')},
 'gis/kml/merge':             {'GET': ('gis','read'), 'POST': ('gis','create')},
 'landowners':                {'GET': ('landowners','read'), 'POST': ('landowners','create')},
 'leases':                    {'GET': ('leases','read'), 'POST': ('leases','create')},
 'leases/[id]/hold':          {'POST': ('leases','update')},
 'leases/[id]/renew':         {'POST': ('leases','update')},
 'payments':                  {'GET': ('payments','read'), 'POST': None},   # POST dispatches on body.action; checked inside
 'projects':                  {'GET': ('projects','read'), 'POST': ('projects','create')},
 'provinces':                 {'GET': None},
 'requests':                  {'GET': ('requests','read'), 'POST': ('requests','create')},
 'requests/[id]/transition':  {'POST': ('requests','approve')},
 'rows':                      {'GET': ('rows','read'), 'POST': ('rows','create')},
 'surveys':                   {'GET': ('surveys','read'), 'POST': ('surveys','create'), 'PUT': ('surveys','update')},
 'units':                     {'GET': None, 'POST': None},   # a unit conversion is a calculation, not a write
}

SHADOW = """
    // ---- bound to the authenticated request (scripts/iam/convert_routes.py) ----
    const { query, withTransaction, getClient } = ctx.db;
    const user = ctx.legacyUser;
    const getCurrentUser = async () => user;
    void query; void withTransaction; void getClient; void getCurrentUser;
"""

SIG = re.compile(r'export async function (GET|POST|PUT|PATCH|DELETE)\s*\(([^)]*?)\)\s*(?::\s*[^{]+)?\{', re.S)

def match_brace(s: str, i: int) -> int:
    """Index of the } matching the { at s[i]; skips strings, templates, comments, regexes."""
    depth = 0; j = i; n = len(s)
    stack = []  # template-literal nesting
    while j < n:
        c = s[j]
        if c in '"\'':
            q = c; j += 1
            while j < n and s[j] != q:
                j += 2 if s[j] == '\\' else 1
        elif c == '`':
            j += 1
            while j < n and s[j] != '`':
                if s[j] == '\\': j += 2; continue
                if s.startswith('${', j):
                    k = match_brace(s, j + 1); j = k + 1; continue
                j += 1
        elif c == '/' and not s.startswith('//', j) and not s.startswith('/*', j) and re.search(r'[(,=:\[!&|?;{}]\s*$|return\s*$', s[max(0, j - 20):j]):
            # a regular-expression literal: skip to its closing slash
            j += 1; cls = False
            while j < n and (s[j] != '/' or cls):
                if s[j] == '\\': j += 2; continue
                if s[j] == '[': cls = True
                elif s[j] == ']': cls = False
                j += 1
        elif s.startswith('//', j):
            j = s.find('\n', j); j = n if j < 0 else j
        elif s.startswith('/*', j):
            j = s.find('*/', j) + 1
        elif c == '{':
            depth += 1
        elif c == '}':
            depth -= 1
            if depth == 0: return j
        j += 1
    raise ValueError('unbalanced braces')

def convert(path: pathlib.Path, perms: dict) -> str:
    s = path.read_text()
    if 'protect(' in s: return s
    out, pos = [], 0
    for m in SIG.finditer(s):
        if m.start() < pos: continue
        method, params = m.group(1), m.group(2)
        if method not in perms:
            raise SystemExit(f'{path}: no permission mapped for {method}')
        p = perms[method]
        opt = f"{{ permission: ['{p[0]}', '{p[1]}'] }}" if p else '{ authenticatedOnly: true }'
        open_i = m.end() - 1
        close_i = match_brace(s, open_i)
        body = s[open_i + 1:close_i]
        bind = []
        names = [x.strip() for x in params.split(',') if x.strip()]
        if names:
            req_name = names[0].split(':')[0].strip()
            bind.append(f'    const {req_name} = ctx.req;')
        if len(names) > 1 or 'params' in params:
            bind.append('    const params = Promise.resolve(ctx.params);')
        out.append(s[pos:m.start()])
        out.append(f'export const {method} = protect({opt}, async (ctx) => {{\n' + '\n'.join(bind) + SHADOW + body + '});')
        pos = close_i + 1
    out.append(s[pos:])
    s = ''.join(out)
    # imports
    s = re.sub(r"import \{[^}]*\} from '@/lib/db';\n", '', s)
    s = re.sub(r"import \{ getCurrentUser \} from '@/lib/auth';\n", '', s)
    s = s.replace("import { NextResponse } from 'next/server';", "import { NextResponse } from 'next/server';\nimport { protect } from '@/lib/iam/http';", 1)
    if "from '@/lib/iam/http'" not in s:
        s = "import { protect } from '@/lib/iam/http';\n" + s
    return s

def main():
    check = '--check' in sys.argv
    changed = []
    for rel, perms in PERMS.items():
        f = API / rel / 'route.ts'
        if not f.exists(): print(f'skip (missing) {rel}'); continue
        try:
            new = convert(f, perms)
        except ValueError as e:
            raise SystemExit(f'{rel}: {e}')
        if new != f.read_text():
            changed.append(rel)
            if not check: f.write_text(new)
    # anything under api/ we did not map is a route nobody has decided on
    for f in sorted(API.rglob('route.ts')):
        rel = str(f.parent.relative_to(API))
        if rel.startswith('auth/'): continue
        if rel not in PERMS: print(f'UNMAPPED ROUTE: {rel}')
    print(('would convert' if check else 'converted'), len(changed), 'routes:', ', '.join(changed))

if __name__ == '__main__':
    main()
