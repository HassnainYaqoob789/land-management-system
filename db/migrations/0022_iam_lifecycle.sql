-- =====================================================================
-- 0022  IAM: user lifecycle, tokens, passwords, provisioning, policy
-- =====================================================================
SET ROLE lms_owner;

CREATE FUNCTION iam.require(p_resource text, p_action text) RETURNS void
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF util.actor_id() IS NULL THEN
    RAISE EXCEPTION 'no actor set' USING ERRCODE = 'invalid_authorization_specification';
  END IF;
  IF NOT iam.has_permission(p_resource, p_action) THEN
    RAISE EXCEPTION 'permission denied: %:%', p_resource, p_action USING ERRCODE = 'insufficient_privilege';
  END IF;
END $$;

-- Same defence in the database for the operations that matter most, so the
-- API layer is not the only thing standing between a request and the ledger.
CREATE FUNCTION iam.tg_require_release() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM iam.require('payments','release');
  RETURN NEW;
END $$;
CREATE TRIGGER payment_release_requires_permission BEFORE INSERT ON lms.payment_release
  FOR EACH ROW EXECUTE FUNCTION iam.tg_require_release();

-- ---------------------------------------------------------------------
-- Users
-- ---------------------------------------------------------------------
CREATE FUNCTION iam.create_user(
    p_username text, p_full_name text, p_email text, p_department text, p_position text,
    p_office text, p_provinces text[], p_groups text[], p_role_codes text[]) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_id uuid; v_actor uuid := util.actor_id(); r text; g text; p text; v_role uuid;
BEGIN
  PERFORM iam.require('users','create');
  -- Province access cannot be wider than the creator's own (an administrator
  -- holds all four through the Admin tier).
  IF (SELECT role_code FROM lms.app_user WHERE id = v_actor) <> 'Admin' THEN
    FOREACH p IN ARRAY coalesce(p_provinces,'{}') LOOP
      IF NOT EXISTS (SELECT 1 FROM lms.app_user_province WHERE user_id = v_actor AND province_code = p) THEN
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
  FOREACH p IN ARRAY coalesce(p_provinces,'{}') LOOP
    INSERT INTO lms.app_user_province(user_id, province_code) VALUES (v_id, p);
  END LOOP;
  FOREACH g IN ARRAY coalesce(p_groups,'{}') LOOP
    INSERT INTO lms.app_user_group(user_id, group_code) VALUES (v_id, g);
  END LOOP;
  FOREACH r IN ARRAY coalesce(p_role_codes,'{}') LOOP
    SELECT id INTO v_role FROM iam.role WHERE code = r;
    IF v_role IS NULL THEN RAISE EXCEPTION 'unknown role %', r USING ERRCODE='invalid_parameter_value'; END IF;
    INSERT INTO iam.user_role(user_id, role_id) VALUES (v_id, v_role);
  END LOOP;
  PERFORM iam.log_event('user_created','success', v_id, p_username, v_actor, v_id, NULL, NULL, NULL, NULL, NULL,
                        jsonb_build_object('roles', to_jsonb(coalesce(p_role_codes,'{}'))));
  RETURN v_id;
END $$;

CREATE FUNCTION iam.update_user(
    p_user uuid, p_full_name text, p_email text, p_department text, p_position text,
    p_office text, p_provinces text[], p_groups text[]) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_actor uuid := util.actor_id(); p text; g text;
BEGIN
  PERFORM iam.require('users','update');
  IF (SELECT role_code FROM lms.app_user WHERE id = v_actor) <> 'Admin' AND p_provinces IS NOT NULL THEN
    FOREACH p IN ARRAY p_provinces LOOP
      IF NOT EXISTS (SELECT 1 FROM lms.app_user_province WHERE user_id = v_actor AND province_code = p) THEN
        RAISE EXCEPTION 'you cannot grant access to province % which you do not hold', p USING ERRCODE='insufficient_privilege';
      END IF;
    END LOOP;
  END IF;
  UPDATE lms.app_user SET full_name = coalesce(nullif(btrim(p_full_name),''), full_name),
         email = CASE WHEN p_email IS NULL THEN email ELSE nullif(btrim(p_email),'') END,
         department = coalesce(p_department, department), position = coalesce(p_position, position),
         office_code = CASE WHEN p_office IS NULL THEN office_code ELSE nullif(p_office,'') END
   WHERE id = p_user;
  IF p_provinces IS NOT NULL THEN
    DELETE FROM lms.app_user_province WHERE user_id = p_user;
    FOREACH p IN ARRAY p_provinces LOOP INSERT INTO lms.app_user_province(user_id, province_code) VALUES (p_user, p); END LOOP;
  END IF;
  IF p_groups IS NOT NULL THEN
    DELETE FROM lms.app_user_group WHERE user_id = p_user;
    FOREACH g IN ARRAY p_groups LOOP INSERT INTO lms.app_user_group(user_id, group_code) VALUES (p_user, g); END LOOP;
  END IF;
  PERFORM iam.log_event('user_updated','success', p_user, NULL, v_actor, p_user, NULL, NULL, NULL, NULL, NULL, '{}');
