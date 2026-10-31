import { randomUUID } from 'node:crypto';
import { Client, Filter, FilterParser, InvalidCredentialsError, SizeLimitExceededError } from 'ldapts';
import { withoutActor } from '../../db';
import { HttpError } from '../http';
import {
  audit, describeError, markFailing, markHealthy, pem, runtimeProvider, text, url,
  type Input, type Provider, type TestResult,
} from './providers';
import { provision } from './complete';

// LDAP / Active Directory sign-in: LDAPS only, the configured CA only, a
// service bind to find the person, then a bind as the person with the password
// they typed. Groups come from the configured attribute; they grant nothing
// unless an identity administrator mapped them.

export interface LdapConfig {
  url: string;               // ldaps://host:port
  bind_dn: string;           // the service account that may search
  base_dn: string;           // where people are searched
  user_filter: string;       // e.g. (uid={{username}}) or (sAMAccountName={{username}})
  group_attribute: string;   // e.g. memberOf
  subject_attribute: string; // immutable id: entryUUID, or objectGUID on AD
  email_attribute: string;
  name_attribute: string;
  ca_certificate: string;    // PEM; empty = the server's system trust store
}

const ATTR = /^([A-Za-z][A-Za-z0-9-]{0,63}|[0-9]+(\.[0-9]+)+)$/;
const PLACEHOLDER = '{{username}}';

export function validateLdapConfig(input: Input): LdapConfig {
  const cfg: LdapConfig = {
    url: url(input, 'url', 'Directory URL', { protocols: ['ldaps:'] }),
    bind_dn: text(input, 'bind_dn', 'Bind DN', { required: true, max: 500 }),
    base_dn: text(input, 'base_dn', 'Base DN', { required: true, max: 500 }),
    user_filter: text(input, 'user_filter', 'User filter', { required: true, max: 500 }),
    group_attribute: text(input, 'group_attribute', 'Group attribute', { def: 'memberOf', pattern: ATTR, hint: 'must be an attribute name' }),
    subject_attribute: text(input, 'subject_attribute', 'Subject attribute', { def: 'entryUUID', pattern: ATTR, hint: 'must be an attribute name' }),
    email_attribute: text(input, 'email_attribute', 'E-mail attribute', { def: 'mail', pattern: ATTR, hint: 'must be an attribute name' }),
    name_attribute: text(input, 'name_attribute', 'Name attribute', { def: 'cn', pattern: ATTR, hint: 'must be an attribute name' }),
    ca_certificate: pem(input, 'ca_certificate', 'CA certificate', { multiple: true }),
  };
  const n = cfg.user_filter.split(PLACEHOLDER).length - 1;
  if (n !== 1) throw new HttpError(400, `User filter: must contain ${PLACEHOLDER} exactly once`, 'validation');
  try { FilterParser.parseString(cfg.user_filter.replace(PLACEHOLDER, 'probe')); }
  catch { throw new HttpError(400, 'User filter: is not a valid LDAP filter, e.g. (uid={{username}})', 'validation'); }
  return cfg;
}

function connect(cfg: LdapConfig): Client {
  return new Client({
    url: cfg.url, timeout: 8000, connectTimeout: 5000, strictDN: true,
    // Certificate and host name are always verified; with a CA configured,
    // only that CA is trusted.
    tlsOptions: { minVersion: 'TLSv1.2', ...(cfg.ca_certificate ? { ca: cfg.ca_certificate } : {}) },
  });
}

/** Attribute values regardless of how the server cased the name, as strings. */
function values(entry: Record<string, unknown>, attribute: string): string[] {
  const key = Object.keys(entry).find((k) => k.toLowerCase() === attribute.toLowerCase());
  if (!key) return [];
  const v = entry[key];
  const list = Array.isArray(v) ? v : v === undefined || v === null ? [] : [v];
  return list.map((x) => (Buffer.isBuffer(x) ? x.toString('hex') : String(x))).filter((s) => s.length > 0);
}

/** Group values as the directory returned them (often DNs), plus each DN's
 * leading CN, so a mapping can name "LMS-LandOfficers" or the full DN. */
