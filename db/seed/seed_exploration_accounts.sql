-- =====================================================================
-- Demo accounts for the exploration land-request flow (migration 0057)
-- =====================================================================
-- EVERY NAME HERE IS INVENTED. Fictional demonstration accounts, like
-- seed_demo.sql. Not a migration; never load it into production.
--
--   psql -d lms_dev -U lms_migrator -f db/seed/seed_exploration_accounts.sql
--
-- Idempotent: an account that already exists is left as it is.
-- Passwords: a placeholder verifier no password produces. Set one with
--   npx tsx scripts/iam/bootstrap.ts --username explorer
--
-- The flow these accounts make possible:
--   explorer / explorerqta  Exploration Planner: draws and raises the request
--   dirops                  Director Operations (tier 2), every province
--   regmgr / regmgrqta / regmgrpnj  Regional Manager (tier 3), SND / BAL / PNJ+KPK
--   landaffairs / landaffqta / landaffpnj  DM / TL Land Affairs (tier 4), SND / BAL / PNJ+KPK
--   lofield / loquetta      (existing) Land Officer: also raises requests, and
--                           takes an approved one up ("Start land work")
-- =====================================================================
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lms.actor_id = '00000000-0000-0000-0000-000000000001';
SET ROLE lms_owner;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM iam.role WHERE code = 'exploration-planner') THEN
    RAISE EXCEPTION 'migration 0057 has not been applied to this database';
  END IF;
END $$;

CREATE TEMP TABLE _x (username text, full_name text, role_code text, dept text, pos text, office text,
                      groups text[], provinces text[], iam_role text);
INSERT INTO _x VALUES
 ('explorer',    'Usman Ghani',    'User',     'Exploration', 'Exploration Planner',          'FO_DHRK', ARRAY[]::text[],                ARRAY['SND'],                   'exploration-planner'),
 ('explorerqta', 'Kamran Bugti',   'User',     'Exploration', 'Exploration Planner',          'OF_QTA',  ARRAY[]::text[],                ARRAY['BAL'],                   'exploration-planner'),
 ('dirops',      'Javed Akhtar',   'Approver', 'Operations',  'Director Operations',          'HO_ISB',  ARRAY['Director Operations'],   ARRAY['SND','BAL','PNJ','KPK'], 'land-request-reviewer'),
 ('regmgr',      'Sadia Memon',    'Approver', 'Operations',  'Regional Manager (Sindh)',     'FO_DHRK', ARRAY['Regional Manager'],      ARRAY['SND'],                   'land-request-reviewer'),
 ('regmgrqta',   'Naseer Kakar',   'Approver', 'Operations',  'Regional Manager (Balochistan)','OF_QTA', ARRAY['Regional Manager'],      ARRAY['BAL'],                   'land-request-reviewer'),
 ('landaffairs', 'Zubair Soomro',  'Approver', 'Land',        'DM / TL Land Affairs',         'FO_DHRK', ARRAY['DM / TL Land Affairs'],  ARRAY['SND'],                   'case-approver'),
 ('landaffqta',  'Gul Bano Rind',  'Approver', 'Land',        'DM / TL Land Affairs',         'OF_QTA',  ARRAY['DM / TL Land Affairs'],  ARRAY['BAL'],                   'case-approver'),
 -- Punjab and KPK (regional office): without these no PNJ/KPK land request could pass tiers 3 and 4.
 ('regmgrpnj',   'Shahid Leghari', 'Approver', 'Operations',  'Regional Manager (Punjab/KPK)','OF_REG',  ARRAY['Regional Manager'],      ARRAY['PNJ','KPK'],             'land-request-reviewer'),
 ('landaffpnj',  'Farah Khattak',  'Approver', 'Land',        'DM / TL Land Affairs',         'OF_REG',  ARRAY['DM / TL Land Affairs'],  ARRAY['PNJ','KPK'],             'case-approver');

DELETE FROM _x WHERE username IN (SELECT username::text FROM lms.app_user);

INSERT INTO lms.app_user (code, username, full_name, role_code, department, position, office_code, email, password_hash, status)
SELECT lms.next_code('USR-'), x.username, x.full_name, x.role_code, x.dept, x.pos, x.office, x.username || '@lms.invalid',
       -- Placeholder. No password produces this verifier.
       '$2b$12$seedplaceholderseedplaceholderseedplaceholderseedplaceholde', 'Active'
FROM _x x ORDER BY x.username;

INSERT INTO lms.app_user_group (user_id, group_code)
SELECT a.id, g FROM _x x JOIN lms.app_user a ON a.username = x.username, unnest(x.groups) AS g;

INSERT INTO lms.app_user_province (user_id, province_code)
SELECT a.id, p FROM _x x JOIN lms.app_user a ON a.username = x.username, unnest(x.provinces) AS p;

INSERT INTO iam.user_role (user_id, role_id, granted_by, reason)
SELECT a.id, r.id, '00000000-0000-0000-0000-000000000001'::uuid, 'demo seed: exploration land-request flow (0057)'
FROM _x x JOIN lms.app_user a ON a.username = x.username JOIN iam.role r ON r.code = x.iam_role;

SELECT 'added: ' || coalesce(string_agg(username, ', ' ORDER BY username), 'none (all present)') FROM _x;
COMMIT;
