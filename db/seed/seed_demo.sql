-- =====================================================================
-- Fictional demonstration data
-- =====================================================================
-- EVERY RECORD HERE IS INVENTED. The names, CNICs, IBANs, parcel numbers,
-- amounts and court cases are fabricated for demonstration and testing. No
-- real landowner, payment or litigation appears in this file.
--
-- Not a migration: this is never loaded automatically, and a production
-- database must not have it. Load it explicitly:
--
--   psql -d lms_dev -U lms_migrator -f db/seed/seed_demo.sql
--
-- It is idempotent at the file level — it refuses to run twice rather than
-- doubling the data.
--
-- Passwords: the hashes below are placeholders in bcrypt's shape that no
-- password produces. Demo accounts therefore cannot be signed in to until a
-- real verifier is set out of band. That is deliberate: a seed file with a
-- known working password is how a demo credential reaches production.
-- =====================================================================
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lms.actor_id = '00000000-0000-0000-0000-000000000001';
SET ROLE lms_owner;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM lms.project LIMIT 1) THEN
    RAISE EXCEPTION 'this database already holds project data; refusing to seed over it'
      USING HINT = 'drop and re-migrate, or load the seed into a fresh database';
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- Users. One per role and per approval position, so every workflow step has
-- somebody who can act on it and segregation of duties is demonstrable.
-- ---------------------------------------------------------------------
CREATE TEMP TABLE _u (username text, full_name text, role_code text, dept text,
                      pos text, office text, groups text[], provinces text[]);
INSERT INTO _u VALUES
 ('admin',   'Asma Rahim',      'Admin',    'IT',          'System Administrator',          'HO_ISB',  ARRAY['System Administrator'],            ARRAY['SND','BAL','PNJ','KPK']),
 ('mland',   'Imran Qadir',     'Approver', 'Land',        'Manager Land (HO)',             'HO_ISB',  ARRAY['Manager Land (HO)'],               ARRAY['SND','BAL','PNJ','KPK']),
 ('finance', 'Shazia Noor',     'Approver', 'Finance',     'Finance Officer',               'HO_ISB',  ARRAY['Finance Officer'],                 ARRAY['SND','BAL','PNJ','KPK']),
 ('audit',   'Tariq Mehmood',   'Viewer',   'Internal Audit','Audit Officer',               'HO_ISB',  ARRAY['Internal Audit'],                  ARRAY['SND','BAL','PNJ','KPK']),
 ('dmfield', 'Nadia Baig',      'Approver', 'Land',        'DM / Team Lead (Field)',        'FO_DHRK', ARRAY['DM / Team Lead (Field)'],          ARRAY['SND']),
 ('sradmin', 'Faisal Shaikh',   'Approver', 'Land',        'Sr. Administrator LMS (Field)', 'FO_DHRK', ARRAY['Sr. Administrator LMS (Field)'],   ARRAY['SND']),
 ('legal',   'Ayesha Siddiqui', 'Approver', 'Legal',       'Legal Advisor',                 'HO_ISB',  ARRAY['Legal Advisor'],                   ARRAY['SND','BAL','PNJ','KPK']),
 ('nego',    'Bilal Chandio',   'User',     'Land',        'Negotiation Officer',           'FO_DHRK', ARRAY['Negotiation Group'],               ARRAY['SND']),
 ('lofield', 'Sanaullah Khoso', 'User',     'Land',        'Land Officer',                  'FO_DHRK', ARRAY['Land Officer (Field)'],            ARRAY['SND']),
 ('loquetta','Zarak Baloch',    'User',     'Land',        'Land Officer',                  'OF_QTA',  ARRAY['Land Officer (Field)'],            ARRAY['BAL']),
 -- Quetta-office staff hold Balochistan access only, and Daharki staff hold
 -- Sindh only. Keeping the two sets disjoint is what makes the cross-province
 -- isolation tests meaningful: there is no account that can approve in both.
 ('negoqta', 'Samiullah Marri', 'User',     'Land',        'Negotiation Officer',           'OF_QTA',  ARRAY['Negotiation Group'],               ARRAY['BAL']),
 ('sradmqta','Rahim Jamali',    'Approver', 'Land',        'Sr. Administrator LMS (Field)', 'OF_QTA',  ARRAY['Sr. Administrator LMS (Field)'],   ARRAY['BAL']),
 ('dmqta',   'Benazir Raisani', 'Approver', 'Land',        'DM / Team Lead (Field)',        'OF_QTA',  ARRAY['DM / Team Lead (Field)'],          ARRAY['BAL']),
 -- The regional office covers Punjab and KPK, where the company holds less
 -- land and does not staff a field office.
 ('lopnj',   'Waqar Lashari',   'User',     'Land',        'Land Officer',                  'OF_REG',  ARRAY['Land Officer (Field)'],            ARRAY['PNJ','KPK']),
 ('sradmpnj','Rukhsana Bibi',   'Approver', 'Land',        'Sr. Administrator LMS (Field)', 'OF_REG',  ARRAY['Sr. Administrator LMS (Field)'],   ARRAY['PNJ','KPK']),
 -- An analyst holds no approval position (migration 0047): not Internal Audit.
 ('viewer',  'Hina Jamal',      'Viewer',   'Planning',    'Analyst',                       'HO_ISB',  ARRAY[]::text[],                         ARRAY['SND','BAL','PNJ','KPK']);

