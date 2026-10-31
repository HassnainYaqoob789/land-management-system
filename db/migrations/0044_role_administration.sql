-- =====================================================================
-- 0044  Role administration: role status on every path, removal cover,
--       grant and revocation events, role history, MFA overview,
--       access reviews
-- =====================================================================
-- Builds on 0041, which already keeps a custom role at or below its
-- creator's database tier and counts the tier in iam.actor_covers_role.
-- 1. A role's status changes with the same rules whichever path changes it:
--    retiring needs roles:delete, any change needs the delegation cover of
--    iam.set_role_status and a reason (the application role has UPDATE on
--    iam.role, so a direct UPDATE could otherwise retire a role with
--    roles:update alone, without a reason). created_by is the actor.
-- 2. Taking a permission out of a role, or changing its scope, needs the same
--    delegation cover as adding it, judged on what was there before.
-- 3. Every grant and revocation writes an audit.auth_event naming the role,
--    scope, expiry and reason (UA-04); iam.role_history() resolves the row
--    audit of iam.role / iam.role_permission / iam.user_role for one role.
-- 4. iam.user_mfa_summary(): enrolment status for users:read holders. Row
--    security on iam.mfa_totp / mfa_webauthn is own-rows-only, so the Users
--    screen could not tell whether anyone else had two-step verification.
-- 5. Access reviews (UA-02): start (snapshot of active assignments, optional
--    role / province filter), decide each item (keep, or revoke with a reason
--    — applied at once through the ordinary guarded UPDATE of iam.user_role),
--    and close once every item is decided. Nobody decides on their own access.
--    Reading stays with the existing users:read policies.
-- 6. iam.anonymise_user records why roles were revoked in revoke_reason
--    (0041 made the grant reason immutable, which broke the 0022 routine).
-- New triggers are named to fire after the 0041 guards of the same timing
-- (PostgreSQL fires them in name order), so those guards' messages win.
SET ROLE lms_owner;
SELECT set_config('lms.actor_id', '00000000-0000-0000-0000-000000000001', true);

-- ---------------------------------------------------------------------
-- 1. Role status and attribution
-- ---------------------------------------------------------------------
CREATE FUNCTION iam.tg_role_guard_status()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  IF iam.is_system_actor() THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.created_by := util.actor_id();
    RETURN NEW;
  END IF;
  IF NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'who created a role cannot be changed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status = 'retired' AND NOT iam.has_permission('roles', 'delete') THEN
      RAISE EXCEPTION 'retiring a role needs roles:delete' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT iam.actor_covers_role(NEW.id) THEN
      RAISE EXCEPTION 'you cannot change the status of a role containing permissions you do not hold'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF length(btrim(coalesce(NEW.status_reason, ''))) < 5 THEN
      RAISE EXCEPTION 'a reason of at least 5 characters is required to change a role''s status'
        USING ERRCODE = 'raise_exception';
    END IF;
  END IF;
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION iam.tg_role_guard_status() FROM PUBLIC;
CREATE TRIGGER role_guard_status BEFORE INSERT OR UPDATE ON iam.role
  FOR EACH ROW EXECUTE FUNCTION iam.tg_role_guard_status();

-- ---------------------------------------------------------------------
-- 2. Removing or narrowing a permission needs cover for what was there
-- ---------------------------------------------------------------------
CREATE FUNCTION iam.tg_role_permission_cover()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  IF iam.is_system_actor() THEN RETURN coalesce(NEW, OLD); END IF;
  IF NOT EXISTS (
      SELECT 1 FROM iam.user_role ur
      JOIN iam.role hr ON hr.id = ur.role_id AND hr.status = 'active'
      JOIN iam.role_permission have ON have.role_id = ur.role_id
      WHERE ur.user_id = util.actor_id() AND ur.revoked_at IS NULL
        AND (ur.expires_at IS NULL OR ur.expires_at > now())
        AND have.permission_id = OLD.permission_id
        AND iam.permission_rank(have.scope_level) >= iam.permission_rank(OLD.scope_level)) THEN
    RAISE EXCEPTION 'you cannot remove or change a permission you do not hold at that scope'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN coalesce(NEW, OLD);
