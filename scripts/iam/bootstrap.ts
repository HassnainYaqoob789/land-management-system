/* Set an initial password for one account, shown once, changed at first sign-in.

   npx tsx scripts/iam/bootstrap.ts --username admin
   npx tsx scripts/iam/bootstrap.ts --username admin --password-from-env INITIAL_PW   # e.g. CI
   npx tsx scripts/iam/bootstrap.ts --username lofield --no-force-change            # test fixtures only

   Connects with DATABASE_URL_ADMIN (the migration role), because setting a
   password outside the application is an administrative act. Replaces
   scripts/seed_passwords.js, which gave every account "<username>123".        */
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { hashPassword } from '../../src/lib/iam/password';

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const username = arg('--username');
if (!username) { console.error('usage: --username <name> [--password-from-env VAR] [--no-force-change]'); process.exit(2); }
const fromEnv = arg('--password-from-env');
const forceChange = !process.argv.includes('--no-force-change');
const dsn = process.env.DATABASE_URL_ADMIN;
if (!dsn) { console.error('DATABASE_URL_ADMIN is not set (connect as lms_migrator)'); process.exit(2); }

(async () => {
  const pw = fromEnv ? process.env[fromEnv] : randomBytes(18).toString('base64url');
  if (!pw || pw.length < 12) { console.error('password must be at least 12 characters'); process.exit(2); }
  const c = new pg.Client({ connectionString: dsn });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE lms_owner');
    await c.query(`SELECT set_config('lms.actor_id','00000000-0000-0000-0000-000000000001', true)`);
    const u = (await c.query('SELECT id, status FROM lms.app_user WHERE username = $1 AND is_service_account = false', [username])).rows[0];
    if (!u) throw new Error(`no such account: ${username}`);
    if (u.status !== 'Active') throw new Error(`account ${username} is ${u.status}`);
    await c.query('SELECT iam.tg_apply_password($1,$2)', [u.id, await hashPassword(pw)]);
    await c.query('UPDATE iam.account_security SET must_change_password = $2 WHERE user_id = $1', [u.id, forceChange]);
    await c.query(`SELECT iam.log_event('password_bootstrap','success',$1,$2,'00000000-0000-0000-0000-000000000001',$1,NULL,NULL,NULL,NULL,NULL,$3)`,
      [u.id, username, JSON.stringify({ forced_change: forceChange })]);
    await c.query('COMMIT');
    if (!fromEnv) {
      // Printed once to the operator's terminal; never stored or logged.
      console.log(`\nInitial password for ${username}:\n\n    ${pw}\n`);
      console.log(forceChange ? 'It must be changed at first sign-in.' : 'NOT forced to change (test fixture).');
    } else console.log(`password set for ${username} from $${fromEnv}`);
  } catch (e: any) {
    await c.query('ROLLBACK').catch(() => {});
    console.error('failed:', e.message); process.exitCode = 1;
  } finally { await c.end(); }
})();
