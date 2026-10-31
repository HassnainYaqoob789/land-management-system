import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3030';

describe('Analytical Reporting & Decision Intelligence API Suite', () => {
  it('GET /api/units should return the full canonical measurement unit catalog', async () => {
    const res = await fetch(`${BASE_URL}/api/units`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.units));
    assert.ok(data.units.length >= 10);
    const murabba = data.units.find((u) => u.code === 'Murabba');
    assert.ok(murabba);
    assert.equal(murabba.note, '1 Murabba = 25 Acres = 1,089,000 sq ft');
  });

  it('POST /api/units should perform live deterministic unit conversion', async () => {
    const res = await fetch(`${BASE_URL}/api/units`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 5.0, fromUnit: 'Acre', toUnit: 'Ghunta' }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.convertedValue, 200.0); // 5 * 40 = 200
  });

  it('GET /api/analytics/kpis should return C-Level Executive KPI package', async () => {
    const res = await fetch(`${BASE_URL}/api/analytics/kpis?role=c_level&unit=Acre`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.role, 'c_level');
    assert.ok(data.kpis.executive);
    assert.ok(Number(data.kpis.executive.total_projects) > 0);
    assert.ok(Number(data.kpis.executive.total_landowners) > 0);
    assert.equal(data.metadata.client, 'Mari Energies Limited');
    assert.equal(data.metadata.developer, 'Alisons Technology');
  });

  it('GET /api/analytics/kpis should dynamically convert area metrics to Kanals', async () => {
    const resAcre = await fetch(`${BASE_URL}/api/analytics/kpis?role=c_level&unit=Acre`);
    const dataAcre = await resAcre.json();
    const acres = Number(dataAcre.kpis.executive.total_area_normalized);

    const resKanal = await fetch(`${BASE_URL}/api/analytics/kpis?role=c_level&unit=Kanal`);
    const dataKanal = await resKanal.json();
    const kanals = Number(dataKanal.kpis.executive.total_area_normalized);

    // 1 Acre = 8 Kanals
    assert.ok(Math.abs(kanals - (acres * 8)) < 1.0);
  });

  it('GET /api/analytics/kpis should return Director Portfolio package', async () => {
    const res = await fetch(`${BASE_URL}/api/analytics/kpis?role=director`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.kpis.portfolio));
    assert.ok(data.kpis.portfolio.length > 0);
  });

  it('GET /api/analytics/kpis should return Finance Aging package', async () => {
    const res = await fetch(`${BASE_URL}/api/analytics/kpis?role=finance`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.kpis.aging));
    assert.ok(data.kpis.aging.length > 0);
  });

  // Test all 15 reports
  const reportKeys = [
    'r1', 'r2', 'r3', 'r4', 'r5',
    'r6', 'r7', 'r8', 'r9', 'r10',
    'r11', 'r12', 'r13', 'r14', 'r15'
  ];

  for (const rKey of reportKeys) {
    it(`GET /api/analytics/reports?report=${rKey} should return valid database report structure`, async () => {
      const res = await fetch(`${BASE_URL}/api/analytics/reports?report=${rKey}&unit=Acre`);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.report_id, rKey);
      assert.ok(data.title);
      assert.ok(Array.isArray(data.cols));
      assert.ok(Array.isArray(data.rows));
      assert.equal(data.developer, 'Alisons Technology');
      assert.equal(data.client, 'Mari Energies Limited');
    });
  }

  it('GET /api/analytics/reports?report=r1&format=csv should stream valid CSV with header and metadata', async () => {
    const res = await fetch(`${BASE_URL}/api/analytics/reports?report=r1&format=csv`);
    assert.equal(res.status, 200);
    const contentType = res.headers.get('content-type');
    assert.ok(contentType?.includes('text/csv'));
    const csvText = await res.text();
    assert.ok(csvText.includes('Mari Energies Limited'));
    assert.ok(csvText.includes('Alisons Technology'));
    assert.ok(csvText.includes('Standardized Reporting Unit'));
  });
});
