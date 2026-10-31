-- =====================================================================
-- 0001  Foundation: schemas, extensions, domains, actor context
-- =====================================================================
-- Objects are created as lms_owner so that nothing in the schema is owned by
-- the account that happens to run the migration.
SET ROLE lms_owner;

-- ---------------------------------------------------------------------
-- Schemas
--   lms      base tables — reachable by the application role through grants
--   audit    append-only audit and version history
--   api      the surface the application and reporting roles are meant to use:
--            security_invoker views and callable routines
--   util     internal helpers, not granted to anyone but the owner
-- ---------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS lms;
CREATE SCHEMA IF NOT EXISTS audit;
CREATE SCHEMA IF NOT EXISTS api;
CREATE SCHEMA IF NOT EXISTS util;
CREATE SCHEMA IF NOT EXISTS ext;

COMMENT ON SCHEMA lms   IS 'LMS base tables (system of record).';
COMMENT ON SCHEMA audit IS 'Append-only audit events and record version history.';
COMMENT ON SCHEMA api   IS 'Application-facing views and routines; the only surface granted to lms_report.';
COMMENT ON SCHEMA util  IS
  'Internal helper routines. USAGE is granted to the runtime roles because the '
  'invoker-rights triggers and routines they run call util.actor_id() and '
  'util.require_actor(); EXECUTE is granted on those two functions only.';
COMMENT ON SCHEMA ext   IS 'Extensions live here, never in public, so an unqualified name cannot resolve to one unexpectedly.';

-- A new function is executable by PUBLIC unless something says otherwise, and
-- a SECURITY DEFINER routine that everyone may call is the classic way a
-- privilege-escalation path appears.
--
-- The obvious prevention does not work. On PostgreSQL 16,
--
--   ALTER DEFAULT PRIVILEGES FOR ROLE lms_owner IN SCHEMA api
--     REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
--
-- is accepted, stores no row in pg_default_acl, and has no effect: revoking a
-- privilege that comes from the built-in default rather than from a
-- default-ACL entry is a no-op. This was measured, not assumed — a probe
-- function created immediately afterwards was still executable by PUBLIC.
--
-- So the rule is enforced the plain way instead: every migration that creates
-- a routine ends with an explicit
--
--   REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA lms, api, audit, util FROM PUBLIC;
--
-- and db/tests/test_10_roles_grants.sql asserts that no routine in these
-- schemas is executable by PUBLIC. The test is the guard, because a future
-- migration will eventually forget the sweep.

-- public is left in place (clients expect it to exist) but nothing may be
-- created in it, and it is not on anyone's search_path by default.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO PUBLIC;

-- ---------------------------------------------------------------------
-- Extensions. All four are "trusted", so the database owner may install them
-- without superuser. btree_gist is needed for the exclusion constraints that
-- stop two leases covering the same parcel over the same period; citext gives
-- case-insensitive natural keys (usernames, codes) without lower() everywhere;
-- pg_trgm backs the landowner name search; pgcrypto provides gen_random_uuid
-- on servers older than 13 and digest() for the import-batch fingerprint.
-- ---------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS btree_gist SCHEMA ext;
CREATE EXTENSION IF NOT EXISTS citext     SCHEMA ext;
CREATE EXTENSION IF NOT EXISTS pg_trgm    SCHEMA ext;
CREATE EXTENSION IF NOT EXISTS pgcrypto   SCHEMA ext;

-- Every routine in this schema sets its own search_path explicitly. The
-- database default below is for interactive sessions only and is not relied on
-- by any function body.
ALTER DATABASE :"DBNAME" SET search_path = lms, api, audit, ext, public;

-- ---------------------------------------------------------------------
-- Domains. These carry the numeric contract in one place instead of repeating
-- precision and sign checks on forty columns.
--
-- Money is numeric(18,2): exact base-10 arithmetic, up to Rs 9,999,999,999,999,999.99,
-- which is four orders of magnitude above the largest plausible compensation
-- case. Never float: a float8 cannot represent Rs 0.01 exactly and a sum of
-- releases would stop reconciling against the ledger.
-- ---------------------------------------------------------------------
CREATE DOMAIN lms.money_pkr      AS numeric(18,2);
CREATE DOMAIN lms.money_pkr_pos  AS numeric(18,2) CHECK (VALUE > 0);
CREATE DOMAIN lms.money_pkr_nonneg AS numeric(18,2) CHECK (VALUE >= 0);
COMMENT ON DOMAIN lms.money_pkr IS
  'Pakistani rupees, exact to the paisa. numeric, never float: see docs/DATABASE_ENGINEERING_REPORT.md.';