END $function$;
REVOKE ALL ON FUNCTION iam.tg_role_permission_cover() FROM PUBLIC;
CREATE TRIGGER role_permission_guard_cover BEFORE UPDATE OR DELETE ON iam.role_permission
  FOR EACH ROW EXECUTE FUNCTION iam.tg_role_permission_cover();

-- ---------------------------------------------------------------------
-- 3. Grant and revocation events; the history of one role
-- ---------------------------------------------------------------------
CREATE FUNCTION iam.tg_user_role_log()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE v_role text; v_row jsonb := to_jsonb(NEW);
BEGIN
  IF TG_OP = 'UPDATE' AND (OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL) THEN RETURN NULL; END IF;
  SELECT r.code INTO v_role FROM iam.role r WHERE r.id = NEW.role_id;
  -- Metadata keys avoid the words iam.metadata_is_safe() refuses (…code…).
  PERFORM iam.log_event(CASE TG_OP WHEN 'INSERT' THEN 'role_granted' ELSE 'role_revoked' END, 'success',
    NEW.user_id, lms.user_username(NEW.user_id)::text, util.actor_id(), NEW.user_id, NULL, NULL, NULL, NULL, NULL,
    jsonb_strip_nulls(jsonb_build_object(
      'role', v_role, 'assignment', NEW.id, 'province', NEW.scope_province, 'project', NEW.scope_project,
      'expires_at', NEW.expires_at,
      'reason', left(CASE TG_OP WHEN 'INSERT' THEN NEW.reason ELSE coalesce(v_row ->> 'revoke_reason', NEW.reason) END, 200))));
  RETURN NULL;
END $function$;
REVOKE ALL ON FUNCTION iam.tg_user_role_log() FROM PUBLIC;
CREATE TRIGGER user_role_log AFTER INSERT OR UPDATE ON iam.user_role
  FOR EACH ROW EXECUTE FUNCTION iam.tg_user_role_log();

