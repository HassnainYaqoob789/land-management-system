-- role: lms_owner
-- tx: rollback
-- actor: admin
--
-- Schema constraints: primary and foreign keys, CHECKs, unique keys, the
-- exclusion constraint, and the deletion policies.
\set QUIET on

DO $$
DECLARE fx record; v_unit uuid; v_lines integer;
BEGIN
  SELECT * INTO fx FROM test.fixtures;

  -- ---------- foreign keys ----------
  PERFORM test.throws($q$
    INSERT INTO lms.project (code, name, type_code, block, province_code, district_id, status)
    VALUES ('FK-TEST-1','FK test','Well Location','Blk','SND',
            '00000000-0000-0000-0000-0000000000ff','Active')
  $q$, 'P0002', 'a project cannot reference a district that does not exist (0046: refused by the admin-unit check before the foreign key)');

  PERFORM test.throws($q$
    INSERT INTO lms.survey (code, province_code, admin_unit_id, survey_no, total_area,
                            land_class, status_code)
    SELECT 'FK-TEST-2','SND', au.id, '999', 1.0, 'Private', 'Not A Status'
    FROM lms.admin_unit au WHERE au.province_code='SND' LIMIT 1
  $q$, '23503', 'a parcel cannot have a land status that is not in the lookup');

  -- The composite (id, province_code) key: a parcel cannot claim a province
  -- different from the administrative unit it sits in.
  PERFORM test.throws($q$
    INSERT INTO lms.survey (code, province_code, admin_unit_id, survey_no, total_area,
                            land_class, status_code)
    SELECT 'FK-TEST-3','PNJ', au.id, '998', 1.0, 'Private','Proposed'
    FROM lms.admin_unit au WHERE au.province_code='SND' AND au.level=2 LIMIT 1
  $q$, 'P0002', 'a parcel cannot sit in a unit belonging to another province (0046: the admin-unit check refuses it first)');

  -- ---------- CHECK constraints ----------
  PERFORM test.throws($q$
    INSERT INTO lms.landowner (code, province_code, full_name, father_name, cnic, owner_type, status)
    VALUES ('CK-1','SND','Test Person','Test Father','123-456-7','O','Active')
  $q$, '23514', 'a malformed CNIC is refused by the domain');

  PERFORM test.throws($q$
    INSERT INTO lms.landowner (code, province_code, full_name, father_name, cnic,
                               owner_type, status, iban)
    VALUES ('CK-2','SND','Test Person','Test Father','45102-9999999-1','O','Active','NOTANIBAN')
  $q$, '23514', 'a malformed IBAN is refused');

  PERFORM test.throws($q$
    UPDATE lms.survey SET total_area = 0 WHERE id = (SELECT survey_112 FROM test.fixtures)
  $q$, '23514', 'a parcel area of zero is refused');

  PERFORM test.throws($q$
    UPDATE lms.survey SET total_area = -5 WHERE id = (SELECT survey_112 FROM test.fixtures)
  $q$, '23514', 'a negative parcel area is refused by the domain');

  PERFORM test.throws($q$
    INSERT INTO lms.app_user (code, username, full_name, role_code, password_hash)
    VALUES ('CK-3','plaintextuser','Plain Text','User','hunter2')
  $q$, '23514', 'a plaintext password cannot be stored in password_hash');

  PERFORM test.throws($q$
    INSERT INTO lms.dbpfc_estimate (code, province_code, project_id, district_id,
                                    area_acres, estimated_rate, stage_code)
    SELECT 'CK-4','PNJ', p.id, au.id, 1.0, 1000, 'Estimated'
    FROM lms.project p, lms.admin_unit au
    WHERE p.province_code='PNJ' AND au.province_code='PNJ' AND au.level=0 LIMIT 1
  $q$, '23514', 'a DBPFC estimate outside Sindh is refused');

  -- A payment is paid to a landowner or to a named external body, never both
  -- and never neither.
  PERFORM test.throws($q$
    INSERT INTO lms.payment_request
      (code, province_code, landowner_id, payee_name, project_id, category_code,
       pay_type, period_from, gross_amount, payment_mode, stage_code)
    SELECT 'CK-5','SND', f.lo_mukhtiar, 'Also an external payee', f.proj_dhrk1,
           'Lease Rent','One-time', current_date, 1000, 'Cross Cheque','Requested'
    FROM test.fixtures f
  $q$, '23514', 'a payment cannot have both a landowner and an external payee');

  PERFORM test.throws($q$
    INSERT INTO lms.payment_request
      (code, province_code, project_id, category_code, pay_type, period_from,
       gross_amount, payment_mode, stage_code)
    SELECT 'CK-6','SND', f.proj_dhrk1,'Lease Rent','One-time', current_date,
           1000,'Cross Cheque','Requested' FROM test.fixtures f
  $q$, '23514', 'a payment with no payee at all is refused');

  PERFORM test.throws($q$
    INSERT INTO lms.payment_hold (scope, reason, placed_by)
    SELECT 'landowner','no target given', f.u_admin FROM test.fixtures f
  $q$, 'P0002', 'a landowner-scoped hold with no landowner is refused (0042: the hold trigger finds no target before the CHECK)');

  PERFORM test.throws($q$
    UPDATE lms.project SET lat = 28.0, lng = NULL WHERE id = (SELECT proj_dhrk1 FROM test.fixtures)
  $q$, '23514', 'half a coordinate pair is refused');

  PERFORM test.throws($q$
    INSERT INTO lms.document (code, entity, record_id, file_name, mime_type, size_bytes,
                              category_code, storage_ref, content_sha256, uploaded_by)
    SELECT 'CK-7','survey', f.survey_112, 'payload.svg', 'image/svg+xml', 100,
           'Photograph','s3://x', sha256('x'::bytea), f.u_admin FROM test.fixtures f
  $q$, '23514', 'an SVG upload is refused: the mime allowlist excludes it');

  PERFORM test.throws($q$
    INSERT INTO lms.document (code, entity, record_id, file_name, mime_type, size_bytes,
                              category_code, storage_ref, content_sha256, uploaded_by)
    SELECT 'CK-8','survey', f.survey_112, 'huge.pdf','application/pdf', 60000000,
           'Photograph','s3://x', sha256('x'::bytea), f.u_admin FROM test.fixtures f
  $q$, '23514', 'an upload over the 50 MiB cap is refused');

  -- ---------- unique keys ----------
  PERFORM test.throws($q$
    INSERT INTO lms.landowner (code, province_code, full_name, father_name, cnic, owner_type, status)
    VALUES ('UQ-1','SND','Impostor','Someone','45102-1100012-3','O','Active')
  $q$, '23505', 'a second landowner with the same CNIC is refused');

  PERFORM test.throws($q$
    INSERT INTO lms.survey (code, province_code, admin_unit_id, survey_no, block_no,
                            total_area, land_class, status_code)
    SELECT 'UQ-2', s.province_code, s.admin_unit_id, s.survey_no, s.block_no,
           1.0,'Private','Proposed'
    FROM lms.survey s WHERE s.id = (SELECT survey_112 FROM test.fixtures)
  $q$, '23505', 'a duplicate survey number in the same unit is refused');

  -- The coalesce() in survey_revenue_key_uq: without it, two parcels with the
  -- same number and a NULL block number would both be accepted.
  SELECT au.id INTO v_unit FROM lms.admin_unit au
   WHERE au.province_code='BAL' AND au.level=4 LIMIT 1;
  INSERT INTO lms.survey (code, province_code, admin_unit_id, survey_no, total_area,
                          land_class, status_code)
  VALUES ('UQ-NULLBLK','BAL', v_unit, 'NB-1', 1.0, 'Private','Proposed');
  PERFORM test.throws($q$
    INSERT INTO lms.survey (code, province_code, admin_unit_id, survey_no, total_area,
                            land_class, status_code)
    SELECT 'UQ-NULLBLK2','BAL', au.id, 'NB-1', 1.0, 'Private','Proposed'
    FROM lms.admin_unit au WHERE au.province_code='BAL' AND au.level=4 LIMIT 1
  $q$, '23505', 'a duplicate survey number with no block number is still refused');

  PERFORM test.throws($q$
    INSERT INTO lms.budget (code, province_code, project_id, fiscal_year, approved_amount)
    SELECT 'UQ-3','SND', f.proj_dhrk1, 2026, 1000 FROM test.fixtures f
  $q$, '23505', 'a second budget for the same project and year is refused');

  PERFORM test.throws($q$
    INSERT INTO lms.case_owner (case_id, landowner_id, owner_status, share_pct)
    SELECT f.case_draft, (SELECT landowner_id FROM lms.case_owner
                          WHERE case_id = f.case_draft LIMIT 1), 'O', 10
    FROM test.fixtures f
  $q$, '23505', 'the same landowner cannot be listed twice in one case');

  -- ---------- exclusion constraint ----------
  -- A parcel already under an approved lease cannot be leased again over an
  -- overlapping period.
  PERFORM test.throws($q$
    WITH l AS (
      INSERT INTO lms.lease (code, province_code, project_id, kind, initial_area,
                             start_date, term_years, rate_per_acre, stage_code)
      SELECT 'EX-1','SND', f.proj_dhrk1,'Private Land', 1.0,
             current_date - 100, 5, 1000, 'Approved' FROM test.fixtures f
      RETURNING id)
    INSERT INTO lms.lease_survey (lease_id, survey_id)
    SELECT l.id, f.survey_112 FROM l, test.fixtures f
  $q$, '23P01', 'a second overlapping lease on the same parcel is refused by the exclusion constraint');

  -- The same parcel may be leased again once the first lease has ended.
  WITH l AS (
    INSERT INTO lms.lease (code, province_code, project_id, kind, initial_area,
                           start_date, term_years, rate_per_acre, stage_code)
    SELECT 'EX-2','SND', f.proj_dhrk1,'Private Land', 1.0,
           current_date + 3000, 2, 1000, 'Approved' FROM test.fixtures f
    RETURNING id)
  INSERT INTO lms.lease_survey (lease_id, survey_id)
  SELECT l.id, f.survey_112 FROM l, test.fixtures f;
  PERFORM test.ok(true, 'a non-overlapping lease on the same parcel is accepted');

  -- The unit-conversion history cannot claim two factors for one instant.
  PERFORM test.throws($q$
    INSERT INTO lms.unit_conversion (unit_code, sqm_per_unit, valid_from, is_confirmed)
    VALUES ('Acre', 99999, '1950-01-01', true)
  $q$, '23P01', 'two overlapping conversion factors for one unit are refused');

  -- ---------- deletion policies ----------
  -- ON DELETE RESTRICT raises foreign_key_violation (23503) up to PostgreSQL 17 and
  -- restrict_violation (23001) from 18; either is the refusal these cases expect.
  PERFORM test.throws($q$
    DELETE FROM lms.province WHERE code = 'SND'
  $q$, (CASE WHEN current_setting('server_version_num')::int >= 180000 THEN '23001' ELSE '23503' END), 'a province in use cannot be deleted (RESTRICT)');

  PERFORM test.throws($q$
    DELETE FROM lms.landowner WHERE id = (SELECT lo_mukhtiar FROM test.fixtures)
  $q$, (CASE WHEN current_setting('server_version_num')::int >= 180000 THEN '23001' ELSE '23503' END), 'a landowner with holdings cannot be deleted (RESTRICT)');

  PERFORM test.throws($q$
    DELETE FROM lms.app_user WHERE id = (SELECT u_mland FROM test.fixtures)
  $q$, (CASE WHEN current_setting('server_version_num')::int >= 180000 THEN '23001' ELSE '23503' END), 'an account that has acted on a record cannot be deleted (RESTRICT)');

  -- CASCADE where it is right: dropping a draft case takes its lines with it.
  SELECT count(*) INTO v_lines FROM lms.case_lease_line
   WHERE case_id = fx.case_draft;
  PERFORM test.ok(v_lines > 0, 'the draft case has lease lines to cascade');
  DELETE FROM lms.compensation_case WHERE id = (SELECT case_draft FROM test.fixtures);
  PERFORM test.eq((SELECT count(*)::integer FROM lms.case_lease_line
                   WHERE case_id = (SELECT case_draft FROM test.fixtures)), 0,
                  'deleting a draft case cascades to its lease lines');

  -- ---------- generated columns ----------
  PERFORM test.throws($q$
    UPDATE lms.compensation_case SET total_amount = 1
    WHERE id = (SELECT case_approved FROM test.fixtures)
  $q$, '428C9', 'the case total is generated and cannot be written directly');

  PERFORM test.throws($q$
    UPDATE lms.payment_request SET net_amount = 1
    WHERE id = (SELECT pay_verified FROM test.fixtures)
  $q$, '428C9', 'the net payable is generated and cannot be written directly');
END $$;
