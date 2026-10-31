import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3030';

describe('API Security, Authentication & Negative Boundary Tests (OWASP ASVS L2)', () => {
  it('should reject unauthenticated requests to protected endpoints with 401', async () => {
    const endpoints = [
      { url: `${BASE_URL}/api/auth/me`, method: 'GET' },
      { url: `${BASE_URL}/api/cases`, method: 'POST', body: {} },
      { url: `${BASE_URL}/api/payments`, method: 'POST', body: { action: 'release' } },
    ];

    for (const ep of endpoints) {
      const res = await fetch(ep.url, {
        method: ep.method,
        headers: { 'Content-Type': 'application/json' },
        body: ep.body ? JSON.stringify(ep.body) : undefined,
      });
      assert.equal(res.status, 401, `Expected 401 Unauthorized for ${ep.method} ${ep.url}`);
    }
  });

  it('should reject invalid credentials with 401', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'lofield', password: 'wrongpassword' }),
    });
    assert.equal(res.status, 401);
    const data = await res.json();
    assert.ok(data.error.includes('Invalid'));
  });

  it('should issue secure HTTP-only cookie on valid login', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'lofield' }),
    });
    assert.equal(res.status, 200);
    const cookie = res.headers.get('set-cookie');
    assert.ok(cookie && cookie.includes('lms_user_id'), 'Set-Cookie contains session token');
    assert.ok(cookie.toLowerCase().includes('httponly'), 'Cookie has HttpOnly flag');
    assert.ok(cookie.toLowerCase().includes('samesite=lax'), 'Cookie has SameSite flag');
  });

  it('should reject deceased landowner case initiation without legal succession', async () => {
    // Login as Land Officer
    const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'lofield' }),
    });
    const cookie = loginRes.headers.get('set-cookie');

    // Fetch landowners and find deceased owner Allah Dino Jarwar
    const loRes = await fetch(`${BASE_URL}/api/landowners`);
    const loData = await loRes.json();
    const deceased = loData.landowners.find(l => l.is_deceased);
    assert.ok(deceased, 'Deceased owner exists in database');

    const projRes = await fetch(`${BASE_URL}/api/projects`);
    const projData = await projRes.json();

    // Attempt case creation
    const caseRes = await fetch(`${BASE_URL}/api/cases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        project_id: projData.projects[0].project_id,
        land_use_code: 'Well Location',
        case_remarks: 'Attempting case on deceased owner without legal mutation',
        crop_amount: 100000,
        owners: [{ landowner_id: deceased.id, share_pct: 100.0 }],
      }),
    });

    assert.equal(caseRes.status, 400, 'Expected 400 Bad Request for deceased owner');
    const caseData = await caseRes.json();
    assert.ok(caseData.error.toLowerCase().includes('deceased'), 'Error message references deceased succession lock');
  });

  it('should reject Segregation of Duties bypass (unauthorized role advancing stage)', async () => {
    // Login as Land Officer (lofield)
    const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'lofield' }),
    });
    const cookie = loginRes.headers.get('set-cookie');

    // Fetch existing cases
    const casesRes = await fetch(`${BASE_URL}/api/cases`);
    const casesData = await casesRes.json();
    const sampleCase = casesData.cases[0];

    // Attempt to directly HO-Approve or Field-Approve as Land Officer
    const transRes = await fetch(`${BASE_URL}/api/cases/${sampleCase.id}/transition`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ to_stage: 'Field Approved', note: 'Unauthorized self-approval attempt' }),
    });

    // Database or API must reject the unauthorized role transition
    assert.ok(transRes.status === 400 || transRes.status === 403, 'Stage advance rejected for unauthorized role');
    const transData = await transRes.json();
    assert.ok(transData.error, 'Error message returned');
  });

  it('should reject payment release on stay-ordered parcel under legal dispute', async () => {
    // Login as Finance Officer
    const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'finance' }),
    });
    const cookie = loginRes.headers.get('set-cookie');

    // Find the landowner with active legal stay order hold (Ghulam Qadir Mahar)
    const loRes = await fetch(`${BASE_URL}/api/landowners`);
    const loData = await loRes.json();
    const heldLandowner = loData.landowners.find(l => l.is_on_hold);
    assert.ok(heldLandowner, 'Held landowner exists in database');

    // Query vouchers to find voucher for held landowner that is not already Released
    const payRes = await fetch(`${BASE_URL}/api/payments`);
    const payData = await payRes.json();
    let heldVoucher = payData.vouchers.find(v => v.landowner_id === heldLandowner.id && v.stage_code !== 'Released');
    let payment_id = heldVoucher ? heldVoucher.id : null;

    if (!payment_id) {
      const projRes = await fetch(`${BASE_URL}/api/projects`);
      const projData = await projRes.json();
      const reqPayRes = await fetch(`${BASE_URL}/api/payments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          action: 'request',
          project_id: projData.projects[0].project_id,
          landowner_id: heldLandowner.id,
          gross_amount: 300000,
          category: 'Tree Compensation',
          pay_type: 'One-time',
        }),
      });
      const reqData = await reqPayRes.json();
      payment_id = reqData.payment_id;
    }

    // Verify voucher if not already verified
    await fetch(`${BASE_URL}/api/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ action: 'verify', payment_id }),
    });

    // Attempt release — must be rejected by lms.wf_guard_payments!
    const releaseRes = await fetch(`${BASE_URL}/api/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        action: 'release',
        payment_id,
        cheque_date: '2026-10-28',
      }),
    });

    assert.equal(releaseRes.status, 400, 'Expected 400 Bad Request on stay-ordered parcel');
    const releaseData = await releaseRes.json();
    assert.ok(releaseData.error.includes('hold'), 'Error mentions payment hold');
    assert.ok(releaseData.error.includes('stay order'), 'Error specifies legal stay order constraint');
  });
});