INSERT INTO lms.app_user (code, username, full_name, role_code, department, position,
                          office_code, email, password_hash, status)
SELECT lms.next_code('USR-'), u.username, u.full_name, u.role_code, u.dept, u.pos,
       u.office, u.username || '@lms.invalid',
       -- Placeholder. No password produces this verifier.
       '$2b$12$seedplaceholderseedplaceholderseedplaceholderseedplaceholde',
       'Active'
FROM _u u ORDER BY u.username;

INSERT INTO lms.app_user_group (user_id, group_code)
SELECT a.id, g FROM _u u JOIN lms.app_user a ON a.username = u.username,
     unnest(u.groups) AS g;

INSERT INTO lms.app_user_province (user_id, province_code)
SELECT a.id, p FROM _u u JOIN lms.app_user a ON a.username = u.username,
     unnest(u.provinces) AS p;

-- ---------------------------------------------------------------------
-- Administrative hierarchy. One complete chain per province, to the depth
-- that province actually has.
-- ---------------------------------------------------------------------
CREATE TEMP TABLE _au (province char(3), level smallint, name text, parent_name text);
INSERT INTO _au VALUES
 -- Sindh: District → Taluka → Deh
 ('SND',0,'Ghotki',NULL), ('SND',1,'Daharki','Ghotki'), ('SND',1,'Mirpur Mathelo','Ghotki'),
 ('SND',2,'Jarwar','Daharki'), ('SND',2,'Bago Daharki','Daharki'), ('SND',2,'Bachal Shah','Mirpur Mathelo'),
 ('SND',0,'Sukkur',NULL), ('SND',1,'Rohri','Sukkur'), ('SND',2,'Arore','Rohri'),
 -- Balochistan: District → Sub-Division → Tehsil → Sub-Tehsil → Mouza
 ('BAL',0,'Dera Bugti',NULL), ('BAL',1,'Sui','Dera Bugti'), ('BAL',2,'Sui Tehsil','Sui'),
 ('BAL',3,'Pirkoh Halka','Sui Tehsil'), ('BAL',4,'Pirkoh','Pirkoh Halka'),
 ('BAL',4,'Loti','Pirkoh Halka'),
 -- Punjab: District → Tehsil → Qanungo Halka → Mouza
 ('PNJ',0,'Rajanpur',NULL), ('PNJ',1,'Jampur','Rajanpur'),
 ('PNJ',2,'Dajal Halka','Jampur'), ('PNJ',3,'Chak Dajal','Dajal Halka'),
 ('PNJ',3,'Basti Lashari','Dajal Halka'),
 -- KPK: District → Sub-Division → Tehsil → Mouza
 ('KPK',0,'Karak',NULL), ('KPK',1,'Karak Sub-Division','Karak'),
 ('KPK',2,'Takht-e-Nasrati','Karak Sub-Division'), ('KPK',3,'Nashpa','Takht-e-Nasrati');

