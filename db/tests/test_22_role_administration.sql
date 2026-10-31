-- role: lms_test
-- tx: rollback
--
-- 0044 as the application sees it (row-level security applies): role status
-- rules on every path, removal cover for role permissions, grant and
-- revocation events, role history, the MFA overview, access reviews and
-- anonymisation under 0041's immutable grant reason.
\set QUIET on

DO $$
DECLARE
  fx record; v_role uuid; v_tool uuid; v_ur uuid; v_ur_viewer uuid; v_admin_ur uuid; v_lofield_de uuid; v_lobal_de uuid;
  v_rev uuid; v_rev_admin uuid; v_rev_snd uuid; v_item uuid; v_new uuid;
BEGIN
  SELECT * INTO fx FROM test.fixtures;

  -- ---------- 1. role status and attribution ----------
  PERFORM test.become('admin');
  INSERT INTO iam.role (code, name, description, db_role_code, created_by)
  VALUES ('t22-exporter', 'T22 exporter', 'role administration test', 'Viewer', fx.u_viewer) RETURNING id INTO v_role;
  PERFORM test.eq((SELECT created_by FROM iam.role WHERE id = v_role), fx.u_admin,
    'the creator is recorded as the actor, whatever the caller says');
  PERFORM test.throws_like(format($q$ UPDATE iam.role SET created_by = %L WHERE id = %L $q$, fx.u_viewer, v_role),
    '%cannot be changed%', 'and cannot be rewritten later');
  INSERT INTO iam.role_permission (role_id, permission_id, scope_level)
  SELECT v_role, id, 'global' FROM iam.permission WHERE resource = 'reports' AND action = 'export';

  PERFORM test.throws_like(format($q$ UPDATE iam.role SET status = 'inactive' WHERE id = %L $q$, v_role),
    '%reason%', 'a direct status change without a reason is refused');
  UPDATE iam.role SET status = 'inactive', status_reason = 'suspended by a direct update' WHERE id = v_role;
  PERFORM test.eq((SELECT status FROM iam.role WHERE id = v_role), 'inactive', 'with a reason a role administrator may suspend');

  -- A role editor: roles:update and manage_permissions but not roles:delete,
  -- reports:export only at province scope, and users:assign for reviews.
  INSERT INTO iam.role (code, name, description, db_role_code)
  VALUES ('t22-role-editor', 'T22 role editor', 'roles:update without roles:delete', 'Viewer') RETURNING id INTO v_tool;
  INSERT INTO iam.role_permission (role_id, permission_id, scope_level)
  SELECT v_tool, id, 'global' FROM iam.permission
   WHERE resource = 'roles' AND action IN ('read', 'update', 'manage_permissions')
      OR resource = 'users' AND action IN ('read', 'assign');
  INSERT INTO iam.role_permission (role_id, permission_id, scope_level)
  SELECT v_tool, id, 'province' FROM iam.permission WHERE resource = 'reports' AND action = 'export';
  INSERT INTO iam.user_role (user_id, role_id, reason) VALUES (fx.u_audit, v_tool, 't22 role editor');
  INSERT INTO iam.user_role (user_id, role_id, reason) VALUES (fx.u_lobal, v_tool, 't22 role editor in one province');

  PERFORM test.become('audit');
  PERFORM test.throws_like(format($q$ UPDATE iam.role SET status = 'retired', status_reason = 'retire it directly' WHERE id = %L $q$, v_role),
    '%roles:delete%', 'retiring needs roles:delete on every path, not only through iam.set_role_status');
  PERFORM test.throws_like(format($q$ UPDATE iam.role SET status = 'active', status_reason = 'bring it back directly' WHERE id = %L $q$, v_role),
    '%do not hold%', 'any status change needs cover for the role''s permissions');

  -- ---------- 2. removing or narrowing a permission needs cover ----------
  PERFORM test.throws_like(format($q$ UPDATE iam.role_permission SET scope_level = 'province' WHERE role_id = %L $q$, v_role),
    '%remove or change%', 'narrowing a permission held only at a smaller scope is refused');
  PERFORM test.throws_like(format($q$ DELETE FROM iam.role_permission WHERE role_id = %L $q$, v_role),
    '%remove or change%', 'and so is removing it');
  PERFORM test.eq((SELECT scope_level FROM iam.role_permission WHERE role_id = v_role), 'global', 'the permission is unchanged');

  PERFORM test.become('admin');
  PERFORM iam.set_role_status('t22-exporter', 'active', 'back in service for t22');
  UPDATE iam.role_permission SET scope_level = 'province' WHERE role_id = v_role;
  UPDATE iam.role_permission SET scope_level = 'global' WHERE role_id = v_role;
  PERFORM test.eq((SELECT scope_level FROM iam.role_permission WHERE role_id = v_role), 'global',
    'someone who holds it at the wider scope may change it');

  -- ---------- 3. grant and revocation events ----------
  INSERT INTO iam.user_role (user_id, role_id, reason, scope_province, expires_at)
  VALUES (fx.u_lofield, v_role, 't22 grant event', 'SND', now() + interval '30 days') RETURNING id INTO v_ur;
  PERFORM test.ok(EXISTS (SELECT 1 FROM audit.auth_event e
                          WHERE e.event_type = 'role_granted' AND e.target_user_id = fx.u_lofield AND e.actor_user_id = fx.u_admin
                            AND e.metadata ->> 'role' = 't22-exporter' AND e.metadata ->> 'province' = 'SND'
                            AND e.metadata ->> 'reason' = 't22 grant event' AND e.metadata ? 'expires_at'),
    'a grant writes an auth event naming the role, scope, expiry and reason');
  UPDATE iam.user_role SET revoked_at = now(), revoke_reason = 't22 revoke event' WHERE id = v_ur;
  PERFORM test.ok(EXISTS (SELECT 1 FROM audit.auth_event e
                          WHERE e.event_type = 'role_revoked' AND e.target_user_id = fx.u_lofield
                            AND e.metadata ->> 'role' = 't22-exporter' AND e.metadata ->> 'reason' = 't22 revoke event'),
    'a revocation writes one with the revocation''s reason');

  -- ---------- 4. role history ----------
  PERFORM test.ok(EXISTS (SELECT 1 FROM iam.role_history('t22-exporter') h WHERE h.entity = 'role' AND h.action = 'INSERT'
                            AND h.actor_username = 'admin'),
    'the history shows who created the role');
  PERFORM test.ok(EXISTS (SELECT 1 FROM iam.role_history('t22-exporter') h WHERE h.entity = 'role' AND 'status' = ANY (h.changed_fields)),
    'its status changes');
  PERFORM test.ok(EXISTS (SELECT 1 FROM iam.role_history('t22-exporter') h WHERE h.entity = 'role_permission'
                            AND h.permission = 'reports:export' AND h.action = 'UPDATE'),
    'the permissions changed in it, by name');
  PERFORM test.ok(EXISTS (SELECT 1 FROM iam.role_history('t22-exporter') h WHERE h.entity = 'user_role'
                            AND h.subject_username = 'lofield' AND h.action = 'UPDATE' AND h.new_data ->> 'revoke_reason' = 't22 revoke event'),
    'and its grants and revocations, naming the member');
  PERFORM test.eq((SELECT count(*)::integer FROM iam.role_history('t22-exporter', 2)), 2, 'the page size is honoured');
  PERFORM test.ok((SELECT min(event_id) FROM iam.role_history('t22-exporter', 2))
                  > (SELECT max(event_id) FROM iam.role_history('t22-exporter', 100, (SELECT min(event_id) FROM iam.role_history('t22-exporter', 2)))),
    'and the next page continues below it');
  PERFORM test.throws_like($q$ SELECT * FROM iam.role_history('no-such-role') $q$, '%no such role%', 'an unknown role is reported');
  PERFORM test.become('lofield');
  PERFORM test.throws($q$ SELECT * FROM iam.role_history('t22-exporter') $q$, '42501', 'reading role history needs roles:read');

  -- ---------- 5. two-step verification overview ----------
  PERFORM test.become('viewer');
  DELETE FROM iam.mfa_totp WHERE user_id = fx.u_viewer;
  INSERT INTO iam.mfa_totp (user_id, secret_ct, key_id, confirmed_at) VALUES (fx.u_viewer, '\x00'::bytea, 't22', now());
  PERFORM test.become('admin');
  PERFORM test.eq((SELECT count(*)::integer FROM iam.mfa_totp WHERE user_id = fx.u_viewer), 0,
    'row-level security hides another account''s authenticator');
  PERFORM test.ok((SELECT totp FROM iam.user_mfa_summary() WHERE user_id = fx.u_viewer),
    'but the overview tells an account administrator it is enrolled');
  PERFORM test.ok(NOT EXISTS (SELECT 1 FROM iam.user_mfa_summary() s JOIN lms.app_user u ON u.id = s.user_id WHERE u.is_service_account),
    'service accounts are not listed');
  PERFORM test.become('lofield');
  PERFORM test.throws($q$ SELECT * FROM iam.user_mfa_summary() $q$, '42501', 'the overview needs users:read');

  -- ---------- 6. access reviews ----------
  PERFORM test.become('admin');
  INSERT INTO iam.user_role (user_id, role_id, reason) VALUES (fx.u_viewer, v_role, 't22 review subject') RETURNING id INTO v_ur_viewer;
  -- Since 0047 the analyst seed account holds only `viewer`; give it the auditor's
  -- users:read (without users:assign) for the read-but-not-decide checks below.
  INSERT INTO iam.user_role (user_id, role_id, reason)
  SELECT fx.u_viewer, id, 't22 read-only reviewer' FROM iam.role WHERE code = 'security-auditor';
  PERFORM test.throws_like($q$ SELECT iam.start_access_review('x', 't22-exporter') $q$, '%5 characters%', 'a review needs a description');
  v_rev := iam.start_access_review('T22 exporter review', 't22-exporter');
  PERFORM test.eq((SELECT count(*)::integer FROM iam.access_review_item WHERE review_id = v_rev), 1,
    'the review snapshots the role''s active assignments only (the revoked one is left out)');
  SELECT id INTO v_item FROM iam.access_review_item WHERE review_id = v_rev AND user_role_id = v_ur_viewer;

  PERFORM test.become('viewer');
  PERFORM test.eq((SELECT count(*)::integer FROM iam.access_review WHERE id = v_rev), 1, 'users:read holders can read the review');
  PERFORM test.eq((SELECT count(*)::integer FROM iam.access_review_item WHERE review_id = v_rev), 1, 'and its items');
  PERFORM test.throws(format($q$ SELECT iam.decide_access_review_item(%L, 'keep') $q$, v_item), '42501',
    'but deciding needs users:assign');
  PERFORM test.throws($q$ SELECT iam.start_access_review('Auditor review', NULL, NULL) $q$, '42501', 'as does starting one');
  PERFORM test.become('lofield');
  PERFORM test.eq((SELECT count(*)::integer FROM iam.access_review), 0, 'without users:read no review is visible');

  PERFORM test.become('viewer');
  PERFORM test.ok(iam.has_permission('reports', 'export'), 'before the decision the member holds the permission');
  PERFORM test.become('admin');
  PERFORM test.throws_like(format($q$ SELECT iam.decide_access_review_item(%L, 'revoke') $q$, v_item),
    '%reason%', 'revoking needs a reason');
  PERFORM iam.decide_access_review_item(v_item, 'revoke', 'no longer exports reports');
  PERFORM test.ok((SELECT revoked_at IS NOT NULL AND revoked_by = fx.u_admin AND revoke_reason = 'no longer exports reports'
                   FROM iam.user_role WHERE id = v_ur_viewer),
    'a revoke decision revokes the assignment at once, attributed to the reviewer');
  PERFORM test.become('viewer');
  PERFORM test.ok(NOT iam.has_permission('reports', 'export'), 'and the member loses the permission on the next check');
  PERFORM test.become('admin');
  PERFORM test.throws_like(format($q$ SELECT iam.decide_access_review_item(%L, 'keep') $q$, v_item),
    '%already been decided%', 'a decision is final');
  PERFORM iam.close_access_review(v_rev, 'exporter access confirmed');
  PERFORM test.ok((SELECT completed_at IS NOT NULL AND completed_by = fx.u_admin FROM iam.access_review WHERE id = v_rev),
    'a review with every item decided can be closed');
  PERFORM test.throws_like(format($q$ SELECT iam.close_access_review(%L) $q$, v_rev), '%already closed%', 'once');
  PERFORM test.throws_like($q$ SELECT iam.start_access_review('Empty review', 't22-exporter') $q$,
    '%no active role assignment%', 'a review that would contain nothing is refused');

  -- Nobody decides on their own access; the last-administrator guard applies.
  SELECT ur.id INTO v_admin_ur FROM iam.user_role ur JOIN iam.role r ON r.id = ur.role_id
   WHERE ur.user_id = fx.u_admin AND r.code = 'system-administrator' AND ur.revoked_at IS NULL;
  v_rev_admin := iam.start_access_review('T22 administrator review', 'system-administrator');
  SELECT id INTO v_item FROM iam.access_review_item WHERE review_id = v_rev_admin AND user_role_id = v_admin_ur;
  PERFORM test.throws_like(format($q$ SELECT iam.decide_access_review_item(%L, 'keep') $q$, v_item),
    '%your own access%', 'a reviewer cannot decide on their own access');
  PERFORM test.throws_like(format($q$ SELECT iam.close_access_review(%L) $q$, v_rev_admin),
    '%still need a decision%', 'and the review cannot close while it is undecided');
  PERFORM test.become('audit');
  PERFORM test.throws_like(format($q$ SELECT iam.decide_access_review_item(%L, 'revoke', 'remove the only admin') $q$, v_item),
    '%last active system administrator%', 'a revoke decision goes through the ordinary guards');
  PERFORM test.ok((SELECT decision IS NULL FROM iam.access_review_item WHERE id = v_item),
    'and a refused revocation records no decision');
  PERFORM iam.decide_access_review_item(v_item, 'keep', 'still the administrator');
  -- Any other administrator in the fixture data is kept as well.
  FOR v_item IN SELECT i.id FROM iam.access_review_item i WHERE i.review_id = v_rev_admin AND i.decision IS NULL LOOP
    PERFORM iam.decide_access_review_item(v_item, 'keep', 'still an administrator');
  END LOOP;
  PERFORM test.become('admin');
  PERFORM iam.close_access_review(v_rev_admin, NULL);
  PERFORM test.ok((SELECT completed_at IS NOT NULL FROM iam.access_review WHERE id = v_rev_admin),
    'another reviewer''s decision lets it close');

  -- Province reviews: grants limited to the province and unlimited grants of its people.
  SELECT ur.id INTO v_lofield_de FROM iam.user_role ur JOIN iam.role r ON r.id = ur.role_id
   WHERE ur.user_id = fx.u_lofield AND r.code = 'data-entry' AND ur.revoked_at IS NULL;
  SELECT ur.id INTO v_lobal_de FROM iam.user_role ur JOIN iam.role r ON r.id = ur.role_id
   WHERE ur.user_id = fx.u_lobal AND r.code = 'data-entry' AND ur.revoked_at IS NULL;
  v_rev_snd := iam.start_access_review('T22 Sindh review', NULL, 'SND');
  PERFORM test.ok(EXISTS (SELECT 1 FROM iam.access_review_item WHERE review_id = v_rev_snd AND user_role_id = v_lofield_de),
    'a Sindh review covers a Sindh officer''s grants');
  PERFORM test.ok(NOT EXISTS (SELECT 1 FROM iam.access_review_item WHERE review_id = v_rev_snd AND user_role_id = v_lobal_de),
    'and not a Balochistan officer''s');
  PERFORM test.become('loquetta');
  PERFORM test.throws_like($q$ SELECT iam.start_access_review('Sindh from Quetta', NULL, 'SND') $q$,
    '%which you do not hold%', 'a reviewer cannot review a province they do not hold');

  -- The review is evidence: started, decided and closed are all recorded.
  PERFORM test.become('admin');
  PERFORM test.ok(EXISTS (SELECT 1 FROM audit.audit_event WHERE entity = 'access_review' AND record_id = v_rev AND action = 'UPDATE'),
    'the review''s rows are audited');
  PERFORM test.ok(EXISTS (SELECT 1 FROM audit.auth_event WHERE event_type = 'access_review_decision' AND metadata ->> 'review' = v_rev::text),
    'each decision is an auth event');
  PERFORM test.ok(EXISTS (SELECT 1 FROM audit.auth_event WHERE event_type = 'access_review_closed' AND metadata ->> 'review' = v_rev::text),
    'and so is closing');

  -- ---------- 7. anonymisation under the immutable grant reason ----------
  v_new := iam.create_user('t22-leaver', 'T22 leaver', NULL, NULL, NULL, NULL, '{SND}', '{}', '{viewer}');
  PERFORM iam.anonymise_user(v_new, 'erasure request t22-0001');
  PERFORM test.ok(NOT EXISTS (SELECT 1 FROM iam.user_role WHERE user_id = v_new AND revoked_at IS NULL),
    'anonymising an account with a role revokes the role');
  PERFORM test.ok(EXISTS (SELECT 1 FROM iam.user_role WHERE user_id = v_new AND revoke_reason = 'account anonymised'),
    'recording why in revoke_reason, leaving the grant''s own reason alone');
  PERFORM test.ok((SELECT username::text LIKE 'anon-%' AND status = 'Deactivated' FROM lms.app_user WHERE id = v_new),
    'and the account is anonymised and deactivated');
END $$;