-- The row audit of one role, its permissions and its assignments, newest
-- first, with people and permissions resolved to names. Page with p_before
-- (the smallest event_id already shown).
CREATE FUNCTION iam.role_history(p_role text, p_limit integer DEFAULT 100, p_before bigint DEFAULT NULL)
 RETURNS TABLE(event_id bigint, occurred_at timestamptz, actor_username text, actor_name text,
               entity text, action text, changed_fields text[], old_data jsonb, new_data jsonb,
               permission text, subject_username text, subject_name text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE v_id uuid;
BEGIN
  PERFORM iam.require('roles', 'read');
  SELECT r.id INTO v_id FROM iam.role r WHERE r.code = p_role;
  IF v_id IS NULL THEN RAISE EXCEPTION 'no such role %', p_role USING ERRCODE = 'no_data_found'; END IF;
  RETURN QUERY
  WITH ev AS (
    SELECT e.* FROM audit.audit_event e WHERE e.entity = 'role' AND e.record_id = v_id
    UNION ALL
    SELECT e.* FROM audit.audit_event e
     WHERE e.entity = 'role_permission'
       AND (e.new_data @> jsonb_build_object('role_id', v_id) OR e.old_data @> jsonb_build_object('role_id', v_id))
    UNION ALL
    SELECT e.* FROM audit.audit_event e
     WHERE e.entity = 'user_role' AND e.record_id IN (SELECT ur.id FROM iam.user_role ur WHERE ur.role_id = v_id)
  )
  SELECT ev.id, ev.occurred_at, ev.actor_username, lms.user_full_name(ev.actor_id), ev.entity, ev.action,
         ev.changed_fields, ev.old_data, ev.new_data,
         (SELECT p.resource || ':' || p.action FROM iam.permission p
           WHERE ev.entity = 'role_permission' AND p.id = (coalesce(ev.new_data, ev.old_data) ->> 'permission_id')::uuid),
         CASE WHEN ev.entity = 'user_role' THEN lms.user_username((coalesce(ev.new_data, ev.old_data) ->> 'user_id')::uuid)::text END,
         CASE WHEN ev.entity = 'user_role' THEN lms.user_full_name((coalesce(ev.new_data, ev.old_data) ->> 'user_id')::uuid) END
  FROM ev
  WHERE p_before IS NULL OR ev.id < p_before
  ORDER BY ev.id DESC
  LIMIT least(greatest(coalesce(p_limit, 100), 1), 500);
END $function$;
REVOKE ALL ON FUNCTION iam.role_history(text, integer, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION iam.role_history(text, integer, bigint) TO lms_readwrite;

-- ---------------------------------------------------------------------
-- 4. Two-step verification status for account administrators
-- ---------------------------------------------------------------------
CREATE FUNCTION iam.user_mfa_summary()
 RETURNS TABLE(user_id uuid, totp boolean, passkeys integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  PERFORM iam.require('users', 'read');
  RETURN QUERY
  SELECT u.id,
         EXISTS (SELECT 1 FROM iam.mfa_totp m WHERE m.user_id = u.id AND m.confirmed_at IS NOT NULL),
         (SELECT count(*)::integer FROM iam.mfa_webauthn w WHERE w.user_id = u.id)
  FROM lms.app_user u
  WHERE NOT u.is_service_account;
END $function$;
REVOKE ALL ON FUNCTION iam.user_mfa_summary() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION iam.user_mfa_summary() TO lms_readwrite;

-- ---------------------------------------------------------------------
-- 5. Access reviews
-- ---------------------------------------------------------------------
-- No write path ever existed (SELECT was the only grant), so there are no
-- rows to reconcile with the new constraints.
ALTER TABLE iam.access_review
  ADD COLUMN scope_role      uuid REFERENCES iam.role(id),
  ADD COLUMN scope_province  char(3) REFERENCES lms.province(code),
  ADD COLUMN completed_by    uuid REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  ADD COLUMN completion_note text,
  ADD CONSTRAINT access_review_completed_ck CHECK ((completed_at IS NULL) = (completed_by IS NULL));
COMMENT ON TABLE iam.access_review IS
  'A periodic review of role assignments: a snapshot of the active grants (optionally one role / one province), '
  'a keep / revoke decision on each, closed when all are decided. Written only by iam.start_access_review, '
  'iam.decide_access_review_item and iam.close_access_review.';

ALTER TABLE iam.access_review_item
  ADD COLUMN reason text,
  ADD CONSTRAINT access_review_item_decided_ck
    CHECK ((decision IS NULL) = (decided_at IS NULL) AND (decision IS NULL) = (decided_by IS NULL)),
  ADD CONSTRAINT access_review_item_reason_ck
    CHECK (decision IS DISTINCT FROM 'revoke' OR length(btrim(coalesce(reason, ''))) >= 5);
CREATE INDEX access_review_started_idx ON iam.access_review (started_at DESC);

CREATE TRIGGER access_review_audit AFTER INSERT OR UPDATE OR DELETE ON iam.access_review
  FOR EACH ROW EXECUTE FUNCTION audit.tg_audit_row();
CREATE TRIGGER access_review_item_audit AFTER UPDATE OR DELETE ON iam.access_review_item
  FOR EACH ROW EXECUTE FUNCTION audit.tg_audit_row();

CREATE FUNCTION iam.start_access_review(p_note text, p_role text DEFAULT NULL, p_province text DEFAULT NULL)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE v_actor uuid := util.actor_id(); v_role uuid; v_id uuid; v_n integer;
BEGIN
  PERFORM iam.require('users', 'assign');
  IF length(btrim(coalesce(p_note, ''))) < 5 THEN
    RAISE EXCEPTION 'describe the review in at least 5 characters' USING ERRCODE = 'raise_exception';
  END IF;
  IF p_role IS NOT NULL THEN
    SELECT r.id INTO v_role FROM iam.role r WHERE r.code = p_role;
    IF v_role IS NULL THEN RAISE EXCEPTION 'no such role %', p_role USING ERRCODE = 'no_data_found'; END IF;
  END IF;
  IF p_province IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM lms.province pv WHERE pv.code = p_province) THEN
      RAISE EXCEPTION 'no such province %', p_province USING ERRCODE = 'no_data_found';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM lms.app_user_province up WHERE up.user_id = v_actor AND up.province_code = p_province) THEN
      RAISE EXCEPTION 'you cannot review province % which you do not hold', p_province
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  INSERT INTO iam.access_review (started_by, note, scope_role, scope_province)
  VALUES (v_actor, left(btrim(p_note), 500), v_role, p_province) RETURNING id INTO v_id;
  -- A province review covers grants limited to that province and unlimited
  -- grants of people who hold the province.
  INSERT INTO iam.access_review_item (review_id, user_role_id)
  SELECT v_id, ur.id
  FROM iam.user_role ur
  WHERE ur.revoked_at IS NULL AND (ur.expires_at IS NULL OR ur.expires_at > now())
    AND (v_role IS NULL OR ur.role_id = v_role)
    AND (p_province IS NULL OR ur.scope_province = p_province
         OR (ur.scope_province IS NULL AND EXISTS (
               SELECT 1 FROM lms.app_user_province up WHERE up.user_id = ur.user_id AND up.province_code = p_province)));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN
    RAISE EXCEPTION 'no active role assignment matches this review' USING ERRCODE = 'no_data_found';
  END IF;
  PERFORM iam.log_event('access_review_started', 'success', NULL, NULL, v_actor, NULL, NULL, NULL, NULL, NULL, NULL,
    jsonb_strip_nulls(jsonb_build_object('review', v_id, 'role', p_role, 'province', p_province, 'items', v_n)));
  RETURN v_id;
END $function$;
REVOKE ALL ON FUNCTION iam.start_access_review(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION iam.start_access_review(text, text, text) TO lms_readwrite;

CREATE FUNCTION iam.decide_access_review_item(p_item uuid, p_decision text, p_reason text DEFAULT NULL)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE v_actor uuid := util.actor_id(); v_item record; v_review record; v_ur record;
BEGIN
  PERFORM iam.require('users', 'assign');
  IF p_decision IS NULL OR p_decision NOT IN ('keep', 'revoke') THEN
    RAISE EXCEPTION 'the decision must be keep or revoke' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_decision = 'revoke' AND length(btrim(coalesce(p_reason, ''))) < 5 THEN
    RAISE EXCEPTION 'a reason of at least 5 characters is required to revoke' USING ERRCODE = 'raise_exception';
  END IF;
  SELECT i.* INTO v_item FROM iam.access_review_item i WHERE i.id = p_item FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no such review item' USING ERRCODE = 'no_data_found'; END IF;
  -- FOR SHARE: a concurrent close waits until this decision is in.
  SELECT r.* INTO v_review FROM iam.access_review r WHERE r.id = v_item.review_id FOR SHARE;
  IF v_review.completed_at IS NOT NULL THEN
    RAISE EXCEPTION 'this review is closed' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF v_item.decision IS NOT NULL THEN
    RAISE EXCEPTION 'this item has already been decided' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  SELECT ur.* INTO v_ur FROM iam.user_role ur WHERE ur.id = v_item.user_role_id FOR UPDATE;
  IF v_ur.user_id = v_actor THEN
    RAISE EXCEPTION 'you cannot review your own access; another reviewer must decide this item'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_decision = 'keep' AND (v_ur.revoked_at IS NOT NULL OR (v_ur.expires_at IS NOT NULL AND v_ur.expires_at <= now())) THEN
    RAISE EXCEPTION 'this assignment has already ended; record it as revoked'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF p_decision = 'revoke' AND v_ur.revoked_at IS NULL THEN
    -- The ordinary guarded path: the iam.user_role triggers apply (last
    -- administrator, delegation cover, attribution) as on the Users screen.
    UPDATE iam.user_role SET revoked_at = now(), revoke_reason = left(btrim(p_reason), 300) WHERE id = v_ur.id;
  END IF;
  UPDATE iam.access_review_item
     SET decision = p_decision, reason = nullif(left(btrim(coalesce(p_reason, '')), 300), ''),
         decided_by = v_actor, decided_at = now()
   WHERE id = p_item;
  PERFORM iam.log_event('access_review_decision', 'success', v_ur.user_id, NULL, v_actor, v_ur.user_id,
    NULL, NULL, NULL, NULL, NULL,
    jsonb_build_object('review', v_item.review_id, 'item', p_item, 'decision', p_decision, 'assignment', v_ur.id));
END $function$;
REVOKE ALL ON FUNCTION iam.decide_access_review_item(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION iam.decide_access_review_item(uuid, text, text) TO lms_readwrite;

CREATE FUNCTION iam.close_access_review(p_review uuid, p_note text DEFAULT NULL)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE v_actor uuid := util.actor_id(); v_review record; v_open integer; v_keep integer; v_revoke integer;
BEGIN
  PERFORM iam.require('users', 'assign');
  SELECT r.* INTO v_review FROM iam.access_review r WHERE r.id = p_review FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no such access review' USING ERRCODE = 'no_data_found'; END IF;
  IF v_review.completed_at IS NOT NULL THEN
    RAISE EXCEPTION 'this review is already closed' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  SELECT count(*) FILTER (WHERE i.decision IS NULL), count(*) FILTER (WHERE i.decision = 'keep'),
         count(*) FILTER (WHERE i.decision = 'revoke')
    INTO v_open, v_keep, v_revoke
    FROM iam.access_review_item i WHERE i.review_id = p_review;
  IF v_open > 0 THEN
    RAISE EXCEPTION '% item(s) still need a decision', v_open USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  UPDATE iam.access_review
     SET completed_at = now(), completed_by = v_actor,
         completion_note = nullif(left(btrim(coalesce(p_note, '')), 500), '')
   WHERE id = p_review;
  PERFORM iam.log_event('access_review_closed', 'success', NULL, NULL, v_actor, NULL, NULL, NULL, NULL, NULL, NULL,
    jsonb_build_object('review', p_review, 'kept', v_keep, 'revoked', v_revoke));
END $function$;
REVOKE ALL ON FUNCTION iam.close_access_review(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION iam.close_access_review(uuid, text) TO lms_readwrite;

-- ---------------------------------------------------------------------
-- 6. Anonymisation under 0041's immutable grant reason
-- ---------------------------------------------------------------------
-- 0022's routine revoked the roles by overwriting user_role.reason, which the
-- 0041 assignment guard now refuses ("cannot be edited"), so no account with
-- a role could be anonymised. The revocation's reason goes in revoke_reason;
-- the body is otherwise 0022's.
CREATE OR REPLACE FUNCTION iam.anonymise_user(p_user uuid, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE v_actor uuid := util.actor_id();
BEGIN
  PERFORM iam.require('users','delete');
  IF p_user = v_actor THEN RAISE EXCEPTION 'you cannot anonymise yourself' USING ERRCODE='insufficient_privilege'; END IF;
  IF length(btrim(coalesce(p_reason,''))) < 10 THEN
    RAISE EXCEPTION 'a justification of at least 10 characters is required' USING ERRCODE='invalid_parameter_value';
  END IF;
  -- Roles first, so the last-administrator guard runs.
  UPDATE iam.user_role SET revoked_at = now(), revoked_by = v_actor, revoke_reason = 'account anonymised'
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
END $function$;

RESET ROLE;
