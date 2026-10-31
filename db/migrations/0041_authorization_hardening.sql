-- =====================================================================
-- 0041  Authorization hardening: who may assert an identity, the database
--       tier, identity-table writes, delegation and approval positions,
--       policy settings, scope, sign-in challenges and background jobs
-- =====================================================================
-- Closes the database findings of the 2026-10-29 RBAC audit (IAMDB-01..17,
-- AUTH-07, UA-05/08/09, UI-10/12):
-- 1. Only the application tier (members of lms_readwrite) and owner sessions
--    may assert an actor. A read-only reporting login gets no actor at all.
--    The system account (USR-000) counts only in owner sessions or inside a
--    routine that entered a signed system context, so a raw
--    set_config('lms.actor_id', …) no longer yields administrator rights.
-- 2. The database tier that row-level security trusts is computed from the
--    actor's active, unexpired IAM assignments (no drift after an expiry).
-- 3. Accounts, province access and approval positions change only through
--    the identity routines. Approval positions are delegated authority:
--    users:assign, never on your own account, never with system
--    administration.
-- 4. Assignment, role and role-permission guards fail closed and keep
--    attribution and expiry immutable; the last administrator is protected
--    with expiry taken into account; deactivation is permanent.
-- 5. Security and identity settings go through iam.set_policy (validated
--    and logged); the administrator approval override cannot be switched on.
-- 6. A scope-aware permission check (province, project, assignment) backs
--    payment release; the MFA requirement follows sensitive permissions;
--    sign-in challenges are reachable only through routines.
-- 7. Import promotion, reconciliation and derived-data refresh check
--    permissions; users:read / sessions:read holders can read accounts and
--    sessions; notifications are strictly personal; the integration worker
--    uses dedicated routines instead of the system actor.
SET ROLE lms_owner;
SELECT set_config('lms.actor_id', '00000000-0000-0000-0000-000000000001', true);

-- ---------------------------------------------------------------------
-- 1. Who may assert an actor
-- ---------------------------------------------------------------------
-- The application (lms_readwrite members) and owner sessions assert the
-- actor; anyone else — the reporting login in particular — has none, so
-- row-level security shows them nothing (default deny).
CREATE OR REPLACE FUNCTION util.actor_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT CASE
    WHEN pg_catalog.pg_has_role(session_user, 'lms_readwrite', 'MEMBER')
      OR pg_catalog.pg_has_role(session_user, 'lms_owner', 'MEMBER')
    THEN nullif(pg_catalog.current_setting('lms.actor_id', true), '')::pg_catalog.uuid
  END
$function$;

CREATE OR REPLACE FUNCTION util.require_actor()
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE a uuid;
BEGIN
  a := util.actor_id();
  IF a IS NULL THEN
    RAISE EXCEPTION 'no actor set for this transaction'
      USING ERRCODE = 'invalid_authorization_specification',
            HINT = 'call api.set_actor(<app_user.id>) as the first statement of the transaction';
  END IF;
  RETURN a;
END $function$;

