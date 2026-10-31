const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL || 'postgresql://lms_app@localhost:5432/lms_dev' });

async function check() {
  for (const table of ['lease_lessor', 'lease_survey', 'lease_renewal']) {
    const res = await pool.query(
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'lms' AND table_name = $1 ORDER BY ordinal_position`,
      [table]
    );
    console.log('TABLE:', table);
    console.log(res.rows.map(r => `${r.column_name} (${r.data_type})`).join(', '));
    console.log();
  }
  await pool.end();
}
check().catch(console.error);
