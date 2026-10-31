// Local identity providers and a mail sink for automated tests — NEVER for
// production. They let the sign-in code be exercised against real protocol
// implementations instead of mocks:
//
//   OIDC  oidc-provider (the reference OpenID Connect implementation)   :4010
//   SAML  a minimal IdP that signs assertions with xml-crypto            :4020
//   LDAP  ldapjs over TLS (LDAPS) with a throwaway CA                     :6636
//   SMTP  smtp-server with STARTTLS; every message saved as .eml          :2525
//
//   node scripts/test-idp/server.mjs <dir> <app-origin>
//
// Writes <dir>/config.json describing endpoints, client credentials and the
// CA / signing certificates, which the tests use to register the providers in
// the LMS through its own administration API.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { randomBytes, randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { join } from 'node:path';
import Provider from 'oidc-provider';
import ldap from 'ldapjs';
import { SMTPServer } from 'smtp-server';
import { SignedXml } from 'xml-crypto';

const DIR = process.argv[2];
const APP = (process.argv[3] || 'http://localhost:3041').replace(/\/$/, '');
if (!DIR) { console.error('usage: server.mjs <dir> <app-origin>'); process.exit(2); }
mkdirSync(join(DIR, 'mail'), { recursive: true });

// ---- throwaway PKI ---------------------------------------------------------
const ssl = (...a) => execFileSync('openssl', a, { stdio: 'pipe' });
const f = (n) => join(DIR, n);
ssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=LMS Test CA',
  '-keyout', f('ca.key'), '-out', f('ca.pem'), '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign');
