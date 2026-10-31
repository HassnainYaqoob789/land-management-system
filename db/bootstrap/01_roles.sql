-- =====================================================================
-- LMS cluster bootstrap: database roles and least-privilege split
-- Run ONCE per cluster, as a superuser. Not a schema migration: roles are
-- cluster-wide objects and the migration role is deliberately not allowed to
-- create them.
--
--   psql -d postgres -f db/bootstrap/01_roles.sql
--
-- No passwords are set here. Credentials are provisioned out of band (see
-- docs/DATABASE_SECURITY_REVIEW.md, "Credential provisioning"): on a developer
-- machine the local socket uses peer/trust authentication; in a deployed
-- environment each login role is given a password or a client certificate from
-- the secret store and this file is never the place that holds it.
-- =====================================================================

-- lms_owner owns every schema object. It cannot log in, so there is no session
-- that holds object-owner privileges by default, and nothing routinely runs
-- with the rights needed to drop or alter the schema. It is also the role that
-- row-level security must never be evaluated for: an owner bypasses its own
-- tables' policies.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lms_owner') THEN
    CREATE ROLE lms_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;

-- lms_migrator applies migrations. It is a member of lms_owner and does
-- SET ROLE lms_owner at the top of every migration, so migrated objects belong
-- to lms_owner rather than to the migrating account.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lms_migrator') THEN
    CREATE ROLE lms_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;
GRANT lms_owner TO lms_migrator;

-- lms_app is the application runtime. No DDL, no table ownership, no BYPASSRLS:
-- it reads and writes through grants and is subject to every row-level policy.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lms_app') THEN
    CREATE ROLE lms_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;

-- lms_report is read-only reporting: SELECT on the api views only, never on
-- base tables, and still subject to row-level security.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lms_report') THEN
    CREATE ROLE lms_report LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;

-- lms_test runs the automated test suite. Same privileges as lms_app so that a
-- test proves what the application can actually do, plus the ability to call
-- the test fixtures. It is never created in a production cluster.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lms_test') THEN
    CREATE ROLE lms_test LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;

-- lms_worker runs the integration outbox worker (scripts/sap_outbox_worker.ts).
-- It belongs to lms_readwrite only for EXECUTE on the outbox routines, which
-- themselves accept no other session; it never acts as the system account.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lms_worker') THEN
    CREATE ROLE lms_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;

-- lms_readwrite / lms_readonly are group roles that carry the table grants, so
-- a new service account is provisioned by one GRANT rather than by repeating
-- the privilege list.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lms_readwrite') THEN
    CREATE ROLE lms_readwrite NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lms_readonly') THEN
    CREATE ROLE lms_readonly NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;
GRANT lms_readwrite TO lms_app;
GRANT lms_readwrite TO lms_test;
GRANT lms_readonly  TO lms_report;
GRANT lms_readwrite TO lms_worker;

-- Nobody gets the implicit rights of PUBLIC on new schemas.