DO $$
DECLARE r record; v_parent uuid; v_pfx text; v_lvl text;
BEGIN
  FOR r IN SELECT * FROM _au ORDER BY province, level LOOP
    v_parent := NULL;
    IF r.parent_name IS NOT NULL THEN
      SELECT id INTO v_parent FROM lms.admin_unit
      WHERE province_code = r.province AND name = r.parent_name AND level = r.level - 1;
    END IF;
    SELECT name INTO v_lvl FROM lms.province_level
     WHERE province_code = r.province AND depth = r.level;
    v_pfx := r.province || '-'
             || upper(substr(regexp_replace(v_lvl, '[^A-Za-z]', '', 'g'), 1, 3))
             || r.level::text || '-';
    INSERT INTO lms.admin_unit (code, province_code, level, parent_id, name)
    VALUES (lms.next_code(v_pfx), r.province, r.level, v_parent, r.name);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- Projects
-- ---------------------------------------------------------------------
INSERT INTO lms.project (code, name, type_code, block, province_code, district_id,
                         required_area, lat, lng, status, description)
SELECT v.code, v.name, v.type_code, v.block, v.prov, au.id, v.area, v.lat, v.lng, v.status, v.descr
FROM (VALUES
 ('DHRK-001','Daharki Well-01 Location & Access Road','Well Location','Daharki D&PL','SND','Ghotki', 12.5000, 28.061200, 69.687400,'Active','Exploratory well with 1.8 km access road'),
 ('DHRK-10P','Daharki Flowline 10-inch','Pipeline','Daharki D&PL','SND','Ghotki',  8.2500, 28.040000, 69.660000,'Active','10-inch flowline, well-01 to gathering station'),
 ('DHRK-002','Daharki Gathering Station','Compressor Station','Daharki D&PL','SND','Ghotki', 22.0000, 28.030000, 69.650000,'Active','Gathering and compression facility'),
 ('ROHR-001','Rohri Water Pond','Other','Daharki D&PL','SND','Sukkur', 4.0000, 27.690000, 68.900000,'Active','Water storage for drilling operations'),
 ('SUI-004','Sui Pirkoh Well-04','Well Location','Sui Block','BAL','Dera Bugti', 15.0000, 28.620000, 69.190000,'Active','Development well'),
 ('JMPR-003','Jampur Seismic Camp','Camp / Base','Jampur Block','PNJ','Rajanpur',  6.5000, 29.640000, 70.600000,'Active','2D seismic crew base camp'),
 ('KRK-007','Karak Nashpa Well-07','Well Location','Nashpa Block','KPK','Karak', 11.0000, 33.090000, 71.260000,'Completed','Development well, completed 2025')
) AS v(code,name,type_code,block,prov,district,area,lat,lng,status,descr)
JOIN lms.admin_unit au ON au.name = v.district AND au.level = 0 AND au.province_code = v.prov;

INSERT INTO lms.budget (code, province_code, project_id, fiscal_year, approved_amount, approval_ref)
SELECT lms.next_code('BGT-'), p.province_code, p.id, 2026, b.amount, b.ref
FROM (VALUES
 ('DHRK-001', 120000000.00, 'CAPEX-2026-0114'),
 ('DHRK-10P',  45000000.00, 'CAPEX-2026-0115'),
 ('DHRK-002', 200000000.00, 'CAPEX-2026-0120'),
 ('SUI-004',   80000000.00, 'CAPEX-2026-0131'),
 ('JMPR-003',  25000000.00, 'OPEX-2026-0077')
) AS b(code, amount, ref)
JOIN lms.project p ON p.code = b.code::lms.record_code;

