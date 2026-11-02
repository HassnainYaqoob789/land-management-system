import { describe, it, expect, beforeAll } from 'vitest';
import { generate } from 'otplib';
import { Client, sql } from '../iam/client';

// 0062: a voucher held after a change of ownership is either released (hold
// lifted) or cancelled by Finance. Cancelling: Finance only, with a reason,
// only before release; the voucher's own holds are lifted with it.

async function as(user: string): Promise<Client> {
  sql(`DELETE FROM iam.mfa_totp WHERE user_id = (SELECT id FROM lms.app_user WHERE username = '${user}');
       UPDATE iam.account_security SET failed_count = 0, locked_until = NULL WHERE user_id = (SELECT id FROM lms.app_user WHERE username = '${user}')`);
  const c = new Client();
  expect((await c.login(user)).status).toBe(200);
  const me = await c.get('/api/auth/me');
  if (me.data.mfa?.enrolmentOutstanding) {
    const s = await c.post('/api/auth/mfa/totp/start');
    await c.post('/api/auth/mfa/totp/confirm', { code: await generate({ secret: s.data.secret }) });
  }
  return c;
}

let voucher = '';
beforeAll(() => {
  // A live, unreleased Sindh voucher, held the way a mutation holds it.
  voucher = sql(`SELECT id FROM lms.payment_request WHERE province_code = 'SND' AND stage_code IN ('Requested','Verified')
                  AND reversed_at IS NULL ORDER BY created_at DESC LIMIT 1`);
  expect(voucher, 'needs one unreleased Sindh voucher in the test database').toMatch(/^[0-9a-f-]{36}$/);
  sql(`INSERT INTO lms.payment_hold (scope, payment_id, reason, placed_by)
       VALUES ('payment', '${voucher}', 'Ownership changed by mutation T-REG (Sale / Transfer): test', (SELECT id FROM lms.app_user WHERE username = 'admin'))`);
}, 120_000);

describe('Cancelling a voucher (0062)', () => {
  it('needs a Finance permission and a reason', async () => {
    const lo = await as('lofield');
    expect((await lo.post('/api/payments', { action: 'cancel', payment_id: voucher, reason: 'not mine to cancel' })).status).toBe(403);
    const fin = await as('finance');
    expect((await fin.post('/api/payments', { action: 'cancel', payment_id: voucher, reason: '' })).status).toBe(400);
  });
  it('Finance cancels it; its holds are lifted; it cannot be cancelled twice', async () => {
    const fin = await as('finance');
    const r = await fin.post('/api/payments', { action: 'cancel', payment_id: voucher, reason: 'land sold; raise again for the buyer' });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(sql(`SELECT stage_code FROM lms.payment_request WHERE id = '${voucher}'`)).toBe('Cancelled');
    expect(sql(`SELECT count(*) FROM lms.payment_hold WHERE payment_id = '${voucher}' AND lifted_at IS NULL`)).toBe('0');
    expect((await fin.post('/api/payments', { action: 'cancel', payment_id: voucher, reason: 'again please' })).status).toBe(409);
  });
});
