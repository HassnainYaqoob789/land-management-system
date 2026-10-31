-- =====================================================================
-- 0028  Pre-authentication writes are attributed to the account itself
-- =====================================================================
-- The audit trigger refuses any write without an actor (by design: an
-- unattributed change is not recorded as if it were fine). Four pre-auth
-- routines write lms.app_user before any session exists — recording a login,
-- upgrading a legacy hash, redeeming a reset link — and were therefore refused.
-- They now set the actor, transaction-locally, to the account being acted on:
-- the account is the one that just proved its identity (password, or a
-- single-use token), so it is the honest attribution.
SET ROLE lms_owner;

CREATE OR REPLACE FUNCTION iam.note_auth_success(p_user uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM set_config('lms.actor_id', p_user::text, true);
  UPDATE iam.account_security SET failed_count = 0, locked_until = NULL WHERE user_id = p_user;
  UPDATE lms.app_user SET last_login_at = now() WHERE id = p_user;
END $$;

CREATE OR REPLACE FUNCTION iam.rehash_password(p_user uuid, p_old text, p_new text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM set_config('lms.actor_id', p_user::text, true);
  UPDATE lms.app_user SET password_hash = p_new WHERE id = p_user AND password_hash = p_old;
END $$;

CREATE OR REPLACE FUNCTION iam.redeem_token(p_hash bytea, p_purpose text, p_new_hash text) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE i record;
BEGIN
  SELECT * INTO i FROM iam.invitation WHERE token_sha256 = p_hash AND purpose = p_purpose FOR UPDATE;
  IF NOT FOUND OR i.used_at IS NOT NULL OR i.expires_at <= now() THEN
    RAISE EXCEPTION 'this link is invalid or has expired' USING ERRCODE='invalid_authorization_specification';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM lms.app_user WHERE id = i.user_id AND status = 'Active') THEN
    RAISE EXCEPTION 'this link is invalid or has expired' USING ERRCODE='invalid_authorization_specification';
  END IF;
  PERFORM set_config('lms.actor_id', i.user_id::text, true);
  UPDATE iam.invitation SET used_at = now() WHERE id = i.id;
  PERFORM iam.tg_apply_password(i.user_id, p_new_hash);
  UPDATE lms.login_session SET ended_at = now(), end_reason = 'revoked' WHERE user_id = i.user_id AND ended_at IS NULL;
  RETURN i.user_id;
END $$;

-- A sign-in is recorded in audit.auth_event; recording it again as a business
-- change to lms.app_user (last_login_at) is noise that would bury real edits
-- to an account. The audit trigger ignores that column, the same way it
-- ignores updated_at.
CREATE OR REPLACE FUNCTION audit.tg_audit_row() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_actor uuid; v_user record; v_old jsonb; v_new jsonb; v_changed text[];
  v_id uuid; v_code text; v_prov text; v_row jsonb;
  c_redact text[] := ARRAY['password_hash','token_sha256','secret_ct','ciphertext','verifier','public_key'];
BEGIN
  v_actor := util.require_actor();
  SELECT username, role_code INTO v_user FROM lms.app_user WHERE id = v_actor;
  IF TG_OP = 'DELETE' THEN
    v_old := to_jsonb(OLD); v_row := v_old;
  ELSIF TG_OP = 'INSERT' THEN
    v_new := to_jsonb(NEW); v_row := v_new;
  ELSE
    v_old := to_jsonb(OLD); v_new := to_jsonb(NEW); v_row := v_new;
    SELECT array_agg(k ORDER BY k) INTO v_changed
    FROM jsonb_object_keys(v_new) AS k
    WHERE v_new -> k IS DISTINCT FROM v_old -> k
      AND k NOT IN ('updated_at','updated_by','version','last_login_at');
    IF v_changed IS NULL THEN RETURN NULL; END IF;
  END IF;
  v_id := (v_row ->> 'id')::uuid; v_code := v_row ->> 'code'; v_prov := v_row ->> 'province_code';
  IF v_old IS NOT NULL THEN v_old := v_old - c_redact; END IF;
  IF v_new IS NOT NULL THEN v_new := v_new - c_redact; END IF;
  INSERT INTO audit.audit_event(actor_id, actor_username, actor_role, entity, record_id, record_code,
                                province_code, action, old_data, new_data, changed_fields)
  VALUES (v_actor, v_user.username, v_user.role_code, TG_TABLE_NAME, v_id,
          CASE WHEN v_code ~ '^[A-Za-z0-9][A-Za-z0-9/-]{1,31}$' THEN v_code::lms.record_code END,
          v_prov::char(3), TG_OP, v_old, v_new, v_changed);
  RETURN NULL;
END $$;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA lms, api, audit, util, iam FROM PUBLIC;
GRANT EXECUTE ON FUNCTION iam.note_auth_success(uuid), iam.rehash_password(uuid,text,text),
  iam.redeem_token(bytea,text,text) TO lms_readwrite;