-- ---------------------------------------------------------------------
-- Surveys (parcels)
-- ---------------------------------------------------------------------
INSERT INTO lms.survey (code, province_code, admin_unit_id, survey_no, block_no, khasra_type,
                        total_area, land_class, status_code, lat, lng, remarks)
SELECT lms.next_code('AREA-'), v.prov, au.id, v.survey_no, v.block_no, v.khasra_type,
       v.area, v.land_class, v.status, v.lat, v.lng, v.remarks
FROM (VALUES
 ('SND','Jarwar',      '112', '7',  NULL,     18.7500,'Private',   'Leased',            28.061000, 69.687000,'Well-01 pad and access'),
 ('SND','Jarwar',      '113', '7',  NULL,     26.0000,'Private',   'Leased',            28.059000, 69.684000,'Access road corridor'),
 ('SND','Jarwar',      '118', '7',  NULL,     31.2500,'Private',   'Under Acquisition', 28.055000, 69.680000,'Flowline route'),
 ('SND','Bago Daharki','204', '11', NULL,     44.5000,'Government','Leased',            28.040000, 69.661000,'Government land, DBPFC rate pending'),
 ('SND','Bago Daharki','207', '11', NULL,     12.0000,'Private',   'Proposed',          28.038000, 69.658000,'Gathering station option'),
 ('SND','Bachal Shah', '331', '14', NULL,     55.7500,'Private',   'Disputed',          28.090000, 69.720000,'Succession dispute pending'),
 ('SND','Arore',       '42',  '3',  NULL,      9.5000,'Private',   'Acquired',          27.691000, 68.901000,'Water pond'),
 ('BAL','Pirkoh',      '1187',NULL, NULL,     63.0000,'Private',   'Leased',            28.621000, 69.191000,'Well-04 pad'),
 ('BAL','Loti',        '1204',NULL, NULL,     38.5000,'Private',   'Proposed',          28.600000, 69.170000,'Future development'),
 ('PNJ','Chak Dajal',  '556', NULL, NULL,     21.0000,'Private',   'Leased',            29.641000, 70.601000,'Seismic camp'),
 ('PNJ','Basti Lashari','604',NULL, NULL,     17.2500,'Private',   'Proposed',          29.630000, 70.590000,'Camp extension option'),
 ('KPK','Nashpa',      '88',  NULL, 'Rural',  29.0000,'Private',   'Acquired',          33.091000, 71.261000,'Well-07 pad, purchased'),
 ('KPK','Nashpa',      '89',  NULL, 'Urban',   3.5000,'Private',   'Acquired',          33.093000, 71.263000,'Site office')
) AS v(prov, unit, survey_no, block_no, khasra_type, area, land_class, status, lat, lng, remarks)
JOIN lms.admin_unit au ON au.name = v.unit AND au.province_code = v.prov;

INSERT INTO lms.project_survey (project_id, survey_id)
SELECT p.id, s.id FROM (VALUES
 ('DHRK-001','112','7'), ('DHRK-001','113','7'), ('DHRK-10P','118','7'),
 ('DHRK-002','204','11'), ('DHRK-002','207','11'), ('ROHR-001','42','3'),
 ('SUI-004','1187',NULL), ('JMPR-003','556',NULL),
 ('KRK-007','88',NULL), ('KRK-007','89',NULL)
) AS v(proj, sno, bno)
JOIN lms.project p ON p.code = v.proj::lms.record_code
JOIN lms.survey  s ON s.survey_no = v.sno
                  AND coalesce(s.block_no,'') = coalesce(v.bno,'')
                  AND s.province_code = p.province_code;

-- ---------------------------------------------------------------------
-- Landowners and their holdings
-- ---------------------------------------------------------------------
INSERT INTO lms.landowner (code, province_code, full_name, father_name, cnic, phone,
                           owner_type, status, tax_status, bank_branch, iban, address)