ssl('req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost', '-keyout', f('tls.key'), '-out', f('tls.csr'));
writeFileSync(f('tls.ext'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n');
ssl('x509', '-req', '-in', f('tls.csr'), '-CA', f('ca.pem'), '-CAkey', f('ca.key'), '-CAcreateserial', '-days', '2', '-extfile', f('tls.ext'), '-out', f('tls.pem'));
ssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=LMS Test SAML IdP', '-keyout', f('saml.key'), '-out', f('saml.pem'));
const CA = readFileSync(f('ca.pem'), 'utf8');
const TLS_KEY = readFileSync(f('tls.key'), 'utf8');
const TLS_CERT = readFileSync(f('tls.pem'), 'utf8');
const SAML_KEY = readFileSync(f('saml.key'), 'utf8');
const SAML_CERT = readFileSync(f('saml.pem'), 'utf8');

// ---- directory of test people (the same three in every IdP) ---------------
const PEOPLE = {
  'ext.officer': { name: 'External Land Officer', email: 'ext.officer@idp.test', groups: ['LMS-LandOfficers'], password: 'Officer-pass-1234' },
  'ext.auditor': { name: 'External Auditor', email: 'ext.auditor@idp.test', groups: ['LMS-Auditors'], password: 'Auditor-pass-1234' },
  'ext.nobody':  { name: 'External Unmapped', email: 'ext.nobody@idp.test', groups: [], password: 'Nobody-pass-1234' },
};

// ---- OIDC ----------------------------------------------------------------
// Served over TLS with the throwaway CA: start the LMS with NODE_EXTRA_CA_CERTS=<dir>/ca.pem
// so it trusts this issuer exactly as it would trust a real one — no insecure-HTTP switch.
const OIDC_PORT = 4010, OIDC_ISSUER = `https://localhost:${OIDC_PORT}`;
const OIDC_CLIENT = { client_id: 'lms-test', client_secret: randomBytes(24).toString('base64url') };
const oidc = new Provider(OIDC_ISSUER, {
  clients: [{
    ...OIDC_CLIENT,
    redirect_uris: [`${APP}/api/auth/oidc/test-oidc/callback`],
    grant_types: ['authorization_code'], response_types: ['code'],
    token_endpoint_auth_method: 'client_secret_basic',
  }],
  pkce: { required: () => true },
  claims: { openid: ['sub'], email: ['email', 'email_verified'], profile: ['name'], groups: ['groups'] },
  scopes: ['openid', 'email', 'profile', 'groups'],
  // The dev login form accepts any login name; only our three people exist.
  async findAccount(_ctx, sub) {
    const p = PEOPLE[sub];
    if (!p) return undefined;
    return { accountId: sub, async claims() { return { sub, email: p.email, email_verified: true, name: p.name, groups: p.groups }; } };
  },
  conformIdTokenClaims: false,
  cookies: { keys: [randomBytes(32).toString('base64url')] },
  features: { devInteractions: { enabled: true } },
});
oidc.proxy = false;
await new Promise((r) => https.createServer({ key: TLS_KEY, cert: TLS_CERT }, oidc.callback()).listen(OIDC_PORT, r));

// ---- SAML IdP ---------------------------------------------------------------
const SAML_PORT = 4020, SAML_BASE = `http://localhost:${SAML_PORT}`;
const SAML_ISSUER = `${SAML_BASE}/saml/metadata`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function samlResponse({ acs, audience, inResponseTo, user }) {
  const p = PEOPLE[user];
  const now = new Date(), later = new Date(now.getTime() + 5 * 60_000), id = `_a${randomUUID().replace(/-/g, '')}`;
  const attr = (n, vals) => `<saml:Attribute Name="${n}">${vals.map((v) => `<saml:AttributeValue>${esc(v)}</saml:AttributeValue>`).join('')}</saml:Attribute>`;
  const assertion = `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id}" Version="2.0" IssueInstant="${now.toISOString()}">`
    + `<saml:Issuer>${SAML_ISSUER}</saml:Issuer>`
    + `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:2.0:nameid-format:persistent">${esc(user)}</saml:NameID>`
    + `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData NotOnOrAfter="${later.toISOString()}" Recipient="${esc(acs)}" InResponseTo="${esc(inResponseTo)}"/></saml:SubjectConfirmation></saml:Subject>`
    + `<saml:Conditions NotBefore="${new Date(now.getTime() - 60_000).toISOString()}" NotOnOrAfter="${later.toISOString()}"><saml:AudienceRestriction><saml:Audience>${esc(audience)}</saml:Audience></saml:AudienceRestriction></saml:Conditions>`
    + `<saml:AuthnStatement AuthnInstant="${now.toISOString()}" SessionIndex="${id}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>`
    + `<saml:AttributeStatement>${attr('email', [p.email])}${attr('displayName', [p.name])}${attr('groups', p.groups.length ? p.groups : [])}</saml:AttributeStatement>`
    + `</saml:Assertion>`;
  const sig = new SignedXml({ privateKey: SAML_KEY, publicCert: SAML_CERT, signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
    canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#' });
  sig.addReference({ xpath: `//*[local-name(.)='Assertion']`, digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
    transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'] });
  sig.computeSignature(assertion, { location: { reference: `//*[local-name(.)='Issuer']`, action: 'after' } });
  const signed = sig.getSignedXml();
  const resp = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_r${randomUUID().replace(/-/g, '')}" Version="2.0" IssueInstant="${now.toISOString()}" Destination="${esc(acs)}" InResponseTo="${esc(inResponseTo)}">`
    + `<saml:Issuer>${SAML_ISSUER}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>${signed}</samlp:Response>`;
  return Buffer.from(resp).toString('base64');
}
const pending = new Map();   // login form token → parsed request
http.createServer((req, res) => {
  const url = new URL(req.url, SAML_BASE);
  const html = (s, code = 200) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' }); res.end(s); };
  if (req.method === 'GET' && url.pathname === '/saml/sso') {
    try {
      const xml = inflateRawSync(Buffer.from(url.searchParams.get('SAMLRequest') ?? '', 'base64')).toString('utf8');
      const id = /\sID="([^"]+)"/.exec(xml)?.[1];
      const acs = /AssertionConsumerServiceURL="([^"]+)"/.exec(xml)?.[1];
      const issuer = /<(?:saml2?:)?Issuer[^>]*>([^<]+)</.exec(xml)?.[1];
      if (!id || !acs || !issuer) return html('bad AuthnRequest', 400);
      const t = randomBytes(16).toString('hex');
      pending.set(t, { id, acs, audience: issuer, relay: url.searchParams.get('RelayState') ?? '' });
      return html(`<!doctype html><title>Test SAML IdP</title><h1>Test SAML IdP</h1><form method="post" action="/saml/login">`
        + `<input type="hidden" name="t" value="${t}"><label>User <input name="user" autofocus></label> <button type="submit">Sign in</button></form>`);
    } catch { return html('bad request', 400); }
  }
  if (req.method === 'POST' && url.pathname === '/saml/login') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      const form = new URLSearchParams(body);
      const p = pending.get(form.get('t') ?? '');
      const user = form.get('user') ?? '';
      if (!p || !PEOPLE[user]) return html('unknown user or expired request', 400);
      pending.delete(form.get('t'));
      const r = samlResponse({ acs: p.acs, audience: p.audience, inResponseTo: p.id, user });
      html(`<!doctype html><title>Redirecting</title><form id="f" method="post" action="${esc(p.acs)}">`
        + `<input type="hidden" name="SAMLResponse" value="${r}"><input type="hidden" name="RelayState" value="${esc(p.relay)}">`
        + `<button type="submit">Continue</button></form><script>document.getElementById('f').submit()</script>`);
    });
    return;
  }
  html('not found', 404);
}).listen(SAML_PORT);

