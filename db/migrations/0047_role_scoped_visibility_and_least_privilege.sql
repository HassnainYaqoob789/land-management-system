-- =====================================================================
-- 0047  Role-scoped visibility & strict least-privilege permissions
-- =====================================================================
-- 1. Separates Legal Advisor (`legal-advisor`) and Negotiation Officer
--    (`negotiation-officer`) from generic field `case-approver`.
-- 2. Fixes `viewer` (`Hina Jamal`, Analyst) so she is assigned the `viewer`
--    role rather than `security-auditor`.
-- 3. Strips unrelated business register permissions from `system-administrator`,
--    `security-auditor`, `viewer`, `finance-approver`, `legal-advisor`,
--    `negotiation-officer`, `case-approver`, `data-entry`, and `land-manager`
--    so each role only holds permissions for modules it actively works on or
--    requires as a lookup dependency.
-- 4. Allows `Admin` tier in `iam.actor_covers_role` to assign/revoke system
--    roles even when `system-administrator` itself does not hold business
--    register permissions (enforcing strict separation of duties).

SET ROLE lms_owner;
SELECT set_config('lms.actor_id', '00000000-0000-0000-0000-000000000001', false);

-- ---------------------------------------------------------------------
-- 1. Allow Admin tier to assign/manage system roles without holding
--    operational business permissions itself
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION iam.actor_covers_role(p_role uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT coalesce(
    iam.is_system_actor()
    OR (
      lms.actor_role() = 'Admin'
      AND coalesce((SELECT is_system FROM iam.role WHERE id = p_role), false)
    )
    OR (
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
              AND iam.permission_rank(have.scope_level) >= iam.permission_rank(need.scope_level)
          )
      )
    ),
    false
  );
$function$;

-- ---------------------------------------------------------------------
-- 2. Create dedicated system roles: `legal-advisor` & `negotiation-officer`
-- ---------------------------------------------------------------------
INSERT INTO iam.role (code, name, description, db_role_code, is_system)
VALUES
  ('legal-advisor', 'Legal Advisor', 'Court litigation, stay orders, LAA 1894 land acquisition, mutation/title review, compensation legal verification, and community grievances.', 'Approver', true),
  ('negotiation-officer', 'Negotiation Officer', 'Field rate negotiation, compensation case checking, surface leases, ROW, acquisitions, grievances, and payment voucher initiation.', 'Approver', true)
ON CONFLICT (code) DO UPDATE
  SET name = EXCLUDED.name,
      description = EXCLUDED.description,
      db_role_code = EXCLUDED.db_role_code,
      is_system = true;

-- ---------------------------------------------------------------------
-- 3. Rebuild role_permission matrix per role on strict least-privilege
-- ---------------------------------------------------------------------
DO $$
DECLARE
  v_role_id uuid;
