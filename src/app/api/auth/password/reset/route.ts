import { publicRoute } from '@/lib/iam/public';
import { json, readJson, str, HttpError } from '@/lib/iam/http';
import { withoutActor } from '@/lib/db';
import { sha256 } from '@/lib/iam/crypto';
import { checkPasswordPolicy, hashPassword, linkRef, matchesHistory } from '@/lib/iam/password';
import { logEvent, num } from '@/lib/iam/login';
import { requestNet } from '@/lib/iam/session';

// Redeems a password-reset OR an invitation link. Single-use, expiring, stored
// only as a hash; redeeming it ends every existing session of the account.
// { token, purpose, check: true } only reports whether the link is still good
// (and the minimum length), so the page can say so before anything is typed.
export const POST = publicRoute(async (req, corr) => {
  const b = await readJson(req, 4096);
  const token = str(b, 'token', { max: 100 });
  const purpose = b.purpose === 'invitation' ? 'invitation' : 'password_reset';
  const event = purpose === 'invitation' ? 'invitation_accepted' : 'password_reset';
  const { ip, ua } = requestNet(req);
  const ref = linkRef(token), h = sha256(token);
  const minLength = await num('security.password_min_length', 12);
  // An unknown, expired or already-used link. A re-used one is recorded with the
  // same link_ref as its earlier success, so the re-use can be traced.
  const refuse = async (userId?: string) => {
    await logEvent(event, 'denied', { userId: userId ?? null, ip, ua, corr, meta: { reason: 'invalid_or_used_link', link_ref: ref } });
    return json({ error: 'This link is invalid, has already been used, or has expired. Ask for a new one.', code: 'bad_token', correlationId: corr }, 400);
  };

  const who = (await withoutActor((c) => c.query('SELECT * FROM iam.token_subject($1,$2)', [h, purpose]))).rows[0];
  if (!who) return refuse();
  if (b.check === true) return json({ ok: true, valid: true, minLength });

  const pw = str(b, 'newPassword', { max: 1024 });
  const fail = async (reason: string, message: string, code: string) => {
    await logEvent(event, 'failure', { userId: who.user_id, username: who.username, ip, ua, corr, meta: { reason, link_ref: ref } });
    throw new HttpError(400, message, code);
  };
  const errs = checkPasswordPolicy(pw, { username: who.username, fullName: who.full_name, minLength });
  if (errs.length) return fail('weak_password', errs.join(' '), 'weak_password');
  const hist = (await withoutActor((c) => c.query('SELECT * FROM iam.recent_password_hashes($1,$2)', [who.user_id, h])))
    .rows.map((r) => r.recent_password_hashes as string);
  if (await matchesHistory(pw, hist)) return fail('reused_password', 'Choose a password you have not used recently.', 'reused');

  const newHash = await hashPassword(pw);
  try {
    // Marks the link used, sets the password (history, lockout cleared) and
    // ends every session of the account, in one transaction.
    await withoutActor((c) => c.query('SELECT iam.redeem_token($1,$2,$3)', [h, purpose, newHash]));
  } catch (e: any) {
    if (e?.code === '28000') return refuse(who.user_id);   // spent by a concurrent request
    throw e;
  }
  await logEvent(event, 'success', { userId: who.user_id, username: who.username, ip, ua, corr, meta: { link_ref: ref, sessions_ended: true } });
  return json({ ok: true });
});
