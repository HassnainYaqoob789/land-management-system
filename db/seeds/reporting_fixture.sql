-- =====================================================================
-- REPORTING TEST FIXTURE — TEST DATABASES ONLY (refuses any other database)
-- =====================================================================
-- Clearly labelled data for the reporting acceptance tests
-- (tests/regression/reporting_api.test.ts). Every code starts with RPTFX and
-- every CNIC with 99701-, so nothing can be mistaken for a real record.
-- Idempotent: if RPTFX-SND exists it does nothing. It only inserts its own
-- rows (and acts on them through the normal routines); it never touches an
-- existing row.
--
-- What it covers, by province (each reports in a different unit):
--   SND (Acre)  RPTFX-S1 recorded 80 Ghunta (2 ac), owners LO1 60% / LO2 40%
--               RPTFX-S2 recorded 4 Jireb (2 ac, provisional factor), LO1 100%
--               RPTFX-C1 approved 100,000; voucher gross 50,000 with 10% WHT
--                 released and allocated 60/40 -> part paid, 50,000 outstanding
--               RPTFX-C2 approved 20,000, paid in full -> zero balance
--               RPTFX-V5 lease rent released to LO1, allocated to no case
--               RPTFX-A1 acquisition still in Negotiation (incomplete)
--   PNJ (Kanal) RPTFX-P1 recorded 16 Kanal (2 ac), owners LO3 / LO4 50% each
--               RPTFX-C3 approved 40,000, paid 40,000, then adjusted by
--                 -5,000 -> over-paid by 5,000 (a negative adjustment)
--   BAL (Acre)  RPTFX-B1 recorded 8 Rod (2 ac), LO5 100%
--               RPTFX-C4 approved 30,000, released then REVERSED -> unpaid
--   KPK (Kanal) RPTFX-K1 3 ac with no recorded unit (unit not kept), LO6 100%
--               RPTFX-C5 assessed 25,000, still at Verified (not approved)
--   LO7 has no ownership share at all.
-- Run as the table owner: SET ROLE lms_owner (tests/iam/client.ts sql() does).
DO $fixture$
DECLARE
  v_admin uuid; v_mland uuid; v_finance uuid;
  d_snd uuid; d_pnj uuid; d_bal uuid; d_kpk uuid; l_snd uuid; l_pnj uuid; l_bal uuid; l_kpk uuid;
  p_snd uuid; p_pnj uuid; p_bal uuid; p_kpk uuid;
  s1 uuid; s2 uuid; pn1 uuid; b1 uuid; k1 uuid;
  lo uuid[] := ARRAY[]::uuid[]; v uuid; i integer;
  c1 uuid; c2 uuid; c3 uuid; c4 uuid; c5 uuid; a1 uuid;
  v1 uuid; v2 uuid; v3 uuid; v4 uuid; v5 uuid; r4 uuid;