BEGIN
  -- Clear existing permissions on the managed system roles so we set exact grants
  DELETE FROM iam.role_permission
  WHERE role_id IN (
    SELECT id FROM iam.role
    WHERE code IN (
      'system-administrator',
      'security-auditor',
      'viewer',
      'finance-approver',
      'legal-advisor',
      'negotiation-officer',
      'case-approver',
      'data-entry',
      'land-manager'
    )
  );

  -- 3A. system-administrator: IAM, Users, Roles, Sessions, Approval Matrix, Settings, Audit Trail
  -- (Plus reports:read & reports:export for dashboard health and role delegation verification)
  SELECT id INTO v_role_id FROM iam.role WHERE code = 'system-administrator';
  INSERT INTO iam.role_permission (role_id, permission_id, scope_level)
  SELECT v_role_id, p.id, 'global'
  FROM iam.permission p
  WHERE (p.resource, p.action) IN (
    ('users', 'read'), ('users', 'create'), ('users', 'update'), ('users', 'delete'),
    ('users', 'assign'), ('users', 'reset_mfa'), ('users', 'revoke_sessions'),
    ('roles', 'read'), ('roles', 'create'), ('roles', 'update'), ('roles', 'delete'), ('roles', 'manage_permissions'),
    ('sessions', 'read'), ('sessions', 'revoke'),
    ('settings', 'read'), ('settings', 'update'),
    ('identity_settings', 'read'), ('identity_settings', 'configure'),
    ('audit_logs', 'read'), ('audit_logs', 'export'),
    ('reports', 'read'), ('reports', 'export'), ('reports', 'share')
  );

  -- 3B. security-auditor: Read-only governance, audit trail, user/role inspection, and core financial/case registers (masked PII)
  SELECT id INTO v_role_id FROM iam.role WHERE code = 'security-auditor';
  INSERT INTO iam.role_permission (role_id, permission_id, scope_level)
  SELECT v_role_id, p.id, 'global'
  FROM iam.permission p
  WHERE (p.resource, p.action) IN (
    ('audit_logs', 'read'),
    ('users', 'read'),
    ('roles', 'read'),
    ('sessions', 'read'),
    ('settings', 'read'),
    ('identity_settings', 'read'),
    ('reports', 'read'),
    ('documents', 'read'),
    ('projects', 'read'),
    ('surveys', 'read'),
    ('landowners', 'read'),
    ('cases', 'read'),
    ('leases', 'read'),
    ('payments', 'read'),
    ('mutations', 'read'),
    ('legal', 'read'),
    ('grievances', 'read')
  );

  -- 3C. viewer (Analyst): Executive/Project Dashboards, Provincial Revenue Systems, GIS Map, and Reports (province-scoped)
  SELECT id INTO v_role_id FROM iam.role WHERE code = 'viewer';
  INSERT INTO iam.role_permission (role_id, permission_id, scope_level)
  SELECT v_role_id, p.id, 'province'
  FROM iam.permission p
  WHERE (p.resource, p.action) IN (
    ('reports', 'read'),
    ('projects', 'read'),
    ('surveys', 'read'),
    ('cases', 'read'),
    ('leases', 'read'),
    ('payments', 'read'),
    ('gis', 'read')
  );

  -- 3D. finance-approver (Finance Officer): Payments, Cheques, Holds, Reconciliations, Budgets, DBPFC + Settlement Lookups
  SELECT id INTO v_role_id FROM iam.role WHERE code = 'finance-approver';
  INSERT INTO iam.role_permission (role_id, permission_id, scope_level)
  SELECT v_role_id, p.id, 'global'
  FROM iam.permission p
  WHERE (p.resource, p.action) IN (
    ('payments', 'read'), ('payments', 'create'), ('payments', 'update'), ('payments', 'verify'),
    ('budgets', 'read'), ('budgets', 'create'), ('budgets', 'update'),
    ('dbpfc', 'read'),
    ('cases', 'read'),
    ('leases', 'read'),
    ('landowners', 'read'), ('pii', 'read'),
    ('surveys', 'read'),
    ('projects', 'read'),
    ('documents', 'read'),
    ('inbox', 'read'),
    ('reports', 'read'), ('reports', 'export'), ('reports', 'share')
  );

  -- 3E. legal-advisor (Legal Advisor): Litigation, Stay Orders, Acquisitions, Cases (Legal Verification), Mutations, Encroachments, Grievances
  SELECT id INTO v_role_id FROM iam.role WHERE code = 'legal-advisor';
  INSERT INTO iam.role_permission (role_id, permission_id, scope_level)
  SELECT v_role_id, p.id, 'province'
  FROM iam.permission p
  WHERE (p.resource, p.action) IN (
    ('legal', 'read'), ('legal', 'create'), ('legal', 'update'),
    ('acquisitions', 'read'), ('acquisitions', 'create'), ('acquisitions', 'update'),
    ('cases', 'read'), ('cases', 'update'), ('cases', 'approve'),
    ('mutations', 'read'), ('mutations', 'create'), ('mutations', 'update'),
    ('encroachments', 'read'), ('encroachments', 'create'), ('encroachments', 'update'),
    ('grievances', 'read'), ('grievances', 'create'), ('grievances', 'update'),
    ('leases', 'read'), ('leases', 'update'),
    ('documents', 'read'), ('documents', 'create'), ('documents', 'update'),
    ('landowners', 'read'), ('pii', 'read'),
    ('surveys', 'read'),
    ('projects', 'read'),
    ('inbox', 'read'),
    ('reports', 'read')
  );

  -- 3F. negotiation-officer (Negotiation Officer): Cases, Leases, Acquisitions, ROW, Land Requests, Grievances, Payment Request initiation
  SELECT id INTO v_role_id FROM iam.role WHERE code = 'negotiation-officer';
  INSERT INTO iam.role_permission (role_id, permission_id, scope_level)
  SELECT v_role_id, p.id, 'province'
  FROM iam.permission p
  WHERE (p.resource, p.action) IN (
    ('projects', 'read'),
    ('surveys', 'read'), ('surveys', 'create'), ('surveys', 'update'),
    ('landowners', 'read'), ('landowners', 'create'), ('landowners', 'update'), ('pii', 'read'),
    ('requests', 'read'), ('requests', 'create'),
    ('acquisitions', 'read'), ('acquisitions', 'create'), ('acquisitions', 'update'),
    ('cases', 'read'), ('cases', 'create'), ('cases', 'update'), ('cases', 'approve'),
    ('leases', 'read'), ('leases', 'create'), ('leases', 'update'),
    ('rows', 'read'), ('rows', 'create'), ('rows', 'update'),
    ('payments', 'read'), ('payments', 'create'),
    ('grievances', 'read'), ('grievances', 'create'), ('grievances', 'update'),
    ('documents', 'read'), ('documents', 'create'), ('documents', 'update'),
    ('gis', 'read'),
    ('inbox', 'read'),
    ('reports', 'read')
  );

  -- 3G. case-approver (Sr. Admin Field & DM / Team Lead Field): Field Operations Supervision, Case/Request/Mutation Approvals, CSV Import Promotion
  SELECT id INTO v_role_id FROM iam.role WHERE code = 'case-approver';
  INSERT INTO iam.role_permission (role_id, permission_id, scope_level)
  SELECT v_role_id, p.id, 'province'
  FROM iam.permission p
  WHERE (p.resource, p.action) IN (
    ('projects', 'read'), ('projects', 'create'), ('projects', 'update'),
    ('surveys', 'read'), ('surveys', 'create'), ('surveys', 'update'),
    ('landowners', 'read'), ('landowners', 'create'), ('landowners', 'update'), ('pii', 'read'),
    ('requests', 'read'), ('requests', 'create'), ('requests', 'approve'),
    ('acquisitions', 'read'), ('acquisitions', 'create'), ('acquisitions', 'update'),
    ('cases', 'read'), ('cases', 'create'), ('cases', 'update'), ('cases', 'approve'),
    ('leases', 'read'), ('leases', 'create'), ('leases', 'update'),
    ('rows', 'read'), ('rows', 'create'), ('rows', 'update'),
    ('encroachments', 'read'), ('encroachments', 'create'), ('encroachments', 'update'),
    ('mutations', 'read'), ('mutations', 'create'), ('mutations', 'update'),
    ('legal', 'read'), ('legal', 'create'), ('legal', 'update'),
    ('payments', 'read'), ('payments', 'create'),
    ('dbpfc', 'read'), ('dbpfc', 'create'), ('dbpfc', 'update'),
    ('grievances', 'read'), ('grievances', 'create'), ('grievances', 'update'),
    ('documents', 'read'), ('documents', 'create'), ('documents', 'update'),
    ('import', 'read'), ('import', 'create'), ('import', 'update'),
    ('gis', 'read'), ('gis', 'create'),
    ('inbox', 'read'),
    ('reports', 'read'), ('reports', 'export')
  );

  -- 3H. data-entry (Field Land Officers): Field Surveys, Landowners, Cases, Leases, Mutations, Legal, ROW, Encroachments, Import Staging
  SELECT id INTO v_role_id FROM iam.role WHERE code = 'data-entry';
  INSERT INTO iam.role_permission (role_id, permission_id, scope_level)
  SELECT v_role_id, p.id, 'province'
  FROM iam.permission p
  WHERE (p.resource, p.action) IN (
    ('projects', 'read'), ('projects', 'create'), ('projects', 'update'),
    ('surveys', 'read'), ('surveys', 'create'), ('surveys', 'update'),
    ('landowners', 'read'), ('landowners', 'create'), ('landowners', 'update'), ('pii', 'read'),
    ('requests', 'read'), ('requests', 'create'),
    ('acquisitions', 'read'), ('acquisitions', 'create'), ('acquisitions', 'update'),
    ('cases', 'read'), ('cases', 'create'), ('cases', 'update'),
    ('leases', 'read'), ('leases', 'create'),
    ('rows', 'read'), ('rows', 'create'), ('rows', 'update'),
    ('encroachments', 'read'), ('encroachments', 'create'), ('encroachments', 'update'),
    ('mutations', 'read'), ('mutations', 'create'), ('mutations', 'update'),
    ('legal', 'read'), ('legal', 'create'), ('legal', 'update'),
    ('payments', 'read'), ('payments', 'create'),
    ('dbpfc', 'read'), ('dbpfc', 'create'), ('dbpfc', 'update'),
    ('grievances', 'read'), ('grievances', 'create'), ('grievances', 'update'),
    ('documents', 'read'), ('documents', 'create'), ('documents', 'update'),
    ('import', 'read'), ('import', 'create'),
    ('gis', 'read'), ('gis', 'create'),
    ('inbox', 'read'),
    ('reports', 'read')
  );

  -- 3I. land-manager (Manager Land HO): Full Head-Office Business, Approval, Release, Budget, and Reporting authority (Zero System/IAM Admin)
  SELECT id INTO v_role_id FROM iam.role WHERE code = 'land-manager';
  INSERT INTO iam.role_permission (role_id, permission_id, scope_level)
  SELECT v_role_id, p.id, 'head_office'
  FROM iam.permission p
  WHERE (p.resource, p.action) IN (
    ('projects', 'read'), ('projects', 'create'), ('projects', 'update'),
    ('surveys', 'read'), ('surveys', 'create'), ('surveys', 'update'),
    ('landowners', 'read'), ('landowners', 'create'), ('landowners', 'update'), ('pii', 'read'),
    ('requests', 'read'), ('requests', 'create'), ('requests', 'approve'),
    ('acquisitions', 'read'), ('acquisitions', 'create'), ('acquisitions', 'update'),
    ('cases', 'read'), ('cases', 'create'), ('cases', 'update'), ('cases', 'approve'),
    ('leases', 'read'), ('leases', 'create'), ('leases', 'update'),
    ('rows', 'read'), ('rows', 'create'), ('rows', 'update'),
    ('encroachments', 'read'), ('encroachments', 'create'), ('encroachments', 'update'),
    ('mutations', 'read'), ('mutations', 'create'), ('mutations', 'update'),
    ('legal', 'read'), ('legal', 'create'), ('legal', 'update'),
    ('payments', 'read'), ('payments', 'update'), ('payments', 'release'),
    ('dbpfc', 'read'), ('dbpfc', 'create'), ('dbpfc', 'update'),
    ('budgets', 'read'), ('budgets', 'create'), ('budgets', 'update'),
    ('grievances', 'read'), ('grievances', 'create'), ('grievances', 'update'),
    ('documents', 'read'), ('documents', 'create'), ('documents', 'update'),
    ('import', 'read'), ('import', 'create'), ('import', 'update'),
    ('gis', 'read'), ('gis', 'create'),
    ('inbox', 'read'),
    ('reports', 'read'), ('reports', 'export'), ('reports', 'share')
  );
