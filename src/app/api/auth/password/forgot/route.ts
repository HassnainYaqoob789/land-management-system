import { after } from 'next/server';
import { publicRoute } from '@/lib/iam/public';
import { json, readJson, str } from '@/lib/iam/http';
import { withoutActor } from '@/lib/db';
import { newToken, sha256 } from '@/lib/iam/crypto';
import { deliverMail } from '@/lib/iam/mail';
import { appOrigin } from '@/lib/iam/config';
import { logEvent } from '@/lib/iam/login';
import { requestNet } from '@/lib/iam/session';
import { linkRef } from '@/lib/iam/password';

// "I forgot my password", for local accounts. Nothing in the answer — body,
// status or timing — depends on whether the account exists or can be
// recovered: every branch does the same database work, mail goes out after the
// response, and every answer takes at least FLOOR_MS. The answer never claims
// that a message was delivered.
const FLOOR_MS = 500;
const settle = async (startedAt: number) => {
  const left = FLOOR_MS - (performance.now() - startedAt);
  if (left > 0) await new Promise((r) => setTimeout(r, left));
};

export const POST = publicRoute(async (req, corr) => {
  const startedAt = performance.now();
  const { ip, ua } = requestNet(req);
  const username = str(await readJson(req, 2048), 'username', { max: 64 }).trim().toLowerCase();
  const base = appOrigin();
  // Requests share the sign-in budget: they are recorded as non-successful
  // sign-in events (flow=password_reset_request), so iam.failure_counts limits
  // them per username and per address together with failed passwords.
  const f = (await withoutActor((c) => c.query(`
    SELECT s.win, s.per_user, s.per_ip, s.minutes, f.by_user, f.by_ip
      FROM (SELECT iam.setting_num('iam.rate_limit_window_minutes', 15)::integer AS win,
                   iam.setting_num('iam.rate_limit_per_user', 10) AS per_user, iam.setting_num('iam.rate_limit_per_ip', 30) AS per_ip,
                   iam.setting_num('iam.recovery_token_minutes', 30) AS minutes) s,
           LATERAL iam.failure_counts($1, $2, s.win) f`, [username, ip]))).rows[0];
  const win = Number(f.win), minutes = Number(f.minutes);
  if (Number(f.by_user) >= Number(f.per_user) || (ip && Number(f.by_ip) >= Number(f.per_ip))) {
    await logEvent('login', 'denied', { username, ip, ua, corr, meta: { flow: 'password_reset_request', reason: 'rate_limited' } });
    await settle(startedAt);
    return json({ error: 'Too many attempts. Try again later.', code: 'rate_limited', correlationId: corr }, 429, { 'Retry-After': String(win * 60) });
  }

  // Issues a token only for an active, non-service, non-emergency account that
  // has a local password and an e-mail address; otherwise returns no row.
  const token = newToken(32), ref = linkRef(token);
  const r = (await withoutActor((c) => c.query('SELECT * FROM iam.request_password_reset($1,$2)', [username, sha256(token)]))).rows[0];
  await logEvent('login', 'info', { userId: r?.user_id ?? null, username, ip, ua, corr,
    meta: { flow: 'password_reset_request', eligible: !!r, link_ref: r ? ref : null } });

  if (r) {
    const link = `${base}/reset-password?token=${encodeURIComponent(token)}`;
    after(async () => {
      try {
        const sent = await deliverMail({ to: r.email, subject: 'Reset your Mari Energies LMS password', text: [
          `A password reset was requested for the Land Management System account "${username}".`, '',
          `To choose a new password, open this link within ${minutes} minutes:`, link, '',
          'The link works once. If you did not ask for this, ignore this message (your password does not change) and tell your administrator.', '',
          'Mari Energies Limited - Land Management System'].join('\n') });
        await logEvent('password_reset_delivery', sent.delivered ? 'success' : 'failure', { userId: r.user_id, username, ip, ua, corr,
          meta: sent.delivered ? { link_ref: ref } : { link_ref: ref, reason: sent.reason, error_code: sent.detail ?? null } });
        if (!sent.delivered) console.error(`[SECURITY] password reset link for user ${r.user_id} was not delivered (${sent.reason}); correlation ${corr}`);
      } catch (e) {
        console.error(`[SECURITY] password reset delivery could not be recorded; correlation ${corr}`, (e as Error)?.message);
      }
    });
  }
  await settle(startedAt);
  return json({ ok: true, message: `Request received. If the username matches an account that can be recovered by e-mail, a reset link will be sent `
    + `to the address on file. The link works once and expires after ${minutes} minutes. If nothing arrives within a few minutes, contact your administrator.` });
});
