#!/usr/bin/env node
// Generates docs/RBAC_PERMISSION_MATRIX.md from the two sources of truth:
//   1. the database — roles, their tier and status, and every permission each
//      role holds with its scope (iam.role, iam.role_permission, iam.permission);
//   2. the code — which permission every API handler demands (protect({...}),
//      plus the per-action ctx.has / ctx.can checks inside it) and which
//      permission every page in the navigation needs (src/components/layout/nav.ts).
// It reports what it finds; it does not judge it. Run after migrations:
//   DATABASE_URL_ADMIN=postgresql://lms_migrator@/lms_iam_test?host=/tmp node scripts/iam/permission_matrix.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const url = process.env.DATABASE_URL_ADMIN;
if (!url) { console.error('Set DATABASE_URL_ADMIN (lms_migrator connection).'); process.exit(2); }

const q = (sql) => execFileSync('psql', ['-X', '-At', '-F', '\t', url, '-c', `SET ROLE lms_owner; ${sql}`], { encoding: 'utf8' })
  .trim().split('\n').filter((l) => l && l !== 'SET').map((l) => l.split('\t'));

const roles = q(`SELECT code, name, db_role_code, status, is_system FROM iam.role ORDER BY is_system DESC, code`);
const perms = q(`SELECT resource, action, is_sensitive, coalesce(description,'') FROM iam.permission ORDER BY resource, action`);
const grants = q(`SELECT r.code, p.resource || ':' || p.action, rp.scope_level
                  FROM iam.role_permission rp JOIN iam.role r ON r.id = rp.role_id JOIN iam.permission p ON p.id = rp.permission_id`);
const g = new Map(grants.map(([r, p, s]) => [`${r}|${p}`, s]));
const SCOPE = { global: 'G', head_office: 'HO', province: 'P', project: 'Pr', assigned: 'A' };

// ---- code: API handlers ----
function walk(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out); else if (f === 'route.ts') out.push(p);
  }
  return out;
}
const routes = [];
for (const file of walk(join(ROOT, 'src/app/api')).sort()) {
  const src = readFileSync(file, 'utf8');
  const path = '/' + relative(join(ROOT, 'src/app'), file).replace(/\/route\.ts$/, '');
  const re = /export\s+const\s+(GET|POST|PUT|PATCH|DELETE)\s*=\s*(protect|publicRoute)\s*\(\s*(\{[^}]*\})?/g;
  let m;
  while ((m = re.exec(src))) {
    const [, method, kind, opts = ''] = m;
    let gate = kind === 'publicRoute' ? 'public (pre-sign-in)' : '';
    const pm = /permission\s*:\s*\[\s*'([a-z_]+)'\s*,\s*'([a-z_]+)'\s*\]/.exec(opts);
    if (pm) gate = `${pm[1]}:${pm[2]}`;
    else if (/authenticatedOnly\s*:\s*true/.test(opts)) gate = 'any signed-in user';
    const extra = [...new Set([...src.matchAll(/ctx\.(?:has|can)\(\s*'([a-z_]+)'\s*,\s*'([a-z_]+)'/g)].map((x) => `${x[1]}:${x[2]}`))]
      .filter((x) => x !== gate);
    routes.push({ path, method, gate: gate || '(not recognised — read the file)', reauth: /reauth\s*:\s*true/.test(opts), extra });
  }
}

// ---- code: pages ----
let pages = [];
try {
  const nav = readFileSync(join(ROOT, 'src/components/layout/nav.ts'), 'utf8');
  pages = [...nav.matchAll(/href\s*:\s*'([^']+)'[^}]*?perm\s*:\s*(\[[^\]]*\]|'[^']*')/g)].map((x) => ({ href: x[1], perm: x[2].replace(/[[\]']/g, '').replace(/\s+/g, ' ') }));
} catch { /* nav.ts missing */ }

// ---- write ----
const lines = [];
lines.push('# RBAC permission matrix', '',
  `Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC by \`scripts/iam/permission_matrix.mjs\` from the database`
  + ` (${url.replace(/\/\/[^@]*@/, '//…@')}) and the source tree. Do not edit by hand.`, '',
  'Scope codes: **G** global, **HO** head office, **P** the holder\'s provinces, **Pr** project, **A** assigned records.',
  'A sensitive permission (⚠) requires multi-factor sign-in for its holders (`iam.mfa_for_sensitive_permissions`).', '',
  '## 1. Roles', '', '| Role | Name | Database tier | Status | System |', '|:---|:---|:---|:---|:---|');
for (const [code, name, tier, status, sys] of roles) lines.push(`| \`${code}\` | ${name} | ${tier} | ${status} | ${sys === 't' ? 'yes' : 'no'} |`);
lines.push('', '## 2. Permissions by role', '', `| Permission | ${roles.map((r) => `\`${r[0]}\``).join(' | ')} | Description |`,
  `|:---|${roles.map(() => ':---:').join('|')}|:---|`);
for (const [res, act, sens, desc] of perms) {
  const key = `${res}:${act}`;
  lines.push(`| ${sens === 't' ? '⚠ ' : ''}\`${key}\` | ${roles.map((r) => SCOPE[g.get(`${r[0]}|${key}`)] ?? '').join(' | ')} | ${desc} |`);
}
lines.push('', '## 3. API handlers', '', 'The gate is what `protect()` checks before the handler runs; "also" lists permissions the handler checks itself (per action or per record).', '',
  '| Route | Method | Gate | Re-auth | Also checks |', '|:---|:---|:---|:---:|:---|');
for (const r of routes) lines.push(`| \`${r.path}\` | ${r.method} | ${r.gate} | ${r.reauth ? 'yes' : ''} | ${r.extra.join(', ')} |`);
lines.push('', '## 4. Pages', '', '| Page | Needs |', '|:---|:---|');
for (const p of pages) lines.push(`| \`${p.href}\` | ${p.perm || 'any signed-in user'} |`);
lines.push('');
writeFileSync(join(ROOT, 'docs/RBAC_PERMISSION_MATRIX.md'), lines.join('\n'));
console.log(`wrote docs/RBAC_PERMISSION_MATRIX.md: ${roles.length} roles, ${perms.length} permissions, ${routes.length} handlers, ${pages.length} pages`);
