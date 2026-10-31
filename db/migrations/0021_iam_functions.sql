-- =====================================================================
-- 0021  IAM routines and triggers
-- =====================================================================
-- Every routine pins search_path and schema-qualifies its references (the
-- convention enforced by test_10). SECURITY DEFINER is used only where the
-- caller has no actor yet (login, session resolution, token redemption) or must
-- write a table it holds no privilege on; each such routine says so and checks
-- authorisation itself, because definer rights bypass row-level security.
SET ROLE lms_owner;

CREATE FUNCTION iam.setting_num(p_key text, p_default numeric) RETURNS numeric
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$ SELECT coalesce((SELECT (value #>> '{}')::numeric FROM lms.system_setting WHERE key = p_key), p_default) $$;

CREATE FUNCTION iam.setting_txt(p_key text, p_default text) RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$ SELECT coalesce((SELECT value #>> '{}' FROM lms.system_setting WHERE key = p_key), p_default) $$;

CREATE FUNCTION iam.permission_rank(p_scope text) RETURNS integer
  LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp
AS $$ SELECT CASE p_scope WHEN 'global' THEN 5 WHEN 'head_office' THEN 4 WHEN 'province' THEN 3
                          WHEN 'project' THEN 2 WHEN 'assigned' THEN 1 ELSE 0 END $$;

CREATE FUNCTION iam.is_system_actor() RETURNS boolean
  LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp
AS $$ SELECT util.actor_id() = '00000000-0000-0000-0000-000000000001'::uuid $$;

-- ---------------------------------------------------------------------
-- Permission resolution. Reads the actor from the transaction-local context,
-- so a caller cannot ask about anyone else. Role removal, expiry, suspension
-- and deactivation all take effect on the very next statement: there is no
-- cache anywhere between the grant and the check.
-- ---------------------------------------------------------------------
CREATE FUNCTION iam.has_permission(p_resource text, p_action text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM lms.app_user u
    JOIN iam.user_role ur ON ur.user_id = u.id AND ur.revoked_at IS NULL
                         AND (ur.expires_at IS NULL OR ur.expires_at > now())
    JOIN iam.role_permission rp ON rp.role_id = ur.role_id
    JOIN iam.permission p ON p.id = rp.permission_id
    WHERE u.id = util.actor_id() AND u.status = 'Active'
      AND p.resource = p_resource AND p.action = p_action);
$$;

CREATE FUNCTION iam.effective_permissions(p_user uuid)
  RETURNS TABLE (resource text, action text, scope_level text, scope_province char(3),
                 scope_project uuid, role_code text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
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
  JOIN iam.role r ON r.id = ur.role_id
  JOIN iam.role_permission rp ON rp.role_id = r.id
  JOIN iam.permission p ON p.id = rp.permission_id
  WHERE u.id = p_user AND u.status = 'Active'
  ORDER BY p.resource, p.action;
END $$;

-- Can the actor hand this role to someone? Only if the actor already holds
-- every permission in it at an equal or wider scope: nobody can delegate
-- authority they do not have.
CREATE FUNCTION iam.actor_covers_role(p_role uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  SELECT iam.is_system_actor() OR NOT EXISTS (
    SELECT 1 FROM iam.role_permission need
    WHERE need.role_id = p_role
      AND NOT EXISTS (
        SELECT 1 FROM iam.user_role ur
        JOIN iam.role_permission have ON have.role_id = ur.role_id
        WHERE ur.user_id = util.actor_id() AND ur.revoked_at IS NULL
          AND (ur.expires_at IS NULL OR ur.expires_at > now())
          AND have.permission_id = need.permission_id
          AND iam.permission_rank(have.scope_level) >= iam.permission_rank(need.scope_level)));
$$;

CREATE FUNCTION iam.sod_conflicts(p_user uuid) RETURNS SETOF text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  WITH held AS (
    SELECT DISTINCT rp.permission_id
    FROM iam.user_role ur JOIN iam.role_permission rp ON rp.role_id = ur.role_id
    WHERE ur.user_id = p_user AND ur.revoked_at IS NULL
      AND (ur.expires_at IS NULL OR ur.expires_at > now()))
  SELECT pa.resource||':'||pa.action||' with '||pb.resource||':'||pb.action||' — '||s.reason
  FROM iam.sod_rule s
  JOIN held ha ON ha.permission_id = s.perm_a
  JOIN held hb ON hb.permission_id = s.perm_b
  JOIN iam.permission pa ON pa.id = s.perm_a
  JOIN iam.permission pb ON pb.id = s.perm_b;
$$;

CREATE FUNCTION iam.sync_db_role(p_user uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_role text;
BEGIN
  SELECT ar.code INTO v_role
  FROM iam.user_role ur
  JOIN iam.role r ON r.id = ur.role_id
  JOIN lms.app_role ar ON ar.code = r.db_role_code
  WHERE ur.user_id = p_user AND ur.revoked_at IS NULL
    AND (ur.expires_at IS NULL OR ur.expires_at > now())
  ORDER BY ar.rank DESC LIMIT 1;
  -- Holding no role leaves the account at the least-privileged database tier.
  UPDATE lms.app_user SET role_code = coalesce(v_role, 'Viewer')
   WHERE id = p_user AND role_code IS DISTINCT FROM coalesce(v_role, 'Viewer');
END $$;

-- ---------------------------------------------------------------------
-- Triggers: role assignment
-- ---------------------------------------------------------------------
CREATE FUNCTION iam.tg_user_role_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_actor uuid := util.actor_id(); v_n integer; v_role_code text;
BEGIN
  IF TG_OP = 'INSERT' THEN
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
    IF v_role_code = 'system-administrator' THEN
      SELECT count(*) INTO v_n
      FROM iam.user_role ur
      JOIN lms.app_user u ON u.id = ur.user_id
      WHERE ur.role_id = OLD.role_id AND ur.revoked_at IS NULL AND ur.id <> OLD.id
        AND u.status = 'Active'
        AND (u.password_hash IS NOT NULL
             OR EXISTS (SELECT 1 FROM iam.external_identity e
                        WHERE e.user_id = u.id AND e.unlinked_at IS NULL));
      IF v_n = 0 THEN
        RAISE EXCEPTION 'this is the last active system administrator; assign another first'
          USING ERRCODE = 'raise_exception';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER user_role_guard BEFORE INSERT OR UPDATE ON iam.user_role
  FOR EACH ROW EXECUTE FUNCTION iam.tg_user_role_guard();

CREATE FUNCTION iam.tg_user_role_after() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_conflict text;
BEGIN
  PERFORM iam.sync_db_role(NEW.user_id);
  IF NEW.revoked_at IS NULL THEN
    SELECT c INTO v_conflict FROM iam.sod_conflicts(NEW.user_id) c LIMIT 1;
    IF v_conflict IS NOT NULL THEN
      RAISE EXCEPTION 'separation of duties: % ', v_conflict USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER user_role_after AFTER INSERT OR UPDATE ON iam.user_role
  FOR EACH ROW EXECUTE FUNCTION iam.tg_user_role_after();

-- System roles are fixed by migration; custom roles cannot hold the sensitive
-- permissions that control identity itself unless the actor already holds them
-- (checked by actor_covers_role on assignment) — and cannot be deleted in use.
CREATE FUNCTION iam.tg_role_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF iam.is_system_actor() THEN RETURN coalesce(NEW, OLD); END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.is_system THEN RAISE EXCEPTION 'system roles are created by migration only' USING ERRCODE='insufficient_privilege'; END IF;
    IF NEW.db_role_code = 'Admin' THEN
      RAISE EXCEPTION 'a custom role cannot map to the Admin database tier' USING ERRCODE='insufficient_privilege';
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
  IF NEW.db_role_code = 'Admin' AND OLD.db_role_code <> 'Admin' THEN
    RAISE EXCEPTION 'a custom role cannot map to the Admin database tier' USING ERRCODE='insufficient_privilege';
  END IF;
  NEW.version := OLD.version + 1; NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER role_guard BEFORE INSERT OR UPDATE OR DELETE ON iam.role
  FOR EACH ROW EXECUTE FUNCTION iam.tg_role_guard();

CREATE FUNCTION iam.tg_role_permission_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_role uuid := coalesce(NEW.role_id, OLD.role_id); v_sys boolean; v_c text;
BEGIN
  IF iam.is_system_actor() THEN RETURN coalesce(NEW, OLD); END IF;
  SELECT is_system INTO v_sys FROM iam.role WHERE id = v_role;
  IF v_sys THEN
    RAISE EXCEPTION 'permissions of a system role are fixed' USING ERRCODE='insufficient_privilege';
  END IF;
  IF TG_OP <> 'DELETE' THEN
    -- You cannot put a permission into a role that you do not yourself hold.
    IF NOT EXISTS (
        SELECT 1 FROM iam.user_role ur JOIN iam.role_permission have ON have.role_id = ur.role_id
        WHERE ur.user_id = util.actor_id() AND ur.revoked_at IS NULL
          AND have.permission_id = NEW.permission_id
          AND iam.permission_rank(have.scope_level) >= iam.permission_rank(NEW.scope_level)) THEN
      RAISE EXCEPTION 'you cannot grant a permission you do not hold' USING ERRCODE='insufficient_privilege';
    END IF;
    -- Separation of duties inside the role itself.
    SELECT pa.resource||':'||pa.action||' with '||pb.resource||':'||pb.action INTO v_c
    FROM iam.sod_rule s
    JOIN iam.role_permission ra ON ra.role_id = v_role AND ra.permission_id = s.perm_a
    JOIN iam.role_permission rb ON rb.role_id = v_role AND rb.permission_id = s.perm_b
    JOIN iam.permission pa ON pa.id = s.perm_a JOIN iam.permission pb ON pb.id = s.perm_b
    WHERE s.perm_a = NEW.permission_id OR s.perm_b = NEW.permission_id LIMIT 1;
  END IF;
  RETURN coalesce(NEW, OLD);
END $$;
CREATE TRIGGER role_permission_guard BEFORE INSERT OR UPDATE OR DELETE ON iam.role_permission
  FOR EACH ROW EXECUTE FUNCTION iam.tg_role_permission_guard();
-- Also check after the fact, once the pair is both present.
CREATE FUNCTION iam.tg_role_permission_sod() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
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
  RETURN NULL;
END $$;
CREATE TRIGGER role_permission_sod AFTER INSERT OR UPDATE ON iam.role_permission
  FOR EACH ROW EXECUTE FUNCTION iam.tg_role_permission_sod();

-- Directory-group mapping must not become a route to privilege.
CREATE FUNCTION iam.tg_group_mapping_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.role_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM iam.role_permission rp JOIN iam.permission p ON p.id = rp.permission_id
      WHERE rp.role_id = NEW.role_id AND (p.is_sensitive OR p.resource IN ('users','roles','identity_settings'))) THEN
    RAISE EXCEPTION 'a directory group cannot be mapped to a privileged role; assign it by hand'
      USING ERRCODE='insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER group_mapping_guard BEFORE INSERT OR UPDATE ON iam.group_mapping
  FOR EACH ROW EXECUTE FUNCTION iam.tg_group_mapping_guard();

-- ---------------------------------------------------------------------
-- Provider configuration: any change to what is tested invalidates the test,
-- and an untested provider is disabled. Revisions are written for every change.
-- ---------------------------------------------------------------------
CREATE FUNCTION iam.tg_provider_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.enabled := false; NEW.last_test_ok := NULL; NEW.last_tested_at := NULL;
    RETURN NEW;
  END IF;
  IF NEW.config IS DISTINCT FROM OLD.config OR NEW.secret_id IS DISTINCT FROM OLD.secret_id
     OR NEW.kind IS DISTINCT FROM OLD.kind THEN
    NEW.last_test_ok := NULL; NEW.last_tested_at := NULL;
    NEW.last_test_detail := 'configuration changed; test again before enabling';
    NEW.last_test_by := NULL;
    NEW.enabled := false;
  END IF;
  NEW.version := OLD.version + 1; NEW.updated_at := now();
  NEW.updated_by := coalesce(util.actor_id(), NEW.updated_by);
  RETURN NEW;
END $$;
CREATE TRIGGER provider_guard BEFORE INSERT OR UPDATE ON iam.auth_provider
  FOR EACH ROW EXECUTE FUNCTION iam.tg_provider_guard();

CREATE FUNCTION iam.tg_provider_revision() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_sum text; v_secver integer;
BEGIN
  SELECT version INTO v_secver FROM iam.secret WHERE id = NEW.secret_id;
  v_sum := CASE WHEN TG_OP = 'INSERT' THEN 'created'
    ELSE concat_ws('; ',
      CASE WHEN NEW.config IS DISTINCT FROM OLD.config THEN 'settings changed' END,
      CASE WHEN NEW.secret_id IS DISTINCT FROM OLD.secret_id THEN 'secret replaced' END,
      CASE WHEN NEW.enabled IS DISTINCT FROM OLD.enabled
           THEN CASE WHEN NEW.enabled THEN 'enabled' ELSE 'disabled' END END,
      CASE WHEN NEW.last_test_ok IS DISTINCT FROM OLD.last_test_ok
           THEN 'tested: '||coalesce(NEW.last_test_ok::text,'cleared') END) END;
  IF v_sum = '' THEN RETURN NULL; END IF;
  INSERT INTO iam.auth_provider_revision(provider_id, version, config, enabled, secret_version, summary, changed_by)
  VALUES (NEW.id, NEW.version, NEW.config, NEW.enabled, v_secver, v_sum, util.actor_id());
  RETURN NULL;
END $$;
CREATE TRIGGER provider_revision AFTER INSERT OR UPDATE ON iam.auth_provider
  FOR EACH ROW EXECUTE FUNCTION iam.tg_provider_revision();

-- ---------------------------------------------------------------------
-- Account lifecycle triggers
-- ---------------------------------------------------------------------
CREATE FUNCTION iam.tg_app_user_after_insert() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  INSERT INTO iam.account_security(user_id, password_changed_at) VALUES (NEW.id, CASE WHEN NEW.password_hash IS NOT NULL THEN now() END)
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END $$;
CREATE TRIGGER app_user_account_security AFTER INSERT ON lms.app_user
  FOR EACH ROW EXECUTE FUNCTION iam.tg_app_user_after_insert();

-- Suspension and deactivation end every session in the same transaction as
-- the status change: the revocation window for those is zero.
CREATE FUNCTION iam.tg_app_user_deactivate() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_n integer;
BEGIN
  IF NEW.status <> 'Active' AND OLD.status = 'Active' THEN
    IF EXISTS (SELECT 1 FROM iam.user_role ur JOIN iam.role r ON r.id = ur.role_id
               WHERE ur.user_id = OLD.id AND ur.revoked_at IS NULL AND r.code = 'system-administrator') THEN
      SELECT count(*) INTO v_n FROM iam.user_role ur JOIN iam.role r ON r.id = ur.role_id
        JOIN lms.app_user u ON u.id = ur.user_id
       WHERE r.code = 'system-administrator' AND ur.revoked_at IS NULL AND u.status = 'Active'
         AND u.id <> OLD.id
         AND (u.password_hash IS NOT NULL OR EXISTS (SELECT 1 FROM iam.external_identity e WHERE e.user_id = u.id AND e.unlinked_at IS NULL));
      IF v_n = 0 THEN
        RAISE EXCEPTION 'this is the last active system administrator; assign another first'
          USING ERRCODE = 'raise_exception';
      END IF;
    END IF;
    UPDATE lms.login_session SET ended_at = now(), end_reason = 'revoked'
     WHERE user_id = OLD.id AND ended_at IS NULL;
    DELETE FROM iam.challenge WHERE user_id = OLD.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER app_user_deactivate BEFORE UPDATE OF status ON lms.app_user
  FOR EACH ROW EXECUTE FUNCTION iam.tg_app_user_deactivate();

-- ---------------------------------------------------------------------
-- PRE-AUTHENTICATION routines (no actor exists yet)
-- ---------------------------------------------------------------------
CREATE FUNCTION iam.authn_lookup(p_username text)
  RETURNS TABLE (user_id uuid, username text, full_name text, status text, password_hash text,
                 failed_count integer, locked_until timestamptz, must_change_password boolean,
                 is_break_glass boolean, mfa_enrolled boolean, is_service_account boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  SELECT u.id, u.username::text, u.full_name, u.status, u.password_hash,
         a.failed_count, a.locked_until, a.must_change_password, a.is_break_glass,
         (EXISTS (SELECT 1 FROM iam.mfa_totp t WHERE t.user_id = u.id AND t.confirmed_at IS NOT NULL)
          OR EXISTS (SELECT 1 FROM iam.mfa_webauthn w WHERE w.user_id = u.id)),
         u.is_service_account
  FROM lms.app_user u LEFT JOIN iam.account_security a ON a.user_id = u.id
  WHERE u.username = p_username::ext.citext;
$$;

CREATE FUNCTION iam.log_event(
    p_event_type text, p_outcome text, p_user uuid, p_username text, p_actor uuid, p_target uuid,
    p_provider uuid, p_ip inet, p_ua text, p_session uuid, p_correlation uuid, p_metadata jsonb)
  RETURNS bigint
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_id bigint;
BEGIN
  INSERT INTO audit.auth_event(event_type, outcome, user_id, username_tried, actor_user_id, target_user_id,
                               provider_id, source_ip, user_agent, session_id, correlation_id, metadata)
  VALUES (p_event_type, p_outcome, p_user, left(p_username,64)::ext.citext, p_actor, p_target, p_provider,
          p_ip, left(p_ua,300), p_session, p_correlation, coalesce(p_metadata,'{}'::jsonb))
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- Failures in a window, by account and by source address. Both are needed:
-- per-account throttling stops a guessing run against one user, per-address
-- throttling stops credential stuffing across many.
CREATE FUNCTION iam.failure_counts(p_username text, p_ip inet, p_window_minutes integer)
  RETURNS TABLE (by_user bigint, by_ip bigint)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  SELECT count(*) FILTER (WHERE username_tried = p_username::ext.citext),
         count(*) FILTER (WHERE source_ip = p_ip)
  FROM audit.auth_event
  WHERE occurred_at > now() - make_interval(mins => p_window_minutes)
    AND event_type = 'login' AND outcome <> 'success';
$$;

CREATE FUNCTION iam.note_auth_failure(p_user uuid) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_max integer := iam.setting_num('security.max_failed_logins', 5)::integer;
        v_mins integer := iam.setting_num('iam.lockout_minutes', 15)::integer; v_locked boolean;
BEGIN
  UPDATE iam.account_security
     SET failed_count = failed_count + 1, last_failure_at = now(),
         locked_until = CASE WHEN failed_count + 1 >= v_max THEN now() + make_interval(mins => v_mins) ELSE locked_until END
   WHERE user_id = p_user
  RETURNING (locked_until IS NOT NULL AND locked_until > now()) INTO v_locked;
  RETURN coalesce(v_locked, false);
END $$;

CREATE FUNCTION iam.note_auth_success(p_user uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  UPDATE iam.account_security SET failed_count = 0, locked_until = NULL WHERE user_id = p_user;
  UPDATE lms.app_user SET last_login_at = now() WHERE id = p_user;
END $$;

-- ---------------------------------------------------------------------
-- Sessions
-- ---------------------------------------------------------------------
CREATE FUNCTION iam.create_session(
    p_user uuid, p_token_sha256 bytea, p_method text, p_provider uuid, p_ip inet, p_ua text,
    p_mfa_method text) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_id uuid; v_idle integer := iam.setting_num('security.session_minutes', 60)::integer;
        v_abs integer := iam.setting_num('iam.session_absolute_hours', 12)::integer; v_status text;
BEGIN
  SELECT status INTO v_status FROM lms.app_user WHERE id = p_user;
  IF v_status IS DISTINCT FROM 'Active' THEN
    RAISE EXCEPTION 'account is not active' USING ERRCODE = 'invalid_authorization_specification';
  END IF;
  INSERT INTO lms.login_session(user_id, expires_at, absolute_expires_at, source_ip, user_agent,
                                token_sha256, auth_method, provider_id, mfa_satisfied_at, mfa_method)
  VALUES (p_user, now() + make_interval(mins => v_idle), now() + make_interval(hours => v_abs),
          p_ip, left(p_ua,300), p_token_sha256, p_method, p_provider,
          CASE WHEN p_mfa_method IS NOT NULL THEN now() END, p_mfa_method)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE FUNCTION iam.resolve_session(p_token_sha256 bytea)
  RETURNS TABLE (session_id uuid, user_id uuid, username text, full_name text, role_code text,
                 auth_method text, mfa_satisfied_at timestamptz, mfa_method text, reauth_at timestamptz,
                 started_at timestamptz, expires_at timestamptz, must_change_password boolean,
                 mfa_enrolled boolean, email text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE s record; v_idle integer := iam.setting_num('security.session_minutes', 60)::integer;
BEGIN
  SELECT ls.* INTO s FROM lms.login_session ls WHERE ls.token_sha256 = p_token_sha256 AND ls.ended_at IS NULL;
  IF NOT FOUND THEN RETURN; END IF;
  IF now() > s.expires_at OR now() > s.absolute_expires_at THEN
    UPDATE lms.login_session SET ended_at = now(), end_reason = 'expired' WHERE id = s.id;
    RETURN;
  END IF;
  IF s.last_seen_at < now() - interval '30 seconds' THEN
    UPDATE lms.login_session
       SET last_seen_at = now(), expires_at = least(now() + make_interval(mins => v_idle), s.absolute_expires_at)
     WHERE id = s.id;
  END IF;
  RETURN QUERY
  SELECT s.id, u.id, u.username::text, u.full_name, u.role_code, s.auth_method, s.mfa_satisfied_at,
         s.mfa_method, s.reauth_at, s.started_at, s.expires_at, a.must_change_password,
         (EXISTS (SELECT 1 FROM iam.mfa_totp t WHERE t.user_id = u.id AND t.confirmed_at IS NOT NULL)
          OR EXISTS (SELECT 1 FROM iam.mfa_webauthn w WHERE w.user_id = u.id)),
         u.email::text
  FROM lms.app_user u LEFT JOIN iam.account_security a ON a.user_id = u.id
  WHERE u.id = s.user_id AND u.status = 'Active';
END $$;

CREATE FUNCTION iam.end_session(p_session uuid, p_reason text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  -- A session may be ended by its owner, or by someone who may revoke sessions.
  IF NOT iam.has_permission('sessions','revoke') AND NOT EXISTS (
      SELECT 1 FROM lms.login_session WHERE id = p_session AND user_id = util.actor_id()) THEN
    RAISE EXCEPTION 'not permitted to end this session' USING ERRCODE='insufficient_privilege';
  END IF;
  UPDATE lms.login_session SET ended_at = now(), end_reason = p_reason
   WHERE id = p_session AND ended_at IS NULL;
END $$;

CREATE FUNCTION iam.end_session_unauthenticated(p_token_sha256 bytea) RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$ UPDATE lms.login_session SET ended_at = now(), end_reason = 'logout'
       WHERE token_sha256 = p_token_sha256 AND ended_at IS NULL $$;

CREATE FUNCTION iam.revoke_user_sessions(p_user uuid, p_except uuid DEFAULT NULL) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE n integer;
BEGIN
  IF p_user IS DISTINCT FROM util.actor_id() AND NOT iam.has_permission('users','revoke_sessions') THEN
    RAISE EXCEPTION 'not permitted to revoke this account''s sessions' USING ERRCODE='insufficient_privilege';
  END IF;
  UPDATE lms.login_session SET ended_at = now(), end_reason = 'revoked'
   WHERE user_id = p_user AND ended_at IS NULL AND id IS DISTINCT FROM p_except;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

CREATE FUNCTION iam.mark_session_mfa(p_session uuid, p_method text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  UPDATE lms.login_session SET mfa_satisfied_at = now(), mfa_method = p_method, reauth_at = now()
   WHERE id = p_session AND user_id = util.actor_id() AND ended_at IS NULL;
END $$;

CREATE FUNCTION iam.mark_session_reauth(p_session uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  UPDATE lms.login_session SET reauth_at = now()
   WHERE id = p_session AND user_id = util.actor_id() AND ended_at IS NULL;
END $$;
