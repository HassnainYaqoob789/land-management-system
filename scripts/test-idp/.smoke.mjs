import { readFileSync } from 'node:fs';
import { Client } from 'ldapts';
import nodemailer from 'nodemailer';
const c = JSON.parse(readFileSync(process.argv[2], 'utf8'));
// LDAPS: service bind, search, user bind
const cl = new Client({ url: c.ldap.url, tlsOptions: { ca: [c.ldap.caPem] } });
await cl.bind(c.ldap.bindDn, c.ldap.bindPassword);
const { searchEntries } = await cl.search(c.ldap.userBase, { filter: '(uid=ext.officer)', attributes: ['uid', 'cn', 'mail', 'memberOf', 'entryUUID'] });
console.log('ldap search', JSON.stringify(searchEntries[0]));
await cl.unbind();
const u = new Client({ url: c.ldap.url, tlsOptions: { ca: [c.ldap.caPem] } });
await u.bind(searchEntries[0].dn, c.people['ext.officer'].password); console.log('ldap user bind ok'); await u.unbind();
try { const b = new Client({ url: c.ldap.url, tlsOptions: { ca: [c.ldap.caPem] } }); await b.bind(searchEntries[0].dn, 'wrong'); console.log('UNEXPECTED bind ok'); } catch (e) { console.log('ldap wrong password refused:', e.constructor.name); }
// SMTP with STARTTLS and the test CA
const t = nodemailer.createTransport({ url: c.smtp.url, requireTLS: true, tls: { ca: [c.smtp.caPem] } } );
const info = await t.sendMail({ from: 'lms@example.test', to: 'someone@example.test', subject: 'smoke', text: 'hello https://example.test/reset?token=abc' });
console.log('smtp sent', info.accepted);