-- These read the actor through util.actor_id() so the rule above applies.
CREATE OR REPLACE FUNCTION lms.actor_provinces()
 RETURNS character[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT coalesce(array_agg(up.province_code ORDER BY up.province_code), '{}'::char(3)[])
  FROM lms.app_user_province up
  WHERE up.user_id = util.actor_id();
$function$;

CREATE OR REPLACE FUNCTION lms.actor_groups()
 RETURNS text[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT coalesce(array_agg(g.group_code ORDER BY g.group_code), '{}'::text[])
  FROM lms.app_user_group g
  WHERE g.user_id = util.actor_id();
$function$;

-- ---------------------------------------------------------------------
-- 2. The system account needs proof, not just its id
-- ---------------------------------------------------------------------
-- A per-database secret (owner-only, never granted) signs the system
-- context for one backend and one transaction. Routines that must act as
-- the system account inside an application session (directory
-- provisioning, the integration worker) enter that context and leave it
-- before they return; nothing else can produce the proof.
CREATE TABLE iam.internal_key (
  name       text PRIMARY KEY,
  secret     bytea NOT NULL CHECK (length(secret) >= 32),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE iam.internal_key ENABLE ROW LEVEL SECURITY;   -- no policy: the owner only
REVOKE ALL ON iam.internal_key FROM PUBLIC;
INSERT INTO iam.internal_key (name, secret) VALUES ('system_context', ext.gen_random_bytes(32));

CREATE FUNCTION iam.context_proof(p_actor uuid)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT encode(ext.hmac(convert_to(p_actor::text || '|' || pg_backend_pid()::text || '|'
                                    || (extract(epoch FROM transaction_timestamp()) * 1000000)::bigint::text, 'UTF8'),
                         k.secret, 'sha256'), 'hex')
  FROM iam.internal_key k WHERE k.name = 'system_context';
$function$;

CREATE FUNCTION iam.enter_system_context()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE v_prev text := coalesce(current_setting('lms.actor_id', true), '');
BEGIN
  PERFORM set_config('lms.actor_id', '00000000-0000-0000-0000-000000000001', true);
  PERFORM set_config('lms.actor_proof', iam.context_proof('00000000-0000-0000-0000-000000000001'), true);
  RETURN v_prev;
END $function$;

CREATE FUNCTION iam.leave_system_context(p_prev text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  PERFORM set_config('lms.actor_proof', '', true);
  PERFORM set_config('lms.actor_id', coalesce(p_prev, ''), true);
END $function$;

CREATE OR REPLACE FUNCTION iam.is_system_actor()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT coalesce(
    util.actor_id() = '00000000-0000-0000-0000-000000000001'::uuid
    AND (pg_has_role(session_user, 'lms_owner', 'MEMBER')
         OR current_setting('lms.actor_proof', true) = iam.context_proof('00000000-0000-0000-0000-000000000001'::uuid)),
    false);
$function$;

-- A service account cannot be a request's actor from the application.
CREATE OR REPLACE FUNCTION api.set_actor(p_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE v_status text; v_service boolean;
BEGIN
  SELECT status, is_service_account INTO v_status, v_service FROM lms.app_user WHERE id = p_user_id;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'unknown application user %', p_user_id
      USING ERRCODE = 'invalid_authorization_specification';
  END IF;
  IF v_status <> 'Active' THEN
    RAISE EXCEPTION 'application user % is %', p_user_id, v_status
      USING ERRCODE = 'invalid_authorization_specification';
  END IF;
  IF v_service AND NOT pg_has_role(session_user, 'lms_owner', 'MEMBER') THEN
    RAISE EXCEPTION 'a service account cannot act for an application request'
      USING ERRCODE = 'invalid_authorization_specification';
  END IF;
  PERFORM set_config('lms.actor_proof', '', true);
  PERFORM set_config('lms.actor_id', p_user_id::text, true);  -- true = transaction-local
END $function$;
-- A reporting login has no actor (above); asserting one is pointless.
REVOKE EXECUTE ON FUNCTION api.set_actor(uuid) FROM lms_readonly;

-- ---------------------------------------------------------------------
-- 3. The database tier comes from IAM, live
-- ---------------------------------------------------------------------
CREATE FUNCTION iam.tier_rank(p_tier text)
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$ SELECT coalesce((SELECT rank FROM lms.app_role WHERE code = p_tier), 0) $function$;

CREATE OR REPLACE FUNCTION lms.actor_role()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT CASE
    WHEN u.status <> 'Active' THEN NULL
    WHEN u.is_service_account THEN
      CASE WHEN pg_has_role(session_user, 'lms_owner', 'MEMBER')
                OR (u.id = '00000000-0000-0000-0000-000000000001'::uuid AND iam.is_system_actor())
           THEN u.role_code END
    ELSE coalesce((
      SELECT ar.code
      FROM iam.user_role ur
      JOIN iam.role r ON r.id = ur.role_id AND r.status = 'active'
      JOIN lms.app_role ar ON ar.code = r.db_role_code
      WHERE ur.user_id = u.id AND ur.revoked_at IS NULL
        AND (ur.expires_at IS NULL OR ur.expires_at > now())
      ORDER BY ar.rank DESC LIMIT 1), 'Viewer')
  END
  FROM lms.app_user u
  WHERE u.id = util.actor_id();
$function$;

-- The stored tier is now informational; keep it in step for display.
CREATE OR REPLACE FUNCTION iam.sync_db_role(p_user uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE v_role text;
BEGIN
  SELECT ar.code INTO v_role
  FROM iam.user_role ur
  JOIN iam.role r ON r.id = ur.role_id AND r.status = 'active'
  JOIN lms.app_role ar ON ar.code = r.db_role_code
  WHERE ur.user_id = p_user AND ur.revoked_at IS NULL
    AND (ur.expires_at IS NULL OR ur.expires_at > now())
  ORDER BY ar.rank DESC LIMIT 1;
  UPDATE lms.app_user SET role_code = coalesce(v_role, 'Viewer')
   WHERE id = p_user AND NOT is_service_account AND role_code IS DISTINCT FROM coalesce(v_role, 'Viewer');
END $function$;

-- ---------------------------------------------------------------------
-- 4. Accounts, province access and positions: identity routines only
-- ---------------------------------------------------------------------
-- current_user (not session_user): inside a definer routine the statement
-- runs as the owner, so the routine — which does its own checks — passes.
CREATE FUNCTION lms.tg_app_user_protect()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  IF pg_has_role(current_user, 'lms_owner', 'MEMBER') THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    RAISE EXCEPTION 'accounts are created only through iam.create_user or directory provisioning'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.username IS DISTINCT FROM OLD.username
     OR NEW.role_code IS DISTINCT FROM OLD.role_code OR NEW.password_hash IS DISTINCT FROM OLD.password_hash
     OR NEW.status IS DISTINCT FROM OLD.status OR NEW.is_service_account IS DISTINCT FROM OLD.is_service_account THEN
    RAISE EXCEPTION 'username, tier, status and password change only through the identity routines'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $function$;
CREATE TRIGGER app_user_protect BEFORE INSERT OR UPDATE ON lms.app_user
  FOR EACH ROW EXECUTE FUNCTION lms.tg_app_user_protect();

CREATE FUNCTION lms.tg_membership_protect()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  IF pg_has_role(current_user, 'lms_owner', 'MEMBER') THEN RETURN coalesce(NEW, OLD); END IF;
  RAISE EXCEPTION 'province access and approval positions change only through iam.create_user and iam.update_user'
    USING ERRCODE = 'insufficient_privilege';
END $function$;
CREATE TRIGGER app_user_province_protect BEFORE INSERT OR UPDATE OR DELETE ON lms.app_user_province
  FOR EACH ROW EXECUTE FUNCTION lms.tg_membership_protect();
CREATE TRIGGER app_user_group_protect BEFORE INSERT OR UPDATE OR DELETE ON lms.app_user_group
  FOR EACH ROW EXECUTE FUNCTION lms.tg_membership_protect();

-- And the grants that made the direct writes possible in the first place.
REVOKE INSERT, UPDATE, DELETE ON lms.app_user, lms.app_user_province, lms.app_user_group FROM lms_readwrite;

-- Approval positions are the workflow-step groups.
CREATE FUNCTION iam.is_approval_position(p_group text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$ SELECT EXISTS (SELECT 1 FROM lms.workflow_step_group WHERE group_code = p_group) $function$;

CREATE FUNCTION iam.holds_system_admin(p_user uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM iam.user_role ur JOIN iam.role r ON r.id = ur.role_id AND r.code = 'system-administrator'
    WHERE ur.user_id = p_user AND ur.revoked_at IS NULL AND (ur.expires_at IS NULL OR ur.expires_at > now()));
$function$;

-- Separation of duties between identity administration and business
-- approval, whoever writes the row (routine, provisioning or migration).
CREATE FUNCTION iam.tg_position_sod()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  IF iam.is_approval_position(NEW.group_code) AND iam.holds_system_admin(NEW.user_id) THEN
    RAISE EXCEPTION 'separation of duties: a system administrator cannot hold the approval position %', NEW.group_code
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $function$;
CREATE TRIGGER app_user_group_sod BEFORE INSERT OR UPDATE ON lms.app_user_group
  FOR EACH ROW EXECUTE FUNCTION iam.tg_position_sod();

CREATE OR REPLACE FUNCTION iam.update_user(p_user uuid, p_full_name text, p_email text, p_department text, p_position text,
                                           p_office text, p_provinces text[], p_groups text[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE v_actor uuid := util.actor_id(); v_target record; p text; v_scoped text;
BEGIN
  PERFORM iam.require('users','update');
  SELECT id, status, is_service_account INTO v_target FROM lms.app_user WHERE id = p_user;
  IF v_target.id IS NULL THEN RAISE EXCEPTION 'unknown user' USING ERRCODE = 'no_data_found'; END IF;
  IF v_target.is_service_account THEN
    RAISE EXCEPTION 'a service account is not edited here' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_target.status = 'Deactivated' THEN
    RAISE EXCEPTION 'a deactivated account cannot be edited' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Province access and approval positions are delegated authority.
  IF p_provinces IS NOT NULL OR p_groups IS NOT NULL THEN
    PERFORM iam.require('users','assign');
    IF p_user = v_actor THEN
      RAISE EXCEPTION 'you cannot change your own province access or approval positions'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  IF p_provinces IS NOT NULL THEN
    -- Outside the Admin tier, only provinces you hold can be added or removed.
    IF lms.actor_role() IS DISTINCT FROM 'Admin' THEN
      FOR p IN SELECT x FROM unnest(p_provinces) x
               UNION SELECT province_code::text FROM lms.app_user_province WHERE user_id = p_user
                       AND NOT (province_code::text = ANY (p_provinces)) LOOP
        IF NOT p = ANY (lms.actor_provinces()::text[]) THEN
          RAISE EXCEPTION 'you cannot grant or remove access to province % which you do not hold', p
            USING ERRCODE = 'insufficient_privilege';
        END IF;
      END LOOP;
    END IF;
    SELECT string_agg(DISTINCT ur.scope_province::text, ', ') INTO v_scoped
    FROM iam.user_role ur
    WHERE ur.user_id = p_user AND ur.revoked_at IS NULL AND ur.scope_province IS NOT NULL
      AND NOT (ur.scope_province::text = ANY (p_provinces));
    IF v_scoped IS NOT NULL THEN
      RAISE EXCEPTION 'revoke the role assignments limited to % before removing access to it', v_scoped
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
  END IF;

  UPDATE lms.app_user SET full_name = coalesce(nullif(btrim(p_full_name),''), full_name),
         email = CASE WHEN p_email IS NULL THEN email ELSE nullif(btrim(p_email),'') END,
         department = coalesce(p_department, department), position = coalesce(p_position, position),
         office_code = CASE WHEN p_office IS NULL THEN office_code ELSE nullif(p_office,'') END
   WHERE id = p_user;
  IF p_provinces IS NOT NULL THEN
    DELETE FROM lms.app_user_province WHERE user_id = p_user AND NOT (province_code::text = ANY (p_provinces));
    INSERT INTO lms.app_user_province(user_id, province_code)
    SELECT p_user, x::char(3) FROM unnest(p_provinces) x ON CONFLICT DO NOTHING;
  END IF;
  IF p_groups IS NOT NULL THEN
    DELETE FROM lms.app_user_group WHERE user_id = p_user AND NOT (group_code = ANY (p_groups));
    INSERT INTO lms.app_user_group(user_id, group_code)
    SELECT p_user, x FROM unnest(p_groups) x ON CONFLICT DO NOTHING;
  END IF;
  PERFORM iam.log_event('user_updated','success', p_user, NULL, v_actor, p_user, NULL, NULL, NULL, NULL, NULL,
                        jsonb_strip_nulls(jsonb_build_object('provinces', to_jsonb(p_provinces), 'groups', to_jsonb(p_groups))));
END $function$;

CREATE OR REPLACE FUNCTION iam.create_user(p_username text, p_full_name text, p_email text, p_department text, p_position text,
                                           p_office text, p_provinces text[], p_groups text[], p_role_codes text[])
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE v_id uuid; v_actor uuid := util.actor_id(); r text; p text; v_role uuid;
BEGIN
  PERFORM iam.require('users','create');
  IF coalesce(cardinality(p_groups), 0) > 0 THEN PERFORM iam.require('users','assign'); END IF;
  -- Province access cannot be wider than the creator's own (an administrator
  -- holds all four through the Admin tier).
  IF lms.actor_role() IS DISTINCT FROM 'Admin' THEN
    FOREACH p IN ARRAY coalesce(p_provinces,'{}') LOOP
      IF NOT p = ANY (lms.actor_provinces()::text[]) THEN
        RAISE EXCEPTION 'you cannot grant access to province % which you do not hold', p
          USING ERRCODE='insufficient_privilege';
      END IF;
    END LOOP;
  END IF;
  INSERT INTO lms.app_user(code, username, full_name, role_code, department, position, office_code, email, status)
  VALUES (lms.next_code('USR-'), p_username, btrim(p_full_name), 'Viewer', p_department, p_position,
          nullif(p_office,''), nullif(btrim(p_email),''), 'Active')
  RETURNING id INTO v_id;
  UPDATE iam.account_security SET must_change_password = true WHERE user_id = v_id;
  INSERT INTO lms.app_user_province(user_id, province_code)
  SELECT v_id, x::char(3) FROM unnest(coalesce(p_provinces,'{}')) x ON CONFLICT DO NOTHING;
  INSERT INTO lms.app_user_group(user_id, group_code)
  SELECT v_id, x FROM unnest(coalesce(p_groups,'{}')) x ON CONFLICT DO NOTHING;
  -- Each grant goes through the assignment guard (delegation, separation of duties).
  FOREACH r IN ARRAY coalesce(p_role_codes,'{}') LOOP
    SELECT id INTO v_role FROM iam.role WHERE code = r;
    IF v_role IS NULL THEN RAISE EXCEPTION 'unknown role %', r USING ERRCODE='invalid_parameter_value'; END IF;
    INSERT INTO iam.user_role(user_id, role_id) VALUES (v_id, v_role);
  END LOOP;
  PERFORM iam.log_event('user_created','success', v_id, p_username, v_actor, v_id, NULL, NULL, NULL, NULL, NULL,
                        jsonb_build_object('roles', to_jsonb(coalesce(p_role_codes,'{}')), 'groups', to_jsonb(coalesce(p_groups,'{}'))));
  RETURN v_id;
END $function$;

-- ---------------------------------------------------------------------
-- 5. Delegation: tier counts, guards fail closed, records stay honest
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION iam.actor_covers_role(p_role uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT coalesce(iam.is_system_actor() OR (
    iam.tier_rank((SELECT db_role_code FROM iam.role WHERE id = p_role)) <= iam.tier_rank(lms.actor_role())
    AND NOT EXISTS (
      SELECT 1 FROM iam.role_permission need
      WHERE need.role_id = p_role
        AND NOT EXISTS (
          SELECT 1 FROM iam.user_role ur
          JOIN iam.role hr ON hr.id = ur.role_id AND hr.status = 'active'
          JOIN iam.role_permission have ON have.role_id = ur.role_id
          WHERE ur.user_id = util.actor_id() AND ur.revoked_at IS NULL
            AND (ur.expires_at IS NULL OR ur.expires_at > now())
            AND have.permission_id = need.permission_id
            AND iam.permission_rank(have.scope_level) >= iam.permission_rank(need.scope_level)))), false);
$function$;

ALTER TABLE iam.user_role ADD COLUMN revoke_reason text
  CHECK (revoke_reason IS NULL OR length(revoke_reason) <= 500);
COMMENT ON COLUMN iam.user_role.reason IS 'Why the role was granted (immutable).';
COMMENT ON COLUMN iam.user_role.revoke_reason IS 'Why the role was revoked.';

CREATE OR REPLACE FUNCTION iam.tg_user_role_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE v_actor uuid := util.actor_id(); v_sys boolean := iam.is_system_actor();
        v_role record; v_user record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'role assignments are revoked, never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT id, code, status INTO v_role FROM iam.role WHERE id = coalesce(NEW.role_id, OLD.role_id);

  IF TG_OP = 'INSERT' THEN
    IF v_role.status IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'role is % and cannot be assigned', coalesce(v_role.status, 'missing') USING ERRCODE = 'insufficient_privilege';
    END IF;
    SELECT id, status, is_service_account INTO v_user FROM lms.app_user WHERE id = NEW.user_id;
    IF v_user.id IS NULL THEN RAISE EXCEPTION 'unknown user' USING ERRCODE = 'foreign_key_violation'; END IF;
    IF v_user.is_service_account THEN
      RAISE EXCEPTION 'roles cannot be given to a service account' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF v_user.status = 'Deactivated' THEN
      RAISE EXCEPTION 'a deactivated account cannot be given roles' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.expires_at IS NOT NULL AND NEW.expires_at <= now() THEN
      RAISE EXCEPTION 'an expiry must be in the future' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF v_role.code = 'system-administrator' THEN
      IF NEW.expires_at IS NOT NULL THEN
        RAISE EXCEPTION 'a system administrator grant cannot be time-limited' USING ERRCODE = 'invalid_parameter_value';
      END IF;
      IF NEW.scope_province IS NOT NULL OR NEW.scope_project IS NOT NULL THEN
        RAISE EXCEPTION 'a system administrator grant cannot be limited to a province or project' USING ERRCODE = 'invalid_parameter_value';
      END IF;
      IF EXISTS (SELECT 1 FROM lms.app_user_group g WHERE g.user_id = NEW.user_id AND iam.is_approval_position(g.group_code)) THEN
        RAISE EXCEPTION 'separation of duties: remove the account''s approval positions before making it a system administrator'
          USING ERRCODE = 'insufficient_privilege';
      END IF;
    END IF;
    IF NEW.scope_province IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM lms.app_user_province WHERE user_id = NEW.user_id AND province_code = NEW.scope_province) THEN
      RAISE EXCEPTION 'the account has no access to province %', NEW.scope_province USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF NOT v_sys THEN
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
      IF NEW.scope_province IS NOT NULL AND lms.actor_role() IS DISTINCT FROM 'Admin'
         AND NOT NEW.scope_province = ANY (lms.actor_provinces()) THEN
        RAISE EXCEPTION 'you cannot grant a role in province % which you do not hold', NEW.scope_province
          USING ERRCODE = 'insufficient_privilege';
      END IF;
    END IF;
    -- Attribution is the database's, not the caller's.
    NEW.granted_by := coalesce(v_actor, '00000000-0000-0000-0000-000000000001'::uuid);
    NEW.granted_at := now();
    NEW.revoked_at := NULL; NEW.revoked_by := NULL; NEW.revoke_reason := NULL;
    RETURN NEW;
  END IF;

  -- UPDATE: revocation is the only permitted change. To change an expiry or
  -- scope, revoke and grant again (so delegation is checked again).
  IF NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.role_id IS DISTINCT FROM OLD.role_id
     OR NEW.scope_province IS DISTINCT FROM OLD.scope_province OR NEW.scope_project IS DISTINCT FROM OLD.scope_project
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.granted_by IS DISTINCT FROM OLD.granted_by
     OR NEW.granted_at IS DISTINCT FROM OLD.granted_at OR NEW.reason IS DISTINCT FROM OLD.reason THEN
    RAISE EXCEPTION 'a role assignment cannot be edited; revoke it and grant another'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'assignment already revoked' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.revoked_at IS NULL THEN
    IF NEW.revoked_by IS DISTINCT FROM OLD.revoked_by OR NEW.revoke_reason IS DISTINCT FROM OLD.revoke_reason THEN
      RAISE EXCEPTION 'only a revocation can be recorded on an assignment' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT v_sys THEN
    IF v_actor IS NULL THEN
      RAISE EXCEPTION 'no actor' USING ERRCODE = 'invalid_authorization_specification';
    END IF;
    IF v_role.code = 'system-administrator' AND OLD.user_id = v_actor THEN
      RAISE EXCEPTION 'you cannot remove your own system administrator role' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  NEW.revoked_at := now();
  NEW.revoked_by := coalesce(v_actor, '00000000-0000-0000-0000-000000000001'::uuid);
  -- Never remove the last working administrator (expiry counts).
  IF v_role.code = 'system-administrator' AND NOT iam.other_working_admin_exists(OLD.user_id) THEN
    RAISE EXCEPTION 'this is the last active system administrator; assign another first'
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END $function$;
-- Assignments are revoked, never deleted.
CREATE TRIGGER user_role_no_delete BEFORE DELETE ON iam.user_role
  FOR EACH ROW EXECUTE FUNCTION iam.tg_user_role_guard();

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
    IF iam.tier_rank(NEW.db_role_code) > iam.tier_rank(lms.actor_role()) THEN
      RAISE EXCEPTION 'you cannot create a role above your own database tier' USING ERRCODE='insufficient_privilege';
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
  IF NEW.is_system IS DISTINCT FROM OLD.is_system THEN
    RAISE EXCEPTION 'a custom role cannot become a system role' USING ERRCODE='insufficient_privilege';
  END IF;
  IF NEW.db_role_code IS DISTINCT FROM OLD.db_role_code THEN
    IF NEW.db_role_code = 'Admin' THEN
      RAISE EXCEPTION 'a custom role cannot map to the Admin database tier' USING ERRCODE='insufficient_privilege';
    END IF;
    IF iam.tier_rank(NEW.db_role_code) > iam.tier_rank(lms.actor_role()) THEN
      RAISE EXCEPTION 'you cannot raise a role above your own database tier' USING ERRCODE='insufficient_privilege';
    END IF;
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

CREATE OR REPLACE FUNCTION iam.tg_role_permission_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE v_sys boolean; v_status text;
BEGIN
  IF iam.is_system_actor() THEN RETURN coalesce(NEW, OLD); END IF;
  -- A row cannot be moved between roles or permissions: that would let a
  -- system role's permission walk out of it unchecked.
  IF TG_OP = 'UPDATE' AND (NEW.role_id IS DISTINCT FROM OLD.role_id OR NEW.permission_id IS DISTINCT FROM OLD.permission_id) THEN
    RAISE EXCEPTION 'a role permission cannot be moved; remove it and add another' USING ERRCODE='insufficient_privilege';
  END IF;
  SELECT is_system, status INTO v_sys, v_status FROM iam.role WHERE id = coalesce(NEW.role_id, OLD.role_id);
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

-- A permission added to a role must not hand any current holder a pair the
-- separation-of-duties rules forbid.
CREATE OR REPLACE FUNCTION iam.tg_role_permission_sod()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE v_c text;
BEGIN
  SELECT pa.resource||':'||pa.action||' with '||pb.resource||':'||pb.action INTO v_c
  FROM iam.sod_rule s
  JOIN iam.role_permission ra ON ra.role_id = NEW.role_id AND ra.permission_id = s.perm_a
  JOIN iam.role_permission rb ON rb.role_id = NEW.role_id AND rb.permission_id = s.perm_b
  JOIN iam.permission pa ON pa.id = s.perm_a JOIN iam.permission pb ON pb.id = s.perm_b LIMIT 1;
  IF v_c IS NOT NULL THEN
    RAISE EXCEPTION 'separation of duties: a role cannot contain %', v_c USING ERRCODE='insufficient_privilege';
  END IF;
  SELECT u.username || ' would hold ' || c INTO v_c
  FROM iam.user_role ur
  JOIN lms.app_user u ON u.id = ur.user_id
  CROSS JOIN LATERAL iam.sod_conflicts(ur.user_id) c
  WHERE ur.role_id = NEW.role_id AND ur.revoked_at IS NULL AND (ur.expires_at IS NULL OR ur.expires_at > now())
  LIMIT 1;
  IF v_c IS NOT NULL THEN
    RAISE EXCEPTION 'separation of duties: %', v_c USING ERRCODE='insufficient_privilege';
  END IF;
  RETURN NULL;
END $function$;

-- ---------------------------------------------------------------------
-- 6. Account status: the last administrator, permanent deactivation
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION iam.set_user_status(p_user uuid, p_status text, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE v_actor uuid := util.actor_id(); v_cur text; v_service boolean;
BEGIN
  PERFORM iam.require('users','update');
  IF p_status NOT IN ('Active','Suspended','Deactivated') THEN
    RAISE EXCEPTION 'invalid status' USING ERRCODE='invalid_parameter_value';
  END IF;
  IF p_user = v_actor THEN RAISE EXCEPTION 'you cannot change your own account status' USING ERRCODE='insufficient_privilege'; END IF;
  SELECT status, is_service_account INTO v_cur, v_service FROM lms.app_user WHERE id = p_user;
  IF v_cur IS NULL THEN RAISE EXCEPTION 'unknown user' USING ERRCODE='no_data_found'; END IF;
  IF v_service THEN
    RAISE EXCEPTION 'a service account cannot be changed here' USING ERRCODE='insufficient_privilege';
  END IF;
  IF length(btrim(coalesce(p_reason,''))) < 5 THEN
    RAISE EXCEPTION 'a reason of at least 5 characters is required' USING ERRCODE='invalid_parameter_value';
  END IF;
  IF v_cur = 'Deactivated' THEN
    RAISE EXCEPTION 'deactivation is permanent; create a new account instead' USING ERRCODE='insufficient_privilege';
  END IF;
  IF v_cur = p_status THEN RETURN; END IF;
  -- Lock-out protection: the last working administrator stays active.
  IF p_status <> 'Active' AND iam.holds_system_admin(p_user) AND NOT iam.other_working_admin_exists(p_user) THEN
    RAISE EXCEPTION 'this is the last active system administrator; it cannot be suspended or deactivated'
      USING ERRCODE='raise_exception';
  END IF;
  UPDATE lms.app_user SET status = p_status WHERE id = p_user;
  UPDATE iam.account_security SET deactivated_at = CASE WHEN p_status = 'Deactivated' THEN now() END WHERE user_id = p_user;
  PERFORM iam.log_event('user_status','success', p_user, NULL, v_actor, p_user, NULL, NULL, NULL, NULL, NULL,
                        jsonb_build_object('status', p_status, 'reason', left(p_reason,200)));
END $function$;

CREATE OR REPLACE FUNCTION iam.tg_app_user_deactivate()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  IF OLD.status = 'Deactivated' AND NEW.status IS DISTINCT FROM 'Deactivated'
     AND NOT pg_has_role(session_user, 'lms_owner', 'MEMBER') THEN
    RAISE EXCEPTION 'deactivation is permanent; create a new account instead' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.status <> 'Active' AND OLD.status = 'Active' THEN
    IF iam.holds_system_admin(OLD.id) AND NOT iam.other_working_admin_exists(OLD.id) THEN
      RAISE EXCEPTION 'this is the last active system administrator; assign another first'
        USING ERRCODE = 'raise_exception';
    END IF;
    UPDATE lms.login_session SET ended_at = now(), end_reason = 'revoked'
     WHERE user_id = OLD.id AND ended_at IS NULL;
    DELETE FROM iam.challenge WHERE user_id = OLD.id;
  END IF;
  RETURN NEW;
END $function$;

-- Sign-in bookkeeping touches only active, human accounts.
CREATE OR REPLACE FUNCTION iam.note_auth_success(p_user uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM lms.app_user WHERE id = p_user AND status = 'Active' AND NOT is_service_account) THEN
    RETURN;
  END IF;
  PERFORM set_config('lms.actor_id', p_user::text, true);
  UPDATE iam.account_security SET failed_count = 0, locked_until = NULL WHERE user_id = p_user;
  UPDATE lms.app_user SET last_login_at = now() WHERE id = p_user;
END $function$;

CREATE OR REPLACE FUNCTION iam.rehash_password(p_user uuid, p_old text, p_new text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM lms.app_user WHERE id = p_user AND status = 'Active' AND NOT is_service_account) THEN
    RETURN;
  END IF;
  PERFORM set_config('lms.actor_id', p_user::text, true);
  UPDATE lms.app_user SET password_hash = p_new WHERE id = p_user AND password_hash = p_old;
END $function$;

-- ---------------------------------------------------------------------
-- 7. Settings: identity and security policy through iam.set_policy only
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION api.set_setting(p_key text, p_value jsonb, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE v_actor uuid := util.require_actor(); v_old jsonb; v_type text; v_txt text; v_e jsonb;
BEGIN
  IF p_key LIKE 'iam.%' OR p_key LIKE 'security.%' OR p_key IN ('workflow.admin_override', 'workflow.sod_mode') THEN
    RAISE EXCEPTION 'setting % is an identity or security policy; change it with iam.set_policy', p_key
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM iam.require('settings','update');
  SELECT value, value_type INTO v_old, v_type FROM lms.system_setting WHERE key = p_key FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown setting %', p_key USING ERRCODE = 'invalid_parameter_value',
      HINT = 'settings are defined by migration; a new one is not created at runtime';
  END IF;
  IF p_value IS NULL OR jsonb_typeof(p_value) IS DISTINCT FROM v_type THEN
    RAISE EXCEPTION 'setting % must be a % value', p_key, v_type USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_txt := p_value #>> '{}';
  CASE p_key
    WHEN 'finance.wht_pct' THEN
      IF v_txt::numeric NOT BETWEEN 0 AND 100 THEN
        RAISE EXCEPTION 'withholding tax must be 0 to 100 percent' USING ERRCODE = 'invalid_parameter_value'; END IF;
    WHEN 'finance.wht_nonfiler_multiplier' THEN
      IF v_txt::numeric NOT BETWEEN 1 AND 5 THEN
        RAISE EXCEPTION 'the non-filer multiplier must be 1 to 5' USING ERRCODE = 'invalid_parameter_value'; END IF;
    WHEN 'grievance.target_days' THEN
      IF v_txt !~ '^[0-9]+$' OR v_txt::int NOT BETWEEN 1 AND 365 THEN
        RAISE EXCEPTION 'grievance target must be 1 to 365 days' USING ERRCODE = 'invalid_parameter_value'; END IF;
    WHEN 'retention.audit_years' THEN
      IF v_txt !~ '^[0-9]+$' OR v_txt::int NOT BETWEEN 1 AND 100 THEN
        RAISE EXCEPTION 'audit retention must be 1 to 100 years' USING ERRCODE = 'invalid_parameter_value'; END IF;
    WHEN 'alerts.lease_expiry_days', 'alerts.row_renewal_days' THEN
      IF jsonb_array_length(p_value) NOT BETWEEN 1 AND 10 THEN
        RAISE EXCEPTION 'give 1 to 10 reminder days' USING ERRCODE = 'invalid_parameter_value'; END IF;
      FOR v_e IN SELECT * FROM jsonb_array_elements(p_value) LOOP
        IF jsonb_typeof(v_e) <> 'number' OR (v_e #>> '{}') !~ '^[0-9]+$' OR (v_e #>> '{}')::int NOT BETWEEN 1 AND 3650 THEN
          RAISE EXCEPTION 'reminder days must be whole numbers from 1 to 3650' USING ERRCODE = 'invalid_parameter_value';
        END IF;
      END LOOP;
    WHEN 'finance.currency' THEN
      IF v_txt !~ '^[A-Z]{3}$' THEN
        RAISE EXCEPTION 'currency must be a three-letter ISO code' USING ERRCODE = 'invalid_parameter_value'; END IF;
    ELSE
      IF v_type = 'string' AND (length(btrim(v_txt)) = 0 OR length(v_txt) > 200) THEN
        RAISE EXCEPTION 'setting % must be 1 to 200 characters', p_key USING ERRCODE = 'invalid_parameter_value';
      END IF;
  END CASE;
  -- The note is handed to the history trigger through a transaction-local
  -- parameter rather than written afterwards: lms.setting_history is
  -- append-only, so there is no afterwards.
  PERFORM set_config('lms.change_note', coalesce(p_note, ''), true);
  UPDATE lms.system_setting
     SET value = p_value, updated_at = clock_timestamp(), updated_by = v_actor,
         version = version + 1
   WHERE key = p_key;
  RETURN v_old;
END $function$;

CREATE OR REPLACE FUNCTION iam.set_policy(p_key text, p_value jsonb, p_note text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE v_old jsonb; v_txt text; v_e text;
BEGIN
  PERFORM iam.require('identity_settings','configure');
  IF p_key NOT LIKE 'iam.%' AND p_key NOT LIKE 'security.%' AND p_key NOT IN ('workflow.admin_override','workflow.sod_mode') THEN
    RAISE EXCEPTION 'not an identity or security setting' USING ERRCODE='invalid_parameter_value';
  END IF;
  SELECT value INTO v_old FROM lms.system_setting WHERE key = p_key FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown setting %', p_key USING ERRCODE='invalid_parameter_value'; END IF;
  IF p_value IS NULL THEN RAISE EXCEPTION 'a value is required' USING ERRCODE='invalid_parameter_value'; END IF;
  v_txt := p_value #>> '{}';
  CASE p_key
    WHEN 'security.password_min_length' THEN
      IF jsonb_typeof(p_value) <> 'number' OR v_txt !~ '^[0-9]+$' OR v_txt::int NOT BETWEEN 10 AND 128 THEN
        RAISE EXCEPTION 'minimum password length must be 10 to 128' USING ERRCODE='invalid_parameter_value'; END IF;
    WHEN 'security.session_minutes' THEN
      IF jsonb_typeof(p_value) <> 'number' OR v_txt !~ '^[0-9]+$' OR v_txt::int NOT BETWEEN 5 AND 480 THEN
        RAISE EXCEPTION 'idle timeout must be 5 to 480 minutes' USING ERRCODE='invalid_parameter_value'; END IF;
    WHEN 'security.max_failed_logins' THEN
      IF jsonb_typeof(p_value) <> 'number' OR v_txt !~ '^[0-9]+$' OR v_txt::int NOT BETWEEN 3 AND 20 THEN
        RAISE EXCEPTION 'lockout threshold must be 3 to 20' USING ERRCODE='invalid_parameter_value'; END IF;
    WHEN 'iam.session_absolute_hours' THEN
      IF jsonb_typeof(p_value) <> 'number' OR v_txt !~ '^[0-9]+$' OR v_txt::int NOT BETWEEN 1 AND 72 THEN
        RAISE EXCEPTION 'absolute session limit must be 1 to 72 hours' USING ERRCODE='invalid_parameter_value'; END IF;
    WHEN 'iam.lockout_minutes' THEN
      IF jsonb_typeof(p_value) <> 'number' OR v_txt !~ '^[0-9]+$' OR v_txt::int NOT BETWEEN 1 AND 1440 THEN
        RAISE EXCEPTION 'lockout duration must be 1 to 1440 minutes' USING ERRCODE='invalid_parameter_value'; END IF;
    WHEN 'iam.password_history' THEN
      IF jsonb_typeof(p_value) <> 'number' OR v_txt !~ '^[0-9]+$' OR v_txt::int NOT BETWEEN 0 AND 20 THEN
        RAISE EXCEPTION 'password history must be 0 to 20' USING ERRCODE='invalid_parameter_value'; END IF;
    WHEN 'iam.invitation_hours' THEN
      IF jsonb_typeof(p_value) <> 'number' OR v_txt !~ '^[0-9]+$' OR v_txt::int NOT BETWEEN 1 AND 336 THEN
        RAISE EXCEPTION 'an invitation lasts 1 to 336 hours' USING ERRCODE='invalid_parameter_value'; END IF;
    WHEN 'iam.rate_limit_per_ip' THEN
      IF jsonb_typeof(p_value) <> 'number' OR v_txt !~ '^[0-9]+$' OR v_txt::int NOT BETWEEN 5 AND 1000 THEN
        RAISE EXCEPTION 'the per-address limit must be 5 to 1000 attempts' USING ERRCODE='invalid_parameter_value'; END IF;
    WHEN 'iam.rate_limit_per_user' THEN
      IF jsonb_typeof(p_value) <> 'number' OR v_txt !~ '^[0-9]+$' OR v_txt::int NOT BETWEEN 3 AND 100 THEN
        RAISE EXCEPTION 'the per-account limit must be 3 to 100 attempts' USING ERRCODE='invalid_parameter_value'; END IF;
    WHEN 'iam.rate_limit_window_minutes' THEN
      IF jsonb_typeof(p_value) <> 'number' OR v_txt !~ '^[0-9]+$' OR v_txt::int NOT BETWEEN 1 AND 1440 THEN
        RAISE EXCEPTION 'the rate-limit window must be 1 to 1440 minutes' USING ERRCODE='invalid_parameter_value'; END IF;
    WHEN 'iam.reauth_minutes' THEN
      IF jsonb_typeof(p_value) <> 'number' OR v_txt !~ '^[0-9]+$' OR v_txt::int NOT BETWEEN 1 AND 60 THEN
        RAISE EXCEPTION 're-authentication lasts 1 to 60 minutes' USING ERRCODE='invalid_parameter_value'; END IF;
    WHEN 'iam.recovery_token_minutes' THEN
      IF jsonb_typeof(p_value) <> 'number' OR v_txt !~ '^[0-9]+$' OR v_txt::int NOT BETWEEN 5 AND 1440 THEN
        RAISE EXCEPTION 'a recovery link lasts 5 to 1440 minutes' USING ERRCODE='invalid_parameter_value'; END IF;
    WHEN 'iam.provisioning_mode' THEN
      IF jsonb_typeof(p_value) <> 'string' OR v_txt NOT IN ('approval','auto') THEN
        RAISE EXCEPTION 'provisioning mode: approval or auto' USING ERRCODE='invalid_parameter_value'; END IF;
    WHEN 'iam.link_by_email' THEN
      IF jsonb_typeof(p_value) <> 'string' OR v_txt NOT IN ('never','verified') THEN
        RAISE EXCEPTION 'link_by_email: never or verified' USING ERRCODE='invalid_parameter_value'; END IF;
    WHEN 'iam.provider_failure_behavior' THEN
      IF jsonb_typeof(p_value) <> 'string' OR v_txt NOT IN ('deny','break_glass_only') THEN
        RAISE EXCEPTION 'provider failure behaviour: deny or break_glass_only' USING ERRCODE='invalid_parameter_value'; END IF;
    WHEN 'iam.mfa_required_all', 'iam.mfa_for_sensitive_permissions' THEN
      IF jsonb_typeof(p_value) <> 'boolean' THEN RAISE EXCEPTION 'must be true or false' USING ERRCODE='invalid_parameter_value'; END IF;
    WHEN 'iam.mfa_required_roles' THEN
      IF jsonb_typeof(p_value) <> 'array' THEN RAISE EXCEPTION 'must be a list of role codes' USING ERRCODE='invalid_parameter_value'; END IF;
      FOR v_e IN SELECT jsonb_array_elements_text(p_value) LOOP
        IF NOT EXISTS (SELECT 1 FROM iam.role WHERE code = v_e AND status <> 'retired') THEN
          RAISE EXCEPTION 'unknown role %', v_e USING ERRCODE='invalid_parameter_value';
        END IF;
      END LOOP;
    WHEN 'iam.local_login_enabled' THEN
      IF jsonb_typeof(p_value) <> 'boolean' THEN RAISE EXCEPTION 'must be true or false' USING ERRCODE='invalid_parameter_value'; END IF;
      IF v_txt = 'false' THEN
        -- Recovery access must exist and be proven before local login goes.
        IF NOT EXISTS (SELECT 1 FROM iam.account_security a JOIN lms.app_user u ON u.id = a.user_id
                       WHERE a.is_break_glass AND u.status = 'Active')
           AND NOT EXISTS (
             SELECT 1 FROM iam.external_identity e
             JOIN iam.auth_provider p ON p.id = e.provider_id AND p.enabled AND p.last_test_ok
             JOIN iam.user_role ur ON ur.user_id = e.user_id AND ur.revoked_at IS NULL
                                  AND (ur.expires_at IS NULL OR ur.expires_at > now())
             JOIN iam.role r ON r.id = ur.role_id AND r.code = 'system-administrator'
             JOIN lms.app_user u ON u.id = e.user_id AND u.status = 'Active'
             WHERE e.unlinked_at IS NULL) THEN
          RAISE EXCEPTION 'refused: turning local login off would lock out every administrator. Designate an emergency-access account with MFA, or link an administrator to a tested, enabled provider first.'
            USING ERRCODE='raise_exception';
        END IF;
      END IF;
    WHEN 'workflow.admin_override' THEN
      -- The override let the Admin tier act in approval positions it does not
      -- hold. Separation of duties keeps it off; it can only be confirmed off.
      IF jsonb_typeof(p_value) <> 'boolean' OR v_txt <> 'false' THEN
        RAISE EXCEPTION 'the administrator approval override is disabled; assign the approval position to an authorised officer instead'
          USING ERRCODE='insufficient_privilege';
      END IF;
    WHEN 'workflow.sod_mode' THEN
      IF jsonb_typeof(p_value) <> 'string' OR v_txt <> 'strict' THEN
        RAISE EXCEPTION 'only strict separation of duties is supported' USING ERRCODE='invalid_parameter_value';
      END IF;
    ELSE
      RAISE EXCEPTION 'setting % is not editable', p_key USING ERRCODE='invalid_parameter_value';
  END CASE;
  PERFORM set_config('lms.change_note', coalesce(p_note,''), true);
  UPDATE lms.system_setting SET value = p_value, updated_at = now(), updated_by = util.actor_id(), version = version + 1
   WHERE key = p_key;
  PERFORM iam.log_event('policy_changed','success', NULL, NULL, util.actor_id(), NULL, NULL, NULL, NULL, NULL, NULL,
                        jsonb_build_object('setting', p_key, 'from', v_old, 'to', p_value));
END $function$;

-- ---------------------------------------------------------------------
-- 8. Scope-aware permission checks
-- ---------------------------------------------------------------------
-- A permission held "at province scope", or a grant limited to one province
-- or project, covers only that province or project. Same rules as the API's
-- ctx.can(); global and head-office grants reach every province the actor
-- can see (row-level security still applies to what is visible).
CREATE FUNCTION iam.has_permission_in(p_resource text, p_action text, p_province text,
                                      p_project uuid DEFAULT NULL, p_assigned_to uuid DEFAULT NULL)
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
    JOIN iam.role_permission rp ON rp.role_id = r.id
    JOIN iam.permission p ON p.id = rp.permission_id
    WHERE u.id = util.actor_id() AND u.status = 'Active'
      AND p.resource = p_resource AND p.action = p_action
      AND (ur.scope_province IS NULL OR ur.scope_province::text = p_province)
      AND (ur.scope_project IS NULL OR ur.scope_project = p_project)
      AND CASE rp.scope_level
            WHEN 'global' THEN true
            WHEN 'head_office' THEN true
            WHEN 'province' THEN p_province IS NULL OR lms.actor_role() = 'Admin'
                                 OR p_province = ANY (lms.actor_provinces()::text[])
            WHEN 'project' THEN p_project IS NOT NULL
                                AND (p_province IS NULL OR lms.actor_role() = 'Admin'
                                     OR p_province = ANY (lms.actor_provinces()::text[]))
            WHEN 'assigned' THEN p_assigned_to IS NOT NULL AND p_assigned_to = u.id
            ELSE false
          END);
$function$;

CREATE FUNCTION iam.require_in(p_resource text, p_action text, p_province text,
                               p_project uuid DEFAULT NULL, p_assigned_to uuid DEFAULT NULL)
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  IF util.actor_id() IS NULL THEN
    RAISE EXCEPTION 'no actor set' USING ERRCODE = 'invalid_authorization_specification';
  END IF;
  IF NOT iam.has_permission_in(p_resource, p_action, p_province, p_project, p_assigned_to) THEN
    RAISE EXCEPTION 'permission denied: %:% for this record', p_resource, p_action USING ERRCODE = 'insufficient_privilege';
  END IF;
END $function$;

-- Releasing money: the release permission must cover the voucher's province.
CREATE OR REPLACE FUNCTION iam.tg_require_release()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  PERFORM iam.require_in('payments', 'release', NEW.province_code::text);
  RETURN NEW;
END $function$;

-- ---------------------------------------------------------------------
-- 9. MFA follows sensitive permissions, not just role names
-- ---------------------------------------------------------------------
INSERT INTO lms.system_setting (key, value, value_type, description) VALUES
  ('iam.mfa_for_sensitive_permissions', 'true', 'boolean',
   'Require multi-factor sign-in for anyone holding a permission marked sensitive (approvals, releases, identity administration), whatever the role is called.')
ON CONFLICT (key) DO NOTHING;
CREATE FUNCTION iam.mfa_required_for(p_user uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT coalesce((SELECT value #>> '{}' FROM lms.system_setting WHERE key = 'iam.mfa_required_all') = 'true', false)
      OR EXISTS (
        SELECT 1
        FROM iam.user_role ur
        JOIN iam.role r ON r.id = ur.role_id AND r.status = 'active'
        WHERE ur.user_id = p_user AND ur.revoked_at IS NULL
          AND (ur.expires_at IS NULL OR ur.expires_at > now())
          AND (r.code IN (SELECT jsonb_array_elements_text(s.value) FROM lms.system_setting s
                          WHERE s.key = 'iam.mfa_required_roles' AND jsonb_typeof(s.value) = 'array')
               OR (coalesce((SELECT value #>> '{}' FROM lms.system_setting WHERE key = 'iam.mfa_for_sensitive_permissions'), 'true') = 'true'
                   AND EXISTS (SELECT 1 FROM iam.role_permission rp JOIN iam.permission p ON p.id = rp.permission_id
                               WHERE rp.role_id = r.id AND p.is_sensitive))));
$function$;

-- ---------------------------------------------------------------------
-- 10. Sign-in challenges through routines only (AUTH-07, IAMDB-17)
-- ---------------------------------------------------------------------
CREATE FUNCTION iam.challenge_issue(p_token_sha256 bytea, p_purpose text, p_user uuid, p_data jsonb, p_ttl_seconds integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE v_id uuid;
BEGIN
  IF p_token_sha256 IS NULL OR length(p_token_sha256) <> 32 THEN
    RAISE EXCEPTION 'a challenge is stored by its SHA-256 digest' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_purpose IS NULL OR p_purpose NOT IN ('mfa_login','webauthn_register','webauthn_login','oidc_state','saml_request') THEN
    RAISE EXCEPTION 'unknown challenge purpose' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_ttl_seconds IS NULL OR p_ttl_seconds NOT BETWEEN 30 AND 900 THEN
    RAISE EXCEPTION 'a challenge lives 30 to 900 seconds' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_data IS NOT NULL AND length(p_data::text) > 8192 THEN
    RAISE EXCEPTION 'challenge data is limited to 8 KB' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_purpose IN ('mfa_login','webauthn_register') AND p_user IS NULL THEN
    RAISE EXCEPTION 'this challenge belongs to an account' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- Housekeeping, bounded per call.
  DELETE FROM iam.challenge WHERE id IN (SELECT c.id FROM iam.challenge c WHERE c.expires_at < now() - interval '1 hour' LIMIT 200);
  INSERT INTO iam.challenge (token_sha256, user_id, purpose, data, expires_at)
  VALUES (p_token_sha256, p_user, p_purpose, coalesce(p_data, '{}'::jsonb), now() + make_interval(secs => p_ttl_seconds))
  RETURNING id INTO v_id;
  RETURN v_id;
END $function$;

CREATE FUNCTION iam.challenge_find(p_token_sha256 bytea, p_purpose text)
 RETURNS TABLE(id uuid, user_id uuid, data jsonb, attempts integer, expires_at timestamptz)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT c.id, c.user_id, c.data, c.attempts::integer, c.expires_at
  FROM iam.challenge c
  WHERE c.token_sha256 = p_token_sha256 AND c.purpose = p_purpose
    AND c.used_at IS NULL AND c.expires_at > now() AND c.attempts < 5;
$function$;

-- A wrong answer: count it atomically; the fifth burns the challenge.
CREATE FUNCTION iam.challenge_fail(p_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE v_att integer;
BEGIN
  UPDATE iam.challenge
     SET attempts = attempts + 1,
         used_at = CASE WHEN attempts + 1 >= 5 THEN now() ELSE used_at END
   WHERE id = p_id AND used_at IS NULL
  RETURNING attempts INTO v_att;
  IF v_att IS NULL THEN RETURN 0; END IF;
  RETURN greatest(0, 5 - v_att);
END $function$;

-- Single use, even under a race between two tabs.
CREATE FUNCTION iam.challenge_consume(p_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  UPDATE iam.challenge SET used_at = now()
   WHERE id = p_id AND used_at IS NULL AND expires_at > now() AND attempts < 5;
  RETURN FOUND;
END $function$;

CREATE FUNCTION iam.challenge_take(p_token_sha256 bytea, p_purpose text)
 RETURNS TABLE(id uuid, user_id uuid, data jsonb)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  UPDATE iam.challenge c SET used_at = now()
   WHERE c.token_sha256 = p_token_sha256 AND c.purpose = p_purpose
     AND c.used_at IS NULL AND c.expires_at > now() AND c.attempts < 5
  RETURNING c.id, c.user_id, c.data;
$function$;

DROP POLICY IF EXISTS challenge_open ON iam.challenge;
REVOKE SELECT, INSERT, UPDATE, DELETE ON iam.challenge FROM lms_readwrite;

-- ---------------------------------------------------------------------
-- 11. Read access that follows permissions; personal notifications
-- ---------------------------------------------------------------------
-- has_permission answers false without an actor; reporting sessions may
-- evaluate these policies, so they need to be able to call it.
GRANT EXECUTE ON FUNCTION iam.has_permission(text, text) TO lms_readonly;
CREATE POLICY users_read ON lms.app_user FOR SELECT USING ((SELECT iam.has_permission('users','read')));
CREATE POLICY users_read ON lms.app_user_province FOR SELECT USING ((SELECT iam.has_permission('users','read')));
CREATE POLICY users_read ON lms.app_user_group FOR SELECT USING ((SELECT iam.has_permission('users','read')));
CREATE POLICY sessions_read ON lms.login_session FOR SELECT USING ((SELECT iam.has_permission('sessions','read')));
ALTER POLICY own_notifications ON lms.notification
  USING (user_id = (SELECT util.actor_id()))
  WITH CHECK (user_id = (SELECT util.actor_id()));

-- Name lookups for audit trails need a signed-in actor.
CREATE OR REPLACE FUNCTION lms.user_username(p_id uuid)
 RETURNS ext.citext
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$ SELECT u.username FROM lms.app_user u WHERE u.id = p_id AND util.actor_id() IS NOT NULL $function$;

CREATE OR REPLACE FUNCTION lms.user_full_name(p_id uuid)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$ SELECT u.full_name FROM lms.app_user u WHERE u.id = p_id AND util.actor_id() IS NOT NULL $function$;

-- ---------------------------------------------------------------------
-- 11b. Import promotion is the land manager's (and administrator's)
-- ---------------------------------------------------------------------
-- The database used to allow promotion to the Approver and Admin tiers only,
-- while IAM told data entry and case approvers they held import:update. The
-- routine now checks import:update itself, so the grant is aligned with the
-- rule that has always applied: staging and validating is import:create;
-- promoting validated rows into the live register is import:update.
UPDATE iam.permission SET description = 'Stage and validate bulk import batches' WHERE resource = 'import' AND action = 'create';
UPDATE iam.permission SET description = 'Promote validated bulk import batches into the live register' WHERE resource = 'import' AND action = 'update';
DELETE FROM iam.role_permission rp
 USING iam.role r, iam.permission p
 WHERE rp.role_id = r.id AND rp.permission_id = p.id
   AND r.code IN ('data-entry', 'case-approver') AND p.resource = 'import' AND p.action = 'update';

-- ---------------------------------------------------------------------
-- 12. Routines that skipped their permission check (generated from the
--     live definitions, with the check added)
-- ---------------------------------------------------------------------
-- Import promotion: the IAM permission (import:update) replaces the tier check,
-- and no row may land in a province the actor cannot reach (IAMDB-09).
CREATE OR REPLACE FUNCTION api.promote_import_batch(p_batch_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := util.require_actor();
  b       record;
  ir      record;
  v_id    uuid;
  v_n     integer := 0;
BEGIN
  PERFORM iam.require('import','update');

  SELECT * INTO b FROM lms.import_batch WHERE id = p_batch_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such import batch %', p_batch_id USING ERRCODE = 'no_data_found';
  END IF;
  IF b.status <> 'validated' THEN
    RAISE EXCEPTION 'batch % is % — only a validated batch may be promoted', b.code, b.status
      USING ERRCODE = 'raise_exception',
            HINT = 'run api.validate_import_batch() and clear every error first';
  END IF;

  -- Every row lands in its own province; each one must be within the actor's reach.
  IF lms.actor_role() IS DISTINCT FROM 'Admin' AND (
       NOT lms.actor_can_see_province(b.province_code)
       OR EXISTS (SELECT 1 FROM lms.import_row r
                  WHERE r.batch_id = p_batch_id AND r.status = 'valid'
                    AND NOT lms.actor_can_see_province(nullif(r.normalised ->> 'province_code', '')::char(3)))) THEN
    RAISE EXCEPTION 'batch % has rows in a province you cannot access', b.code
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE lms.import_batch SET status = 'promoting' WHERE id = p_batch_id;

  FOR ir IN SELECT * FROM lms.import_row
            WHERE batch_id = p_batch_id AND status = 'valid' ORDER BY source_line
  LOOP
    IF b.target_entity = 'landowner' THEN
      INSERT INTO lms.landowner (code, province_code, full_name, father_name, cnic,
                                 phone, owner_type, status, iban, created_by, updated_by)
      VALUES (lms.next_code((ir.normalised ->> 'province_code') || '-'),
              (ir.normalised ->> 'province_code')::char(3),
              ir.normalised ->> 'full_name',
              coalesce(nullif(ir.normalised ->> 'father_name',''), '(not recorded)'),
              (ir.normalised ->> 'cnic')::lms.cnic,
              ir.normalised ->> 'phone',
              (ir.normalised ->> 'owner_type')::char(1),
              'Active', ir.normalised ->> 'iban', v_actor, v_actor)
      RETURNING id INTO v_id;

    ELSIF b.target_entity = 'survey' THEN
      INSERT INTO lms.survey (code, province_code, admin_unit_id, survey_no, block_no,
                              total_area, land_class, status_code, created_by, updated_by)
      SELECT lms.next_code('AREA-'), au.province_code, au.id,
             ir.normalised ->> 'survey_no', ir.normalised ->> 'block_no',
             -- Converted through the one conversion routine, so an imported
             -- area is the same number the application would have computed.
             api.convert_area((ir.normalised ->> 'area_value')::numeric,
                              ir.normalised ->> 'area_unit', 'Acre', current_date, true),
             ir.normalised ->> 'land_class', 'Proposed', v_actor, v_actor
      FROM lms.admin_unit au
      WHERE au.name = ir.normalised ->> 'unit_name'
        AND au.province_code = ir.normalised ->> 'province_code'
      ORDER BY au.level DESC LIMIT 1
      RETURNING id INTO v_id;
    END IF;

    UPDATE lms.import_row SET status = 'promoted', promoted_id = v_id WHERE id = ir.id;

    INSERT INTO lms.data_provenance (entity, record_id, source_kind, batch_id,
                                     source_system, source_key, source_line, confidence)
    VALUES (b.target_entity, v_id, 'import', p_batch_id, b.source_file,
            ir.normalised ->> 'cnic', ir.source_line, 'medium');
    v_n := v_n + 1;
  END LOOP;

  UPDATE lms.import_batch
     SET status = 'promoted', promoted_count = v_n,
         promoted_at = clock_timestamp(), promoted_by = v_actor
   WHERE id = p_batch_id;
  RETURN v_n;
END $function$;

-- Reconciliation scans every province: it needs a finance permission (IAMDB-15).
CREATE OR REPLACE FUNCTION api.reconcile(p_scope text DEFAULT 'all'::text, p_scope_ref uuid DEFAULT NULL::uuid, p_as_of date DEFAULT CURRENT_DATE)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE v_actor uuid := util.require_actor(); v_run uuid; v_n integer;
BEGIN
  IF NOT (iam.has_permission('payments','verify') OR iam.has_permission('payments','release')) THEN
    RAISE EXCEPTION 'permission denied: payments:verify' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO lms.reconciliation_run (scope, scope_ref, as_of, run_by)
  VALUES (p_scope, p_scope_ref, p_as_of, v_actor) RETURNING id INTO v_run;

  -- 1. A case whose stored totals disagree with its lines. This is the check
  --    that would catch a trigger having been disabled, or a direct UPDATE.
  INSERT INTO lms.reconciliation_exception
    (run_id, kind, severity, entity, entity_id, entity_code, province_code,
     expected, actual, difference, detail)
  SELECT v_run, 'case_total_vs_lines', 'error', 'compensation_case', c.id, c.code, c.province_code,
         t.total_amount, c.total_amount, c.total_amount - t.total_amount,
         'stored case total does not match the sum of its lines'
  FROM lms.compensation_case c
  CROSS JOIN LATERAL api.case_totals(c.id) t
  WHERE c.stage_code NOT IN ('Cancelled','Stopped')
    AND c.total_amount <> t.total_amount
    AND (p_scope <> 'case' OR c.id = p_scope_ref)
    AND (p_scope <> 'project' OR c.project_id = p_scope_ref);

  -- 2. Released more against a case than was approved.
  INSERT INTO lms.reconciliation_exception
    (run_id, kind, severity, entity, entity_id, entity_code, province_code,
     expected, actual, difference, detail)
  SELECT v_run, 'over_released', 'error', 'compensation_case', l.case_id, l.case_code, c.province_code,
         l.approved_amount, l.released_amount, l.released_amount - l.approved_amount,
         'released against this case exceeds the approved compensation'
  FROM lms.compensation_case c
  CROSS JOIN LATERAL api.case_liability(c.id) l
  WHERE l.released_amount > l.approved_amount
    AND (p_scope <> 'case' OR c.id = p_scope_ref)
    AND (p_scope <> 'project' OR c.project_id = p_scope_ref);

  -- 3. A voucher marked Released with no release row, or the reverse. Either
  --    direction means the stage label and the ledger have come apart.
  INSERT INTO lms.reconciliation_exception
    (run_id, kind, severity, entity, entity_id, entity_code, province_code, detail)
  SELECT v_run, 'stage_without_release', 'error', 'payment_request', pr.id, pr.code, pr.province_code,
         'voucher stage is Released but there is no release row'
  FROM lms.payment_request pr
  WHERE pr.stage_code = 'Released'
    AND NOT EXISTS (SELECT 1 FROM lms.payment_release r WHERE r.payment_id = pr.id);

  INSERT INTO lms.reconciliation_exception
    (run_id, kind, severity, entity, entity_id, entity_code, province_code, detail)
  SELECT v_run, 'release_without_stage', 'error', 'payment_request', pr.id, pr.code, pr.province_code,
         format('a release exists but the voucher stage is %s', pr.stage_code)
  FROM lms.payment_release r
  JOIN lms.payment_request pr ON pr.id = r.payment_id
  WHERE pr.stage_code <> 'Released';

  -- 4. Released amount not equal to the voucher's net payable.
  INSERT INTO lms.reconciliation_exception
    (run_id, kind, severity, entity, entity_id, entity_code, province_code,
     expected, actual, difference, detail)
  SELECT v_run, 'release_amount_mismatch', 'error', 'payment_release', r.id, pr.code, pr.province_code,
         pr.net_amount, r.released_amount, r.released_amount - pr.net_amount,
         'released amount differs from the voucher net payable'
  FROM lms.payment_release r
  JOIN lms.payment_request pr ON pr.id = r.payment_id
  WHERE r.released_amount <> pr.net_amount;

  -- 5. Ownership shares over 100% on a parcel.
  INSERT INTO lms.reconciliation_exception
    (run_id, kind, severity, entity, entity_id, entity_code, province_code,
     expected, actual, difference, detail)
  SELECT v_run, 'ownership_over_100', 'error', 'survey', s.id, s.code, s.province_code,
         100, tot.share_total, tot.share_total - 100,
         'ownership shares on this parcel exceed 100%'
  FROM lms.survey s
  CROSS JOIN LATERAL (SELECT api.ownership_share_total(s.id) AS share_total) tot
  WHERE tot.share_total > 100;

  -- 6. Committed lease area exceeding the parcel.
  INSERT INTO lms.reconciliation_exception
    (run_id, kind, severity, entity, entity_id, entity_code, province_code,
     expected, actual, difference, detail)
  SELECT v_run, 'area_over_committed', 'error', 'survey', s.id, s.code, s.province_code,
         v.total_area, v.committed_area, v.committed_area - v.total_area,
         v.detail
  FROM lms.survey s
  CROSS JOIN LATERAL api.validate_survey_area(s.id) v
  WHERE NOT v.is_valid;

  -- 7. Budget overspend, as a warning: a sanctioned overrun is a management
  --    decision, not a data error.
  INSERT INTO lms.reconciliation_exception
    (run_id, kind, severity, entity, entity_id, entity_code, province_code,
     expected, actual, difference, detail)
  SELECT v_run, 'budget_exceeded', 'warning', 'budget', b.id, b.code, b.province_code,
         b.approved_amount, b.approved_amount - pos.balance_amount, -pos.balance_amount,
         format('project is over its %s budget by %s', b.fiscal_year, -pos.balance_amount)
  FROM lms.budget b
  CROSS JOIN LATERAL api.budget_status(b.project_id, b.fiscal_year) pos
  WHERE pos.balance_amount < 0;

  SELECT count(*) INTO v_n FROM lms.reconciliation_exception WHERE run_id = v_run;
  UPDATE lms.reconciliation_run
     SET finished_at = clock_timestamp(), exception_count = v_n
   WHERE id = v_run;
  RETURN v_run;
END $function$;

-- Refreshing every materialised view is a maintenance action (IAMDB-15).
CREATE OR REPLACE FUNCTION api.refresh_derived(p_object text DEFAULT NULL::text)
 RETURNS TABLE(object_name text, refreshed boolean, duration_ms integer, detail text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE r record; t0 timestamptz; v_ms integer;
BEGIN
  IF NOT (pg_has_role(session_user, 'lms_owner', 'MEMBER') OR coalesce(iam.has_permission('settings','update'), false)) THEN
    RAISE EXCEPTION 'refreshing derived data needs settings:update' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- CONCURRENTLY cannot run inside a transaction block, so this routine must
  -- be called outside one — with autocommit, or from a maintenance script.
  -- The check is explicit rather than left to a confusing error from REFRESH.
  IF (SELECT count(*) FROM pg_stat_activity
      WHERE pid = pg_backend_pid() AND xact_start IS NOT NULL
        AND xact_start < clock_timestamp() - interval '0 second'
        AND state = 'active') > 0
     AND current_setting('transaction_isolation') IS NOT NULL
     AND NOT pg_catalog.pg_is_in_recovery()
     AND (SELECT txid_current_if_assigned() IS NOT NULL) THEN
    RAISE EXCEPTION 'api.refresh_derived() must be called outside a transaction block'
      USING HINT = 'REFRESH MATERIALIZED VIEW CONCURRENTLY cannot run inside one';
  END IF;

  FOR r IN SELECT d.object_name FROM lms.derived_refresh d
           WHERE p_object IS NULL OR d.object_name = p_object
           ORDER BY d.object_name
  LOOP
    t0 := clock_timestamp();
    BEGIN
      EXECUTE format('REFRESH MATERIALIZED VIEW CONCURRENTLY %s', r.object_name);
      v_ms := (extract(epoch FROM clock_timestamp() - t0) * 1000)::integer;
      UPDATE lms.derived_refresh
         SET is_stale = false, marked_at = NULL,
             refreshed_at = clock_timestamp(), refresh_ms = v_ms
       WHERE lms.derived_refresh.object_name = r.object_name;
      RETURN QUERY SELECT r.object_name, true, v_ms, 'refreshed'::text;
    EXCEPTION WHEN OTHERS THEN
      RETURN QUERY SELECT r.object_name, false,
        (extract(epoch FROM clock_timestamp() - t0) * 1000)::integer, SQLERRM;
    END;
  END LOOP;
END $function$;

-- ---------------------------------------------------------------------
-- 13. Directory provisioning runs in a signed system context
-- ---------------------------------------------------------------------
-- Group mappings (configured by an identity administrator) are applied as
-- the system account; the guards still refuse roles for service or
-- deactivated accounts and the administrator/position conflict.
ALTER FUNCTION iam.provision_external(uuid, text, text, text, boolean, text, text[]) RENAME TO provision_external_core;
REVOKE ALL ON FUNCTION iam.provision_external_core(uuid, text, text, text, boolean, text, text[]) FROM PUBLIC, lms_readwrite;

CREATE FUNCTION iam.provision_external(p_provider uuid, p_subject text, p_issuer text, p_email text,
                                       p_email_verified boolean, p_display text, p_groups text[])
 RETURNS iam.provision_result
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE v_prev text; r iam.provision_result;
BEGIN
  v_prev := iam.enter_system_context();
  r := iam.provision_external_core(p_provider, p_subject, p_issuer, p_email, p_email_verified, p_display, p_groups);
  PERFORM iam.leave_system_context(v_prev);
  RETURN r;
END $function$;

-- ---------------------------------------------------------------------
-- 14. The integration worker: its own routines, no system actor
-- ---------------------------------------------------------------------
-- The worker logs in as lms_worker (created by db/bootstrap/01_roles.sql);
-- owner sessions may run it for maintenance. Nothing else can claim or
-- settle outbox items.
CREATE FUNCTION iam.worker_session()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT session_user::text = 'lms_worker' OR pg_catalog.pg_has_role(session_user, 'lms_owner', 'MEMBER')
$function$;

CREATE FUNCTION api.outbox_next(p_endpoint text)
 RETURNS SETOF lms.integration_outbox
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  IF NOT iam.worker_session() THEN
    RAISE EXCEPTION 'only the integration worker may process the outbox' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM lms.integration_endpoint WHERE code = p_endpoint AND is_enabled) THEN
    RETURN;   -- endpoint switched off by an administrator: nothing to send
  END IF;
  RETURN QUERY
    SELECT o.* FROM lms.integration_outbox o
    WHERE o.endpoint_code = p_endpoint AND o.status = 'pending'
      AND (o.next_attempt_at IS NULL OR o.next_attempt_at <= now())
    ORDER BY o.id
    LIMIT 1
    FOR UPDATE SKIP LOCKED;
END $function$;

CREATE FUNCTION api.outbox_mark_sent(p_id bigint, p_external_ref text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE v_prev text;
BEGIN
  IF NOT iam.worker_session() THEN
    RAISE EXCEPTION 'only the integration worker may process the outbox' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_external_ref IS NULL OR length(btrim(p_external_ref)) = 0 OR length(p_external_ref) > 200 THEN
    RAISE EXCEPTION 'the receiving system''s reference is required (1 to 200 characters)' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_prev := iam.enter_system_context();
  UPDATE lms.integration_outbox
     SET status = 'sent', sent_at = now(), attempts = attempts + 1, external_ref = p_external_ref, last_error = NULL
   WHERE id = p_id AND status = 'pending';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'outbox item % is not pending', p_id USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  PERFORM iam.leave_system_context(v_prev);
END $function$;

CREATE FUNCTION api.outbox_mark_failed(p_id bigint, p_error text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE v_prev text;
BEGIN
  IF NOT iam.worker_session() THEN
    RAISE EXCEPTION 'only the integration worker may process the outbox' USING ERRCODE = 'insufficient_privilege';
  END IF;
  v_prev := iam.enter_system_context();
  -- Back off 5, 10, … up to 60 minutes; after 10 attempts it needs a person.
  UPDATE lms.integration_outbox
     SET attempts = attempts + 1,
         last_error = left(coalesce(p_error, 'unknown error'), 1000),
         next_attempt_at = now() + make_interval(mins => least(60, 5 * (attempts + 1))),
         status = CASE WHEN attempts + 1 >= 10 THEN 'failed' ELSE status END
   WHERE id = p_id AND status = 'pending';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'outbox item % is not pending', p_id USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  PERFORM iam.leave_system_context(v_prev);
END $function$;

-- ---------------------------------------------------------------------
-- 15. Privileges
-- ---------------------------------------------------------------------
-- Internal helpers: owner only.
REVOKE ALL ON FUNCTION iam.context_proof(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION iam.enter_system_context() FROM PUBLIC;
REVOKE ALL ON FUNCTION iam.leave_system_context(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION iam.tier_rank(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION iam.is_approval_position(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION iam.holds_system_admin(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION iam.tg_position_sod() FROM PUBLIC;
REVOKE ALL ON FUNCTION lms.tg_app_user_protect() FROM PUBLIC;
REVOKE ALL ON FUNCTION lms.tg_membership_protect() FROM PUBLIC;
REVOKE ALL ON FUNCTION iam.worker_session() FROM PUBLIC;

-- Called by the application.
REVOKE ALL ON FUNCTION iam.has_permission_in(text, text, text, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION iam.require_in(text, text, text, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION iam.mfa_required_for(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION iam.challenge_issue(bytea, text, uuid, jsonb, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION iam.challenge_find(bytea, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION iam.challenge_fail(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION iam.challenge_consume(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION iam.challenge_take(bytea, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION iam.provision_external(uuid, text, text, text, boolean, text, text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.outbox_next(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.outbox_mark_sent(bigint, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.outbox_mark_failed(bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION iam.has_permission_in(text, text, text, uuid, uuid) TO lms_readwrite;
GRANT EXECUTE ON FUNCTION iam.require_in(text, text, text, uuid, uuid) TO lms_readwrite;
GRANT EXECUTE ON FUNCTION iam.mfa_required_for(uuid) TO lms_readwrite;
GRANT EXECUTE ON FUNCTION iam.challenge_issue(bytea, text, uuid, jsonb, integer) TO lms_readwrite;
GRANT EXECUTE ON FUNCTION iam.challenge_find(bytea, text) TO lms_readwrite;
GRANT EXECUTE ON FUNCTION iam.challenge_fail(uuid) TO lms_readwrite;
GRANT EXECUTE ON FUNCTION iam.challenge_consume(uuid) TO lms_readwrite;
GRANT EXECUTE ON FUNCTION iam.challenge_take(bytea, text) TO lms_readwrite;
GRANT EXECUTE ON FUNCTION iam.provision_external(uuid, text, text, text, boolean, text, text[]) TO lms_readwrite;
-- The provider table's CHECK (no secrets in config) runs as the inserting
-- role; without this, identity administration could not save a provider.
GRANT EXECUTE ON FUNCTION iam.metadata_is_safe(jsonb) TO lms_readwrite;
-- The worker routines check the session themselves (iam.worker_session).
GRANT EXECUTE ON FUNCTION api.outbox_next(text) TO lms_readwrite;
GRANT EXECUTE ON FUNCTION api.outbox_mark_sent(bigint, text) TO lms_readwrite;
GRANT EXECUTE ON FUNCTION api.outbox_mark_failed(bigint, text) TO lms_readwrite;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lms_worker') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION api.outbox_next(text), api.outbox_mark_sent(bigint, text), api.outbox_mark_failed(bigint, text) TO lms_worker';
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 16. Report anything already in breach of the new rules (no data change)
-- ---------------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT u.username, string_agg(g.group_code, ', ') AS positions
    FROM lms.app_user u
    JOIN lms.app_user_group g ON g.user_id = u.id
    WHERE iam.holds_system_admin(u.id) AND iam.is_approval_position(g.group_code)
    GROUP BY u.username
  LOOP
    RAISE NOTICE 'separation of duties: system administrator % also holds approval positions: %', r.username, r.positions;
  END LOOP;
  FOR r IN
    SELECT u.username, ro.code FROM iam.user_role ur
    JOIN lms.app_user u ON u.id = ur.user_id JOIN iam.role ro ON ro.id = ur.role_id
    WHERE ur.revoked_at IS NULL AND u.is_service_account
  LOOP
    RAISE NOTICE 'service account % holds role % (revoke it)', r.username, r.code;
  END LOOP;
END $$;

RESET ROLE;