-- Land area in acres, the primary unit throughout the system. Four decimals is
-- 0.0001 acre = 4.356 sq ft, finer than any revenue record in use, and lets a
-- 40-ghunta (0.025 acre) split stay exact.
CREATE DOMAIN lms.area_acres AS numeric(14,4) CHECK (VALUE >= 0);
COMMENT ON DOMAIN lms.area_acres IS 'Area in acres. Primary unit; province units convert through lms.unit_conversion.';

-- A percentage share of a parcel or a case. Four decimals so that a 1/3 share
-- records as 33.3333 and a set of three heirs can be made to total exactly 100
-- by the application rather than drifting.
CREATE DOMAIN lms.share_pct AS numeric(7,4) CHECK (VALUE > 0 AND VALUE <= 100);
COMMENT ON DOMAIN lms.share_pct IS 'Ownership or case share, percent. Totals are enforced by deferred constraint triggers.';

CREATE DOMAIN lms.rate_pkr AS numeric(18,4) CHECK (VALUE >= 0);
COMMENT ON DOMAIN lms.rate_pkr IS 'A rate (per acre, per year, per tree). Four decimals so a per-ghunta rate stays exact.';

CREATE DOMAIN lms.pct AS numeric(7,4) CHECK (VALUE >= 0 AND VALUE <= 100);

-- A CNIC is the national identity number and the natural key for a landowner.
-- The format is fixed by NADRA: 5 digits, 7 digits, 1 check digit.
CREATE DOMAIN lms.cnic AS text CHECK (VALUE ~ '^[0-9]{5}-[0-9]{7}-[0-9]$');
COMMENT ON DOMAIN lms.cnic IS 'National identity number, 00000-0000000-0. Unique per landowner.';

-- Record codes (AREA-000001, CC-2026-0001, VCH-2026-00001) are shown to users
-- and quoted in correspondence, so they are case-insensitive and never reused.
CREATE DOMAIN lms.record_code AS ext.citext CHECK (VALUE ~ '^[A-Za-z0-9][A-Za-z0-9/-]{1,31}$');

CREATE DOMAIN lms.latitude  AS numeric(9,6)  CHECK (VALUE BETWEEN -90  AND 90);
CREATE DOMAIN lms.longitude AS numeric(9,6)  CHECK (VALUE BETWEEN -180 AND 180);

-- ---------------------------------------------------------------------
-- Actor context
--
-- Audit attribution needs to know which application user is acting. The
-- application connects as one database role (lms_app) through a pool, so the
-- database cannot learn the end user from current_user. Instead the
-- application sets a transaction-local parameter at the start of every
-- transaction, and triggers read it from there.
--
-- SET LOCAL is deliberate and load-bearing: the value is reverted when the
-- transaction ends, so a pooled connection handed to the next request cannot
-- carry the previous request's identity. A session-level SET would leak across
-- requests; db/tests/test_09_identity_context.sql proves the difference.
--
-- LIMITATION, stated plainly: this trusts the application. A compromised or
-- buggy application tier can set any actor id it likes, so this attributes
-- actions as reliably as the application tier is trustworthy — no more. It
-- defends against mistakes and gives a usable trail; it is not proof against a
-- hostile application. Stronger attribution needs one database role per end
-- user, or signed identity assertions; both are recorded as accepted risk in
-- docs/SECURITY_FINDINGS.md (DB-07).
-- ---------------------------------------------------------------------
CREATE FUNCTION util.actor_id() RETURNS uuid
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT nullif(current_setting('lms.actor_id', true), '')::uuid;
$$;
COMMENT ON FUNCTION util.actor_id() IS
  'The application user acting in this transaction, or NULL. Set by api.set_actor().';

CREATE FUNCTION util.require_actor() RETURNS uuid
  LANGUAGE plpgsql STABLE
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE a uuid;
BEGIN
  a := nullif(current_setting('lms.actor_id', true), '')::uuid;
  IF a IS NULL THEN
    RAISE EXCEPTION 'no actor set for this transaction'
      USING ERRCODE = 'invalid_authorization_specification',
            HINT = 'call api.set_actor(<app_user.id>) as the first statement of the transaction';
  END IF;
  RETURN a;
END $$;
COMMENT ON FUNCTION util.require_actor() IS
  'Like util.actor_id() but refuses to proceed without one. Used by every write path.';

-- Timestamps are stored as timestamptz throughout. The application displays
-- Asia/Karachi; the database stores an absolute instant and never guesses a
-- zone from a bare date.

-- util is included: every invoker-rights trigger on a table the application
-- writes to calls util.actor_id(), and that resolution happens as the
-- application role, so it needs USAGE on the schema. EXECUTE is still granted
-- on just the two actor-context functions (migration 0017).
GRANT USAGE ON SCHEMA lms, api, audit, ext, util TO lms_readwrite, lms_readonly;
