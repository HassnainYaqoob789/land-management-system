-- role: lms_test
-- tx: rollback
--
-- 0041, as the application sees it: the system account cannot be assumed,
-- the tier follows IAM, identity tables change only through the routines,
-- delegation and separation of duties hold, settings are validated, scope
-- is honoured, challenges are sealed, and the maintenance routines check
-- permissions. (Checks that need other logins are in test_19_session_trust.py.)
\set QUIET on

DO $$
DECLARE
  fx record; v_sys uuid := '00000000-0000-0000-0000-000000000001';
  v_role uuid; v_scoped uuid; v_ur uuid; v_new uuid; v_ch uuid; v_left integer; v_n integer;
  v_tok bytea := sha256('t19-challenge-token'::bytea);
BEGIN
  SELECT * INTO fx FROM test.fixtures;

  -- ---------- the system account cannot be assumed from the application ----------
  PERFORM test.throws(format($q$ SELECT api.set_actor(%L) $q$, v_sys), '28000',
    'the application cannot make the system account its actor');
  PERFORM set_config('lms.actor_id', v_sys::text, true);           -- the raw parameter, no routine
  PERFORM test.ok(NOT test.is_system_actor(), 'setting the parameter by hand does not make a system actor');
  PERFORM test.ok(lms.actor_role() IS NULL, 'and gives no database tier');
  PERFORM test.eq((SELECT count(*)::integer FROM lms.landowner), 0, 'so row-level security shows nothing');
  PERFORM set_config('lms.actor_proof', repeat('ab', 32), true);
  PERFORM test.ok(NOT test.is_system_actor(), 'a forged proof is not accepted');
  PERFORM test.throws($q$ SELECT iam.enter_system_context() $q$, '42501', 'the system context cannot be entered directly');
  PERFORM test.throws($q$ SELECT iam.context_proof('00000000-0000-0000-0000-000000000001') $q$, '42501',
    'and its proof cannot be computed by the application');
  PERFORM test.throws($q$ SELECT * FROM iam.internal_key $q$, '42501', 'nor its key read');

  -- ---------- MFA follows sensitive permissions (before this test grants anything) ----------
  PERFORM test.ok(iam.mfa_required_for(fx.u_lofield), 'data entry approves mutations (a sensitive permission): MFA required');
  PERFORM test.ok(iam.mfa_required_for(fx.u_admin), 'an administrator: MFA required');
  PERFORM test.ok(NOT iam.mfa_required_for(fx.u_viewer), 'a read-only account: not required by policy');

  -- ---------- the tier follows IAM ----------
  PERFORM test.become('lofield');
  PERFORM test.eq(lms.actor_role(), 'User', 'data entry sits in the User tier through its role');
  PERFORM test.become('mland');
  PERFORM test.eq(lms.actor_role(), 'Approver', 'the land manager in the Approver tier');

  -- ---------- identity tables are written only by the routines ----------
  PERFORM test.become('admin');
  PERFORM test.throws($q$ UPDATE lms.app_user SET role_code = 'Admin' WHERE username = 'viewer' $q$, '42501',
    'an administrator cannot raise a tier with a direct update');
  PERFORM test.throws($q$ UPDATE lms.app_user SET full_name = 'Renamed' WHERE username = 'viewer' $q$, '42501',
    'nor edit an account outside the identity routines');
  PERFORM test.throws($q$ INSERT INTO lms.app_user_group (user_id, group_code)
                         SELECT id, 'Manager Land (HO)' FROM lms.app_user WHERE username = 'viewer' $q$, '42501',
    'nor hand out an approval position directly');
  PERFORM test.throws($q$ DELETE FROM lms.app_user_province WHERE user_id = (SELECT id FROM lms.app_user WHERE username = 'lofield') $q$,
    '42501', 'nor remove province access directly');

  -- ---------- approval positions are delegated authority ----------
  PERFORM test.throws_like(format($q$ SELECT iam.update_user(%L, NULL, NULL, NULL, NULL, NULL, NULL,
                                       ARRAY['System Administrator','Manager Land (HO)']) $q$, fx.u_admin),
    '%your own%', 'an administrator cannot give itself an approval position');
  PERFORM test.throws_like(format($q$ SELECT iam.update_user(%L, NULL, NULL, NULL, NULL, NULL, '{SND}', NULL) $q$, fx.u_admin),
    '%your own%', 'nor change its own province access');
  -- Another administrator may not hold a position either.
  v_new := iam.create_user('t19-admin2', 'Second administrator', NULL, 'IT', 'Administrator', NULL, '{SND}', '{}',
                           '{system-administrator}');
  PERFORM test.throws_like(format($q$ SELECT iam.update_user(%L, NULL, NULL, NULL, NULL, NULL, NULL, ARRAY['Manager Land (HO)']) $q$, v_new),
    '%separation of duties%', 'a system administrator cannot be given an approval position');
  PERFORM test.throws_like(format($q$ INSERT INTO iam.user_role (user_id, role_id, reason)
                                     SELECT %L, id, 'x' FROM iam.role WHERE code = 'system-administrator' $q$, fx.u_mland),
    '%separation of duties%', 'and an officer with an approval position cannot become a system administrator');
  -- Positions need users:assign, not just users:update.
  INSERT INTO iam.role (code, name, description, db_role_code)
  VALUES ('t19-user-editor', 'T19 user editor', 'users:update without assign', 'Viewer') RETURNING id INTO v_role;
  INSERT INTO iam.role_permission (role_id, permission_id, scope_level)
  SELECT v_role, id, 'global' FROM iam.permission WHERE resource = 'users' AND action IN ('update', 'read');
  INSERT INTO iam.user_role (user_id, role_id, reason) VALUES (fx.u_audit, v_role, 'editor without assign');
  PERFORM test.become('audit');
  PERFORM iam.update_user(fx.u_viewer, 'Viewer (renamed by t19)', NULL, NULL, NULL, NULL, NULL, NULL);
  PERFORM test.eq((SELECT full_name FROM lms.app_user WHERE id = fx.u_viewer), 'Viewer (renamed by t19)',
    'users:update edits a profile');
  PERFORM test.throws_like(format($q$ SELECT iam.update_user(%L, NULL, NULL, NULL, NULL, NULL, NULL, ARRAY['Legal Advisor']) $q$, fx.u_viewer),
    '%users:assign%', 'but approval positions need users:assign');

  -- ---------- assignments: honest records, no edits, no deletes ----------
  PERFORM test.become('admin');
  -- A permission the administrator holds (0047 removed its business permissions; a grant needs the granter to hold it).
  INSERT INTO iam.role (code, name, description, db_role_code)
  VALUES ('t19-scoped', 'T19 scoped', 'province-limited grant test', 'User') RETURNING id INTO v_scoped;
  INSERT INTO iam.role_permission (role_id, permission_id, scope_level)
  SELECT v_scoped, id, 'province' FROM iam.permission WHERE resource = 'reports' AND action = 'share';
  PERFORM test.throws_like(format($q$ INSERT INTO iam.user_role (user_id, role_id, reason) VALUES (%L, %L, 'x') $q$, v_sys, v_scoped),
    '%service account%', 'a role cannot be given to a service account');
  PERFORM test.throws_like(format($q$ INSERT INTO iam.user_role (user_id, role_id, reason, expires_at) VALUES (%L, %L, 'x', now() - interval '1 day') $q$,
                                  fx.u_viewer, v_scoped),
    '%future%', 'an assignment cannot start out expired');
  PERFORM test.throws_like(format($q$ INSERT INTO iam.user_role (user_id, role_id, reason, expires_at)
                                     SELECT %L, id, 'x', now() + interval '1 day' FROM iam.role WHERE code = 'system-administrator' $q$, fx.u_viewer),
    '%time-limited%', 'a system administrator grant cannot be time-limited');
  PERFORM test.throws_like(format($q$ INSERT INTO iam.user_role (user_id, role_id, reason, scope_province) VALUES (%L, %L, 'x', 'KPK') $q$,
                                  fx.u_lofield, v_scoped),
    '%no access to province%', 'a grant cannot be limited to a province the account cannot see');
  INSERT INTO iam.user_role (user_id, role_id, reason, granted_by, expires_at)
  VALUES (fx.u_lofield, v_scoped, 'scoped grant for t19', fx.u_viewer, now() + interval '30 days') RETURNING id INTO v_ur;
  PERFORM test.eq((SELECT granted_by FROM iam.user_role WHERE id = v_ur), fx.u_admin,
    'the grantor is recorded as the actor, whatever the caller says');
  PERFORM test.throws_like(format($q$ UPDATE iam.user_role SET expires_at = now() + interval '5 years' WHERE id = %L $q$, v_ur),
    '%cannot be edited%', 'an expiry cannot be extended in place');
  PERFORM test.throws_like(format($q$ UPDATE iam.user_role SET granted_by = %L WHERE id = %L $q$, fx.u_mland, v_ur),
    '%cannot be edited%', 'nor the grantor rewritten');
  PERFORM test.throws(format($q$ DELETE FROM iam.user_role WHERE id = %L $q$, v_ur),
    '42501', 'and an assignment is never deleted');
  UPDATE iam.user_role SET revoked_at = now() - interval '1 year', revoked_by = fx.u_viewer, revoke_reason = 'end of t19'
   WHERE id = v_ur;
  PERFORM test.eq((SELECT revoked_by FROM iam.user_role WHERE id = v_ur), fx.u_admin,
    'the revoker is recorded as the actor');
  PERFORM test.ok((SELECT revoked_at > now() - interval '1 minute' FROM iam.user_role WHERE id = v_ur),
    'and the revocation time is the database''s');
  PERFORM test.eq((SELECT reason FROM iam.user_role WHERE id = v_ur), 'scoped grant for t19',
    'the reason for the grant is kept beside the reason for the revocation');
  PERFORM test.throws_like(format($q$ UPDATE iam.user_role SET revoked_at = now(), revoke_reason = 'x'
                                     WHERE user_id = %L AND revoked_at IS NULL
                                       AND role_id = (SELECT id FROM iam.role WHERE code = 'system-administrator') $q$, fx.u_admin),
    '%your own system administrator%', 'an administrator cannot remove its own administrator role');

  -- ---------- scope: a province-limited grant covers that province only ----------
  INSERT INTO iam.user_role (user_id, role_id, reason, scope_province) VALUES (fx.u_lobal, v_scoped, 'scoped to BAL', 'BAL');
  PERFORM test.become('loquetta');
  PERFORM test.ok(iam.has_permission_in('reports', 'share', 'BAL'), 'a grant limited to Balochistan covers Balochistan');
  PERFORM test.ok(NOT iam.has_permission_in('reports', 'share', 'SND'), 'and not Sindh');
  PERFORM test.throws($q$ SELECT iam.require_in('reports', 'share', 'SND') $q$, '42501', 'require_in refuses outside the scope');
  PERFORM test.become('lofield');
  PERFORM test.ok(iam.has_permission_in('landowners', 'read', 'SND'), 'a province-level permission covers the officer''s province');
  PERFORM test.ok(NOT iam.has_permission_in('landowners', 'read', 'KPK'), 'and not a province the officer cannot see');
  PERFORM test.ok(NOT iam.has_permission_in('payments', 'release', 'SND'), 'nor a permission the officer does not hold');

  -- ---------- roles: tier and system flag ----------
  PERFORM test.become('admin');
  PERFORM test.throws_like(format($q$ UPDATE iam.role SET is_system = true WHERE id = %L $q$, v_scoped),
    '%system role%', 'a custom role cannot be promoted to a system role');
  PERFORM test.throws_like(format($q$ UPDATE iam.role_permission SET role_id = %L
                                     WHERE role_id = (SELECT id FROM iam.role WHERE code = 'system-administrator')
                                       AND permission_id = (SELECT id FROM iam.permission WHERE resource = 'users' AND action = 'assign') $q$, v_scoped),
    '%cannot be moved%', 'a permission cannot be moved out of a system role');
  -- Tier: a Viewer-tier role maker cannot create an Approver-tier role.
  INSERT INTO iam.role (code, name, description, db_role_code)
  VALUES ('t19-role-maker', 'T19 role maker', 'roles:create at Viewer tier', 'Viewer') RETURNING id INTO v_role;
  INSERT INTO iam.role_permission (role_id, permission_id, scope_level)
  SELECT v_role, id, 'global' FROM iam.permission WHERE resource = 'roles' AND action IN ('create', 'read');
  INSERT INTO iam.user_role (user_id, role_id, reason) VALUES (fx.u_viewer, v_role, 'tier test');
  PERFORM test.become('viewer');
  PERFORM test.eq(lms.actor_role(), 'Viewer', 'the role maker is in the Viewer tier');
  PERFORM test.throws_like($q$ INSERT INTO iam.role (code, name, description, db_role_code) VALUES ('t19-approver', 'x', 'x', 'Approver') $q$,
    '%above your own database tier%', 'and cannot create a role above its own tier');

  -- ---------- account status ----------
  PERFORM test.become('admin');
  PERFORM iam.set_user_status(v_new, 'Deactivated', 'leaver in t19');
  PERFORM test.throws_like(format($q$ SELECT iam.set_user_status(%L, 'Active', 'bring them back') $q$, v_new),
    '%permanent%', 'deactivation is permanent');
  PERFORM test.throws_like(format($q$ SELECT iam.set_user_status(%L, 'Suspended', 'touch the system account') $q$, v_sys),
    '%service account%', 'a service account''s status is not changed here');
  PERFORM test.throws_like(format($q$ INSERT INTO iam.user_role (user_id, role_id, reason) VALUES (%L, %L, 'x') $q$, v_new, v_scoped),
    '%deactivated%', 'and a deactivated account gets no new roles');

  -- ---------- settings ----------
  PERFORM test.throws_like($q$ SELECT api.set_setting('security.session_minutes', '600000'::jsonb) $q$,
    '%iam.set_policy%', 'security settings cannot go through the general settings routine');
  PERFORM test.throws_like($q$ SELECT api.set_setting('workflow.admin_override', 'true'::jsonb) $q$,
    '%iam.set_policy%', 'nor the approval override');
  PERFORM test.throws_like($q$ SELECT api.set_setting('finance.wht_pct', '"ten"'::jsonb) $q$,
    '%must be a number%', 'a value of the wrong type is refused');
  PERFORM test.throws_like($q$ SELECT api.set_setting('finance.wht_pct', '250'::jsonb) $q$,
    '%0 to 100%', 'an out-of-range value is refused');
  PERFORM test.throws_like($q$ SELECT iam.set_policy('workflow.admin_override', 'true'::jsonb, 'try it') $q$,
    '%disabled%', 'the approval override cannot be switched on');
  PERFORM test.throws_like($q$ SELECT iam.set_policy('iam.rate_limit_per_user', '"lots"'::jsonb, 'try it') $q$,
    '%3 to 100%', 'a non-numeric rate limit is refused (it would break every sign-in)');
  PERFORM test.throws_like($q$ SELECT iam.set_policy('iam.not_a_setting', '1'::jsonb, 'try it') $q$,
    '%unknown setting%', 'an unknown identity setting is refused');
  PERFORM iam.set_policy('security.session_minutes', '45'::jsonb, 'shorter idle timeout');
  PERFORM test.eq((SELECT value FROM lms.system_setting WHERE key = 'security.session_minutes'), '45'::jsonb,
    'a valid security setting is applied through iam.set_policy');

  -- ---------- read access follows permissions ----------
  PERFORM test.become('lofield');
  PERFORM test.eq((SELECT count(*)::integer FROM lms.app_user), 1, 'an officer sees only their own account');
  PERFORM test.become('audit');    -- 0047: the security auditor is the audit account
  PERFORM test.ok((SELECT count(*) FROM lms.app_user) > 5, 'the security auditor (users:read) sees every account');
  PERFORM test.ok((SELECT count(*) FROM lms.app_user_province) > 5, 'and their province access');

  -- ---------- sign-in challenges are sealed ----------
  PERFORM test.throws($q$ SELECT count(*) FROM iam.challenge $q$, '42501', 'the challenge table cannot be read directly');
  PERFORM test.throws($q$ UPDATE iam.challenge SET attempts = 0 $q$, '42501', 'nor its attempt counter reset');
  PERFORM test.unbecome();
  PERFORM test.throws($q$ SELECT iam.challenge_issue('\x00'::bytea, 'mfa_login', NULL, '{}', 300) $q$, '22023',
    'a challenge is stored only as a SHA-256 digest');
  PERFORM test.throws(format($q$ SELECT iam.challenge_issue(%L, 'mfa_login', NULL, '{}', 300) $q$, v_tok), '22023',
    'an MFA challenge belongs to an account');
  v_ch := iam.challenge_issue(v_tok, 'mfa_login', fx.u_lofield, '{"method":"local"}', 300);
  PERFORM test.eq((SELECT user_id FROM iam.challenge_find(v_tok, 'mfa_login')), fx.u_lofield, 'a live challenge is found by its digest');
  PERFORM test.ok(NOT EXISTS (SELECT 1 FROM iam.challenge_find(v_tok, 'webauthn_login')), 'only for its own purpose');
  FOR v_n IN 1..4 LOOP v_left := iam.challenge_fail(v_ch); END LOOP;
  PERFORM test.eq(v_left, 1, 'four wrong answers leave one attempt');
  PERFORM test.eq(iam.challenge_fail(v_ch), 0, 'the fifth burns the challenge');
  PERFORM test.ok(NOT EXISTS (SELECT 1 FROM iam.challenge_find(v_tok, 'mfa_login')), 'which can no longer be found');
  PERFORM test.ok(NOT iam.challenge_consume(v_ch), 'or used');
  v_ch := iam.challenge_issue(sha256('t19-second'::bytea), 'oidc_state', NULL, '{"nonce":"n"}', 120);
  PERFORM test.eq((SELECT data->>'nonce' FROM iam.challenge_take(sha256('t19-second'::bytea), 'oidc_state')), 'n',
    'a state challenge is taken once');
  PERFORM test.ok(NOT EXISTS (SELECT 1 FROM iam.challenge_take(sha256('t19-second'::bytea), 'oidc_state')),
    'and a replay finds nothing');

  -- ---------- maintenance routines check permissions ----------
  PERFORM test.become('lofield');
  PERFORM test.throws($q$ SELECT api.reconcile('all') $q$, '42501', 'reconciliation needs a finance permission');
  PERFORM test.throws($q$ SELECT * FROM api.refresh_derived() $q$, '42501', 'refreshing derived data needs settings:update');
  PERFORM test.throws($q$ SELECT * FROM api.outbox_next('erp_finance') $q$, '42501', 'only the integration worker reads the outbox');
  PERFORM test.unbecome();
  PERFORM test.ok(lms.user_full_name(fx.u_admin) IS NULL, 'names are not looked up without an actor');
  PERFORM test.become('lofield');
  PERFORM test.ok(lms.user_full_name(fx.u_admin) IS NOT NULL, 'but are for a signed-in actor (audit trails)');
END $$;