SELECT lms.next_code(v.prov || '-'), v.prov, v.nm, v.fa, v.cnic, v.ph, v.ot, v.st, v.tax, v.bank, v.iban, v.addr
FROM (VALUES
 ('SND','Allah Dino Jarwar','Ghulam Hussain Jarwar','45102-1100011-1','+92 300 1110011','O','Deceased','Filer', 'HBL Daharki','PK24HABB0000011000110011','Village Jarwar, Daharki, Ghotki'),
 ('SND','Mukhtiar Ali Jarwar','Allah Dino Jarwar',  '45102-1100012-3','+92 300 1110012','O','Active','Filer',   'HBL Daharki','PK24HABB0000011000110012','Village Jarwar, Daharki, Ghotki'),
 ('SND','Zubaida Khatoon','Allah Dino Jarwar',      '45102-1100013-6','+92 300 1110013','O','Active','Non-Filer','HBL Daharki','PK24HABB0000011000110013','Village Jarwar, Daharki, Ghotki'),
 ('SND','Rasool Bux Khoso','Hyder Bux Khoso',       '45102-1100014-9','+92 301 1110014','B','Active','Filer',   'UBL Mirpur Mathelo','PK77UNIL0000011000110014','Bago Daharki, Ghotki'),
 ('SND','Ghulam Qadir Mahar','Sher Mohammad Mahar', '45102-1100015-2','+92 302 1110015','O','Active','Filer',   'MCB Ghotki','PK36MUCB0000011000110015','Bachal Shah, Mirpur Mathelo'),
 ('SND','Noor Mohammad Shaikh','Abdul Razzak Shaikh','45201-1100016-5','+92 303 1110016','A','Active','Filer',  'HBL Rohri','PK24HABB0000011000110016','Arore, Rohri, Sukkur'),
 ('BAL','Shahbaz Khan Bugti','Mir Doda Khan Bugti', '52101-1200021-4','+92 333 1200021','O','Active','Non-Filer','NBP Sui','PK11NBPA0000012000120021','Pirkoh, Dera Bugti'),
 ('BAL','Gul Hassan Bugti','Mir Doda Khan Bugti',   '52101-1200022-7','+92 333 1200022','O','Active','Non-Filer','NBP Sui','PK11NBPA0000012000120022','Pirkoh, Dera Bugti'),
 ('PNJ','Muhammad Aslam Lashari','Ahmed Bakhsh Lashari','32303-1300031-8','+92 345 1300031','O','Active','Filer','BOP Jampur','PK55BPUN0000013000130031','Chak Dajal, Jampur, Rajanpur'),
 ('KPK','Niaz Mohammad Khattak','Sher Zaman Khattak','14301-1400041-2','+92 346 1400041','O','Active','Filer', 'HBL Karak','PK24HABB0000014000140041','Nashpa, Takht-e-Nasrati, Karak')
) AS v(prov,nm,fa,cnic,ph,ot,st,tax,bank,iban,addr);

-- Holdings. Shares per parcel never exceed 100%; the deferred constraint
-- trigger checks that at COMMIT.
INSERT INTO lms.survey_ownership_share (survey_id, landowner_id, share_pct, revenue_doc_ref, effective_from)
SELECT s.id, lo.id, v.share, v.ref, v.eff::date
FROM (VALUES
 ('112', '7',  '45102-1100011-1', 100.0000, 'Form VII-B / 112-7 / 2019', '2019-04-02'),
 ('113', '7',  '45102-1100012-3',  60.0000, 'Form VII-B / 113-7 / 2021', '2021-06-14'),
 ('113', '7',  '45102-1100013-6',  40.0000, 'Form VII-B / 113-7 / 2021', '2021-06-14'),
 ('118', '7',  '45102-1100012-3', 100.0000, 'Form VII-B / 118-7 / 2022', '2022-01-20'),
 ('207', '11', '45102-1100014-9', 100.0000, 'Form VII-B / 207-11 / 2020','2020-09-09'),
 ('331', '14', '45102-1100015-2',  75.0000, 'Form VII-B / 331-14 / 2018','2018-03-11'),
 ('42',  '3',  '45201-1100016-5', 100.0000, 'Form VII-B / 42-3 / 2023',  '2023-07-01'),
 ('1187',NULL, '52101-1200021-4',  50.0000, 'Khasra 1187 / 2020',        '2020-02-02'),
 ('1187',NULL, '52101-1200022-7',  50.0000, 'Khasra 1187 / 2020',        '2020-02-02'),
 ('1204',NULL, '52101-1200021-4', 100.0000, 'Khasra 1204 / 2021',        '2021-11-15'),
 ('556', NULL, '32303-1300031-8', 100.0000, 'Khasra 556 / 2022',         '2022-05-05'),
 ('88',  NULL, '14301-1400041-2', 100.0000, 'Khasra 88 / 2017',          '2017-08-19')
) AS v(sno, bno, cnic, share, ref, eff)
JOIN lms.landowner lo ON lo.cnic = v.cnic::lms.cnic
JOIN lms.survey s ON s.survey_no = v.sno
                 AND coalesce(s.block_no,'') = coalesce(v.bno,'')
                 AND s.province_code = lo.province_code;

