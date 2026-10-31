-- =====================================================================
-- 0039  RBAC lifecycle, administrator safeguards, sensitive personal data,
--       passkey sign-in and SAML
-- =====================================================================
-- 1. Roles get a lifecycle: active → inactive (suspended: assignments stay
--    but confer nothing) → retired (terminal; no new assignments, no edits).
--    System roles stay active. Every check that decides access —
--    has_permission, effective_permissions, actor_covers_role — counts active
--    roles only, so suspending a role takes effect on the very next request.
-- 2. The last working system administrator can no longer be suspended or
--    deactivated (revocation of the role was already guarded).
-- 3. A permission for sensitive personal data (pii:read: full CNIC, phone,
--    IBAN, address) separates "can see this landowner" from "can see their
--    identity documents", and reports:share lets a manager publish a report
--    template to colleagues.
-- 4. Passkeys (WebAuthn / FIDO2) become a first-factor sign-in: a
--    pre-authentication lookup by credential id, a signature-counter check
--    that refuses a cloned authenticator, and a guard that stops a user from
--    deleting the last way they have of signing in.
-- 5. SAML joins LDAP and OIDC as a provider kind; sessions record 'saml' and
--    'passkey' sign-ins; SAML request ids are kept as single-use challenges.
SET ROLE lms_owner;
-- Seed rows below are written as the system account so the role guards
-- (which refuse changes to system roles from anyone else) let them through.
SELECT set_config('lms.actor_id', '00000000-0000-0000-0000-000000000001', true);

-- ---------------------------------------------------------------------
-- 1. Role lifecycle
-- ---------------------------------------------------------------------
ALTER TABLE iam.role
  ADD COLUMN status            text NOT NULL DEFAULT 'active'
                               CHECK (status IN ('active','inactive','retired')),
  ADD COLUMN status_reason     text,
  ADD COLUMN status_changed_at timestamptz,
  ADD COLUMN status_changed_by uuid;
COMMENT ON COLUMN iam.role.status IS
  'active: grants its permissions. inactive: assignments are kept but confer nothing. '
  'retired: terminal; cannot be assigned or edited. System roles are always active.';

CREATE OR REPLACE FUNCTION iam.has_permission(p_resource text, p_action text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM lms.app_user u
    JOIN iam.user_role ur ON ur.user_id = u.id AND ur.revoked_at IS NULL
                         AND (ur.expires_at IS NULL OR ur.expires_at > now())
    JOIN iam.role r ON r.id = ur.role_id AND r.status = 'active'
    JOIN iam.role_permission rp ON rp.role_id = ur.role_id
    JOIN iam.permission p ON p.id = rp.permission_id
    WHERE u.id = util.actor_id() AND u.status = 'Active'
      AND p.resource = p_resource AND p.action = p_action);
$function$;

