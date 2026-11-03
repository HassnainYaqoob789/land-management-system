-- =====================================================================
-- Demo account that sees every tab and can act on it: "director"
-- (client requirement 2 Nov 2026; widened to full actions 3 Nov 2026)
-- =====================================================================
-- EVERY NAME HERE IS INVENTED. A fictional demonstration account, like
-- seed_demo.sql. Not a migration; never load it into production.
--
--   psql -d lms_dev -U lms_migrator -f db/seed/seed_director_account.sql
--
-- What the director can do:
--   * every permission in every province (add, edit, approve, delete,
--     export, settings, users and roles), CNICs unmasked (pii:read);
--   * every business approval position, so any workflow step can be taken.
--
-- What it still cannot do, because the database forbids it for EVERY user:
--   * payments:release. One person may not raise or verify a voucher AND
--     release it (iam.sod_rule). The director raises and verifies; Manager
--     Land (HO) releases.
--   * approve the same record twice, or approve a record it prepared
--     (workflow.sod_mode = strict). On one record the director can take one
--     step; the other steps need other accounts.
--
-- Idempotent: re-running it also upgrades the earlier read-only director.
-- Password: a placeholder verifier no password produces. Set one with
--   npx tsx scripts/iam/bootstrap.ts --username director
-- =====================================================================
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lms.actor_id = '00000000-0000-0000-0000-000000000001';
SET ROLE lms_owner;

INSERT INTO iam.role (code, name, description, db_role_code, is_system)
VALUES ('demo-director', 'Director (all tabs, all actions)',
        'Demonstration only: every permission in every province except payment release, and every business approval position.',
        'Approver', false)
ON CONFLICT (code) DO UPDATE
  SET name = EXCLUDED.name, description = EXCLUDED.description, db_role_code = EXCLUDED.db_role_code;

-- Every permission except payments:release (see the header).
INSERT INTO iam.role_permission (role_id, permission_id, scope_level)
SELECT r.id, p.id, 'global'
  FROM iam.role r CROSS JOIN iam.permission p
 WHERE r.code = 'demo-director'
   AND NOT (p.resource = 'payments' AND p.action = 'release')
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO lms.app_user (code, username, full_name, role_code, department, position, office_code, email, password_hash, status)
SELECT lms.next_code('USR-'), 'director', 'Asif Rehman', 'Approver', 'Management', 'Director (demo, all tabs)', 'HO_ISB',
       'director@lms.invalid', '$2b$12$seedplaceholderseedplaceholderseedplaceholderseedplaceholde', 'Active'
 WHERE NOT EXISTS (SELECT 1 FROM lms.app_user WHERE username = 'director');

INSERT INTO lms.app_user_province (user_id, province_code)
SELECT a.id, p FROM lms.app_user a, unnest(ARRAY['SND','BAL','PNJ','KPK']) AS p
 WHERE a.username = 'director'
ON CONFLICT DO NOTHING;

-- Every business approval position (not System Administrator / Internal Audit).
INSERT INTO lms.app_user_group (user_id, group_code)
SELECT a.id, g.code
  FROM lms.app_user a CROSS JOIN lms.approval_group g
 WHERE a.username = 'director'
   AND g.code NOT IN ('System Administrator', 'Internal Audit')
ON CONFLICT DO NOTHING;

INSERT INTO iam.user_role (user_id, role_id, granted_by, reason)
SELECT a.id, r.id, '00000000-0000-0000-0000-000000000001'::uuid, 'demo seed: all-tabs director account'
  FROM lms.app_user a JOIN iam.role r ON r.code = 'demo-director'
 WHERE a.username = 'director'
   AND NOT EXISTS (SELECT 1 FROM iam.user_role ur WHERE ur.user_id = a.id AND ur.role_id = r.id AND ur.revoked_at IS NULL);

-- The database tier follows the role (Viewer -> Approver for an existing director).
SELECT iam.sync_db_role(id) FROM lms.app_user WHERE username = 'director';

SELECT 'director: ' || count(*) || ' permissions' FROM iam.role_permission rp JOIN iam.role r ON r.id = rp.role_id WHERE r.code = 'demo-director';
SELECT 'director: ' || count(*) || ' approval positions' FROM lms.app_user_group g JOIN lms.app_user a ON a.id = g.user_id WHERE a.username = 'director';
COMMIT;
