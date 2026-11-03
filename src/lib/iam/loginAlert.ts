import { withActor } from '../db';
import { deliverMail } from './mail';
import { deviceFromRequest, type DeviceInfo } from './device';
import { locateIp, type GeoInfo } from './geoip';

// Sign-in alert: after every successful sign-in, an e-mail to the addresses in
// LOGIN_ALERT_TO says who signed in, when, from where and on what device.
//   LOGIN_ALERT_TO          one or more addresses, comma separated; empty = off
//   LOGIN_ALERT_TIMEZONE    time zone for the e-mail (default Asia/Karachi)
//   LOGIN_ALERT_GEO / IPINFO_TOKEN   location lookup, see ./geoip
// Mail goes through the SMTP settings in ./mailer (SMTP_HOST, SMTP_FROM, ...).
// The alert is sent after the sign-in answer has gone back, so it never slows
// or blocks a sign-in. It is e-mail only: nothing is written to the database or
// shown in the app (by the owner's decision); a failed delivery is reported in
// the server log only.

const ADDRESS = /^[^\s@<>()",;:\\]+@[^\s@<>()",;:\\]+\.[^\s@<>()",;:\\]+$/;

export function alertRecipients(env: NodeJS.ProcessEnv = process.env): string[] {
  const list = (env.LOGIN_ALERT_TO ?? '').split(/[,;\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  return [...new Set(list.filter((a) => ADDRESS.test(a)))];
}

export const loginAlertsOn = (env: NodeJS.ProcessEnv = process.env) => alertRecipients(env).length > 0;

/** What the request tells us, read before the response is sent. */
export interface LoginContext {
  userId: string; username: string; method: string; mfaMethod: string | null;
  providerId: string | null; sessionId: string; corr: string;
  ip: string | null; ua: string | null; device: DeviceInfo;
  language: string | null; site: string | null; at: Date;
}

export function loginContext(req: Request, p: Omit<LoginContext, 'device' | 'language' | 'site' | 'at' | 'ip' | 'ua'>,
  net: { ip: string | null; ua: string | null }): LoginContext {
  const lang = req.headers.get('accept-language');
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  return { ...p, ...net, device: deviceFromRequest(req), at: new Date(),
    language: lang ? lang.split(',')[0].trim().slice(0, 20) : null,
    site: host ? host.split(',')[0].trim().slice(0, 100) : null };
}

interface Account {
  code: string | null; full_name: string | null; email: string | null; department: string | null; position: string | null;
  office_code: string | null; roles: string[]; provinces: string[]; groups: string[];
  prev: { started_at: Date; source_ip: string | null; user_agent: string | null; auth_method: string | null } | null;
  ip_seen: boolean; ua_seen: boolean; today: number;
}

async function account(c: LoginContext): Promise<Account> {
  return withActor(c.userId, async (db) => {
    const u = (await db.query(`SELECT code, full_name, email, department, position, office_code FROM lms.app_user WHERE id = $1`, [c.userId])).rows[0] ?? {};
    const roles = (await db.query(`SELECT r.name FROM iam.user_role ur JOIN iam.role r ON r.id = ur.role_id
      WHERE ur.user_id = $1 AND ur.revoked_at IS NULL AND (ur.expires_at IS NULL OR ur.expires_at > now()) AND r.status = 'active' ORDER BY r.name`,
      [c.userId])).rows.map((r) => r.name as string);
    const provinces = (await db.query(`SELECT province_code FROM lms.app_user_province WHERE user_id = $1 ORDER BY 1`, [c.userId])).rows.map((r) => r.province_code as string);
    const groups = (await db.query(`SELECT group_code FROM lms.app_user_group WHERE user_id = $1 ORDER BY 1`, [c.userId])).rows.map((r) => r.group_code as string);
    const prev = (await db.query(`SELECT started_at, host(source_ip) AS source_ip, user_agent, auth_method FROM lms.login_session
      WHERE user_id = $1 AND id <> $2 ORDER BY started_at DESC LIMIT 1`, [c.userId, c.sessionId])).rows[0] ?? null;
    const seen = (await db.query(`SELECT
        EXISTS (SELECT 1 FROM lms.login_session WHERE user_id = $1 AND id <> $2 AND source_ip IS NOT DISTINCT FROM $3::inet) AS ip_seen,
        EXISTS (SELECT 1 FROM lms.login_session WHERE user_id = $1 AND id <> $2 AND user_agent IS NOT DISTINCT FROM left($4, 300)) AS ua_seen,
        (SELECT count(*) FROM lms.login_session WHERE user_id = $1 AND started_at >= date_trunc('day', now())) AS today`,
      [c.userId, c.sessionId, c.ip, c.ua])).rows[0];
    return { ...u, roles, provinces, groups, prev, ip_seen: !!seen.ip_seen, ua_seen: !!seen.ua_seen, today: Number(seen.today) };
  });
}

const METHOD: Record<string, string> = {
  local: 'Username and password', ldap: 'Company directory (LDAP)', oidc: 'Single sign-on (OIDC)', saml: 'Single sign-on (SAML)',
  passkey: 'Passkey', break_glass: 'EMERGENCY (break-glass) account',
};
const MFA: Record<string, string> = { totp: 'Authenticator app code', recovery: 'Recovery code', passkey: 'Passkey', webauthn: 'Passkey' };

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));
const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').slice(0, 200);

function when(d: Date, tz: string) {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true, timeZoneName: 'short' }).format(d);
  } catch { return d.toISOString(); }
}

