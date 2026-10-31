/**
 * service_readiness.js
 * Checks system readiness: Node.js, Next.js server, and PostgreSQL database.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

async function checkDatabase() {
  // Credentials come from the environment (DATABASE_URL, as the app uses), never from source.
  if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL (the lms_app connection) to check the database.');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 3000 });

  try {
    const client = await pool.connect();
    const res = await client.query('SELECT current_database(), version(), count(*) FROM information_schema.tables WHERE table_schema = $1', ['lms']);
    // Row counts across every province need the maintenance (owner) connection:
    // the application role cannot act as the system account.
    if (!process.env.DATABASE_URL_ADMIN) {
      client.release();
      await pool.end();
      return { connected: true, database: res.rows[0].current_database, tableCount: res.rows[0].count,
               stats: 'not collected (set DATABASE_URL_ADMIN to the lms_migrator connection)' };
    }
    client.release();
    await pool.end();
    const admin = new Pool({ connectionString: process.env.DATABASE_URL_ADMIN, connectionTimeoutMillis: 3000 });
    const ac = await admin.connect();
    await ac.query('BEGIN');
    await ac.query('SET LOCAL ROLE lms_owner');
    await ac.query("SELECT set_config('lms.actor_id', '00000000-0000-0000-0000-000000000001', true)");
    
    // Check specific table counts
    const counts = await ac.query(`
      SELECT 
        (SELECT count(*) FROM lms.project) as projects,
        (SELECT count(*) FROM lms.landowner) as landowners,
        (SELECT count(*) FROM lms.survey) as surveys,
        (SELECT count(*) FROM lms.lease) as leases,
        (SELECT count(*) FROM lms.compensation_case) as cases,
        (SELECT count(*) FROM lms.payment_request) as payments,
        (SELECT count(*) FROM lms.workflow_transition) as audit_logs
    `);

    await ac.query('ROLLBACK');
    ac.release();
    await admin.end();
    return {
      connected: true,
      database: res.rows[0].current_database,
      tableCount: res.rows[0].count,
      stats: counts.rows[0],
    };
  } catch (err) {
    await pool.end();
    return { connected: false, error: err.message };
  }
}

function checkHttp(port = 3030) {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${port}/api/auth/login`, (res) => {
      resolve({ online: true, statusCode: res.statusCode });
    });
    req.on('error', (err) => {
      resolve({ online: false, error: err.message });
    });
    req.setTimeout(2000, () => {
      req.abort();
      resolve({ online: false, error: 'Connection timed out' });
    });
  });
}

async function main() {
  console.log('================================================================');
  console.log('⚡ Mari Energies LMS — Service & Infrastructure Readiness Check');
  console.log('================================================================\n');

  console.log(`[1] Runtime Environment:`);
  console.log(`  - Node.js Version: ${process.version}`);
  console.log(`  - Platform / Arch: ${process.platform} / ${process.arch}`);

  console.log(`\n[2] PostgreSQL 16 Database Engine:`);
  const dbResult = await checkDatabase();
  if (dbResult.connected) {
    console.log(`  ✅ Connected to PostgreSQL database: ${dbResult.database}`);
    console.log(`  ✅ Total 'lms' schema tables: ${dbResult.tableCount}`);
    console.log(`  📊 Key Operational Record Counts:`);
    console.log(`     • Concession Projects: ${dbResult.stats.projects}`);
    console.log(`     • Master Landowners:   ${dbResult.stats.landowners}`);
    console.log(`     • Cadastral Surveys:   ${dbResult.stats.surveys}`);
    console.log(`     • Surface Leases:      ${dbResult.stats.leases}`);
    console.log(`     • Compensation Cases:  ${dbResult.stats.cases}`);
    console.log(`     • Payment Records:     ${dbResult.stats.payments}`);
    console.log(`     • Audit Trail Events:  ${dbResult.stats.audit_logs}`);
  } else {
    console.log(`  ❌ Database Connection Failed: ${dbResult.error}`);
  }

  console.log(`\n[3] Next.js 15 Application Server:`);
  const httpResult = await checkHttp(3030);
  if (httpResult.online) {
    console.log(`  ✅ Application Daemon running on http://localhost:3030 (HTTP ${httpResult.statusCode})`);
  } else {
    console.log(`  ❌ Application Daemon not reachable on port 3030: ${httpResult.error}`);
  }

  console.log('\n================================================================');
  if (dbResult.connected && httpResult.online) {
    console.log('🎉 ALL SERVICES HEALTHY & READY FOR DEPLOYMENT / VALIDATION');
  } else {
    console.log('⚠️ ONE OR MORE SERVICES NOT READY');
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { checkDatabase, checkHttp };
