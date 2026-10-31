import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

// The database comes from DATABASE_URL (as the application's own), never from a
// connection string with a password written into the repository.
if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL (the lms_app connection) to run the live conversion checks.');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

describe('Land Measurement Standardization & Conversion Engine (Slide 5 Authoritative Matrix)', () => {
  // Test direct mathematical factors
  const SQM_FACTORS = {
    murabba: 101171.41056,
    acre: 4046.8564224,
    rod: 1011.7141056,
    jireb: 2023.4282112,
    kanal: 505.8570528,
    ghunta: 101.17141056,
    marla: 25.29285264,
    'sq yard': 0.83612736,
    'sq feet': 0.09290304,
    sqm: 1.0,
    hectare: 10000.0,
  };

  it('should verify 1 Murabba = exactly 25 Acres = 100 Rods = 200 Kanals = 1,000 Ghuntas', () => {
    const murabbaSqm = SQM_FACTORS.murabba;
    assert.equal(murabbaSqm / SQM_FACTORS.acre, 25.0);
    assert.equal(murabbaSqm / SQM_FACTORS.rod, 100.0);
    assert.equal(murabbaSqm / SQM_FACTORS.kanal, 200.0);
    assert.equal(murabbaSqm / SQM_FACTORS.ghunta, 1000.0);
    assert.equal(murabbaSqm / SQM_FACTORS.marla, 4000.0);
  });

  it('should verify 1 Acre = 40 Ghuntas (Sindh) = 8 Kanals = 160 Marlas = 4,840 sq yd = 43,560 sq ft', () => {
    const acreSqm = SQM_FACTORS.acre;
    assert.equal(acreSqm / SQM_FACTORS.ghunta, 40.0);
    assert.equal(acreSqm / SQM_FACTORS.kanal, 8.0);
    assert.equal(acreSqm / SQM_FACTORS.marla, 160.0);
    assert.ok(Math.abs(acreSqm / SQM_FACTORS['sq yard'] - 4840.0) < 0.0001);
    assert.ok(Math.abs(acreSqm / SQM_FACTORS['sq feet'] - 43560.0) < 0.0001);
  });

  it('should verify 1 Hectare = exactly 10,000 m² = 2.47105 Acres', () => {
    const haSqm = SQM_FACTORS.hectare;
    assert.equal(haSqm, 10000.0);
    const acresInHa = haSqm / SQM_FACTORS.acre;
    assert.ok(Math.abs(acresInHa - 2.47105) < 0.001);
  });

  // Test live PostgreSQL lms.convert_area() function
  it('should execute live lms.convert_area() in PostgreSQL: 1 Acre -> 40 Ghuntas', async () => {
    const client = await pool.connect();
    try {
      const res = await client.query(`SELECT lms.convert_area(1.0, 'Acre', 'Ghunta') as converted`);
      assert.equal(Number(res.rows[0].converted), 40.0);
    } finally {
      client.release();
    }
  });

  it('should execute live lms.convert_area() in PostgreSQL: 1 Acre -> 8 Kanals', async () => {
    const client = await pool.connect();
    try {
      const res = await client.query(`SELECT lms.convert_area(1.0, 'Acre', 'Kanal') as converted`);
      assert.equal(Number(res.rows[0].converted), 8.0);
    } finally {
      client.release();
    }
  });

  it('should execute live lms.convert_area() in PostgreSQL: 1 Murabba -> 25 Acres', async () => {
    const client = await pool.connect();
    try {
      const res = await client.query(`SELECT lms.convert_area(1.0, 'Murabba', 'Acre') as converted`);
      assert.equal(Number(res.rows[0].converted), 25.0);
    } finally {
      client.release();
    }
  });

  it('should verify reciprocal conversion: Acre -> Kanal -> Acre yields identical value', async () => {
    const client = await pool.connect();
    try {
      const initialAcres = 12.5;
      const res1 = await client.query(`SELECT lms.convert_area($1, 'Acre', 'Kanal') as kanals`, [initialAcres]);
      const kanals = Number(res1.rows[0].kanals);
      assert.equal(kanals, 100.0);

      const res2 = await client.query(`SELECT lms.convert_area($1, 'Kanal', 'Acre') as acres`, [kanals]);
      const finalAcres = Number(res2.rows[0].acres);
      assert.equal(finalAcres, initialAcres);
    } finally {
      client.release();
    }
  });

  it('should fail with an exception when passed an unsupported unit', async () => {
    const client = await pool.connect();
    try {
      await assert.rejects(
        async () => {
          await client.query(`SELECT lms.convert_area(10.0, 'InvalidUnitXYZ', 'Acre')`);
        },
        /Unsupported source land measurement unit/
      );
    } finally {
      client.release();
    }
  });

  // 0043: one table-driven converter that says when a factor is provisional.
  const one = async (sql, params = []) => {
    const client = await pool.connect();
    try { return (await client.query(sql, params)).rows[0]; } finally { client.release(); }
  };

  it('converts exactly and flags provisional factors (lms.uom_convert_detail)', async () => {
    const jireb = await one(`SELECT value, confirmed FROM lms.uom_convert_detail(2, 'Jireb', 'Acre')`);
    assert.equal(Number(jireb.value), 1);
    assert.equal(jireb.confirmed, false, 'Jireb is awaiting Land Department confirmation');
    const kanal = await one(`SELECT value, confirmed FROM lms.uom_convert_detail(8, 'Kanal', 'Acre')`);
    assert.equal(Number(kanal.value), 1);
    assert.equal(kanal.confirmed, true);
    const ha = await one(`SELECT value::text AS v FROM lms.uom_convert_detail(1, 'Acre', 'Hectare')`);
    assert.match(ha.v, /^0\.40468564224/, 'the exact factor, not 0.4047');
  });

  it('treats Bega as the slide-5 alias of Jireb', async () => {
    assert.equal((await one(`SELECT lms.uom_code('Bega') AS c`)).c, 'Jireb');
  });

  it('returns no value (never a guess) for an unknown unit', async () => {
    assert.equal((await one(`SELECT value FROM lms.uom_convert_detail(1, 'Acre', 'Furlong')`)).value, null);
  });

  it('has a factor in force for every area unit, and lms.convert_area agrees with it', async () => {
    assert.equal(Number((await one(`SELECT count(*) AS n FROM lms.measurement_unit mu WHERE mu.is_area
      AND NOT EXISTS (SELECT 1 FROM lms.unit_conversion c WHERE c.unit_code = mu.code AND c.valid_range @> current_date)`)).n), 0);
    const r = await one(`SELECT bool_and(lms.convert_area(10, unit_code, 'Acre') = round((SELECT value FROM lms.uom_convert_detail(10, unit_code, 'Acre')), 4)) AS ok
                         FROM lms.unit_conversion WHERE valid_range @> current_date`);
    assert.equal(r.ok, true);
  });

  it('lists each province\'s units from the client reference, flagged until confirmed', async () => {
    const r = await one(`SELECT string_agg(unit_code, ',' ORDER BY unit_code) AS u, bool_or(confirmed) AS any_confirmed
                         FROM lms.province_unit WHERE province_code = 'KPK' AND source = 'client_reference'`);
    assert.equal(r.u, 'Acre,Kanal,Marla,Square Feet');
    assert.equal(r.any_confirmed, false);
  });

  after(async () => {
    await pool.end();
  });
});
