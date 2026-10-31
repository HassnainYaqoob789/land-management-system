-- =====================================================================
-- Correction: every object in the LMS schemas must be owned by lms_owner
-- =====================================================================
-- Run as a superuser:  psql -d lms_dev -f db/bootstrap/04_fix_ownership.sql
--
-- Why it exists: migration 0026 was applied as a superuser account instead of
-- through db/tools/migrate.py's lms_migrator -> SET ROLE lms_owner path, so its
-- tables, views and function were owned by that superuser. A view owned by a
-- superuser and not marked security_invoker reads its base tables with
-- superuser rights, bypassing every row-level security policy. Ownership is
-- the security design here (see db/bootstrap/01_roles.sql), so this resets it.
-- Idempotent; touches only objects not already owned by lms_owner.
\set ON_ERROR_STOP on
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT c.relkind, quote_ident(n.nspname)||'.'||quote_ident(c.relname) AS obj
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname IN ('lms','api','audit','iam','util') AND c.relkind IN ('r','v','m','S','p','f')
             AND pg_get_userbyid(c.relowner) <> 'lms_owner'
  LOOP
    EXECUTE format('ALTER %s %s OWNER TO lms_owner',
      CASE r.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'S' THEN 'SEQUENCE'
                     WHEN 'f' THEN 'FOREIGN TABLE' ELSE 'TABLE' END, r.obj);
    RAISE NOTICE 'reassigned %', r.obj;
  END LOOP;
  FOR r IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname IN ('lms','api','audit','iam','util') AND pg_get_userbyid(p.proowner) <> 'lms_owner'
  LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO lms_owner', r.sig);
    RAISE NOTICE 'reassigned %', r.sig;
  END LOOP;
END $$;
-- Grants the new owner would otherwise not have passed on.
GRANT SELECT, INSERT, UPDATE ON lms.project_kml_import, lms.project_spatial_feature, lms.project_gis_merge TO lms_readwrite;
GRANT SELECT ON api.v_executive_kpis, api.v_project_portfolio, api.v_finance_aging, api.v_data_quality_audit, api.v_gis_coverage TO lms_readwrite;
