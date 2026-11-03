#!/usr/bin/env node
// Builds a DEMO environment: a separate database (default lms_demo) with the
// fictional demo seed, the reporting fixture when present, a fresh random
// password for every demo account, and a credentials file the sign-in page can
// show — only when the server runs with LMS_DEMO_MODE=on and that file.
//
// Demo only. It drops and recreates the target database, so it refuses any
// database not named lms_demo* (lms_dev, lms_test, lms_iam_test, lms_perf and
// production are never touched). The rebuild needs a PostgreSQL superuser
// (the local OS account here).
//
//   node scripts/demo/setup_demo.mjs            # lms_demo, credentials in .data/demo-credentials.json
//   node scripts/demo/setup_demo.mjs lms_demo2
//
// Then start the app against it:
//   DATABASE_URL="postgresql://lms_app@/lms_demo?host=/tmp" LMS_DEMO_MODE=on \
//   LMS_DEMO_CREDENTIALS_FILE="$PWD/.data/demo-credentials.json" npx next start -p 3050
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, chmodSync } from 'node:fs';

const DB = process.argv[2] || 'lms_demo';
if (!/^lms_demo[a-z0-9_]*$/.test(DB)) {
  console.error(`refusing to rebuild "${DB}": the demo setup only rebuilds databases named lms_demo*`);
  process.exit(2);
}
const ADMIN = `postgresql://lms_migrator@/${DB}?host=/tmp`;
const OUT = '.data/demo-credentials.json';
const sh = (cmd, args, env = {}) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', env: { ...process.env, ...env } });
const sql = (q) => sh('psql', ['-X', '-At', '-F', '\t', '-v', 'ON_ERROR_STOP=1', '-U', 'lms_migrator', '-d', DB, '-c',
  `SET ROLE lms_owner; SELECT set_config('lms.actor_id','00000000-0000-0000-0000-000000000001',true); ${q}`])
  .split('\n').filter((l) => l && l !== 'SET' && !/^0{8}-/.test(l));

console.log(`1/5 rebuilding ${DB} with the demo seed`);
sh('bash', ['db/tools/rebuild.sh', DB]);

if (existsSync('db/seeds/reporting_fixture.sql')) {
  console.log('2/5 loading the reporting fixture (multi-province units, owners, partial payments)');
  sh('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-U', 'lms_migrator', '-d', DB, '-f', 'db/seeds/reporting_fixture.sql']);
} else console.log('2/5 no reporting fixture yet (db/seeds/reporting_fixture.sql) — skipped');

// Exploration land-request flow (migration 0057): planner, Director Operations,
// Regional Manager and DM / TL Land Affairs accounts.
sh('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-U', 'lms_migrator', '-d', DB, '-f', 'db/seed/seed_exploration_accounts.sql']);
sh('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-U', 'lms_migrator', '-d', DB, '-f', 'db/seed/seed_director_account.sql']);

// Demo convenience: no authenticator enrolment on first sign-in. This changes
// the demo database only; every other environment keeps the MFA policy.
console.log('3/5 demo policy: MFA prompts off in this database only');
sql(`UPDATE lms.system_setting SET value = 'false'::jsonb WHERE key IN ('iam.mfa_required_all','iam.mfa_for_sensitive_permissions');
     UPDATE lms.system_setting SET value = '[]'::jsonb WHERE key = 'iam.mfa_required_roles';
     SELECT iam.log_event('policy_changed','success',NULL,NULL,'00000000-0000-0000-0000-000000000001',NULL,NULL,NULL,NULL,NULL,NULL,
       '{"setting":"demo environment: MFA requirements off"}'::jsonb);`);

console.log('4/5 setting a fresh password for every demo account');
const SEES = {
  'system-administrator': 'Users, roles, settings and audit; no approvals or payments (separation of duties)',
  'land-manager': 'Head-office land approvals, payment release, reports in every province',
  'finance-approver': 'Vouchers and verification, finance reports',
  'case-approver': 'Approves cases and mutations in its province',
  'data-entry': 'Creates landowners, parcels, cases and imports in its province; cannot approve',
  'security-auditor': 'Read-only: accounts, sessions and audit trail',
  viewer: 'Read-only dashboards and registers',
  'exploration-planner': 'Draws the land it needs on the GIS map and raises land requests; no landowner data or approvals',
  'land-request-reviewer': 'Decides its tier of land requests (Director Operations / Regional Manager) on the map',
  'demo-director': 'Every tab, every action except payment release; one approval step per record',
};
const users = sql(`SELECT u.username, u.full_name, coalesce(u.position,''),
                          coalesce((SELECT string_agg(r.code, ',' ORDER BY r.code) FROM iam.user_role ur JOIN iam.role r ON r.id = ur.role_id
                                    WHERE ur.user_id = u.id AND ur.revoked_at IS NULL), ''),
                          coalesce((SELECT string_agg(p.province_code, ',' ORDER BY p.province_code) FROM lms.app_user_province p WHERE p.user_id = u.id), '')
                   FROM lms.app_user u WHERE NOT u.is_service_account AND u.status = 'Active' ORDER BY u.username`)
  .map((l) => l.split('\t'));
const accounts = [];
for (const [username, fullName, position, roles, provinces] of users) {
  // 16 characters from a 62-symbol alphabet plus a fixed suffix that satisfies the policy.
  const password = randomBytes(24).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 14) + '-Dm7';
  sh('npx', ['tsx', 'scripts/iam/bootstrap.ts', '--username', username, '--password-from-env', 'DEMO_PW', '--no-force-change'],
    { DATABASE_URL_ADMIN: ADMIN, DEMO_PW: password });
  const r = roles ? roles.split(',') : [];
  accounts.push({ username, password, fullName, position, roles: r, provinces: provinces ? provinces.split(',') : [],
    sees: r.map((x) => SEES[x] ?? x).join('; ') || 'No role: signs in but sees nothing' });
}

console.log(`5/5 writing ${OUT} (mode 600, outside git)`);
mkdirSync('.data', { recursive: true });
writeFileSync(OUT, JSON.stringify({ database: DB, generatedAt: new Date().toISOString(), accounts }, null, 2), { mode: 0o600 });
chmodSync(OUT, 0o600);
console.log(`\n${accounts.length} demo accounts ready in ${DB}. Start the server with LMS_DEMO_MODE=on and LMS_DEMO_CREDENTIALS_FILE=${process.cwd()}/${OUT}`);
