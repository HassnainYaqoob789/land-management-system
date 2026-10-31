import pg from 'pg';
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';

const { Pool } = pg;

// There is deliberately no default connection string. A default of
// "postgresql://localhost/lms_dev" connects as the operating-system account,
// which on a developer machine is a superuser, and a superuser bypasses every
// row-level security policy without any error (finding APP-06).
const connectionString = process.env.DATABASE_URL;

let _pool: pg.Pool | undefined;
export function getPool(): pg.Pool {
  if (_pool) return _pool;
  if (!connectionString) throw new Error('DATABASE_URL is not set. It must connect as the lms_app role.');
  _pool = new Pool({ connectionString, max: Number(process.env.DB_POOL_MAX || 20), idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000, statement_timeout: 30000, idle_in_transaction_session_timeout: 30000 } as pg.PoolConfig);
  _pool.on('error', (err) => console.error('Unexpected PostgreSQL pool error:', err.message));
  return _pool;
}
/** @deprecated kept for existing imports; use getPool() */
export const pool = new Proxy({} as pg.Pool, { get: (_t, p) => (getPool() as any)[p] });

let verified: Promise<void> | undefined;
/** Refuse to serve unless the runtime role is least-privileged. Runs once. */
export function assertSafeDbRole(): Promise<void> {
  if (!verified) {
    verified = (async () => {
      const r = await getPool().query(
        `SELECT current_user AS u, r.rolsuper, r.rolbypassrls,
                EXISTS (SELECT 1 FROM pg_class c WHERE c.relowner = r.oid AND c.relnamespace IN ('lms'::regnamespace,'iam'::regnamespace)) AS owns_objects
         FROM pg_roles r WHERE r.rolname = current_user`);
      const x = r.rows[0];
      if (x.rolsuper || x.rolbypassrls || x.owns_objects) {
        throw new Error(
          `Refusing to run: the database role "${x.u}" ${x.rolsuper ? 'is a superuser' : x.rolbypassrls ? 'bypasses row-level security' : 'owns the schema'}. ` +
          'Connect as lms_app so province isolation and the grants are enforced.');
      }
    })();
    verified.catch(() => { verified = undefined; });
  }
  return verified;
}

/** A transaction acting as one authenticated user. api.set_actor() is
 * transaction-local (SET LOCAL), so identity cannot leak to the next request
 * that gets this pooled connection. */
export async function withActor<T>(userId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  await assertSafeDbRole();
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT api.set_actor($1)', [userId]);
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** For pre-authentication routines only (login, session lookup). No actor. */
export async function withoutActor<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  await assertSafeDbRole();
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// There is deliberately no helper that runs as the system account: request
// code uses withActor() (or ctx.client inside protect()), and pre-sign-in code
// uses withoutActor(). Maintenance scripts connect with their own role.
