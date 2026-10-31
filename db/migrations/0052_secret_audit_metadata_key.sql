-- =====================================================================
-- 0052  iam.tg_secret_audit: a metadata key the event table accepts
-- =====================================================================
-- audit.auth_event refuses metadata whose keys look like credentials
-- (auth_event_metadata_safe_ck → iam.metadata_is_safe: any key containing
-- "secret", "token", "password", …). iam.tg_secret_audit (0023) logged
-- {secret_name, version}, so storing or rotating any provider secret (an
-- OIDC client secret, an LDAP bind password) failed with "The data breaks a
-- validation rule" and no single sign-on provider with a secret could be
-- saved. The value logged was only the secret's name, never the secret.
-- Found by tests/iam/sso.test.ts against the test IdPs on 2026-10-30.
-- The key is now "name"; the event types (secret_stored / secret_rotated)
-- still say what it is.

SET ROLE lms_owner;

CREATE OR REPLACE FUNCTION iam.tg_secret_audit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  PERFORM iam.log_event(CASE TG_OP WHEN 'INSERT' THEN 'secret_stored' ELSE 'secret_rotated' END,
        'success', NULL, NULL, util.actor_id(), NULL, NULL, NULL, NULL, NULL, NULL,
        jsonb_build_object('name', NEW.name, 'version', NEW.version));
  RETURN NULL;
END $function$;

-- The check that caught it, kept as a guarantee: the logged metadata is safe.
DO $$
BEGIN
  IF NOT iam.metadata_is_safe(jsonb_build_object('name', 'x', 'version', 1)) THEN
    RAISE EXCEPTION '0052: the secret audit metadata is still refused';
  END IF;
END $$;

RESET ROLE;
