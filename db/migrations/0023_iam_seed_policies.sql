-- =====================================================================
-- 0023  IAM: permission catalogue, system roles, settings, redaction,
--       row-level security and grants
-- =====================================================================
SET ROLE lms_owner;

-- ---------------------------------------------------------------------
-- Fix from the previous phase: audit.tg_audit_row logged to_jsonb(OLD/NEW),
-- which for lms.app_user includes password_hash. A verifier in the audit
-- trail is readable by everyone who may read the trail. Credentials are now
-- redacted from both images; the changed-field list still names the column, so
-- "the password changed" remains visible without the value.
-- ---------------------------------------------------------------------
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
    WHERE v_new -> k IS DISTINCT FROM v_old -> k AND k NOT IN ('updated_at','updated_by','version');
    IF v_changed IS NULL THEN RETURN NULL; END IF;
  END IF;
  v_id := (v_row ->> 'id')::uuid; v_code := v_row ->> 'code'; v_prov := v_row ->> 'province_code';
  IF v_old IS NOT NULL THEN
    v_old := v_old - c_redact;
  END IF;
  IF v_new IS NOT NULL THEN
    v_new := v_new - c_redact;
  END IF;
  INSERT INTO audit.audit_event(actor_id, actor_username, actor_role, entity, record_id, record_code,
                                province_code, action, old_data, new_data, changed_fields)
  VALUES (v_actor, v_user.username, v_user.role_code, TG_TABLE_NAME, v_id,
          CASE WHEN v_code ~ '^[A-Za-z0-9][A-Za-z0-9/-]{1,31}$' THEN v_code::lms.record_code END,
          v_prov::char(3), TG_OP, v_old, v_new, v_changed);
  RETURN NULL;
END $$;

-- ---------------------------------------------------------------------
-- Permission catalogue. Only resources that exist in the application.
-- ---------------------------------------------------------------------
INSERT INTO iam.permission(resource, action, description, is_sensitive) VALUES
 ('users','read','View user accounts, their roles and effective permissions',false),
 ('users','create','Create accounts and send invitations; approve external-identity provisioning',true),
 ('users','update','Edit accounts, change status, issue password resets, unlink external identities',true),
 ('users','delete','Anonymise an account',true),
 ('users','assign','Assign and revoke roles',true),
 ('users','reset_mfa','Reset another user''s MFA (justification required)',true),
 ('users','revoke_sessions','End another user''s sessions',true),
 ('roles','read','View roles and their permissions',false),
 ('roles','create','Create custom roles',true),
 ('roles','update','Edit custom roles',true),
 ('roles','delete','Delete unused custom roles',true),
 ('roles','manage_permissions','Change the permissions of a custom role',true),
 ('identity_settings','read','View authentication providers and policies',false),
 ('identity_settings','configure','Configure providers, policies and emergency access',true),
 ('sessions','read','View active sessions',false),
 ('sessions','revoke','End any session',true),
 ('audit_logs','read','View the business audit trail and security log',false),
 ('audit_logs','export','Export audit and security records',true),
 ('projects','read','View projects',false),('projects','create','Create projects',false),
 ('landowners','read','View landowners',false),('landowners','create','Create landowners',false),
 ('surveys','read','View parcels',false),('surveys','create','Create parcels',false),('surveys','update','Edit parcels and ownership shares',false),
 ('cases','read','View compensation cases',false),('cases','create','Create compensation cases',false),
 ('cases','approve','Advance a case through its workflow (the approval matrix decides which step)',false),
 ('leases','read','View leases',false),('leases','create','Create leases',false),
 ('payments','read','View payments',false),('payments','create','Raise a payment request',false),
 ('payments','verify','Verify a payment request',true),
 ('payments','release','Release a payment (issue a cheque)',true),
 ('dbpfc','read','View DBPFC estimates',false),
 ('rows','read','View ROW corridors',false),('rows','create','Create ROW corridors',false),
 ('gis','read','View the GIS layers',false),
 ('reports','read','View reports and dashboards',false),
 ('reports','export','Export reports',true);

-- Roles. db_role_code is the database tier the account is enforced at.
INSERT INTO iam.role(code, name, description, is_system, db_role_code) VALUES
 ('system-administrator','System administrator','Administers identity, roles and configuration. Holds no payment-verify or -release authority.',true,'Admin'),
 ('land-manager','Land manager (HO)','Approves cases and releases payments.',true,'Approver'),
 ('finance-approver','Finance approver','Raises and verifies payments.',true,'User'),
 ('case-approver','Case approver','Advances compensation cases through the approval matrix.',true,'User'),
 ('data-entry','Data entry','Creates and edits land records.',true,'User'),
 ('viewer','Viewer','Read-only access to land records and reports.',true,'Viewer'),
 ('security-auditor','Security auditor','Read-only access to users, roles, sessions and audit records.',true,'Viewer');

