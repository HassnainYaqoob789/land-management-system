-- =====================================================================
-- LMS cluster bootstrap: create the database, owned by lms_owner.
-- Run as a superuser, after 01_roles.sql. CREATE DATABASE cannot run inside a
-- transaction, so this is not a migration either.
--
--   psql -d postgres -v db=lms_dev -f db/bootstrap/02_database.sql
-- =====================================================================
\if :{?db}
\else
  \set db lms_dev
\endif

SELECT format('CREATE DATABASE %I OWNER lms_owner ENCODING ''UTF8''', :'db')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db') \gexec

-- CONNECT is granted explicitly; PUBLIC loses it so that a new role on the
-- cluster cannot reach this database by default.
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'db') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO lms_migrator, lms_app, lms_report, lms_test', :'db') \gexec
