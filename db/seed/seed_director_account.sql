-- =====================================================================
-- Demo account that sees every tab: "director" (client requirement, 2 Nov 2026)
-- =====================================================================
-- EVERY NAME HERE IS INVENTED. A fictional demonstration account, like
-- seed_demo.sql. Not a migration; never load it into production.
--
--   psql -d lms_dev -U lms_migrator -f db/seed/seed_director_account.sql
--
-- The client asked for one account that opens every tab, for the opening
-- walkthrough, then the ladder of accounts with fewer tabs. This role reads
-- every register in every province and decides nothing: no create, update,
-- approve or payment permission, no approval position, and no pii:read
-- (CNICs stay masked; pii:read is a sensitive permission that would also
-- require MFA). It cannot change anything, so it breaks no segregation of
-- duties.
--
-- Idempotent. Password: a placeholder verifier no password produces. Set one with
--   npx tsx scripts/iam/bootstrap.ts --username director
-- =====================================================================
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lms.actor_id = '00000000-0000-0000-0000-000000000001';
SET ROLE lms_owner;

INSERT INTO iam.role (code, name, description, db_role_code, is_system)
VALUES ('demo-director', 'Director (all tabs, read-only)',
        'Demonstration only: reads every register, report and setting in every province; changes nothing. CNICs masked.',
        'Viewer', false)
ON CONFLICT (code) DO NOTHING;

INSERT INTO iam.role_permission (role_id, permission_id, scope_level)
SELECT r.id, p.id, 'global'
  FROM iam.role r JOIN iam.permission p ON p.action = 'read' AND NOT p.is_sensitive
 WHERE r.code = 'demo-director'
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO lms.app_user (code, username, full_name, role_code, department, position, office_code, email, password_hash, status)
SELECT lms.next_code('USR-'), 'director', 'Asif Rehman', 'Viewer', 'Management', 'Director (demo, all tabs)', 'HO_ISB',
       'director@lms.invalid', '$2b$12$seedplaceholderseedplaceholderseedplaceholderseedplaceholde', 'Active'
 WHERE NOT EXISTS (SELECT 1 FROM lms.app_user WHERE username = 'director');

INSERT INTO lms.app_user_province (user_id, province_code)
SELECT a.id, p FROM lms.app_user a, unnest(ARRAY['SND','BAL','PNJ','KPK']) AS p
 WHERE a.username = 'director'
ON CONFLICT DO NOTHING;

INSERT INTO iam.user_role (user_id, role_id, granted_by, reason)
SELECT a.id, r.id, '00000000-0000-0000-0000-000000000001'::uuid, 'demo seed: all-tabs director account'
  FROM lms.app_user a JOIN iam.role r ON r.code = 'demo-director'
 WHERE a.username = 'director'
   AND NOT EXISTS (SELECT 1 FROM iam.user_role ur WHERE ur.user_id = a.id AND ur.role_id = r.id AND ur.revoked_at IS NULL);

SELECT 'director: ' || count(*) || ' permissions' FROM iam.role_permission rp JOIN iam.role r ON r.id = rp.role_id WHERE r.code = 'demo-director';
COMMIT;