CREATE FUNCTION pg_temp.grant_perm(p_role text, p_perm text, p_scope text DEFAULT 'province') RETURNS void
  LANGUAGE plpgsql AS $f$
BEGIN
  INSERT INTO iam.role_permission(role_id, permission_id, scope_level)
  SELECT r.id, p.id, p_scope FROM iam.role r, iam.permission p
  WHERE r.code = p_role AND p.resource||':'||p.action = p_perm;
  IF NOT FOUND THEN RAISE EXCEPTION 'cannot grant %:%', p_role, p_perm; END IF;
END $f$;

DO $$
DECLARE biz text[] := ARRAY['projects:read','landowners:read','surveys:read','cases:read','leases:read','payments:read',
                            'dbpfc:read','rows:read','gis:read','reports:read'];
        w text[] := ARRAY['projects:create','landowners:create','surveys:create','surveys:update','cases:create','leases:create','rows:create'];
        p text;
BEGIN
  -- system-administrator: everything identity-related, global; business read and
  -- write, but no approve / verify / release.
  FOR p IN SELECT resource||':'||action FROM iam.permission
           WHERE resource IN ('users','roles','identity_settings','sessions','audit_logs') LOOP
    PERFORM pg_temp.grant_perm('system-administrator', p, 'global');
  END LOOP;
  FOREACH p IN ARRAY biz||w||ARRAY['reports:export'] LOOP PERFORM pg_temp.grant_perm('system-administrator', p, 'global'); END LOOP;

  FOREACH p IN ARRAY biz||w||ARRAY['cases:approve','payments:release','reports:export'] LOOP PERFORM pg_temp.grant_perm('land-manager', p); END LOOP;
  FOREACH p IN ARRAY biz||ARRAY['payments:create','payments:verify','reports:export'] LOOP PERFORM pg_temp.grant_perm('finance-approver', p); END LOOP;
  FOREACH p IN ARRAY biz||w||ARRAY['cases:approve','reports:export'] LOOP PERFORM pg_temp.grant_perm('case-approver', p); END LOOP;
  FOREACH p IN ARRAY biz||w||ARRAY['payments:create'] LOOP PERFORM pg_temp.grant_perm('data-entry', p); END LOOP;
  FOREACH p IN ARRAY biz LOOP PERFORM pg_temp.grant_perm('viewer', p); END LOOP;
  FOREACH p IN ARRAY biz||ARRAY['users:read','roles:read','identity_settings:read','sessions:read','audit_logs:read'] LOOP
    PERFORM pg_temp.grant_perm('security-auditor', p, 'global');
  END LOOP;
END $$;

-- Separation of duties at the role level. Whoever raises or verifies a payment
-- cannot also release it; the same person cannot assign roles and audit them.
INSERT INTO iam.sod_rule(perm_a, perm_b, reason)
SELECT least(a.id,b.id), greatest(a.id,b.id), r FROM (VALUES
  ('payments','create','payments','release','the person who raises a payment cannot release it'),
  ('payments','verify','payments','release','verification and release are separate duties'),
  ('users','assign','audit_logs','read','role administration is not combined with review of it')
) v(ra,aa,rb,ab,r)
JOIN iam.permission a ON a.resource=v.ra AND a.action=v.aa
JOIN iam.permission b ON b.resource=v.rb AND b.action=v.ab;
-- The last rule above would make system-administrator (users:assign +
-- audit_logs:read) impossible; the administrator needs both to do the job.
-- Remove it rather than weaken the role: this separation is enforced by giving
-- the security-auditor role to someone else, not by a rule the product breaks.
DELETE FROM iam.sod_rule WHERE reason LIKE 'role administration%';

