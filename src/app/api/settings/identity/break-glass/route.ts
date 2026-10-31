import { HttpError, json, protect, readJson, str } from '@/lib/iam/http';
import { routineMessage } from '@/lib/iam/sso/admin';

// Emergency-access ("break-glass") accounts: local accounts that can still sign
// in when local sign-in is switched off or every provider fails. The database
// insists on MFA and an active local password (iam.set_break_glass); each such
// sign-in raises a security event.
export const POST = protect({ permission: ['identity_settings', 'configure'], reauth: true }, async (ctx) => {
  const b = await readJson(ctx.req, 1024);
  const username = str(b, 'username', { max: 64 }).trim().toLowerCase();
  if (typeof b.enabled !== 'boolean') throw new HttpError(400, 'enabled must be true or false.', 'validation');
  const u = (await ctx.client.query('SELECT id FROM lms.app_user WHERE username = $1', [username])).rows[0];
  if (!u) throw new HttpError(400, 'No account has that username.', 'validation');
  await ctx.client.query('SELECT iam.set_break_glass($1, $2)', [u.id, b.enabled]).catch(routineMessage);
  return json({ ok: true });
});
