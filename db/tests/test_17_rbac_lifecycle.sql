-- role: lms_owner
-- tx: rollback
-- actor: admin
--
-- 0039: role lifecycle (active / inactive / retired), the last-administrator
-- rule, sensitive-data permission, passkey counter and the keep-one-way-in
-- guard, and what the sign-in page may learn about providers. Run as the
-- table owner so setup can touch protected columns; every rule under test is
-- a trigger or a definer routine, which apply to the owner too, and access is
-- asserted through iam.has_permission as the acting user.
\set QUIET on

DO $$
DECLARE
  v_admin uuid; v_viewer uuid; v_audit uuid; v_lofield uuid; v_second uuid;
  v_role uuid; v_ur uuid; v_tool uuid;
  v_sys uuid := '00000000-0000-0000-0000-000000000001';
  v_cred bytea := decode('0a0b0c0d0e0f', 'hex');
BEGIN
  SELECT id INTO v_admin FROM lms.app_user WHERE username = 'admin';
  SELECT id INTO v_viewer FROM lms.app_user WHERE username = 'viewer';
  SELECT id INTO v_audit FROM lms.app_user WHERE username = 'audit';
  SELECT id INTO v_lofield FROM lms.app_user WHERE username = 'lofield';

  -- ---------- lifecycle ----------
  INSERT INTO iam.role (code, name, description, db_role_code)
  VALUES ('test-exporter', 'Test exporter', 'lifecycle test', 'Viewer') RETURNING id INTO v_role;
  INSERT INTO iam.role_permission (role_id, permission_id, scope_level)
  SELECT v_role, id, 'global' FROM iam.permission WHERE resource = 'reports' AND action = 'export';
  INSERT INTO iam.user_role (user_id, role_id, reason) VALUES (v_viewer, v_role, 'lifecycle test') RETURNING id INTO v_ur;

  PERFORM api.set_actor(v_viewer);
  PERFORM test.ok(iam.has_permission('reports', 'export'), 'an active role grants its permissions');

  PERFORM api.set_actor(v_admin);
  PERFORM iam.set_role_status('test-exporter', 'inactive', 'suspended for the test');
  PERFORM api.set_actor(v_viewer);
  PERFORM test.ok(NOT iam.has_permission('reports', 'export'), 'an inactive role grants nothing, from the next check');
  PERFORM test.eq((SELECT count(*) FROM iam.effective_permissions(v_viewer) WHERE role_code = 'test-exporter')::int, 0,
                  'and is absent from the effective permissions');

  PERFORM api.set_actor(v_admin);
  PERFORM test.throws_like(
    $q$ INSERT INTO iam.user_role (user_id, role_id, reason)
        SELECT u.id, r.id, 'x' FROM lms.app_user u, iam.role r WHERE u.username = 'lofield' AND r.code = 'test-exporter' $q$,
    '%cannot be assigned%', 'an inactive role cannot be assigned');
  PERFORM iam.set_role_status('test-exporter', 'active', 'back in service');
  PERFORM test.throws_like($q$ SELECT iam.set_role_status('test-exporter', 'retired', 'retire it now') $q$,
    '%still has members%', 'a role with members cannot be retired');
  UPDATE iam.user_role SET revoked_at = now(), revoke_reason = 'end of lifecycle test' WHERE id = v_ur;
  PERFORM iam.set_role_status('test-exporter', 'retired', 'no longer needed');
  PERFORM test.eq((SELECT status FROM iam.role WHERE id = v_role), 'retired', 'the role is retired');
  PERFORM test.throws_like($q$ UPDATE iam.role SET name = 'renamed' WHERE code = 'test-exporter' $q$,
    '%retired%', 'a retired role cannot be edited');
  PERFORM test.throws_like(
    $q$ INSERT INTO iam.user_role (user_id, role_id, reason)
        SELECT u.id, r.id, 'x' FROM lms.app_user u, iam.role r WHERE u.username = 'lofield' AND r.code = 'test-exporter' $q$,
    '%cannot be assigned%', 'a retired role cannot be assigned');
  PERFORM test.throws($q$ SELECT iam.set_role_status('system-administrator', 'inactive', 'should not work') $q$,
    '42501', 'a system role cannot be suspended');
  PERFORM test.throws_like($q$ SELECT iam.set_role_status('test-exporter', 'active', 'bring it back') $q$,
    '%retired%', 'and a retired role cannot be revived');

  -- Status changes need roles:update; a viewer cannot.
  PERFORM api.set_actor(v_viewer);
  PERFORM test.throws($q$ SELECT iam.set_role_status('data-entry', 'inactive', 'nope nope') $q$, '42501',
    'changing a role''s status needs roles:update');

  -- ---------- last administrator ----------
  -- A helper role (users:update + users:assign, no administrator rights)
  -- held by the auditor, who then tries to lock the only administrator out.
  PERFORM api.set_actor(v_admin);
  INSERT INTO iam.role (code, name, description, db_role_code)
  VALUES ('test-user-admin', 'Test user admin', 'last-admin test', 'Viewer') RETURNING id INTO v_tool;
  INSERT INTO iam.role_permission (role_id, permission_id, scope_level)
  SELECT v_tool, id, 'global' FROM iam.permission WHERE resource = 'users' AND action IN ('update', 'assign', 'read');
  INSERT INTO iam.user_role (user_id, role_id, reason) VALUES (v_audit, v_tool, 'last-admin test');

  PERFORM api.set_actor(v_audit);
  PERFORM test.throws_like(format($q$ SELECT iam.set_user_status(%L, 'Suspended', 'lock the admin out') $q$, v_admin),
    '%last active system administrator%', 'the last working administrator cannot be suspended');
  PERFORM test.throws_like(format($q$ SELECT iam.set_user_status(%L, 'Deactivated', 'lock the admin out') $q$, v_admin),
    '%last active system administrator%', 'nor deactivated');
  PERFORM test.throws_like(
    format($q$ UPDATE iam.user_role SET revoked_at = now(), revoke_reason = 'remove the admin'
              WHERE user_id = %L AND role_id = (SELECT id FROM iam.role WHERE code = 'system-administrator') $q$, v_admin),
    '%last active system administrator%', 'nor have the role revoked');

  -- With a second working administrator, the first can be suspended. (Not
  -- lofield: an approval position and system administration do not mix.)
  PERFORM api.set_actor(v_admin);
  v_second := iam.create_user('t17-second-admin', 'Second administrator', NULL, 'IT', 'Administrator', NULL,
                              '{SND}', '{}', '{system-administrator}');
  UPDATE lms.app_user SET password_hash = (SELECT password_hash FROM lms.app_user WHERE id = v_admin)
   WHERE id = v_second;   -- a way to sign in
  PERFORM api.set_actor(v_sys);
  PERFORM test.throws_like(format($q$ INSERT INTO iam.user_role (user_id, role_id, reason)
                                     SELECT %L, id, 'x' FROM iam.role WHERE code = 'system-administrator' $q$, v_lofield),
    '%separation of duties%', 'an officer holding an approval position cannot also be a system administrator');
  PERFORM api.set_actor(v_audit);
  PERFORM iam.set_user_status(v_admin, 'Suspended', 'another administrator exists');
  PERFORM test.eq((SELECT status FROM lms.app_user WHERE id = v_admin), 'Suspended', 'suspension allowed once another administrator works');

  -- ---------- sensitive personal data ----------
  PERFORM api.set_actor(v_lofield);
  PERFORM test.ok(iam.has_permission('pii', 'read'), 'data entry sees full CNICs (pii:read)');
  PERFORM api.set_actor(v_viewer);
  PERFORM test.ok(NOT iam.has_permission('pii', 'read'), 'the security auditor sees them masked');

  -- ---------- passkeys ----------
  PERFORM api.set_actor(v_viewer);
  INSERT INTO iam.mfa_webauthn (user_id, credential_id, public_key, sign_count, transports, label)
  VALUES (v_viewer, v_cred, decode('00', 'hex'), 5, '{internal}', 'test key');
  PERFORM iam.passkey_record_use(v_cred, 6);
  PERFORM test.eq((SELECT sign_count FROM iam.passkey_lookup(v_cred)), 6::bigint, 'the counter advances and is stored');
  PERFORM test.throws_like(format($q$ SELECT iam.passkey_record_use(%L::bytea, 6) $q$, v_cred),
    '%did not advance%', 'a counter that does not advance is refused (cloned authenticator)');
  PERFORM test.eq((SELECT username FROM iam.passkey_lookup(v_cred)), 'viewer', 'lookup names the owner');
  PERFORM test.ok(NOT EXISTS (SELECT 1 FROM iam.passkey_lookup(decode('ffff', 'hex'))), 'an unknown credential finds nothing');

  -- With a password, the passkey can go; without one, the last passkey stays.
  UPDATE lms.app_user SET password_hash = NULL WHERE id = v_viewer;
  PERFORM test.throws_like(format($q$ DELETE FROM iam.mfa_webauthn WHERE credential_id = %L::bytea $q$, v_cred),
    '%only way to sign in%', 'the only way to sign in cannot be removed');
  INSERT INTO iam.mfa_webauthn (user_id, credential_id, public_key, sign_count, transports, label)
  VALUES (v_viewer, decode('0102', 'hex'), decode('00', 'hex'), 0, '{usb}', 'second key');
  DELETE FROM iam.mfa_webauthn WHERE credential_id = v_cred;
  PERFORM test.ok(NOT EXISTS (SELECT 1 FROM iam.mfa_webauthn WHERE credential_id = v_cred), 'with a second passkey the first can be removed');

  -- ---------- what the sign-in page may learn ----------
  PERFORM api.set_actor(v_second);    -- the remaining administrator (the original one is suspended above)
  INSERT INTO iam.auth_provider (kind, name, display_name, config) VALUES ('saml', 'test-saml', 'Test SAML', '{}'::jsonb);
  PERFORM test.ok(EXISTS (SELECT 1 FROM iam.signin_methods() WHERE name = 'test-saml' AND NOT available),
    'a provider that has not passed its test is listed as unavailable');
  PERFORM test.ok(NOT EXISTS (SELECT 1 FROM iam.provider_runtime('test-saml')),
    'and gives a sign-in flow nothing to use');
  PERFORM test.throws($q$ UPDATE iam.auth_provider SET enabled = true WHERE name = 'test-saml' $q$, '23514',
    'a provider cannot be enabled before it passes a test');
END $$;
