-- =====================================================================
-- 0027  IAM integration with the modules added in 0024-0026, and the
--       security gaps those modules shipped with
-- =====================================================================
-- Migrations 0024-0026 (land requests, lease holds/renewals, KML/GIS and
-- analytics) were written in parallel with the IAM work. Reviewing them found:
--   * four tables with no row-level security: any account could read every
--     province's land requests and spatial imports;
--   * five analytics views without security_invoker, so they read their base
--     tables as the owner and bypassed every province policy;
--   * no audit triggers on the new tables;
--   * a four-tier land-request approval with no segregation of duties: one
--     person could approve every tier, including their own request.
-- This migration closes those, adds the permissions the new routes need, and
-- carries the IAM helpers that were drafted as 0024 before that number was
-- taken (the draft was never applied).
-- Ownership first. Migration 0026 does not SET ROLE lms_owner, so on a build
-- run through db/tools/migrate.py its objects belong to lms_migrator (and on a
-- database where it was applied by hand, to whoever applied it). Ownership is
-- part of the security design — lms_app must not own anything, and a view's
-- owner decides whose rights it runs with — so it is normalised here, as the
-- migrating role, before anything else. Where the objects are already owned by
-- lms_owner this is a no-op. (A superuser-owned object cannot be reassigned
-- from here; db/bootstrap/04_fix_ownership.sql exists for that case.)
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT c.relkind, quote_ident(n.nspname)||'.'||quote_ident(c.relname) AS obj
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname IN ('lms','api') AND c.relkind IN ('r','v','m','S')
             AND pg_get_userbyid(c.relowner) = current_user
  LOOP
    EXECUTE format('ALTER %s %s OWNER TO lms_owner',
      CASE r.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'S' THEN 'SEQUENCE' ELSE 'TABLE' END, r.obj);
  END LOOP;
  FOR r IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname IN ('lms','api') AND pg_get_userbyid(p.proowner) = current_user
  LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO lms_owner', r.sig);
  END LOOP;
END $$;

SET ROLE lms_owner;
-- The new owner needs to pass the runtime grants on again.
GRANT SELECT, INSERT, UPDATE ON lms.project_kml_import, lms.project_spatial_feature, lms.project_gis_merge TO lms_readwrite;
GRANT SELECT ON api.v_executive_kpis, api.v_project_portfolio, api.v_finance_aging, api.v_data_quality_audit, api.v_gis_coverage TO lms_readwrite;