export interface AlertRow { label: string; value: string; href?: string; flag?: boolean }

/** The e-mail's rows, grouped; exported for tests. */
export function alertSections(c: LoginContext, a: Account, geo: GeoInfo, tz: string): { title: string; rows: AlertRow[] }[] {
  const newIp = !!a.prev && !a.ip_seen, newDevice = !!a.prev && !a.ua_seen;
  const map = geo.lat != null && geo.lon != null ? `https://www.google.com/maps?q=${geo.lat},${geo.lon}` : undefined;
  return [
    { title: 'Who', rows: [
      { label: 'Name', value: a.full_name || c.username },
      { label: 'Username', value: c.username },
      { label: 'Employee code', value: a.code ?? '' },
      { label: 'E-mail', value: a.email ?? '' },
      { label: 'Designation', value: [a.position, a.department].filter(Boolean).join(', ') },
      { label: 'Roles', value: a.roles.join(', ') || 'none' },
      { label: 'Approval positions', value: a.groups.join(', ') || 'none' },
      { label: 'Provinces', value: a.provinces.join(', ') || 'none' },
    ] },
    { title: 'When', rows: [
      { label: 'Time (Pakistan)', value: when(c.at, tz) },
      { label: "Visitor's local time", value: geo.timezone && geo.timezone !== tz ? `${when(c.at, geo.timezone)} (${geo.timezone})` : '' },
      { label: 'Time (UTC)', value: c.at.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC') },
      { label: 'Sign-ins today', value: String(a.today) },
      { label: 'Previous sign-in', value: a.prev ? `${when(new Date(a.prev.started_at), tz)} from ${a.prev.source_ip ?? 'unknown address'}` : 'First sign-in on record' },
    ] },
    { title: 'Where', rows: [
      { label: 'Location (approx.)', value: geo.text, href: map },
      { label: 'Postal / area code', value: geo.postal ?? '' },
      { label: 'IP address', value: c.ip ?? 'unknown', flag: newIp },
      { label: 'New address?', value: a.prev ? (newIp ? 'YES: first sign-in from this address' : 'No, used before') : 'n/a', flag: newIp },
      { label: 'Network / ISP', value: geo.isp ?? '' },
      { label: 'Visitor time zone', value: geo.timezone ?? '' },
      { label: 'Site used', value: c.site ?? '' },
    ] },
    { title: 'Device', rows: [
      { label: 'Device', value: c.device.summary },
      { label: 'Device type', value: c.device.type },
      { label: 'Operating system', value: c.device.os },
      { label: 'Browser', value: c.device.browser },
      { label: 'New device?', value: a.prev ? (newDevice ? 'YES: first sign-in with this browser' : 'No, used before') : 'n/a', flag: newDevice },
      { label: 'Language', value: c.language ?? '' },
      { label: 'Browser string', value: (c.ua ?? '').slice(0, 300) },
    ] },
    { title: 'Sign-in', rows: [
      { label: 'Method', value: METHOD[c.method] ?? c.method, flag: c.method === 'break_glass' },
      { label: 'Second factor (MFA)', value: c.mfaMethod ? (MFA[c.mfaMethod] ?? c.mfaMethod) : 'None' },
      { label: 'Session', value: c.sessionId.slice(0, 8) },
      { label: 'Reference', value: c.corr },
    ] },
  ].map((s) => ({ ...s, rows: s.rows.filter((r) => r.value !== '') }));
}

export function composeAlert(c: LoginContext, a: Account, geo: GeoInfo, tz: string) {
  const sections = alertSections(c, a, geo, tz);
  const name = a.full_name || c.username;
  const newIp = !!a.prev && !a.ip_seen, newDevice = !!a.prev && !a.ua_seen;
  const tags = [c.method === 'break_glass' ? 'EMERGENCY ACCESS' : '', newDevice ? 'new device' : '', newIp ? 'new location' : ''].filter(Boolean);
  const where = geo.status === 'found' ? (geo.city || geo.country || geo.text) : (c.ip ?? 'unknown address');
  const subject = oneLine(`${tags.length ? `[${tags.join(', ')}] ` : ''}LMS sign-in: ${name} (${c.username}) from ${where}, ${c.device.type.toLowerCase()}`);

  const text = [
    `${name} (${c.username}) signed in to the Mari Energies Land Management System.`, '',
    ...sections.flatMap((s) => [s.title.toUpperCase(), ...s.rows.map((r) => `  ${r.label}: ${r.value}${r.href ? `  (${r.href})` : ''}`), '']),
    'If this sign-in was not expected, suspend the account under Users & Roles and end its sessions.',
    'Location comes from the IP address and is approximate (city level).',
  ].join('\n');

  const rowsHtml = (rows: AlertRow[]) => rows.map((r) => `<tr><td style="padding:4px 12px 4px 0;color:#555;width:170px;vertical-align:top">${esc(r.label)}</td>`
    + `<td style="padding:4px 0;${r.flag ? 'color:#b42318;font-weight:600' : 'color:#111'};word-break:break-word">`
    + (r.href ? `<a href="${esc(r.href)}" style="color:#0b5cad">${esc(r.value)}</a>` : esc(r.value)) + `</td></tr>`).join('');
  const html = `<!doctype html><html><body style="margin:0;background:#f4f5f7;font-family:Segoe UI,Arial,sans-serif;font-size:14px">
<div style="max-width:640px;margin:0 auto;padding:16px">
<div style="background:#0d3b66;color:#fff;padding:14px 18px;border-radius:8px 8px 0 0">
<div style="font-size:12px;opacity:.85">Mari Energies LMS · Sign-in alert</div>
<div style="font-size:18px;font-weight:600;margin-top:4px">${esc(name)} signed in</div>
${tags.length ? `<div style="margin-top:6px;display:inline-block;background:#b42318;padding:2px 8px;border-radius:10px;font-size:12px">${esc(tags.join(' · '))}</div>` : ''}
</div>
<div style="background:#fff;padding:6px 18px 16px;border-radius:0 0 8px 8px;border:1px solid #e3e6ea;border-top:0">
${sections.map((s) => `<h3 style="font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:#0d3b66;margin:16px 0 6px">${esc(s.title)}</h3>
<table style="border-collapse:collapse;width:100%;table-layout:fixed">${rowsHtml(s.rows)}</table>`).join('\n')}
<p style="margin:18px 0 0;color:#555;font-size:12px">If this sign-in was not expected, suspend the account under <b>Users &amp; Roles</b> and end its sessions.
Location comes from the IP address and is approximate (city level).</p>
</div></div></body></html>`;
  return { subject, text, html, newIp, newDevice };
}

/** Builds and sends the alert. Never throws. */
export async function sendLoginAlert(c: LoginContext): Promise<void> {
  const to = alertRecipients();
  if (!to.length) return;
  try {
    const tz = process.env.LOGIN_ALERT_TIMEZONE?.trim() || 'Asia/Karachi';
    const [a, geo] = await Promise.all([account(c), locateIp(c.ip)]);
    const mail = composeAlert(c, a, geo, tz);
    const results = await Promise.all(to.map((addr) => deliverMail({ to: addr, subject: mail.subject, text: mail.text, html: mail.html })));
    const delivered = results.filter((r) => r.delivered).length;
    const firstFail = results.find((r) => !r.delivered) as { reason?: string; detail?: string } | undefined;
    if (firstFail) console.error(`[SECURITY] sign-in alert for ${c.username} not delivered to ${to.length - delivered} of ${to.length} (${firstFail.reason}); correlation ${c.corr}`);
  } catch (e) {
    console.error(`[SECURITY] sign-in alert for ${c.username} failed; correlation ${c.corr}`, (e as Error)?.message);
  }
}