END $$;

CREATE FUNCTION iam.set_user_status(p_user uuid, p_status text, p_reason text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_actor uuid := util.actor_id(); v_n integer;
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
  UPDATE lms.app_user SET status = p_status WHERE id = p_user;
  UPDATE iam.account_security SET deactivated_at = CASE WHEN p_status = 'Deactivated' THEN now() END WHERE user_id = p_user;
  PERFORM iam.log_event('user_status','success', p_user, NULL, v_actor, p_user, NULL, NULL, NULL, NULL, NULL,
                        jsonb_build_object('status', p_status, 'reason', left(p_reason,200)));
END $$;

CREATE FUNCTION iam.anonymise_user(p_user uuid, p_reason text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_actor uuid := util.actor_id();
BEGIN
  PERFORM iam.require('users','delete');
  IF p_user = v_actor THEN RAISE EXCEPTION 'you cannot anonymise yourself' USING ERRCODE='insufficient_privilege'; END IF;
  IF length(btrim(coalesce(p_reason,''))) < 10 THEN
    RAISE EXCEPTION 'a justification of at least 10 characters is required' USING ERRCODE='invalid_parameter_value';
  END IF;
  -- Roles first, so the last-administrator guard runs.
  UPDATE iam.user_role SET revoked_at = now(), revoked_by = v_actor, reason = 'account anonymised'
   WHERE user_id = p_user AND revoked_at IS NULL;
  UPDATE lms.app_user SET status = 'Deactivated' WHERE id = p_user AND status <> 'Deactivated';
  DELETE FROM iam.mfa_totp WHERE user_id = p_user;
  DELETE FROM iam.mfa_webauthn WHERE user_id = p_user;
  DELETE FROM iam.mfa_recovery_code WHERE user_id = p_user;
  DELETE FROM iam.invitation WHERE user_id = p_user;
  UPDATE iam.external_identity SET unlinked_at = now() WHERE user_id = p_user AND unlinked_at IS NULL;
  DELETE FROM lms.app_user_province WHERE user_id = p_user;
  DELETE FROM lms.app_user_group WHERE user_id = p_user;
  -- The row, its id and every approval and audit entry that points at it stay.
  UPDATE lms.app_user SET username = 'anon-' || substr(replace(p_user::text,'-',''),1,12),
         full_name = 'Anonymised user', email = NULL, password_hash = NULL,
         department = NULL, position = NULL
   WHERE id = p_user;
  UPDATE iam.account_security SET anonymised_at = now() WHERE user_id = p_user;
  PERFORM iam.log_event('user_anonymised','success', p_user, NULL, v_actor, p_user, NULL, NULL, NULL, NULL, NULL,
                        jsonb_build_object('reason', left(p_reason,200)));
END $$;

CREATE FUNCTION iam.reset_mfa(p_user uuid, p_justification text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_actor uuid := util.actor_id();
BEGIN
  PERFORM iam.require('users','reset_mfa');
  IF p_user = v_actor THEN RAISE EXCEPTION 'you cannot reset your own MFA' USING ERRCODE='insufficient_privilege'; END IF;
  IF length(btrim(coalesce(p_justification,''))) < 10 THEN
    RAISE EXCEPTION 'a justification of at least 10 characters is required' USING ERRCODE='invalid_parameter_value';
  END IF;
  DELETE FROM iam.mfa_totp WHERE user_id = p_user;
  DELETE FROM iam.mfa_webauthn WHERE user_id = p_user;
  DELETE FROM iam.mfa_recovery_code WHERE user_id = p_user;
  UPDATE lms.login_session SET ended_at = now(), end_reason = 'revoked' WHERE user_id = p_user AND ended_at IS NULL;
  PERFORM iam.log_event('mfa_reset_by_admin','success', p_user, NULL, v_actor, p_user, NULL, NULL, NULL, NULL, NULL,
                        jsonb_build_object('justification', left(p_justification,200)));
END $$;

-- ---------------------------------------------------------------------
-- Tokens: invitation and recovery. Only the SHA-256 of a token is stored.
-- ---------------------------------------------------------------------
CREATE FUNCTION iam.issue_token(p_user uuid, p_purpose text, p_hash bytea) RETURNS timestamptz
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_exp timestamptz;
BEGIN
  IF p_purpose = 'invitation' THEN
    PERFORM iam.require('users','create');
    v_exp := now() + make_interval(hours => iam.setting_num('iam.invitation_hours', 72)::integer);
  ELSIF p_purpose = 'password_reset' THEN
    PERFORM iam.require('users','update');
    v_exp := now() + make_interval(mins => iam.setting_num('iam.recovery_token_minutes', 30)::integer);
  ELSE
    RAISE EXCEPTION 'unknown purpose' USING ERRCODE='invalid_parameter_value';
  END IF;
  IF EXISTS (SELECT 1 FROM iam.account_security WHERE user_id = p_user AND is_break_glass) THEN
    RAISE EXCEPTION 'emergency-access accounts cannot be recovered by token' USING ERRCODE='insufficient_privilege';
  END IF;
  UPDATE iam.invitation SET used_at = now() WHERE user_id = p_user AND purpose = p_purpose AND used_at IS NULL;
  INSERT INTO iam.invitation(user_id, token_sha256, purpose, created_by, expires_at)
  VALUES (p_user, p_hash, p_purpose, util.actor_id(), v_exp);
  RETURN v_exp;
END $$;

-- Self-service "I forgot my password". Pre-authentication. It returns a row
-- only for an active account that actually has a local password to reset, and
-- the HTTP layer answers identically either way so it cannot be used to
-- discover which usernames exist.
CREATE FUNCTION iam.request_password_reset(p_username text, p_hash bytea)
  RETURNS TABLE (user_id uuid, email text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE u record;
BEGIN
  IF iam.setting_txt('iam.local_login_enabled','true') <> 'true' THEN RETURN; END IF;
  SELECT au.id, au.email::text AS email INTO u
  FROM lms.app_user au JOIN iam.account_security a ON a.user_id = au.id
  WHERE au.username = p_username::ext.citext AND au.status = 'Active'
    AND au.is_service_account = false AND a.is_break_glass = false
    AND au.password_hash IS NOT NULL AND au.email IS NOT NULL;
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE iam.invitation SET used_at = now() WHERE invitation.user_id = u.id AND purpose = 'password_reset' AND used_at IS NULL;
  INSERT INTO iam.invitation(user_id, token_sha256, purpose, created_by, expires_at)
  VALUES (u.id, p_hash, 'password_reset', NULL,
          now() + make_interval(mins => iam.setting_num('iam.recovery_token_minutes', 30)::integer));
  RETURN QUERY SELECT u.id, u.email;
END $$;

CREATE FUNCTION iam.peek_token(p_hash bytea, p_purpose text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$ SELECT user_id FROM iam.invitation
       WHERE token_sha256 = p_hash AND purpose = p_purpose AND used_at IS NULL AND expires_at > now() $$;

CREATE FUNCTION iam.recent_password_hashes(p_user uuid, p_token bytea DEFAULT NULL) RETURNS SETOF text
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE n integer := iam.setting_num('iam.password_history', 5)::integer;
BEGIN
  IF NOT (p_user = util.actor_id()
          OR (p_token IS NOT NULL AND EXISTS (SELECT 1 FROM iam.invitation i WHERE i.token_sha256 = p_token
                AND i.user_id = p_user AND i.used_at IS NULL AND i.expires_at > now()))) THEN
    RAISE EXCEPTION 'not permitted' USING ERRCODE='insufficient_privilege';
  END IF;
  RETURN QUERY SELECT h FROM (
    SELECT hash AS h, set_at FROM iam.password_history WHERE user_id = p_user
    UNION ALL SELECT password_hash, now() FROM lms.app_user WHERE id = p_user AND password_hash IS NOT NULL
    ORDER BY set_at DESC LIMIT n) t;
END $$;

CREATE FUNCTION iam.tg_apply_password(p_user uuid, p_hash text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  INSERT INTO iam.password_history(user_id, hash) VALUES (p_user, p_hash);
  DELETE FROM iam.password_history WHERE user_id = p_user AND id NOT IN (
    SELECT id FROM iam.password_history WHERE user_id = p_user ORDER BY set_at DESC, id DESC LIMIT 20);
  UPDATE lms.app_user SET password_hash = p_hash, password_set_at = now() WHERE id = p_user;
  UPDATE iam.account_security SET password_changed_at = now(), must_change_password = false,
         failed_count = 0, locked_until = NULL WHERE user_id = p_user;
END $$;

CREATE FUNCTION iam.redeem_token(p_hash bytea, p_purpose text, p_new_hash text) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE i record;
BEGIN
  SELECT * INTO i FROM iam.invitation
   WHERE token_sha256 = p_hash AND purpose = p_purpose FOR UPDATE;
  IF NOT FOUND OR i.used_at IS NOT NULL OR i.expires_at <= now() THEN
    RAISE EXCEPTION 'this link is invalid or has expired' USING ERRCODE='invalid_authorization_specification';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM lms.app_user WHERE id = i.user_id AND status = 'Active') THEN
    RAISE EXCEPTION 'this link is invalid or has expired' USING ERRCODE='invalid_authorization_specification';
  END IF;
  UPDATE iam.invitation SET used_at = now() WHERE id = i.id;
  PERFORM iam.tg_apply_password(i.user_id, p_new_hash);
  -- A reset ends every existing session: whoever had the old password is out.
  UPDATE lms.login_session SET ended_at = now(), end_reason = 'revoked' WHERE user_id = i.user_id AND ended_at IS NULL;
  RETURN i.user_id;
END $$;

CREATE FUNCTION iam.change_password(p_new_hash text, p_keep_session uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_u uuid := util.actor_id();
BEGIN
  IF v_u IS NULL THEN RAISE EXCEPTION 'no actor' USING ERRCODE='invalid_authorization_specification'; END IF;
  PERFORM iam.tg_apply_password(v_u, p_new_hash);
  UPDATE lms.login_session SET ended_at = now(), end_reason = 'revoked'
   WHERE user_id = v_u AND ended_at IS NULL AND id IS DISTINCT FROM p_keep_session;
END $$;

CREATE FUNCTION iam.rehash_password(p_user uuid, p_old text, p_new text) RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$ UPDATE lms.app_user SET password_hash = p_new WHERE id = p_user AND password_hash = p_old $$;

-- ---------------------------------------------------------------------
-- Providers
-- ---------------------------------------------------------------------
CREATE FUNCTION iam.record_provider_test(p_provider uuid, p_ok boolean, p_detail text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM iam.require('identity_settings','configure');
  UPDATE iam.auth_provider SET last_tested_at = now(), last_test_ok = p_ok,
         last_test_detail = left(p_detail, 300), last_test_by = util.actor_id()
   WHERE id = p_provider;
  PERFORM iam.log_event('provider_test', CASE WHEN p_ok THEN 'success' ELSE 'failure' END, NULL, NULL,
                        util.actor_id(), NULL, p_provider, NULL, NULL, NULL, NULL, '{}');
END $$;

-- Disabling the last way in must not lock everyone out.
CREATE FUNCTION iam.tg_provider_lockout() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD.enabled AND NOT NEW.enabled AND iam.setting_txt('iam.local_login_enabled','true') <> 'true'
     AND NOT EXISTS (SELECT 1 FROM iam.auth_provider WHERE enabled AND id <> OLD.id)
     AND NOT EXISTS (SELECT 1 FROM iam.account_security a JOIN lms.app_user u ON u.id = a.user_id
                     WHERE a.is_break_glass AND u.status = 'Active') THEN
    RAISE EXCEPTION 'refused: local login is off and this is the last enabled provider; enable local login or an emergency-access account first'
      USING ERRCODE='raise_exception';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER provider_lockout BEFORE UPDATE OF enabled ON iam.auth_provider
  FOR EACH ROW EXECUTE FUNCTION iam.tg_provider_lockout();

CREATE FUNCTION iam.set_break_glass(p_user uuid, p_on boolean) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM iam.require('identity_settings','configure');
  IF p_on AND NOT (EXISTS (SELECT 1 FROM iam.mfa_totp WHERE user_id = p_user AND confirmed_at IS NOT NULL)
                   OR EXISTS (SELECT 1 FROM iam.mfa_webauthn WHERE user_id = p_user)) THEN
    RAISE EXCEPTION 'an emergency-access account must have MFA enrolled first' USING ERRCODE='raise_exception';
  END IF;
  IF p_on AND NOT EXISTS (SELECT 1 FROM lms.app_user WHERE id = p_user AND password_hash IS NOT NULL AND status='Active') THEN
    RAISE EXCEPTION 'an emergency-access account needs an active local password' USING ERRCODE='raise_exception';
  END IF;
  UPDATE iam.account_security SET is_break_glass = p_on WHERE user_id = p_user;
  PERFORM iam.log_event('break_glass_designated', 'success', p_user, NULL, util.actor_id(), p_user, NULL, NULL, NULL, NULL, NULL,
                        jsonb_build_object('enabled', p_on));
END $$;

-- ---------------------------------------------------------------------
-- Authentication policy. A validated wrapper: a setting that could lock every
-- administrator out is checked before it is written.
-- ---------------------------------------------------------------------
CREATE FUNCTION iam.set_policy(p_key text, p_value jsonb, p_note text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_old jsonb; v_n numeric; v_txt text;
BEGIN
  PERFORM iam.require('identity_settings','configure');
  IF p_key NOT LIKE 'iam.%' AND p_key NOT IN ('security.session_minutes','security.max_failed_logins','security.password_min_length') THEN
    RAISE EXCEPTION 'not an identity setting' USING ERRCODE='invalid_parameter_value';
  END IF;
  SELECT value INTO v_old FROM lms.system_setting WHERE key = p_key FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown setting %', p_key USING ERRCODE='invalid_parameter_value'; END IF;
  v_txt := p_value #>> '{}';
  CASE p_key
    WHEN 'security.password_min_length' THEN
      IF jsonb_typeof(p_value) <> 'number' OR v_txt::numeric NOT BETWEEN 10 AND 128 THEN
        RAISE EXCEPTION 'minimum password length must be 10 to 128' USING ERRCODE='invalid_parameter_value'; END IF;
    WHEN 'security.session_minutes' THEN
      IF jsonb_typeof(p_value) <> 'number' OR v_txt::numeric NOT BETWEEN 5 AND 480 THEN
        RAISE EXCEPTION 'idle timeout must be 5 to 480 minutes' USING ERRCODE='invalid_parameter_value'; END IF;
    WHEN 'security.max_failed_logins' THEN
      IF jsonb_typeof(p_value) <> 'number' OR v_txt::numeric NOT BETWEEN 3 AND 20 THEN
        RAISE EXCEPTION 'lockout threshold must be 3 to 20' USING ERRCODE='invalid_parameter_value'; END IF;
    WHEN 'iam.session_absolute_hours' THEN
      IF jsonb_typeof(p_value) <> 'number' OR v_txt::numeric NOT BETWEEN 1 AND 72 THEN
        RAISE EXCEPTION 'absolute session limit must be 1 to 72 hours' USING ERRCODE='invalid_parameter_value'; END IF;
    WHEN 'iam.lockout_minutes' THEN
      IF jsonb_typeof(p_value) <> 'number' OR v_txt::numeric NOT BETWEEN 1 AND 1440 THEN
        RAISE EXCEPTION 'lockout duration must be 1 to 1440 minutes' USING ERRCODE='invalid_parameter_value'; END IF;
    WHEN 'iam.password_history' THEN
      IF jsonb_typeof(p_value) <> 'number' OR v_txt::numeric NOT BETWEEN 0 AND 20 THEN
        RAISE EXCEPTION 'password history must be 0 to 20' USING ERRCODE='invalid_parameter_value'; END IF;
    WHEN 'iam.provisioning_mode' THEN
      IF v_txt NOT IN ('approval','auto') THEN RAISE EXCEPTION 'provisioning mode: approval or auto' USING ERRCODE='invalid_parameter_value'; END IF;
    WHEN 'iam.link_by_email' THEN
      IF v_txt NOT IN ('never','verified') THEN RAISE EXCEPTION 'link_by_email: never or verified' USING ERRCODE='invalid_parameter_value'; END IF;
    WHEN 'iam.provider_failure_behavior' THEN
      IF v_txt NOT IN ('deny','break_glass_only') THEN
        RAISE EXCEPTION 'provider failure behaviour: deny or break_glass_only' USING ERRCODE='invalid_parameter_value'; END IF;
    WHEN 'iam.mfa_required_all' THEN
      IF jsonb_typeof(p_value) <> 'boolean' THEN RAISE EXCEPTION 'must be true or false' USING ERRCODE='invalid_parameter_value'; END IF;
    WHEN 'iam.mfa_required_roles' THEN
      IF jsonb_typeof(p_value) <> 'array' THEN RAISE EXCEPTION 'must be a list of role codes' USING ERRCODE='invalid_parameter_value'; END IF;
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
             JOIN iam.role r ON r.id = ur.role_id AND r.code = 'system-administrator'
             JOIN lms.app_user u ON u.id = e.user_id AND u.status = 'Active'
             WHERE e.unlinked_at IS NULL) THEN
          RAISE EXCEPTION 'refused: turning local login off would lock out every administrator. Designate an emergency-access account with MFA, or link an administrator to a tested, enabled provider first.'
            USING ERRCODE='raise_exception';
        END IF;
      END IF;
    ELSE
      IF p_key NOT LIKE 'iam.%' THEN RAISE EXCEPTION 'not editable here' USING ERRCODE='invalid_parameter_value'; END IF;
  END CASE;
  PERFORM set_config('lms.change_note', coalesce(p_note,''), true);
  UPDATE lms.system_setting SET value = p_value, updated_at = now(), updated_by = util.actor_id(), version = version + 1
   WHERE key = p_key;
  PERFORM iam.log_event('policy_changed','success', NULL, NULL, util.actor_id(), NULL, NULL, NULL, NULL, NULL, NULL,
                        jsonb_build_object('setting', p_key, 'from', v_old, 'to', p_value));
END $$;

-- ---------------------------------------------------------------------
-- External identity provisioning and linking
-- ---------------------------------------------------------------------
CREATE TYPE iam.provision_result AS (user_id uuid, status text);

CREATE FUNCTION iam.provision_external(
    p_provider uuid, p_subject text, p_issuer text, p_email text, p_email_verified boolean,
    p_display text, p_groups text[]) RETURNS iam.provision_result
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE r iam.provision_result; v_link record; v_mode text := iam.setting_txt('iam.provisioning_mode','approval');
        v_existing uuid; v_new uuid; v_user text; gm record;
BEGIN
  -- Already linked: this is the only path that identifies an existing user,
  -- and it is keyed on the provider's immutable subject.
  SELECT e.*, u.status AS ustatus INTO v_link FROM iam.external_identity e
    JOIN lms.app_user u ON u.id = e.user_id
   WHERE e.provider_id = p_provider AND e.subject = p_subject AND e.unlinked_at IS NULL;
  IF FOUND THEN
    IF v_link.ustatus <> 'Active' THEN
      INSERT INTO iam.provisioning_log(provider_id, user_id, subject, action, outcome, detail)
      VALUES (p_provider, v_link.user_id, p_subject, 'login_refused', 'refused', 'account is '||v_link.ustatus);
      r.user_id := v_link.user_id; r.status := 'inactive'; RETURN r;
    END IF;
    UPDATE iam.external_identity SET last_login_at = now() WHERE id = v_link.id;
    r.user_id := v_link.user_id; r.status := 'ok';
  ELSE
    -- Optional auto-link by verified email. Off by default: an email address
    -- is not a stable identity, and linking on it is the classic account
    -- takeover. When on, only an UNLINKED local account is eligible and the
    -- provider must assert the address is verified.
    IF iam.setting_txt('iam.link_by_email','never') = 'verified' AND p_email_verified AND p_email IS NOT NULL THEN
      SELECT u.id INTO v_existing FROM lms.app_user u JOIN iam.account_security a ON a.user_id = u.id
       WHERE u.email = p_email::ext.citext AND u.status = 'Active' AND a.is_break_glass = false
         AND u.is_service_account = false
         AND NOT EXISTS (SELECT 1 FROM iam.external_identity x WHERE x.user_id = u.id AND x.provider_id = p_provider AND x.unlinked_at IS NULL);
      IF v_existing IS NOT NULL THEN
        INSERT INTO iam.external_identity(user_id, provider_id, subject, issuer, email_at_link, last_login_at)
        VALUES (v_existing, p_provider, p_subject, p_issuer, p_email, now());
        INSERT INTO iam.provisioning_log(provider_id, user_id, subject, action, outcome, detail)
        VALUES (p_provider, v_existing, p_subject, 'linked', 'success', 'linked by verified email (policy: verified)');
        r.user_id := v_existing; r.status := 'ok';
      END IF;
    END IF;
    IF r.user_id IS NULL THEN
      IF v_mode = 'auto' THEN
        v_user := 'ext-' || substr(encode(sha256((p_provider::text||p_subject)::bytea),'hex'),1,16);
        INSERT INTO lms.app_user(code, username, full_name, role_code, email, status)
        VALUES (lms.next_code('USR-'), v_user, coalesce(nullif(btrim(p_display),''), v_user), 'Viewer',
                nullif(p_email,''), 'Active') RETURNING id INTO v_new;
        INSERT INTO iam.external_identity(user_id, provider_id, subject, issuer, email_at_link, last_login_at)
        VALUES (v_new, p_provider, p_subject, p_issuer, p_email, now());
        INSERT INTO iam.provisioning_log(provider_id, user_id, subject, action, outcome, detail)
        VALUES (p_provider, v_new, p_subject, 'created', 'success', 'automatic provisioning, no roles until mapped');
        r.user_id := v_new; r.status := 'ok';
      ELSE
        INSERT INTO iam.provisioning_request(provider_id, subject, issuer, email, display_name, groups)
        VALUES (p_provider, p_subject, p_issuer, p_email, p_display, coalesce(p_groups,'{}'))
        ON CONFLICT (provider_id, subject) DO UPDATE
           SET email = EXCLUDED.email, display_name = EXCLUDED.display_name, groups = EXCLUDED.groups
         WHERE iam.provisioning_request.status = 'pending';
        INSERT INTO iam.provisioning_log(provider_id, subject, action, outcome, detail)
        VALUES (p_provider, p_subject, 'requested', 'success', 'awaiting administrator approval');
        r.status := 'pending'; RETURN r;
      END IF;
    END IF;
  END IF;
  -- Group mapping is re-applied on every login so a directory change takes
  -- effect at the next sign-in; it only touches what the mapping owns.
  FOR gm IN SELECT * FROM iam.group_mapping WHERE provider_id = p_provider AND external_group = ANY (coalesce(p_groups,'{}')) LOOP
    IF gm.role_id IS NOT NULL THEN
      INSERT INTO iam.user_role(user_id, role_id, granted_by, reason)
      VALUES (r.user_id, gm.role_id, '00000000-0000-0000-0000-000000000001', 'directory group '||gm.external_group)
      ON CONFLICT DO NOTHING;
    END IF;
    IF gm.approval_group IS NOT NULL THEN
      INSERT INTO lms.app_user_group(user_id, group_code) VALUES (r.user_id, gm.approval_group) ON CONFLICT DO NOTHING;
    END IF;
    IF gm.province_code IS NOT NULL THEN
      INSERT INTO lms.app_user_province(user_id, province_code) VALUES (r.user_id, gm.province_code) ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;
  RETURN r;
END $$;

CREATE FUNCTION iam.decide_provisioning(p_request uuid, p_approve boolean, p_note text, p_link_user uuid, p_role_codes text[])
  RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE q record; v_user uuid; v_name text; rc text; v_role uuid;
BEGIN
  PERFORM iam.require('users','create');
  SELECT * INTO q FROM iam.provisioning_request WHERE id = p_request AND status = 'pending' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no such pending request' USING ERRCODE='no_data_found'; END IF;
  IF NOT p_approve THEN
    UPDATE iam.provisioning_request SET status='rejected', decided_at=now(), decided_by=util.actor_id(), decision_note=left(p_note,200) WHERE id = q.id;
    INSERT INTO iam.provisioning_log(provider_id, subject, action, outcome, detail) VALUES (q.provider_id, q.subject, 'rejected', 'success', left(p_note,200));
    RETURN NULL;
  END IF;
  IF p_link_user IS NOT NULL THEN
    v_user := p_link_user;     -- an administrator, explicitly, links to an existing account
  ELSE
    v_name := 'ext-' || substr(encode(sha256((q.provider_id::text||q.subject)::bytea),'hex'),1,16);
    INSERT INTO lms.app_user(code, username, full_name, role_code, email, status)
    VALUES (lms.next_code('USR-'), v_name, coalesce(nullif(btrim(q.display_name),''), v_name), 'Viewer', nullif(q.email,''), 'Active')
    RETURNING id INTO v_user;
  END IF;
  INSERT INTO iam.external_identity(user_id, provider_id, subject, issuer, email_at_link, linked_by)
  VALUES (v_user, q.provider_id, q.subject, q.issuer, q.email, util.actor_id());
  FOREACH rc IN ARRAY coalesce(p_role_codes,'{}') LOOP
    SELECT id INTO v_role FROM iam.role WHERE code = rc;
    IF v_role IS NULL THEN RAISE EXCEPTION 'unknown role %', rc USING ERRCODE='invalid_parameter_value'; END IF;
    INSERT INTO iam.user_role(user_id, role_id) VALUES (v_user, v_role);
  END LOOP;
  UPDATE iam.provisioning_request SET status='approved', decided_at=now(), decided_by=util.actor_id(),
         decision_note=left(p_note,200), resulting_user=v_user WHERE id = q.id;
  INSERT INTO iam.provisioning_log(provider_id, user_id, subject, action, outcome, detail)
  VALUES (q.provider_id, v_user, q.subject, 'approved', 'success', left(p_note,200));
  RETURN v_user;
END $$;

CREATE FUNCTION iam.unlink_identity(p_identity uuid, p_reason text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE e record;
BEGIN
  PERFORM iam.require('users','update');
  SELECT * INTO e FROM iam.external_identity WHERE id = p_identity AND unlinked_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no such link' USING ERRCODE='no_data_found'; END IF;
  -- Never strand the only working administrator.
  IF EXISTS (SELECT 1 FROM iam.user_role ur JOIN iam.role r ON r.id=ur.role_id
             WHERE ur.user_id=e.user_id AND ur.revoked_at IS NULL AND r.code='system-administrator')
     AND NOT EXISTS (SELECT 1 FROM lms.app_user WHERE id=e.user_id AND password_hash IS NOT NULL)
     AND NOT EXISTS (SELECT 1 FROM iam.external_identity x WHERE x.user_id=e.user_id AND x.unlinked_at IS NULL AND x.id<>e.id) THEN
    RAISE EXCEPTION 'this would leave an administrator with no way to sign in' USING ERRCODE='raise_exception';
  END IF;
  UPDATE iam.external_identity SET unlinked_at = now() WHERE id = e.id;
  UPDATE lms.login_session SET ended_at=now(), end_reason='revoked' WHERE user_id=e.user_id AND provider_id=e.provider_id AND ended_at IS NULL;
  INSERT INTO iam.provisioning_log(provider_id, user_id, subject, action, outcome, detail)
  VALUES (e.provider_id, e.user_id, e.subject, 'unlinked', 'success', left(p_reason,200));
END $$;

-- Deprovisioning by directory: called by the sync job for every linked user
-- the directory no longer returns as enabled.
CREATE FUNCTION iam.deprovision_external(p_provider uuid, p_subject text, p_reason text) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE e record;
BEGIN
  SELECT * INTO e FROM iam.external_identity WHERE provider_id=p_provider AND subject=p_subject AND unlinked_at IS NULL;
  IF NOT FOUND THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM iam.account_security WHERE user_id = e.user_id AND is_break_glass) THEN RETURN false; END IF;
  UPDATE lms.login_session SET ended_at=now(), end_reason='revoked' WHERE user_id=e.user_id AND ended_at IS NULL AND auth_method <> 'local';
  -- Only external-only accounts are suspended. An account that also has a
  -- local password keeps that route; the directory cannot end it.
  UPDATE lms.app_user SET status='Suspended' WHERE id=e.user_id AND status='Active' AND password_hash IS NULL;
  INSERT INTO iam.provisioning_log(provider_id, user_id, subject, action, outcome, detail)
  VALUES (p_provider, e.user_id, p_subject, 'deprovisioned', 'success', left(p_reason,200));
  RETURN true;
END $$;