-- ---------------------------------------------------------------------
-- Pre-auth helpers
-- ---------------------------------------------------------------------
CREATE FUNCTION iam.public_providers() RETURNS TABLE (name text, display_name text, kind text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$ SELECT name, display_name, kind FROM iam.auth_provider WHERE enabled AND last_test_ok IS TRUE ORDER BY display_name $$;

-- Who a still-valid reset/invitation link belongs to, for the password policy
-- check (not your username, not your name). Returns nothing for a bad token.
CREATE FUNCTION iam.token_subject(p_hash bytea, p_purpose text) RETURNS TABLE (user_id uuid, username text, full_name text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  SELECT u.id, u.username::text, u.full_name FROM iam.invitation i JOIN lms.app_user u ON u.id = i.user_id
  WHERE i.token_sha256 = p_hash AND i.purpose = p_purpose AND i.used_at IS NULL AND i.expires_at > now() AND u.status = 'Active'
$$;

-- ---------------------------------------------------------------------
-- Permissions for the new modules
-- ---------------------------------------------------------------------
INSERT INTO iam.permission(resource, action, description, is_sensitive) VALUES
 ('requests','read','View land requests',false),
 ('requests','create','Raise a land request',false),
 ('requests','approve','Approve, reject or return a land request at your tier',false),
 ('leases','update','Place or lift a hold on a lease, or renew it',true),
 ('gis','create','Import KML/KMZ layers and merge them',false)
ON CONFLICT (resource, action) DO NOTHING;

CREATE FUNCTION pg_temp.grant_perm(p_role text, p_perm text, p_scope text DEFAULT 'province') RETURNS void
  LANGUAGE plpgsql AS $f$
BEGIN
  INSERT INTO iam.role_permission(role_id, permission_id, scope_level)
  SELECT r.id, p.id, p_scope FROM iam.role r, iam.permission p
  WHERE r.code = p_role AND p.resource||':'||p.action = p_perm
  ON CONFLICT DO NOTHING;
END $f$;
DO $$
BEGIN
  PERFORM pg_temp.grant_perm('system-administrator','requests:read','global');
  PERFORM pg_temp.grant_perm('system-administrator','gis:create','global');
  PERFORM pg_temp.grant_perm('land-manager','requests:read');   PERFORM pg_temp.grant_perm('land-manager','requests:approve');
  PERFORM pg_temp.grant_perm('land-manager','leases:update');   PERFORM pg_temp.grant_perm('land-manager','gis:create');
  PERFORM pg_temp.grant_perm('case-approver','requests:read');  PERFORM pg_temp.grant_perm('case-approver','requests:approve');
  PERFORM pg_temp.grant_perm('case-approver','leases:update');  PERFORM pg_temp.grant_perm('case-approver','gis:create');
  PERFORM pg_temp.grant_perm('data-entry','requests:read');     PERFORM pg_temp.grant_perm('data-entry','requests:create');
  PERFORM pg_temp.grant_perm('data-entry','gis:create');
  PERFORM pg_temp.grant_perm('finance-approver','requests:read');
  PERFORM pg_temp.grant_perm('viewer','requests:read');
  PERFORM pg_temp.grant_perm('security-auditor','requests:read','global');
END $$;

-- ---------------------------------------------------------------------
-- Row-level security on the new tables, the same model as everywhere else
-- ---------------------------------------------------------------------
ALTER TABLE lms.land_request ENABLE ROW LEVEL SECURITY;
CREATE POLICY province_scope ON lms.land_request FOR ALL TO lms_readwrite, lms_readonly
  USING      (lms.actor_role() = 'Admin' OR province_code = ANY (lms.actor_provinces()))
  WITH CHECK (lms.actor_role() = 'Admin' OR province_code = ANY (lms.actor_provinces()));

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['project_kml_import','project_spatial_feature','project_gis_merge'] LOOP
    EXECUTE format('ALTER TABLE lms.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($f$
      CREATE POLICY province_scope_via_project ON lms.%I FOR ALL TO lms_readwrite, lms_readonly
        USING (lms.actor_role() = 'Admin' OR EXISTS (SELECT 1 FROM lms.project p
               WHERE p.id = lms.%I.project_id AND p.province_code = ANY (lms.actor_provinces())))
        WITH CHECK (lms.actor_role() = 'Admin' OR EXISTS (SELECT 1 FROM lms.project p
               WHERE p.id = lms.%I.project_id AND p.province_code = ANY (lms.actor_provinces())))
    $f$, t, t, t);
  END LOOP;
END $$;

-- The analytics views read their base tables as the caller, so the policies
-- above and in 0016 apply to them.
ALTER VIEW api.v_executive_kpis    SET (security_invoker = true);
ALTER VIEW api.v_project_portfolio SET (security_invoker = true);
ALTER VIEW api.v_finance_aging     SET (security_invoker = true);
ALTER VIEW api.v_data_quality_audit SET (security_invoker = true);
ALTER VIEW api.v_gis_coverage      SET (security_invoker = true);

-- Audit the new tables like the rest. land_request already has its audit
-- trigger from 0024; the GIS tables did not.
CREATE TRIGGER project_kml_import_audit AFTER INSERT OR UPDATE OR DELETE ON lms.project_kml_import
  FOR EACH ROW EXECUTE FUNCTION audit.tg_audit_row();
CREATE TRIGGER project_gis_merge_audit AFTER INSERT OR UPDATE OR DELETE ON lms.project_gis_merge
  FOR EACH ROW EXECUTE FUNCTION audit.tg_audit_row();

-- ---------------------------------------------------------------------
-- Segregation of duties on land-request approval. Enforced on the row, so it
-- holds however the update arrives: the requester approves no tier, and no
-- one approves two tiers of the same request.
-- ---------------------------------------------------------------------
CREATE FUNCTION lms.tg_land_request_sod() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_ids uuid[];
BEGIN
  v_ids := array_remove(ARRAY[NEW.director_ops_id, NEW.regional_mgr_id, NEW.land_affairs_id], NULL);
  IF NEW.created_by IS NOT NULL AND NEW.created_by = ANY (v_ids) THEN
    RAISE EXCEPTION 'segregation of duties: the person who raised a land request cannot approve it'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF cardinality(v_ids) <> (SELECT count(DISTINCT x) FROM unnest(v_ids) x) THEN
    RAISE EXCEPTION 'segregation of duties: one person cannot approve two tiers of the same land request'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER land_request_sod BEFORE INSERT OR UPDATE OF director_ops_id, regional_mgr_id, land_affairs_id, created_by
  ON lms.land_request FOR EACH ROW EXECUTE FUNCTION lms.tg_land_request_sod();

GRANT EXECUTE ON FUNCTION iam.public_providers(), iam.token_subject(bytea,text) TO lms_readwrite;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA lms, api, audit, util, iam FROM PUBLIC;