// ---- LDAPS -------------------------------------------------------------------
const LDAP_PORT = 6636, BASE_DN = 'dc=lms,dc=test';
const SERVICE = { dn: `cn=lms-bind,ou=service,${BASE_DN}`, password: randomBytes(18).toString('base64url') };
const dnOf = (uid) => `uid=${uid},ou=people,${BASE_DN}`;
const groupDn = (g) => `cn=${g},ou=groups,${BASE_DN}`;
const lds = ldap.createServer({ certificate: TLS_CERT, key: TLS_KEY });
lds.bind(BASE_DN, (req, res, next) => {
  const dn = req.dn.toString().replace(/\s/g, '');
  const pw = req.credentials;
  if (dn === SERVICE.dn.replace(/\s/g, '') && pw === SERVICE.password) { res.end(); return next(); }
  for (const [uid, p] of Object.entries(PEOPLE)) if (dn === dnOf(uid) && pw === p.password) { res.end(); return next(); }
  return next(new ldap.InvalidCredentialsError());
});
lds.search(`ou=people,${BASE_DN}`, (req, res, next) => {
  for (const [uid, p] of Object.entries(PEOPLE)) {
    const entry = { dn: dnOf(uid), attributes: { objectclass: ['inetOrgPerson'], uid, cn: p.name, mail: p.email, memberof: p.groups.map(groupDn), entryuuid: `uuid-${uid}` } };
    if (req.filter.matches(entry.attributes)) res.send(entry);
  }
  res.end(); return next();
});
await new Promise((r) => lds.listen(LDAP_PORT, '127.0.0.1', r));

// ---- SMTP sink ---------------------------------------------------------------
const SMTP_PORT = 2525;
const smtp = new SMTPServer({
  key: TLS_KEY, cert: TLS_CERT, authOptional: true, disabledCommands: ['AUTH'],
  onData(stream, session, cb) {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => {
      const to = session.envelope.rcptTo.map((r) => r.address).join(',');
      writeFileSync(join(DIR, 'mail', `${Date.now()}-${randomBytes(4).toString('hex')}-${to.replace(/[^a-z0-9@.]/gi, '_')}.eml`), Buffer.concat(chunks));
      cb();
    });
  },
});
await new Promise((r) => smtp.listen(SMTP_PORT, '127.0.0.1', r));

writeFileSync(join(DIR, 'config.json'), JSON.stringify({
  app: APP,
  people: Object.fromEntries(Object.entries(PEOPLE).map(([k, v]) => [k, { ...v }])),
  oidc: { issuer: OIDC_ISSUER, ...OIDC_CLIENT, redirectUri: `${APP}/api/auth/oidc/test-oidc/callback` },
  caFile: join(DIR, 'ca.pem'),
  saml: { entryPoint: `${SAML_BASE}/saml/sso`, issuer: SAML_ISSUER, certPem: SAML_CERT },
  ldap: { url: `ldaps://localhost:${LDAP_PORT}`, caPem: CA, bindDn: SERVICE.dn, bindPassword: SERVICE.password,
          userBase: `ou=people,${BASE_DN}`, userFilter: '(uid={{username}})', groupAttribute: 'memberOf', groupDnPattern: groupDn('{{group}}') },
  smtp: { url: `smtp://127.0.0.1:${SMTP_PORT}`, caPem: CA, mailDir: join(DIR, 'mail') },
}, null, 2), { mode: 0o600 });
console.log(`test IdPs ready: OIDC ${OIDC_ISSUER}, SAML ${SAML_BASE}, LDAPS :${LDAP_PORT}, SMTP :${SMTP_PORT}; config ${join(DIR, 'config.json')}`);