END $$;

-- ---------------------------------------------------------------------
-- 4. Reassign `viewer`, `legal`, `nego`, and `negoqta` to their exact roles
-- ---------------------------------------------------------------------
DO $$
DECLARE
  v_viewer_uid uuid;
  v_legal_uid uuid;
  v_nego_uid uuid;
  v_negoqta_uid uuid;
  v_viewer_role uuid;
  v_legal_role uuid;
  v_nego_role uuid;
BEGIN
  SELECT id INTO v_viewer_uid FROM lms.app_user WHERE username = 'viewer';
  SELECT id INTO v_legal_uid FROM lms.app_user WHERE username = 'legal';
  SELECT id INTO v_nego_uid FROM lms.app_user WHERE username = 'nego';
  SELECT id INTO v_negoqta_uid FROM lms.app_user WHERE username = 'negoqta';

  SELECT id INTO v_viewer_role FROM iam.role WHERE code = 'viewer';
  SELECT id INTO v_legal_role FROM iam.role WHERE code = 'legal-advisor';
  SELECT id INTO v_nego_role FROM iam.role WHERE code = 'negotiation-officer';

  -- Fix viewer (Hina Jamal): remove Internal Audit group & security-auditor role, assign viewer role
  IF v_viewer_uid IS NOT NULL THEN
    DELETE FROM lms.app_user_group WHERE user_id = v_viewer_uid AND group_code = 'Internal Audit';
    UPDATE iam.user_role
       SET revoked_at = now(),
           revoke_reason = 'Reassigned from security-auditor to viewer (Analyst) role'
     WHERE user_id = v_viewer_uid
       AND revoked_at IS NULL
       AND role_id <> v_viewer_role;

    IF NOT EXISTS (SELECT 1 FROM iam.user_role WHERE user_id = v_viewer_uid AND role_id = v_viewer_role AND revoked_at IS NULL) THEN
      INSERT INTO iam.user_role (user_id, role_id, reason)
      VALUES (v_viewer_uid, v_viewer_role, 'Management Analyst read-only dashboard & reporting role');
    END IF;
  END IF;

  -- Fix legal (Ayesha Siddiqui): replace generic case-approver with legal-advisor
  IF v_legal_uid IS NOT NULL THEN
    UPDATE iam.user_role
       SET revoked_at = now(),
           revoke_reason = 'Replaced generic case-approver with dedicated legal-advisor role'
     WHERE user_id = v_legal_uid
       AND revoked_at IS NULL
       AND role_id <> v_legal_role;

    IF NOT EXISTS (SELECT 1 FROM iam.user_role WHERE user_id = v_legal_uid AND role_id = v_legal_role AND revoked_at IS NULL) THEN
      INSERT INTO iam.user_role (user_id, role_id, reason)
      VALUES (v_legal_uid, v_legal_role, 'Legal Advisor role for litigation, title, acquisition & legal verification');
    END IF;
  END IF;

  -- Fix nego (Bilal Chandio) & negoqta (Samiullah Marri): replace generic case-approver with negotiation-officer
  IF v_nego_uid IS NOT NULL THEN
    UPDATE iam.user_role
       SET revoked_at = now(),
           revoke_reason = 'Replaced generic case-approver with dedicated negotiation-officer role'
     WHERE user_id = v_nego_uid
       AND revoked_at IS NULL
       AND role_id <> v_nego_role;

    IF NOT EXISTS (SELECT 1 FROM iam.user_role WHERE user_id = v_nego_uid AND role_id = v_nego_role AND revoked_at IS NULL) THEN
      INSERT INTO iam.user_role (user_id, role_id, reason)
      VALUES (v_nego_uid, v_nego_role, 'Negotiation Officer role for Sindh field negotiations');
    END IF;
  END IF;

  IF v_negoqta_uid IS NOT NULL THEN
    UPDATE iam.user_role
       SET revoked_at = now(),
           revoke_reason = 'Replaced generic case-approver with dedicated negotiation-officer role'
     WHERE user_id = v_negoqta_uid
       AND revoked_at IS NULL
       AND role_id <> v_nego_role;

    IF NOT EXISTS (SELECT 1 FROM iam.user_role WHERE user_id = v_negoqta_uid AND role_id = v_nego_role AND revoked_at IS NULL) THEN
      INSERT INTO iam.user_role (user_id, role_id, reason)
      VALUES (v_negoqta_uid, v_nego_role, 'Negotiation Officer role for Balochistan field negotiations');
    END IF;
  END IF;
END $$;

RESET ROLE;