-- ---------------------------------------------------------------------
-- RBAC roles for the demo accounts. Same mapping migration 0023 applies to
-- accounts that already exist, repeated here because on a clean build the
-- migrations run before any account does.
-- ---------------------------------------------------------------------
INSERT INTO iam.user_role(user_id, role_id, granted_by, reason)
SELECT u.id, r.id, '00000000-0000-0000-0000-000000000001'::uuid, 'demo seed'
FROM lms.app_user u
JOIN iam.role r ON r.code = (
  CASE
    WHEN u.role_code = 'Admin' THEN 'system-administrator'
    -- Dedicated designation roles (migration 0047), ahead of the generic tiers.
    WHEN EXISTS (SELECT 1 FROM lms.app_user_group g WHERE g.user_id=u.id AND g.group_code='Legal Advisor') THEN 'legal-advisor'
    WHEN EXISTS (SELECT 1 FROM lms.app_user_group g WHERE g.user_id=u.id AND g.group_code='Negotiation Group') THEN 'negotiation-officer'
    WHEN u.role_code = 'Approver' AND EXISTS (SELECT 1 FROM lms.app_user_group g WHERE g.user_id=u.id AND g.group_code='Manager Land (HO)') THEN 'land-manager'
    WHEN u.role_code = 'Approver' AND EXISTS (SELECT 1 FROM lms.app_user_group g WHERE g.user_id=u.id AND g.group_code='Finance Officer') THEN 'finance-approver'
    WHEN u.role_code = 'Approver' THEN 'case-approver'
    WHEN u.role_code = 'User' THEN 'data-entry'
    WHEN EXISTS (SELECT 1 FROM lms.app_user_group g WHERE g.user_id=u.id AND g.group_code='Internal Audit') THEN 'security-auditor'
    ELSE 'viewer' END)
WHERE u.is_service_account = false
  AND NOT EXISTS (SELECT 1 FROM iam.user_role x WHERE x.user_id = u.id AND x.revoked_at IS NULL);
INSERT INTO iam.user_role(user_id, role_id, granted_by, reason)
SELECT DISTINCT u.id, (SELECT id FROM iam.role WHERE code='case-approver'), '00000000-0000-0000-0000-000000000001'::uuid,
       'holds an approval position in the case workflow'
FROM lms.app_user u JOIN lms.app_user_group g ON g.user_id = u.id
JOIN lms.workflow_step_group s ON s.group_code = g.group_code AND s.workflow_code = 'cases'
WHERE u.is_service_account = false AND u.role_code NOT IN ('Admin','Viewer')
  AND NOT EXISTS (SELECT 1 FROM iam.user_role x JOIN iam.role r ON r.id=x.role_id
                  WHERE x.user_id=u.id AND r.code IN ('case-approver','land-manager','legal-advisor','negotiation-officer')
                    AND x.revoked_at IS NULL);

COMMIT;