export function groupNames(raw: string[]): string[] {
  const out: string[] = [];
  for (const g of raw) {
    out.push(g);
    const m = /^\s*cn\s*=\s*((?:\\.|[^,+\\])+)/i.exec(g);
    if (m) {
      const cn = m[1].trim().replace(/\\([0-9a-fA-F]{2})/g, (_s, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\(.)/g, '$1');
      if (cn) out.push(cn);
    }
  }
  return [...new Set(out)];
}

export type LdapResult =
  | { ok: true; userId: string; username: string; providerId: string }
  | { ok: false; reason: 'invalid_credentials' | 'unavailable' | 'pending_approval' | 'inactive' };

const INVALID: LdapResult = { ok: false, reason: 'invalid_credentials' };
const UNAVAILABLE: LdapResult = { ok: false, reason: 'unavailable' };

async function setting(key: string, def: number): Promise<number> {
  const r = await withoutActor((c) => c.query('SELECT iam.setting_num($1, $2) AS n', [key, def]));
  return Number(r.rows[0].n);
}

export interface DirectoryPerson { dn: string; subject: string | null; email: string | null; name: string | null; groups: string[] }
export type DirectoryAnswer =
  | { kind: 'person'; person: DirectoryPerson }
  | { kind: 'not_found'; matches: number }
  | { kind: 'bad_password' }
  | { kind: 'failure'; stage: 'service_bind' | 'search' | 'user_bind'; detail: string };

/** The directory conversation alone (no database): service bind, escaped
 * search for exactly one person, then a bind as that person. */
export async function directoryLookup(cfg: LdapConfig, bindPassword: string, login: string, password: string): Promise<DirectoryAnswer> {
  if (!password) return { kind: 'bad_password' };     // never an anonymous bind
  const c = connect(cfg);
  try {
    try { await c.bind(cfg.bind_dn, bindPassword); } catch (e) { return { kind: 'failure', stage: 'service_bind', detail: describeError(e) }; }
    const filter = cfg.user_filter.replace(PLACEHOLDER, Filter.escape(login));
    let found: Record<string, unknown>[];
    // Attribute names are case-insensitive (RFC 4512) but not every server
    // matches the requested list that way: ask in lower case, read any case.
    const wanted = [cfg.subject_attribute, cfg.group_attribute, cfg.email_attribute, cfg.name_attribute];
    try {
      ({ searchEntries: found } = await c.search(cfg.base_dn, {
        scope: 'sub', filter, sizeLimit: 2, timeLimit: 8,
        attributes: [...new Set(wanted.map((a) => a.toLowerCase()))],
        explicitBufferAttributes: cfg.subject_attribute.toLowerCase() === 'objectguid' ? [cfg.subject_attribute, 'objectGUID', 'objectguid'] : [],
      }));
    } catch (e) {
      if (e instanceof SizeLimitExceededError) return { kind: 'not_found', matches: 2 };   // ambiguous: never guess
      return { kind: 'failure', stage: 'search', detail: describeError(e) };
    }
    if (found.length !== 1) return { kind: 'not_found', matches: found.length };
    const entry = found[0];
    const dn = String(entry.dn);
    try { await c.bind(dn, password); } catch (e) {
      if (e instanceof InvalidCredentialsError) return { kind: 'bad_password' };
      return { kind: 'failure', stage: 'user_bind', detail: describeError(e) };
    }
    return { kind: 'person', person: {
      dn, subject: values(entry, cfg.subject_attribute)[0] ?? null, email: values(entry, cfg.email_attribute)[0] ?? null,
      name: values(entry, cfg.name_attribute)[0] ?? null, groups: groupNames(values(entry, cfg.group_attribute)),
    } };
  } finally {
    await c.unbind().catch(() => {});
  }
}

/** Directory sign-in for the password form (called by the login route). The
 * answer never says which step failed: unknown person and wrong password are
 * both invalid_credentials. Failures are logged as login failures so the
 * per-account rate limit counts them. */
export async function ldapAuthenticate(providerName: string, username: string, password: string,
  net: { ip?: string | null; ua?: string | null } = {}): Promise<LdapResult> {
  const corr = randomUUID();
  const where = { ip: net.ip ?? null, ua: net.ua ?? null };   // so the per-address limit counts directory failures too
  const login = (username ?? '').trim();
  if (!login || login.length > 128 || /[\u0000-\u001f\u007f]/.test(login)) return INVALID;
  // An empty password is an anonymous bind on most servers: it would "succeed".
  if (typeof password !== 'string' || password.length === 0 || password.length > 1024) return INVALID;

  let p: Provider | null;
  try { p = await runtimeProvider(providerName); } catch (e) {
    console.error(`[${corr}] LDAP provider ${providerName} could not be loaded:`, describeError(e));
    return UNAVAILABLE;
  }
  if (!p || p.kind !== 'ldap' || !p.secret) return UNAVAILABLE;
  const cfg = p.config as unknown as LdapConfig;

  // Stop before the directory does: its own lockout is not ours to trip.
  const window = await setting('iam.rate_limit_window_minutes', 15);
  const f = (await withoutActor((c) => c.query('SELECT * FROM iam.failure_counts($1, NULL, $2)', [login, window]))).rows[0];
  if (Number(f?.by_user ?? 0) >= (await setting('iam.rate_limit_per_user', 10))) {
    await audit('login', 'denied', { username: login, provider: p.id, corr, ...where, meta: { method: 'ldap', reason: 'rate_limited' } });
    return INVALID;
  }

  const answer = await directoryLookup(cfg, p.secret, login, password);
  switch (answer.kind) {
    case 'person': break;
    case 'not_found':
      await audit('login', 'unknown_user', { username: login, provider: p.id, corr, ...where, meta: { method: 'ldap', matches: answer.matches } });
      return INVALID;
    case 'bad_password':
      await audit('login', 'bad_password', { username: login, provider: p.id, corr, ...where, meta: { method: 'ldap' } });
      return INVALID;
    default:
      // The directory itself failed (unreachable, certificate, service bind):
      // show the method as unavailable for a while.
      if (answer.stage !== 'user_bind') markFailing(p.name);
      await audit('directory', 'failure', { provider: p.id, corr, meta: { method: 'ldap', reason: answer.stage, detail: answer.detail } });
      return UNAVAILABLE;
  }
  markHealthy(p.name);
  const { person } = answer;
  if (!person.subject) {
    await audit('directory', 'failure', { provider: p.id, corr, meta: { method: 'ldap', reason: 'no_subject_attribute' } });
    return UNAVAILABLE;
  }
  const out = await provision(p, {
    subject: person.subject, issuer: cfg.url, email: person.email, emailVerified: false,
    displayName: person.name, groups: person.groups,
  }, 'ldap', corr, where);
  if (out.status === 'pending') return { ok: false, reason: 'pending_approval' };
  if (out.status === 'inactive') return { ok: false, reason: 'inactive' };
  return { ok: true, userId: out.userId, username: out.username, providerId: p.id };
}

/** Test connection: LDAPS handshake with certificate checks, the service
 * bind, and a read of the search base. */
export async function testLdap(p: Provider): Promise<TestResult> {
  const cfg = p.config as unknown as LdapConfig;
  if (!p.secret) return { ok: false, detail: 'No bind password is stored.' };
  const c = connect(cfg);
  try {
    try { await c.bind(cfg.bind_dn, p.secret); } catch (e) {
      return { ok: false, detail: e instanceof InvalidCredentialsError
        ? 'The directory refused the bind DN and password.'
        : `Could not connect and bind over LDAPS: ${describeError(e)}` };
    }
    try { await c.search(cfg.base_dn, { scope: 'base', filter: '(objectClass=*)', attributes: ['1.1'], sizeLimit: 1, timeLimit: 8 }); }
    catch (e) { return { ok: false, detail: `Bound, but the base DN could not be read: ${describeError(e)}` }; }
    return { ok: true, detail: `Connected over LDAPS with a verified certificate, bound as the service account and read ${cfg.base_dn}.` };
  } finally {
    await c.unbind().catch(() => {});
  }
}