BEGIN
  IF current_database() NOT LIKE '%test%' THEN
    RAISE EXCEPTION 'reporting_fixture.sql loads only into a test database (this is %)', current_database();
  END IF;
  IF EXISTS (SELECT 1 FROM lms.project WHERE code = 'RPTFX-SND') THEN
    RAISE NOTICE 'reporting fixture already loaded';
    RETURN;
  END IF;

  SELECT id INTO v_admin FROM lms.app_user WHERE username = 'admin';
  SELECT id INTO v_mland FROM lms.app_user WHERE username = 'mland';
  SELECT id INTO v_finance FROM lms.app_user WHERE username = 'finance';
  PERFORM api.set_actor(v_admin);

  SELECT id INTO d_snd FROM lms.admin_unit WHERE province_code = 'SND' AND level = 0 ORDER BY code LIMIT 1;
  SELECT id INTO d_pnj FROM lms.admin_unit WHERE province_code = 'PNJ' AND level = 0 ORDER BY code LIMIT 1;
  SELECT id INTO d_bal FROM lms.admin_unit WHERE province_code = 'BAL' AND level = 0 ORDER BY code LIMIT 1;
  SELECT id INTO d_kpk FROM lms.admin_unit WHERE province_code = 'KPK' AND level = 0 ORDER BY code LIMIT 1;
  SELECT id INTO l_snd FROM lms.admin_unit WHERE province_code = 'SND' ORDER BY level DESC, code LIMIT 1;
  SELECT id INTO l_pnj FROM lms.admin_unit WHERE province_code = 'PNJ' ORDER BY level DESC, code LIMIT 1;
  SELECT id INTO l_bal FROM lms.admin_unit WHERE province_code = 'BAL' ORDER BY level DESC, code LIMIT 1;
  SELECT id INTO l_kpk FROM lms.admin_unit WHERE province_code = 'KPK' ORDER BY level DESC, code LIMIT 1;

  INSERT INTO lms.project (code, name, type_code, block, province_code, district_id) VALUES
    ('RPTFX-SND', 'RPTFX Sindh reporting project', 'Well Location', 'RPTFX', 'SND', d_snd) RETURNING id INTO p_snd;
  INSERT INTO lms.project (code, name, type_code, block, province_code, district_id) VALUES
    ('RPTFX-PNJ', 'RPTFX Punjab reporting project', 'Well Location', 'RPTFX', 'PNJ', d_pnj) RETURNING id INTO p_pnj;
  INSERT INTO lms.project (code, name, type_code, block, province_code, district_id) VALUES
    ('RPTFX-BAL', 'RPTFX Balochistan reporting project', 'Well Location', 'RPTFX', 'BAL', d_bal) RETURNING id INTO p_bal;
  INSERT INTO lms.project (code, name, type_code, block, province_code, district_id) VALUES
    ('RPTFX-KPK', 'RPTFX KPK reporting project', 'Well Location', 'RPTFX', 'KPK', d_kpk) RETURNING id INTO p_kpk;

  -- Parcels, in the unit each was recorded in.
  INSERT INTO lms.survey (code, province_code, admin_unit_id, survey_no, land_class, total_area, recorded_area, recorded_unit, status_code)
  VALUES ('RPTFX-S1', 'SND', l_snd, 'RPTFX-1', 'Private', 1, 80, 'Ghunta', 'Proposed') RETURNING id INTO s1;
  INSERT INTO lms.survey (code, province_code, admin_unit_id, survey_no, land_class, total_area, recorded_area, recorded_unit, status_code)
  VALUES ('RPTFX-S2', 'SND', l_snd, 'RPTFX-2', 'Private', 1, 4, 'Jireb', 'Proposed') RETURNING id INTO s2;
  INSERT INTO lms.survey (code, province_code, admin_unit_id, survey_no, land_class, total_area, recorded_area, recorded_unit, status_code)
  VALUES ('RPTFX-P1', 'PNJ', l_pnj, 'RPTFX-3', 'Private', 1, 16, 'Kanal', 'Proposed') RETURNING id INTO pn1;
  INSERT INTO lms.survey (code, province_code, admin_unit_id, survey_no, land_class, total_area, recorded_area, recorded_unit, status_code)
  VALUES ('RPTFX-B1', 'BAL', l_bal, 'RPTFX-4', 'Private', 1, 8, 'Rod', 'Proposed') RETURNING id INTO b1;
  INSERT INTO lms.survey (code, province_code, admin_unit_id, survey_no, land_class, total_area, status_code)
  VALUES ('RPTFX-K1', 'KPK', l_kpk, 'RPTFX-5', 'Private', 3, 'Proposed') RETURNING id INTO k1;

  -- Seven people (LO7 holds no share).
  FOR i IN 1 .. 7 LOOP
    INSERT INTO lms.landowner (code, province_code, full_name, father_name, cnic, owner_type, tax_status)
    VALUES ('RPTFX-LO' || i,
            (ARRAY['SND','SND','PNJ','PNJ','BAL','KPK','SND'])[i],
            'RPTFX Person ' || i, 'RPTFX Father ' || i,
            format('99701-%s-%s', lpad(i::text, 7, '0'), i % 10), 'O', 'Filer')
    RETURNING id INTO v;
    lo := lo || v;
  END LOOP;
  INSERT INTO lms.survey_ownership_share (survey_id, landowner_id, share_pct) VALUES
    (s1, lo[1], 60), (s1, lo[2], 40), (s2, lo[1], 100), (pn1, lo[3], 50), (pn1, lo[4], 50), (b1, lo[5], 100), (k1, lo[6], 100);

  -- Cases, valued by the database from their lines.
  INSERT INTO lms.compensation_case (code, province_code, project_id, land_use_code, case_date, effective_date, lease_term_months, stage_code)
  VALUES ('RPTFX-C1', 'SND', p_snd, 'Well Location', current_date, current_date, 12, 'Prepared') RETURNING id INTO c1;
  INSERT INTO lms.compensation_case (code, province_code, project_id, land_use_code, case_date, effective_date, lease_term_months, stage_code)
  VALUES ('RPTFX-C2', 'SND', p_snd, 'Well Location', current_date, current_date, 12, 'Prepared') RETURNING id INTO c2;
  INSERT INTO lms.compensation_case (code, province_code, project_id, land_use_code, case_date, effective_date, lease_term_months, stage_code)
  VALUES ('RPTFX-C3', 'PNJ', p_pnj, 'Well Location', current_date, current_date, 12, 'Prepared') RETURNING id INTO c3;
  INSERT INTO lms.compensation_case (code, province_code, project_id, land_use_code, case_date, effective_date, lease_term_months, stage_code)
  VALUES ('RPTFX-C4', 'BAL', p_bal, 'Well Location', current_date, current_date, 12, 'Prepared') RETURNING id INTO c4;
  INSERT INTO lms.compensation_case (code, province_code, project_id, land_use_code, case_date, effective_date, lease_term_months, stage_code)
  VALUES ('RPTFX-C5', 'KPK', p_kpk, 'Well Location', current_date, current_date, 12, 'Prepared') RETURNING id INTO c5;
  INSERT INTO lms.case_lease_line (case_id, survey_id, lease_area, line_no) VALUES
    (c1, s1, 1.5, 1), (c2, s2, 1, 1), (c3, pn1, 1, 1), (c4, b1, 1, 1), (c5, k1, 1, 1);
  INSERT INTO lms.case_misc_line (case_id, payment_type, amount) VALUES
    (c1, 'RPTFX award', 100000), (c2, 'RPTFX award', 20000), (c3, 'RPTFX award', 40000), (c4, 'RPTFX award', 30000), (c5, 'RPTFX award', 25000);
  INSERT INTO lms.case_owner (case_id, landowner_id, owner_status, share_pct) VALUES
    (c1, lo[1], 'O', 60), (c1, lo[2], 'O', 40), (c2, lo[1], 'O', 100), (c3, lo[3], 'O', 50), (c3, lo[4], 'O', 50),
    (c4, lo[5], 'O', 100), (c5, lo[6], 'O', 100);
  PERFORM api.recalculate_case_totals(x) FROM unnest(ARRAY[c1, c2, c3, c4, c5]) x;
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;
  UPDATE lms.compensation_case SET stage_code = 'HO Approved', approved_at = now() WHERE id IN (c1, c2, c3, c4);
  UPDATE lms.compensation_case SET stage_code = 'Verified' WHERE id = c5;

  -- An incomplete acquisition.
  INSERT INTO lms.acquisition (code, province_code, project_id, mode, area_required, stage_code)
  VALUES ('RPTFX-A1', 'SND', p_snd, 'Direct Purchase', 1.0, 'Negotiation') RETURNING id INTO a1;
  INSERT INTO lms.acquisition_survey (acquisition_id, survey_id) VALUES (a1, s1);

  -- Vouchers, released by Finance (so a land manager may later reverse one).
  PERFORM api.set_actor(v_mland);
  INSERT INTO lms.payment_request (code, province_code, landowner_id, project_id, case_id, category_code, pay_type, period_from, gross_amount, wht_pct, payment_mode, stage_code, remarks)
  VALUES ('RPTFX-V1', 'SND', lo[1], p_snd, c1, 'Lease Rent', 'One-time', current_date, 50000, 10, 'Cross Cheque', 'Verified', 'RPTFX part payment, case C1') RETURNING id INTO v1;
  INSERT INTO lms.payment_request (code, province_code, landowner_id, project_id, case_id, category_code, pay_type, period_from, gross_amount, wht_pct, payment_mode, stage_code, remarks)
  VALUES ('RPTFX-V2', 'SND', lo[1], p_snd, c2, 'Lease Rent', 'One-time', current_date, 20000, 0, 'Cross Cheque', 'Verified', 'RPTFX full payment, case C2') RETURNING id INTO v2;
  INSERT INTO lms.payment_request (code, province_code, landowner_id, project_id, case_id, category_code, pay_type, period_from, gross_amount, wht_pct, payment_mode, stage_code, remarks)
  VALUES ('RPTFX-V3', 'PNJ', lo[3], p_pnj, c3, 'Lease Rent', 'One-time', current_date, 40000, 0, 'Cross Cheque', 'Verified', 'RPTFX payment in full, case C3') RETURNING id INTO v3;
  INSERT INTO lms.payment_request (code, province_code, landowner_id, project_id, case_id, category_code, pay_type, period_from, gross_amount, wht_pct, payment_mode, stage_code, remarks)
  VALUES ('RPTFX-V4', 'BAL', lo[5], p_bal, c4, 'Lease Rent', 'One-time', current_date, 30000, 0, 'Cross Cheque', 'Verified', 'RPTFX payment to be reversed, case C4') RETURNING id INTO v4;
  INSERT INTO lms.payment_request (code, province_code, landowner_id, project_id, category_code, pay_type, period_from, gross_amount, wht_pct, payment_mode, stage_code, remarks)
  VALUES ('RPTFX-V5', 'SND', lo[1], p_snd, 'Lease Rent', 'One-time', current_date, 5000, 0, 'Cross Cheque', 'Verified', 'RPTFX released with no case') RETURNING id INTO v5;
  INSERT INTO lms.payment_release (payment_id, province_code, cheque_no, cheque_date, released_amount, released_by)
  SELECT pr.id, pr.province_code, 'RPTFX-CHQ-' || right(pr.code::text, 2), current_date, pr.net_amount, v_finance
  FROM lms.payment_request pr WHERE pr.id IN (v1, v2, v3, v4, v5);
  UPDATE lms.payment_request SET stage_code = 'Released' WHERE id IN (v1, v2, v3, v4, v5);

  -- Allocations through the routine that enforces the rules (gross basis).
  PERFORM api.allocate_payment(v1, c1, 27000, lo[1], 'RPTFX 60% share');   -- settles 30,000
  PERFORM api.allocate_payment(v1, c1, 18000, lo[2], 'RPTFX 40% share');   -- settles 20,000
  PERFORM api.allocate_payment(v2, c2, 20000, lo[1], 'RPTFX in full');
  PERFORM api.allocate_payment(v3, c3, 20000, lo[3], 'RPTFX in full');
  PERFORM api.allocate_payment(v3, c3, 20000, lo[4], 'RPTFX in full');
  PERFORM api.allocate_payment(v4, c4, 30000, lo[5], 'RPTFX to be reversed');
  -- The payments are settled (checked) before the decree that follows them.
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;

  -- A negative adjustment (court decree) and a reversal.
  PERFORM api.adjust_case(c3, -5000, 'RPTFX court decree reduced the award');
  SELECT id INTO r4 FROM lms.payment_release WHERE payment_id = v4;
  PERFORM api.reverse_release(r4, 'RPTFX cheque returned unpaid by the bank');
  SET CONSTRAINTS ALL IMMEDIATE;
  RAISE NOTICE 'reporting fixture loaded';
END
$fixture$;