CREATE OR REPLACE FUNCTION iam.effective_permissions(p_user uuid)
 RETURNS TABLE(resource text, action text, scope_level text, scope_province character, scope_project uuid, role_code text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  IF p_user IS DISTINCT FROM util.actor_id() AND NOT iam.has_permission('users','read') THEN
    RAISE EXCEPTION 'not permitted to inspect another account''s permissions'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
  SELECT p.resource, p.action, rp.scope_level, ur.scope_province, ur.scope_project, r.code
  FROM lms.app_user u
  JOIN iam.user_role ur ON ur.user_id = u.id AND ur.revoked_at IS NULL
                       AND (ur.expires_at IS NULL OR ur.expires_at > now())
  JOIN iam.role r ON r.id = ur.role_id AND r.status = 'active'
  JOIN iam.role_permission rp ON rp.role_id = r.id
  JOIN iam.permission p ON p.id = rp.permission_id
  WHERE u.id = p_user AND u.status = 'Active'
  ORDER BY p.resource, p.action;
END $function$;

-- Delegation: an actor may grant a role only if every permission in it is one
-- they themselves hold, through an ACTIVE role, at the same or a wider scope.
CREATE OR REPLACE FUNCTION iam.actor_covers_role(p_role uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT iam.is_system_actor() OR NOT EXISTS (
    SELECT 1 FROM iam.role_permission need
    WHERE need.role_id = p_role
      AND NOT EXISTS (
        SELECT 1 FROM iam.user_role ur
        JOIN iam.role hr ON hr.id = ur.role_id AND hr.status = 'active'
        JOIN iam.role_permission have ON have.role_id = ur.role_id
        WHERE ur.user_id = util.actor_id() AND ur.revoked_at IS NULL
          AND (ur.expires_at IS NULL OR ur.expires_at > now())
          AND have.permission_id = need.permission_id
          AND iam.permission_rank(have.scope_level) >= iam.permission_rank(need.scope_level)));
$function$;

-- The permission-into-role guard used the same delegation rule but ignored
-- expiry and role status; it now uses the same definition as the above.
CREATE OR REPLACE FUNCTION iam.tg_role_permission_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE v_role uuid := coalesce(NEW.role_id, OLD.role_id); v_sys boolean; v_status text;
BEGIN
  IF iam.is_system_actor() THEN RETURN coalesce(NEW, OLD); END IF;
  SELECT is_system, status INTO v_sys, v_status FROM iam.role WHERE id = v_role;
  IF v_sys THEN
    RAISE EXCEPTION 'permissions of a system role are fixed' USING ERRCODE='insufficient_privilege';
  END IF;
  IF v_status = 'retired' THEN
    RAISE EXCEPTION 'a retired role cannot be changed' USING ERRCODE='insufficient_privilege';
  END IF;
  IF TG_OP <> 'DELETE' THEN
    IF NOT EXISTS (
        SELECT 1 FROM iam.user_role ur
        JOIN iam.role hr ON hr.id = ur.role_id AND hr.status = 'active'
        JOIN iam.role_permission have ON have.role_id = ur.role_id
        WHERE ur.user_id = util.actor_id() AND ur.revoked_at IS NULL
          AND (ur.expires_at IS NULL OR ur.expires_at > now())
          AND have.permission_id = NEW.permission_id
          AND iam.permission_rank(have.scope_level) >= iam.permission_rank(NEW.scope_level)) THEN
      RAISE EXCEPTION 'you cannot grant a permission you do not hold at that scope' USING ERRCODE='insufficient_privilege';
    END IF;
  END IF;
  RETURN coalesce(NEW, OLD);
END $function$;

CREATE OR REPLACE FUNCTION iam.tg_role_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  IF iam.is_system_actor() THEN RETURN coalesce(NEW, OLD); END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.is_system THEN RAISE EXCEPTION 'system roles are created by migration only' USING ERRCODE='insufficient_privilege'; END IF;
    IF NEW.db_role_code = 'Admin' THEN
      RAISE EXCEPTION 'a custom role cannot map to the Admin database tier' USING ERRCODE='insufficient_privilege';
    END IF;
    IF NEW.status <> 'active' THEN
      RAISE EXCEPTION 'a new role starts active' USING ERRCODE='invalid_parameter_value';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.is_system THEN
    RAISE EXCEPTION 'system role % cannot be modified or deleted', OLD.code USING ERRCODE='insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM iam.user_role WHERE role_id = OLD.id AND revoked_at IS NULL) THEN
      RAISE EXCEPTION 'role % is still assigned', OLD.code USING ERRCODE='raise_exception';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'retired' THEN
    RAISE EXCEPTION 'role % is retired and cannot be changed', OLD.code USING ERRCODE='insufficient_privilege';
  END IF;
  IF NEW.code IS DISTINCT FROM OLD.code THEN
    RAISE EXCEPTION 'a role code cannot be changed; create a new role' USING ERRCODE='insufficient_privilege';
  END IF;
  IF NEW.db_role_code = 'Admin' AND OLD.db_role_code <> 'Admin' THEN
    RAISE EXCEPTION 'a custom role cannot map to the Admin database tier' USING ERRCODE='insufficient_privilege';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status = 'retired' AND EXISTS (SELECT 1 FROM iam.user_role WHERE role_id = OLD.id AND revoked_at IS NULL) THEN
      RAISE EXCEPTION 'role % still has members; remove them before retiring it', OLD.code USING ERRCODE='raise_exception';
    END IF;
    NEW.status_changed_at := now();
    NEW.status_changed_by := util.actor_id();
  END IF;
  NEW.version := OLD.version + 1; NEW.updated_at := now();
  RETURN NEW;
END $function$;

-- Assignments: only an active role can be granted. (Body otherwise as 0021/0027.)
CREATE OR REPLACE FUNCTION iam.tg_user_role_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE v_actor uuid := util.actor_id(); v_n integer; v_role_code text; v_status text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT status INTO v_status FROM iam.role WHERE id = NEW.role_id;
    IF v_status IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'role is % and cannot be assigned', coalesce(v_status, 'missing') USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT iam.is_system_actor() THEN
      IF v_actor IS NULL THEN
        RAISE EXCEPTION 'no actor' USING ERRCODE = 'invalid_authorization_specification';
      END IF;
      IF NEW.user_id = v_actor THEN
        RAISE EXCEPTION 'you cannot assign a role to yourself' USING ERRCODE = 'insufficient_privilege';
      END IF;
      IF NOT iam.actor_covers_role(NEW.role_id) THEN
        RAISE EXCEPTION 'you cannot grant a role containing permissions you do not hold'
          USING ERRCODE = 'insufficient_privilege';
      END IF;
    END IF;
    NEW.granted_by := coalesce(NEW.granted_by, v_actor);
    NEW.granted_at := now();
    RETURN NEW;
  END IF;

  -- UPDATE: the only permitted change is revocation.
  IF NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.role_id IS DISTINCT FROM OLD.role_id
     OR NEW.scope_province IS DISTINCT FROM OLD.scope_province
     OR NEW.scope_project IS DISTINCT FROM OLD.scope_project THEN
    RAISE EXCEPTION 'a role assignment cannot be edited; revoke it and grant another'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'assignment already revoked' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.revoked_at IS NOT NULL THEN
    NEW.revoked_by := coalesce(NEW.revoked_by, v_actor);
    -- Never remove the last working administrator.
    SELECT code INTO v_role_code FROM iam.role WHERE id = OLD.role_id;
    IF v_role_code = 'system-administrator' AND NOT iam.other_working_admin_exists(OLD.user_id) THEN
      RAISE EXCEPTION 'this is the last active system administrator; assign another first'
        USING ERRCODE = 'raise_exception';
    END IF;
  END IF;
  RETURN NEW;
END $function$;

-- "Working": active account, holds the role, and has a way to sign in.
CREATE FUNCTION iam.other_working_admin_exists(p_except uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM iam.user_role ur
    JOIN iam.role r ON r.id = ur.role_id AND r.code = 'system-administrator'
    JOIN lms.app_user u ON u.id = ur.user_id
    WHERE ur.revoked_at IS NULL AND (ur.expires_at IS NULL OR ur.expires_at > now())
      AND u.id <> p_except AND u.status = 'Active'
      AND (u.password_hash IS NOT NULL
           OR EXISTS (SELECT 1 FROM iam.external_identity e WHERE e.user_id = u.id AND e.unlinked_at IS NULL)
           OR EXISTS (SELECT 1 FROM iam.mfa_webauthn w WHERE w.user_id = u.id)));
$function$;
REVOKE ALL ON FUNCTION iam.other_working_admin_exists(uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION iam.set_user_status(p_user uuid, p_status text, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE v_actor uuid := util.actor_id();
BEGIN
  PERFORM iam.require('users','update');
  IF p_status NOT IN ('Active','Suspended','Deactivated') THEN
    RAISE EXCEPTION 'invalid status' USING ERRCODE='invalid_parameter_value';
  END IF;
  IF p_user = v_actor THEN RAISE EXCEPTION 'you cannot change your own account status' USING ERRCODE='insufficient_privilege'; END IF;
  IF p_user = '00000000-0000-0000-0000-000000000001' THEN
    RAISE EXCEPTION 'the system account cannot be changed' USING ERRCODE='insufficient_privilege';
  END IF;
  IF length(btrim(coalesce(p_reason,''))) < 5 THEN
    RAISE EXCEPTION 'a reason of at least 5 characters is required' USING ERRCODE='invalid_parameter_value';
  END IF;
  -- Lock-out protection: the last working administrator stays active.
  IF p_status <> 'Active'
     AND EXISTS (SELECT 1 FROM iam.user_role ur JOIN iam.role r ON r.id = ur.role_id
                 WHERE ur.user_id = p_user AND r.code = 'system-administrator' AND ur.revoked_at IS NULL)
     AND NOT iam.other_working_admin_exists(p_user) THEN
    RAISE EXCEPTION 'this is the last active system administrator; it cannot be suspended or deactivated'
      USING ERRCODE='raise_exception';
  END IF;
  UPDATE lms.app_user SET status = p_status WHERE id = p_user;
  UPDATE iam.account_security SET deactivated_at = CASE WHEN p_status = 'Deactivated' THEN now() END WHERE user_id = p_user;
  PERFORM iam.log_event('user_status','success', p_user, NULL, v_actor, p_user, NULL, NULL, NULL, NULL, NULL,
                        jsonb_build_object('status', p_status, 'reason', left(p_reason,200)));
END $function$;

-- Role status changes go through one audited routine.
CREATE FUNCTION iam.set_role_status(p_code text, p_status text, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE v_id uuid; v_actor uuid := util.actor_id();
BEGIN
  IF p_status = 'retired' THEN PERFORM iam.require('roles','delete'); ELSE PERFORM iam.require('roles','update'); END IF;
  IF p_status NOT IN ('active','inactive','retired') THEN
    RAISE EXCEPTION 'invalid role status' USING ERRCODE='invalid_parameter_value';
  END IF;
  IF length(btrim(coalesce(p_reason,''))) < 5 THEN
    RAISE EXCEPTION 'a reason of at least 5 characters is required' USING ERRCODE='invalid_parameter_value';
  END IF;
  SELECT id INTO v_id FROM iam.role WHERE code = p_code;
  IF v_id IS NULL THEN RAISE EXCEPTION 'no such role %', p_code USING ERRCODE='no_data_found'; END IF;
  -- Reactivating or suspending a role changes what its members can do; the
  -- actor must be able to grant everything in it.
  IF NOT iam.actor_covers_role(v_id) THEN
    RAISE EXCEPTION 'you cannot change the status of a role containing permissions you do not hold'
      USING ERRCODE='insufficient_privilege';
  END IF;
  UPDATE iam.role SET status = p_status, status_reason = left(btrim(p_reason), 300) WHERE id = v_id;
  PERFORM iam.log_event('role_status','success', NULL, NULL, v_actor, NULL, NULL, NULL, NULL, NULL, NULL,
                        jsonb_build_object('role', p_code, 'status', p_status, 'reason', left(p_reason,200)));
END $function$;
REVOKE ALL ON FUNCTION iam.set_role_status(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION iam.set_role_status(text,text,text) TO lms_readwrite;

-- ---------------------------------------------------------------------
-- 3. Sensitive personal data and report sharing
-- ---------------------------------------------------------------------
INSERT INTO iam.permission (resource, action, description, is_sensitive) VALUES
  ('pii', 'read', 'See full CNIC, phone, IBAN and address of landowners and payees (others see them masked)', true),
  ('reports', 'share', 'Publish report templates for colleagues', false);

INSERT INTO iam.role_permission (role_id, permission_id, scope_level)
SELECT r.id, p.id, CASE WHEN r.code = 'system-administrator' THEN 'global' ELSE 'province' END
FROM iam.role r, iam.permission p
WHERE p.resource = 'pii' AND p.action = 'read'
  AND r.code IN ('data-entry', 'case-approver', 'land-manager', 'finance-approver', 'system-administrator');

INSERT INTO iam.role_permission (role_id, permission_id, scope_level)
SELECT r.id, p.id, CASE WHEN r.code = 'system-administrator' THEN 'global' ELSE 'province' END
FROM iam.role r, iam.permission p
WHERE p.resource = 'reports' AND p.action = 'share'
  AND r.code IN ('land-manager', 'finance-approver', 'system-administrator');

-- ---------------------------------------------------------------------
-- 4. Passkeys as a first factor
-- ---------------------------------------------------------------------
ALTER TABLE iam.mfa_webauthn
  ADD COLUMN aaguid      text,
  ADD COLUMN backed_up   boolean,
  ADD COLUMN device_type text CHECK (device_type IN ('singleDevice','multiDevice'));

-- Before sign-in there is no actor, so the lookup is a definer routine that
-- returns only what verification needs, for one credential id.
CREATE FUNCTION iam.passkey_lookup(p_credential bytea)
 RETURNS TABLE(user_id uuid, username text, status text, public_key bytea, sign_count bigint, transports text[], is_service_account boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT w.user_id, u.username::text, u.status, w.public_key, w.sign_count, w.transports, u.is_service_account
  FROM iam.mfa_webauthn w JOIN lms.app_user u ON u.id = w.user_id
  WHERE w.credential_id = p_credential;
$function$;
REVOKE ALL ON FUNCTION iam.passkey_lookup(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION iam.passkey_lookup(bytea) TO lms_readwrite;

-- The counter must move forward when the authenticator keeps one (a counter
-- of 0 means "not supported" and is allowed to stay 0).
CREATE FUNCTION iam.passkey_record_use(p_credential bytea, p_new_count bigint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE v_old bigint;
BEGIN
  SELECT sign_count INTO v_old FROM iam.mfa_webauthn WHERE credential_id = p_credential FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown credential' USING ERRCODE='no_data_found'; END IF;
  IF (p_new_count > 0 OR v_old > 0) AND p_new_count <= v_old THEN
    RAISE EXCEPTION 'passkey signature counter did not advance (possible cloned authenticator)'
      USING ERRCODE='insufficient_privilege';
  END IF;
  UPDATE iam.mfa_webauthn SET sign_count = p_new_count, last_used_at = now() WHERE credential_id = p_credential;
END $function$;
REVOKE ALL ON FUNCTION iam.passkey_record_use(bytea,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION iam.passkey_record_use(bytea,bigint) TO lms_readwrite;

-- Removing a passkey may not leave an account with no way to sign in.
CREATE FUNCTION iam.tg_webauthn_keep_one_way_in()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  IF iam.is_system_actor() THEN RETURN OLD; END IF;
  IF NOT EXISTS (SELECT 1 FROM lms.app_user u WHERE u.id = OLD.user_id AND u.password_hash IS NOT NULL)
     AND NOT EXISTS (SELECT 1 FROM iam.external_identity e WHERE e.user_id = OLD.user_id AND e.unlinked_at IS NULL)
     AND NOT EXISTS (SELECT 1 FROM iam.mfa_webauthn w WHERE w.user_id = OLD.user_id AND w.id <> OLD.id) THEN
    RAISE EXCEPTION 'this is your only way to sign in; set a password or add another passkey first'
      USING ERRCODE='raise_exception';
  END IF;
  RETURN OLD;
END $function$;
REVOKE ALL ON FUNCTION iam.tg_webauthn_keep_one_way_in() FROM PUBLIC;
CREATE TRIGGER webauthn_keep_one_way_in BEFORE DELETE ON iam.mfa_webauthn
  FOR EACH ROW EXECUTE FUNCTION iam.tg_webauthn_keep_one_way_in();

-- ---------------------------------------------------------------------
-- 5. SAML and the new sign-in methods
-- ---------------------------------------------------------------------
ALTER TABLE iam.auth_provider DROP CONSTRAINT auth_provider_kind_check;
ALTER TABLE iam.auth_provider ADD CONSTRAINT auth_provider_kind_check CHECK (kind IN ('ldap','oidc','saml'));
ALTER TABLE lms.login_session DROP CONSTRAINT login_session_auth_method_check;
ALTER TABLE lms.login_session ADD CONSTRAINT login_session_auth_method_check
  CHECK (auth_method IN ('local','ldap','oidc','saml','passkey','break_glass'));
ALTER TABLE iam.challenge DROP CONSTRAINT challenge_purpose_check;
ALTER TABLE iam.challenge ADD CONSTRAINT challenge_purpose_check
  CHECK (purpose IN ('mfa_login','webauthn_register','webauthn_login','oidc_state','saml_request'));

-- What a sign-in flow needs about one ENABLED, tested provider before any
-- user is known: its configuration and the ciphertext of its secret. The
-- secret is decrypted in the application with a key the database never sees.
CREATE FUNCTION iam.provider_runtime(p_name text)
 RETURNS TABLE(id uuid, kind text, name text, display_name text, config jsonb,
               secret_name text, secret_key_id text, secret_ciphertext bytea)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT p.id, p.kind, p.name, p.display_name, p.config, s.name, s.key_id, s.ciphertext
  FROM iam.auth_provider p LEFT JOIN iam.secret s ON s.id = p.secret_id
  WHERE p.name = p_name AND p.enabled AND p.last_test_ok IS TRUE;
$function$;
REVOKE ALL ON FUNCTION iam.provider_runtime(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION iam.provider_runtime(text) TO lms_readwrite;

-- Every configured provider for the sign-in page, including ones that are
-- not usable, so the page can say so instead of hiding the option. No
-- configuration or secret leaves the database through this.
CREATE FUNCTION iam.signin_methods()
 RETURNS TABLE(name text, display_name text, kind text, available boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT name, display_name, kind, (enabled AND last_test_ok IS TRUE) FROM iam.auth_provider ORDER BY kind, display_name;
$function$;
REVOKE ALL ON FUNCTION iam.signin_methods() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION iam.signin_methods() TO lms_readwrite;

RESET ROLE;
