-- =====================================================================
-- First administrator for an EMPTY production database
-- =====================================================================
-- Creates one account, "admin", with the system-administrator role, the
-- System Administrator position and all four provinces. It has NO usable
-- password: set one afterwards with
--   DATABASE_URL_ADMIN=... npx tsx scripts/iam/bootstrap.ts --username admin
--
--   psql -h 127.0.0.1 -U lms_migrator -d lms_prod \
--        -v name='Full Name' -v email='admin@example.com' -f db/seed/seed_production_admin.sql
--
-- Idempotent: does nothing if "admin" already exists. Everything else
-- (users, roles, provinces, positions) is then done in the app as admin.
-- =====================================================================
\set ON_ERROR_STOP on
\if :{?name}
\else
  \set name 'System Administrator'
\endif
\if :{?email}
\else
  \set email 'admin@lms.invalid'
\endif

BEGIN;
SET LOCAL lms.actor_id = '00000000-0000-0000-0000-000000000001';
SET ROLE lms_owner;

CREATE TEMP TABLE _a (full_name text, email text);
INSERT INTO _a VALUES (:'name', :'email');

INSERT INTO lms.app_user (code, username, full_name, role_code, department, position, office_code, email, password_hash, status)
SELECT lms.next_code('USR-'), 'admin', a.full_name, 'Admin', 'IT', 'System Administrator', NULL, a.email,
       -- Placeholder. No password produces this verifier; bootstrap.ts sets a real one.
       '$2b$12$seedplaceholderseedplaceholderseedplaceholderseedplaceholde', 'Active'
FROM _a a
WHERE NOT EXISTS (SELECT 1 FROM lms.app_user WHERE username = 'admin');

INSERT INTO lms.app_user_group (user_id, group_code)
SELECT u.id, 'System Administrator' FROM lms.app_user u
WHERE u.username = 'admin'
  AND NOT EXISTS (SELECT 1 FROM lms.app_user_group g WHERE g.user_id = u.id AND g.group_code = 'System Administrator');

INSERT INTO lms.app_user_province (user_id, province_code)
SELECT u.id, p.code FROM lms.app_user u CROSS JOIN lms.province p
WHERE u.username = 'admin'
  AND NOT EXISTS (SELECT 1 FROM lms.app_user_province x WHERE x.user_id = u.id AND x.province_code = p.code);

INSERT INTO iam.user_role (user_id, role_id, granted_by, reason)
SELECT u.id, r.id, '00000000-0000-0000-0000-000000000001'::uuid, 'first administrator (production bootstrap)'
FROM lms.app_user u JOIN iam.role r ON r.code = 'system-administrator'
WHERE u.username = 'admin'
  AND NOT EXISTS (SELECT 1 FROM iam.user_role x WHERE x.user_id = u.id AND x.role_id = r.id AND x.revoked_at IS NULL);

SELECT username, full_name, status FROM lms.app_user WHERE username = 'admin';
COMMIT;
