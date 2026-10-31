import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Client, signInAs, sql } from '../iam/client';

// One check per defect fixed in the end-to-end audit of 2026-10-31
// (docs/reports/E2E_AUDIT_2026-10-31.md, migration 0059 and the routes).

const signed: Record<string, Client> = {};
async function as(user: string): Promise<Client> {
  return (signed[user] ??= await signInAs(user));   // handles the MFA challenge and enrolment
}
const one = (q: string) => sql(q).split('\n')[0];

let caseId = '', projectId = '', ownerId = '', payable = 0, raised = 0;
beforeAll(() => {
  // An approved Sindh case with owners and room left under its award.
  const row = one(`SELECT m.case_id, m.project_id, m.payable_amount,
      (SELECT coalesce(sum(gross_amount),0) FROM lms.payment_request pr WHERE pr.case_id = m.case_id)
      FROM lms.case_money m WHERE m.stage_code = 'HO Approved' AND m.province_code = 'SND'
       AND EXISTS (SELECT 1 FROM lms.case_owner co JOIN lms.landowner lo ON lo.id = co.landowner_id WHERE co.case_id = m.case_id AND lo.status <> 'Deceased')
       AND m.payable_amount - (SELECT coalesce(sum(gross_amount),0) FROM lms.payment_request pr WHERE pr.case_id = m.case_id) > 1000
     ORDER BY m.payable_amount LIMIT 1`).split('|');
  [caseId, projectId] = row; payable = Number(row[2]); raised = Number(row[3]);
  ownerId = one(`SELECT co.landowner_id FROM lms.case_owner co JOIN lms.landowner lo ON lo.id = co.landowner_id
                 WHERE co.case_id = '${caseId}' AND lo.status <> 'Deceased' LIMIT 1`);
}, 120_000);

const voucher = (extra: Record<string, unknown>) => ({
  action: 'request', idempotency_key: randomUUID(), project_id: projectId, case_id: caseId,
  category: 'Crop Compensation', pay_type: 'One-time', payment_mode: 'Cross Cheque', land_class: 'Private',
  period_from: '2026-10-01', ...extra,
});

describe('Payments (0059)', () => {
  it('a case voucher must name the landowner it pays (no typed payee, no tax bypass)', async () => {
    const r = await (await as('lofield')).post('/api/payments', voucher({ payee_name: 'Typed Name', gross_amount: 100 }));
    expect(r.status, JSON.stringify(r.data)).toBe(400);
    expect(r.data.error).toMatch(/must name the landowner/);
  });
  it('vouchers on a case cannot exceed its award', async () => {
    const r = await (await as('lofield')).post('/api/payments', voucher({ landowner_id: ownerId, gross_amount: payable - raised + 1 }));
    expect(r.status, JSON.stringify(r.data)).toBe(400);
    expect(r.data.error).toMatch(/award is/);
  });
  it('a deceased landowner is not paid', async () => {
    sql(`UPDATE lms.landowner SET status = 'Deceased' WHERE id = '${ownerId}'`);
    try {
      const r = await (await as('lofield')).post('/api/payments', voucher({ landowner_id: ownerId, gross_amount: 100 }));
      expect(r.status, JSON.stringify(r.data)).toBe(400);
      expect(r.data.error).toMatch(/deceased/);
    } finally { sql(`UPDATE lms.landowner SET status = 'Active' WHERE id = '${ownerId}'`); }
  });
  it('a valid voucher within the award is still accepted', async () => {
    const r = await (await as('lofield')).post('/api/payments', voucher({ landowner_id: ownerId, gross_amount: 100 }));
    expect(r.status, JSON.stringify(r.data)).toBeLessThan(300);
  });
  it('the cheque list says whether a release was reversed', () => {
    expect(sql(`SELECT count(*) FROM information_schema.columns WHERE table_schema = 'api' AND table_name = 'v_payment_release' AND column_name = 'reversed_at'`)).toBe('1');
  });
  it('a reversed release does not count as paid to the landowner', () => {
    const bad = sql(`SELECT count(*) FROM api.v_landowner_summary s
      WHERE s.paid_to_date <> coalesce((SELECT sum(r.released_amount) FROM lms.payment_release r JOIN lms.payment_request pr ON pr.id = r.payment_id
        WHERE pr.landowner_id = s.landowner_id AND NOT EXISTS (SELECT 1 FROM lms.payment_release_reversal x WHERE x.release_id = r.id)), 0)`);
    expect(bad).toBe('0');
  });
});

describe('Personal and financial data', () => {
  it('a parcel record shows owners only to those who read landowners', async () => {
    const sid = one(`SELECT s.id FROM lms.survey s WHERE s.province_code = 'SND' AND EXISTS (SELECT 1 FROM lms.survey_ownership_share x WHERE x.survey_id = s.id) LIMIT 1`);
    const v = await (await as('viewer')).get(`/api/surveys?id=${sid}`);
    if (v.status === 200) { expect(v.data.shares).toEqual([]); expect(v.data.owners_shown).toBe(false); }
    const lo = await (await as('lofield')).get(`/api/surveys?id=${sid}`);
    expect(lo.data.shares.length).toBeGreaterThan(0);
  });
  it('dashboard KPIs do not hand lease rents or names to a role without the registers', async () => {
    const k = await (await as('admin')).get('/api/analytics/kpis');
    expect(k.status).toBe(200);
    expect(k.data.kpis?.lease_alerts).toBeUndefined();
    for (const q of k.data.kpis?.quality_exceptions ?? []) expect(q.samples).toEqual([]);
  });
  it('a CNIC lookup in the person statement needs pii:read', async () => {
    const r = await (await as('audit')).get('/api/reports/person?cnic=42101-1234567-1');
    expect(r.status).toBe(403);
  });
});

describe('Land requests', () => {
  it('Punjab / KPK requests have a Regional Manager and a Land Affairs holder', () => {
    for (const g of ['Regional Manager', 'DM / TL Land Affairs'])
      for (const p of ['PNJ', 'KPK'])
        expect(Number(sql(`SELECT count(*) FROM lms.app_user_group g JOIN lms.app_user_province up ON up.user_id = g.user_id
          WHERE g.group_code = '${g}' AND up.province_code = '${p}'`)), `${g} in ${p}`).toBeGreaterThan(0);
  });
});
