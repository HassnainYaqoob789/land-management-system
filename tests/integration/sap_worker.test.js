// The integration outbox worker against the real database (lms_test).
//
// The SAP gateway itself is not available here, so a small local HTTP server
// stands in for it — a labelled test double, used only by this test. Everything
// else is real: the worker process, its database routines and the outbox rows.
// What is proven: it refuses to run without configuration, posts and records
// the gateway's document reference, records a failure with back-off instead of
// inventing a result, and never switches an endpoint on by itself.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import http from 'node:http';

const DB = process.env.LMS_TEST_DB || 'lms_test';
// libpq host/port from PGHOST/PGPORT when set (a TCP cluster, e.g. Windows), else the /tmp socket.
const ADMIN = process.env.PGHOST
  ? `postgresql://lms_migrator@${process.env.PGHOST}${process.env.PGPORT ? ':' + process.env.PGPORT : ''}/${DB}`
  : `postgresql://lms_migrator@/${DB}?host=/tmp`;
const sql = (q) => execFileSync('psql', ['-X', '-At', '-q', '-U', 'lms_migrator', '-d', DB, '-c',
  `SET ROLE lms_owner; SET lms.actor_id = '00000000-0000-0000-0000-000000000001'; ${q}`], { encoding: 'utf8' }).replace(/\r/g, '').trim();   // psql on Windows: CRLF
// Asynchronous on purpose: the stand-in gateway runs in this process and must
// keep answering while the worker runs.
const runWorker = (env) => new Promise((resolve) => {
  const p = spawn('npx', ['tsx', 'scripts/sap_outbox_worker.ts'], { env: { ...process.env, ...env }, shell: process.platform === 'win32' });
  let stdout = '', stderr = '';
  p.stdout.on('data', (c) => { stdout += c; }); p.stderr.on('data', (c) => { stderr += c; });
  const t = setTimeout(() => p.kill('SIGKILL'), 60_000);
  p.on('close', (status) => { clearTimeout(t); resolve({ status, stdout, stderr }); });
});

let server, port, reply = { status: 200, body: { document_number: '1900000042', fiscal_year: '2026' } };
const received = [];
const KEY = `t-sap-${process.pid}`;

before(async () => {
  server = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => {
      received.push({ key: req.headers['idempotency-key'], body: JSON.parse(b || '{}') });
      res.writeHead(reply.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  // Park the existing queue so only this test's item is due; restore afterwards.
  sql(`UPDATE lms.integration_outbox SET next_attempt_at = next_attempt_at + interval '100 years' WHERE status = 'pending' AND idempotency_key NOT LIKE 't-sap-%'`);
  sql(`INSERT INTO lms.integration_outbox (endpoint_code, event_type, entity, record_id, payload, idempotency_key, status)
       VALUES ('erp_finance', 'payment_released', 'payment_request', gen_random_uuid(), '{"amount":"1000.00"}', '${KEY}', 'pending')`);
});

after(() => {
  sql(`DELETE FROM lms.integration_outbox WHERE idempotency_key = '${KEY}'`);
  sql(`UPDATE lms.integration_outbox SET next_attempt_at = next_attempt_at - interval '100 years' WHERE next_attempt_at > now() + interval '50 years'`);
  sql(`UPDATE lms.integration_endpoint SET is_enabled = false WHERE code = 'erp_finance'`);
  server.close();
});

describe('SAP outbox worker', () => {
  it('refuses to run when the SAP integration is not configured, and sends nothing', async () => {
    const r = await runWorker({ WORKER_DATABASE_URL: ADMIN, SAP_POSTING_URL: '' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /not configured/);
    assert.equal(sql(`SELECT status FROM lms.integration_outbox WHERE idempotency_key = '${KEY}'`), 'pending');
  });

  it('does not switch a disabled endpoint on, so nothing is posted', async () => {
    const r = await runWorker({ WORKER_DATABASE_URL: ADMIN, SAP_POSTING_URL: `http://127.0.0.1:${port}/post` });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(received.length, 0);
    assert.equal(sql(`SELECT is_enabled FROM lms.integration_endpoint WHERE code = 'erp_finance'`), 'f');
  });

  it('records a gateway failure with back-off instead of a result', async () => {
    sql(`UPDATE lms.integration_endpoint SET is_enabled = true WHERE code = 'erp_finance'`);
    reply = { status: 503, body: { error: 'maintenance' } };
    const r = await runWorker({ WORKER_DATABASE_URL: ADMIN, SAP_POSTING_URL: `http://127.0.0.1:${port}/post` });
    assert.equal(r.status, 0, r.stderr);
    const row = sql(`SELECT status || '|' || attempts || '|' || (last_error LIKE '%503%') || '|' || (next_attempt_at > now())
                     FROM lms.integration_outbox WHERE idempotency_key = '${KEY}'`);
    assert.equal(row, 'pending|1|true|true');
  });

  it('posts with the idempotency key and stores the document reference the gateway returned', async () => {
    sql(`UPDATE lms.integration_outbox SET next_attempt_at = now() WHERE idempotency_key = '${KEY}'`);
    reply = { status: 200, body: { document_number: '1900000042', fiscal_year: '2026' } };
    const r = await runWorker({ WORKER_DATABASE_URL: ADMIN, SAP_POSTING_URL: `http://127.0.0.1:${port}/post` });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(received.some((x) => x.key === KEY && x.body.payload?.amount === '1000.00'));
    assert.equal(sql(`SELECT status || '|' || external_ref FROM lms.integration_outbox WHERE idempotency_key = '${KEY}'`),
      'sent|BELNR:1900000042/GJAHR:2026');
  });

  it('cannot be driven from the application role', () => {
    const r = spawnSync('psql', ['-X', '-At', '-U', 'lms_app', '-d', DB, '-c', "SELECT count(*) FROM api.outbox_next('erp_finance')"], { encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /only the integration worker/);
  });
});
