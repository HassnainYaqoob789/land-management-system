// Delivers ERP postings from lms.integration_outbox to the SAP integration
// gateway (for example an SAP CPI / PI-PO REST adapter in front of
// BAPI_ACC_DOCUMENT_POST).
//
// It posts for real or not at all: there is no simulated SAP. Without
// SAP_POSTING_URL it stops before touching the outbox. The database decides
// what it may do — it connects as lms_worker (db/bootstrap/01_roles.sql) and
// uses only api.outbox_next / api.outbox_mark_sent / api.outbox_mark_failed,
// which refuse any other session. It never switches endpoints on; that is an
// administrator's decision.
//
//   WORKER_DATABASE_URL  postgres connection as lms_worker (required)
//   SAP_POSTING_URL      HTTPS endpoint of the gateway (required)
//   SAP_POSTING_TOKEN    bearer token for the gateway (optional)
//   SAP_TIMEOUT_MS       per-request timeout, default 15000
//
//   npm run worker:sap            one pass over the queue
//   npm run worker:sap -- --daemon  poll every 5 seconds
import { Pool } from 'pg';

interface OutboxRow {
  id: string;            // bigint arrives as a string
  endpoint_code: string;
  event_type: string;
  entity: string;
  record_id: string;
  payload: unknown;
  idempotency_key: string;
  attempts: number;
}

const ENDPOINT = 'erp_finance';

function config() {
  const db = process.env.WORKER_DATABASE_URL;
  const url = process.env.SAP_POSTING_URL;
  if (!db) throw new Error('WORKER_DATABASE_URL is not set (connect as lms_worker).');
  if (!url) throw new Error('SAP_POSTING_URL is not set: the SAP integration is not configured, nothing was sent.');
  if (!/^https:\/\//i.test(url) && process.env.NODE_ENV === 'production') throw new Error('SAP_POSTING_URL must use https in production.');
  return { db, url, token: process.env.SAP_POSTING_TOKEN || null, timeout: Number(process.env.SAP_TIMEOUT_MS || 15000) };
}

/** One posting. Resolves to the gateway's document reference; throws on any failure. */
async function post(row: OutboxRow, c: ReturnType<typeof config>): Promise<string> {
  const res = await fetch(c.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': row.idempotency_key,
      ...(c.token ? { authorization: `Bearer ${c.token}` } : {}),
    },
    body: JSON.stringify({ event_type: row.event_type, entity: row.entity, record_id: row.record_id, payload: row.payload }),
    signal: AbortSignal.timeout(c.timeout),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`gateway answered ${res.status}`);
  let body: { document_number?: unknown; fiscal_year?: unknown };
  try { body = JSON.parse(text); } catch { throw new Error('gateway answered with something other than JSON'); }
  const doc = typeof body.document_number === 'string' ? body.document_number.trim() : '';
  const year = typeof body.fiscal_year === 'string' || typeof body.fiscal_year === 'number' ? String(body.fiscal_year) : '';
  if (!doc || !/^[0-9]{4}$/.test(year)) throw new Error('gateway did not return a document number and fiscal year');
  return `BELNR:${doc}/GJAHR:${year}`;
}

export async function processOutboxQueue(): Promise<number> {
  const c = config();
  const pool = new Pool({ connectionString: c.db, max: 2 });
  let sent = 0;
  try {
    for (;;) {
      const client = await pool.connect();
      let row: OutboxRow | undefined;
      try {
        await client.query('BEGIN');
        row = (await client.query<OutboxRow>('SELECT * FROM api.outbox_next($1)', [ENDPOINT])).rows[0];
        if (!row) { await client.query('COMMIT'); break; }
        try {
          const ref = await post(row, c);
          await client.query('SELECT api.outbox_mark_sent($1, $2)', [row.id, ref]);
          await client.query('COMMIT');
          sent++;
          console.log(`[sap-worker] item ${row.id} posted (${ref})`);
        } catch (e) {
          // Record the failure (with back-off) in the same transaction that held the lock.
          const msg = e instanceof Error ? e.message : String(e);
          await client.query('SELECT api.outbox_mark_failed($1, $2)', [row.id, msg]);
          await client.query('COMMIT');
          console.error(`[sap-worker] item ${row.id} failed: ${msg}`);
        }
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    }
  } finally {
    await pool.end();
  }
  return sent;
}

async function main() {
  const daemon = process.argv.includes('--daemon');
  do {
    try {
      const n = await processOutboxQueue();
      console.log(`[sap-worker] pass complete: ${n} posted`);
    } catch (e) {
      console.error(`[sap-worker] ${e instanceof Error ? e.message : String(e)}`);
      if (!daemon) process.exit(1);
    }
    if (daemon) await new Promise((r) => setTimeout(r, 5000));
  } while (daemon);
}

if (process.argv[1] && /sap_outbox_worker\.[tj]s$/.test(process.argv[1])) void main();
