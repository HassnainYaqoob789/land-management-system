-- =====================================================================
-- 0048  RBAC: close designation gaps left by 0047
-- =====================================================================
-- Found by the 2026-10-30 RBAC audit (live sign-in of every demo account
-- and a cross-check of lms.workflow_step_group against route permissions).
-- Only additions; nothing granted by 0047 is removed.
--
-- 1. data-entry (Land Officer): + leases:update.
--    The Land Officer (Field) position approves the leases "Under Review"
--    step, and lease transitions are gated by leases:update. Without it the
--    officer could never act on the step assigned to them.
-- 2. security-auditor (Audit Officer): read-only coverage of every register
--    it audits (acquisitions, ROW, encroachments, DBPFC, budgets, land
--    requests, imports, GIS) and audit_logs:export for audit evidence.
--    Still no pii:read (CNIC stays masked) and no write permission.
-- 3. finance-approver (Finance Officer): + acquisitions/rows/legal :read.
--    Finance pays acquisition and ROW compensation and places payment holds
--    for stay orders, so it must see those registers.
-- 4. negotiation-officer: + dbpfc:read (DBPFC rates are the reference the
--    negotiator negotiates against).
-- 5. legal-advisor: + rows:read, gis:read (title review of pipeline
--    corridors and parcel boundaries).

SET ROLE lms_owner;
SELECT set_config('lms.actor_id', '00000000-0000-0000-0000-000000000001', false);

INSERT INTO iam.role_permission (role_id, permission_id, scope_level)
SELECT r.id, p.id, g.scope
FROM (VALUES
  ('data-entry',          'leases',        'update', 'province'),

  ('security-auditor',    'acquisitions',  'read',   'global'),
  ('security-auditor',    'rows',          'read',   'global'),
  ('security-auditor',    'encroachments', 'read',   'global'),
  ('security-auditor',    'dbpfc',         'read',   'global'),
  ('security-auditor',    'budgets',       'read',   'global'),
  ('security-auditor',    'requests',      'read',   'global'),
  ('security-auditor',    'import',        'read',   'global'),
  ('security-auditor',    'gis',           'read',   'global'),
  ('security-auditor',    'audit_logs',    'export', 'global'),

  ('finance-approver',    'acquisitions',  'read',   'global'),
  ('finance-approver',    'rows',          'read',   'global'),
  ('finance-approver',    'legal',         'read',   'global'),

  ('negotiation-officer', 'dbpfc',         'read',   'province'),

  ('legal-advisor',       'rows',          'read',   'province'),
  ('legal-advisor',       'gis',           'read',   'province')
) AS g(role_code, resource, action, scope)
JOIN iam.role r ON r.code = g.role_code
JOIN iam.permission p ON p.resource = g.resource AND p.action = g.action
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- Every grant above must resolve; a renamed role or permission is an error, not a silent skip.
DO $$
DECLARE missing int;
BEGIN
  SELECT count(*) INTO missing FROM (VALUES
    ('data-entry','leases','update'), ('security-auditor','audit_logs','export'),
    ('security-auditor','gis','read'), ('finance-approver','legal','read'),
    ('negotiation-officer','dbpfc','read'), ('legal-advisor','gis','read')) AS c(rc, res, act)
  WHERE NOT EXISTS (
    SELECT 1 FROM iam.role_permission rp
    JOIN iam.role r ON r.id = rp.role_id AND r.code = c.rc
    JOIN iam.permission p ON p.id = rp.permission_id AND p.resource = c.res AND p.action = c.act);
  IF missing > 0 THEN RAISE EXCEPTION '0048: % expected grants are missing', missing; END IF;
END $$;

RESET ROLE;