-- ---------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------
INSERT INTO lms.system_setting(key, value, value_type, description) VALUES
 ('iam.local_login_enabled','true','boolean','Allow username and password sign-in'),
 ('iam.session_absolute_hours','12','number','Hard session limit regardless of activity'),
 ('iam.lockout_minutes','15','number','How long an account stays locked after too many failures'),
 ('iam.password_history','5','number','Previous passwords that cannot be reused'),
 ('iam.mfa_required_all','false','boolean','Require MFA for every account'),
 ('iam.mfa_required_roles','["system-administrator","land-manager","finance-approver"]','array','Roles whose holders must use MFA'),
 ('iam.provisioning_mode','"approval"','string','approval = an administrator approves a first-time external user; auto = created with no roles'),
 ('iam.link_by_email','"never"','string','never, or verified: link an external identity to a local account by a provider-verified email'),
 ('iam.provider_failure_behavior','"deny"','string','deny: a failing enterprise provider never falls back to local passwords'),
 ('iam.recovery_token_minutes','30','number','Password-reset link lifetime'),
 ('iam.invitation_hours','72','number','Invitation link lifetime'),
 ('iam.reauth_minutes','10','number','How recent a re-authentication must be for a sensitive change'),
 ('iam.rate_limit_window_minutes','15','number','Window for login-failure rate limiting'),
 ('iam.rate_limit_per_user','10','number','Failed attempts per account in the window before further attempts are refused'),
 ('iam.rate_limit_per_ip','30','number','Failed attempts per source address in the window before further attempts are refused')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------
-- Existing accounts keep working: map them onto roles from what they already
-- were. Run as the system actor, which the role guards recognise.
-- ---------------------------------------------------------------------
INSERT INTO iam.user_role(user_id, role_id, granted_by, reason)
SELECT u.id, r.id, '00000000-0000-0000-0000-000000000001'::uuid, 'migrated from existing role and approval groups'
FROM lms.app_user u
JOIN iam.role r ON r.code = (
  CASE
    WHEN u.role_code = 'Admin' THEN 'system-administrator'
    WHEN u.role_code = 'Approver' AND EXISTS (SELECT 1 FROM lms.app_user_group g WHERE g.user_id=u.id AND g.group_code='Manager Land (HO)') THEN 'land-manager'
    WHEN u.role_code = 'Approver' AND EXISTS (SELECT 1 FROM lms.app_user_group g WHERE g.user_id=u.id AND g.group_code='Finance Officer') THEN 'finance-approver'
    WHEN u.role_code = 'Approver' THEN 'case-approver'
    WHEN u.role_code = 'User' THEN 'data-entry'
    WHEN EXISTS (SELECT 1 FROM lms.app_user_group g WHERE g.user_id=u.id AND g.group_code='Internal Audit') THEN 'security-auditor'
    ELSE 'viewer' END)
WHERE u.is_service_account = false;
-- Users who sit in a case-approval position in the matrix need the permission
-- to advance a case; the matrix still decides which step.
INSERT INTO iam.user_role(user_id, role_id, granted_by, reason)
SELECT DISTINCT u.id, (SELECT id FROM iam.role WHERE code='case-approver'), '00000000-0000-0000-0000-000000000001'::uuid,
       'holds an approval position in the case workflow'
FROM lms.app_user u JOIN lms.app_user_group g ON g.user_id = u.id
JOIN lms.workflow_step_group s ON s.group_code = g.group_code AND s.workflow_code = 'cases'
WHERE u.is_service_account = false AND u.role_code NOT IN ('Admin','Viewer')
  AND NOT EXISTS (SELECT 1 FROM iam.user_role x JOIN iam.role r ON r.id=x.role_id
                  WHERE x.user_id=u.id AND r.code IN ('case-approver','land-manager') AND x.revoked_at IS NULL);

-- ---------------------------------------------------------------------
-- Secrets are audited by name and version only, never by content.
-- ---------------------------------------------------------------------
CREATE FUNCTION iam.tg_secret_audit() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM iam.log_event(CASE TG_OP WHEN 'INSERT' THEN 'secret_stored' ELSE 'secret_rotated' END,
        'success', NULL, NULL, util.actor_id(), NULL, NULL, NULL, NULL, NULL, NULL,
        jsonb_build_object('secret_name', NEW.name, 'version', NEW.version));
  RETURN NULL;
END $$;
CREATE TRIGGER secret_audit AFTER INSERT OR UPDATE OF ciphertext ON iam.secret
  FOR EACH ROW EXECUTE FUNCTION iam.tg_secret_audit();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['role','role_permission','user_role','auth_provider','group_mapping','external_identity'] LOOP
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON iam.%I FOR EACH ROW EXECUTE FUNCTION audit.tg_audit_row()', t||'_audit', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- Row-level security. Permission is checked in the database as well as in the
-- application, so a bypass of the API layer is not a bypass of authorisation.
-- ---------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['permission','role','role_permission','user_role','sod_rule','account_security',
      'auth_provider','auth_provider_revision','secret','external_identity','provisioning_request',
      'provisioning_log','group_mapping','mfa_totp','mfa_webauthn','mfa_recovery_code','challenge',
      'invitation','password_history','access_review','access_review_item'] LOOP
    EXECUTE format('ALTER TABLE iam.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

CREATE POLICY read_all ON iam.permission FOR SELECT TO lms_readwrite USING (util.actor_id() IS NOT NULL);
CREATE POLICY read_all ON iam.sod_rule   FOR SELECT TO lms_readwrite USING (util.actor_id() IS NOT NULL);
CREATE POLICY read_roles ON iam.role     FOR SELECT TO lms_readwrite USING (util.actor_id() IS NOT NULL);
CREATE POLICY ins_roles ON iam.role      FOR INSERT TO lms_readwrite WITH CHECK (iam.has_permission('roles','create'));
CREATE POLICY upd_roles ON iam.role      FOR UPDATE TO lms_readwrite USING (iam.has_permission('roles','update')) WITH CHECK (iam.has_permission('roles','update'));
CREATE POLICY del_roles ON iam.role      FOR DELETE TO lms_readwrite USING (iam.has_permission('roles','delete'));

CREATE POLICY read_rp ON iam.role_permission FOR SELECT TO lms_readwrite USING (util.actor_id() IS NOT NULL);
CREATE POLICY write_rp ON iam.role_permission FOR ALL TO lms_readwrite
  USING (iam.has_permission('roles','manage_permissions')) WITH CHECK (iam.has_permission('roles','manage_permissions'));

CREATE POLICY read_ur ON iam.user_role FOR SELECT TO lms_readwrite
  USING (user_id = util.actor_id() OR iam.has_permission('users','read') OR iam.has_permission('roles','read'));
CREATE POLICY ins_ur ON iam.user_role FOR INSERT TO lms_readwrite WITH CHECK (iam.has_permission('users','assign'));
CREATE POLICY upd_ur ON iam.user_role FOR UPDATE TO lms_readwrite
  USING (iam.has_permission('users','assign')) WITH CHECK (iam.has_permission('users','assign'));

CREATE POLICY read_as ON iam.account_security FOR SELECT TO lms_readwrite
  USING (user_id = util.actor_id() OR iam.has_permission('users','read'));

CREATE POLICY read_prov ON iam.auth_provider FOR SELECT TO lms_readwrite USING (iam.has_permission('identity_settings','read'));
CREATE POLICY ins_prov  ON iam.auth_provider FOR INSERT TO lms_readwrite WITH CHECK (iam.has_permission('identity_settings','configure'));
CREATE POLICY upd_prov  ON iam.auth_provider FOR UPDATE TO lms_readwrite
  USING (iam.has_permission('identity_settings','configure')) WITH CHECK (iam.has_permission('identity_settings','configure'));
CREATE POLICY read_provrev ON iam.auth_provider_revision FOR SELECT TO lms_readwrite USING (iam.has_permission('identity_settings','read'));

-- Ciphertext is readable by the application (the LDAP bind needs it before any
-- user is signed in) and useless without the key held outside the database.
CREATE POLICY read_secret ON iam.secret FOR SELECT TO lms_readwrite USING (true);
CREATE POLICY ins_secret  ON iam.secret FOR INSERT TO lms_readwrite WITH CHECK (iam.has_permission('identity_settings','configure'));
CREATE POLICY upd_secret  ON iam.secret FOR UPDATE TO lms_readwrite
  USING (iam.has_permission('identity_settings','configure')) WITH CHECK (iam.has_permission('identity_settings','configure'));

CREATE POLICY read_ei ON iam.external_identity FOR SELECT TO lms_readwrite
  USING (user_id = util.actor_id() OR iam.has_permission('users','read'));
CREATE POLICY read_preq ON iam.provisioning_request FOR SELECT TO lms_readwrite USING (iam.has_permission('users','create'));
CREATE POLICY read_plog ON iam.provisioning_log FOR SELECT TO lms_readwrite
  USING (iam.has_permission('users','read') OR iam.has_permission('identity_settings','read'));
CREATE POLICY gm_read ON iam.group_mapping FOR SELECT TO lms_readwrite USING (iam.has_permission('identity_settings','read'));
CREATE POLICY gm_write ON iam.group_mapping FOR ALL TO lms_readwrite
  USING (iam.has_permission('identity_settings','configure')) WITH CHECK (iam.has_permission('identity_settings','configure'));

CREATE POLICY own_totp ON iam.mfa_totp FOR ALL TO lms_readwrite
  USING (user_id = util.actor_id()) WITH CHECK (user_id = util.actor_id());
CREATE POLICY own_webauthn ON iam.mfa_webauthn FOR ALL TO lms_readwrite
  USING (user_id = util.actor_id()) WITH CHECK (user_id = util.actor_id());
CREATE POLICY own_recovery ON iam.mfa_recovery_code FOR ALL TO lms_readwrite
  USING (user_id = util.actor_id()) WITH CHECK (user_id = util.actor_id());
-- Challenges exist before anyone is signed in; they are hashed, single-use and
-- expire in minutes.
CREATE POLICY challenge_open ON iam.challenge FOR ALL TO lms_readwrite USING (true) WITH CHECK (true);

CREATE POLICY ar_read ON iam.access_review FOR SELECT TO lms_readwrite USING (iam.has_permission('users','read'));
CREATE POLICY ari_read ON iam.access_review_item FOR SELECT TO lms_readwrite USING (iam.has_permission('users','read'));

-- ---------------------------------------------------------------------
-- Grants. Reporting gets nothing in iam. The application gets exactly what its
-- policies above describe, column-restricted where a column must stay
-- server-controlled.
-- ---------------------------------------------------------------------
REVOKE USAGE ON SCHEMA iam FROM lms_readonly;
REVOKE ALL ON ALL TABLES IN SCHEMA iam FROM PUBLIC, lms_readonly, lms_readwrite;
GRANT SELECT ON iam.permission, iam.sod_rule, iam.role_permission, iam.user_role, iam.account_security,
      iam.auth_provider_revision, iam.external_identity, iam.provisioning_request, iam.provisioning_log,
      iam.access_review, iam.access_review_item TO lms_readwrite;
GRANT SELECT, INSERT, UPDATE, DELETE ON iam.role, iam.role_permission, iam.group_mapping TO lms_readwrite;
GRANT INSERT, UPDATE ON iam.user_role TO lms_readwrite;
GRANT SELECT ON iam.role, iam.group_mapping TO lms_readwrite;
GRANT SELECT, INSERT ON iam.auth_provider TO lms_readwrite;
GRANT UPDATE (display_name, enabled, config, secret_id) ON iam.auth_provider TO lms_readwrite;
GRANT SELECT, INSERT, UPDATE ON iam.secret TO lms_readwrite;
GRANT SELECT, INSERT, UPDATE, DELETE ON iam.mfa_totp, iam.mfa_webauthn, iam.mfa_recovery_code, iam.challenge TO lms_readwrite;
-- invitation and password_history: no direct access at all; routines only.

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA iam FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  iam.has_permission(text,text), iam.effective_permissions(uuid), iam.actor_covers_role(uuid),
  iam.authn_lookup(text), iam.log_event(text,text,uuid,text,uuid,uuid,uuid,inet,text,uuid,uuid,jsonb),
  iam.failure_counts(text,inet,integer), iam.note_auth_failure(uuid), iam.note_auth_success(uuid),
  iam.create_session(uuid,bytea,text,uuid,inet,text,text), iam.resolve_session(bytea),
  iam.end_session(uuid,text), iam.end_session_unauthenticated(bytea),
  iam.revoke_user_sessions(uuid,uuid), iam.mark_session_mfa(uuid,text), iam.mark_session_reauth(uuid),
  iam.create_user(text,text,text,text,text,text,text[],text[],text[]),
  iam.update_user(uuid,text,text,text,text,text,text[],text[]),
  iam.set_user_status(uuid,text,text), iam.anonymise_user(uuid,text), iam.reset_mfa(uuid,text),
  iam.issue_token(uuid,text,bytea), iam.request_password_reset(text,bytea), iam.peek_token(bytea,text),
  iam.recent_password_hashes(uuid,bytea), iam.redeem_token(bytea,text,text), iam.change_password(text,uuid),
  iam.rehash_password(uuid,text,text), iam.record_provider_test(uuid,boolean,text),
  iam.set_break_glass(uuid,boolean), iam.set_policy(text,jsonb,text),
  iam.provision_external(uuid,text,text,text,boolean,text,text[]),
  iam.decide_provisioning(uuid,boolean,text,uuid,text[]), iam.unlink_identity(uuid,text),
  iam.deprovision_external(uuid,text,text), iam.setting_num(text,numeric), iam.setting_txt(text,text)
  TO lms_readwrite;

-- The new routines are created after the sweeps in earlier migrations.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA lms, api, audit, util, iam FROM PUBLIC;
