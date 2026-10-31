-- role: lms_owner
-- tx: rollback
-- actor: admin
--
-- 0043: units (aliases, provisional factors, recorded areas, imports, land
-- requests), the area-commitment rule, the money definitions (gross
-- settlement basis, adjustments, reversals, owner attribution with no lost
-- paisa), allocation rules, the person statement, report datasets and
-- reconciliation. Run as the table owner so setup can create the rows a
-- scenario needs; every rule under test is a trigger, a constraint or a
-- definer routine, which apply to the owner too, and every routine is called
-- as the acting user it checks.
\set QUIET on

-- A compensation case with one lease line, one award line and its owners,
-- valued by the database. Left at 'Prepared'.
CREATE FUNCTION pg_temp.t21_case(p_code text, p_project uuid, p_survey uuid, p_area numeric, p_amount numeric,
                                 p_owners uuid[], p_shares numeric[], p_start date, p_months integer)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v uuid; i integer;
BEGIN
  INSERT INTO lms.compensation_case (code, province_code, project_id, land_use_code, case_date, effective_date,
                                     lease_term_months, stage_code)
  SELECT p_code, p.province_code, p.id, 'Well Location', p_start, p_start, p_months, 'Prepared'
  FROM lms.project p WHERE p.id = p_project RETURNING id INTO v;
  INSERT INTO lms.case_lease_line (case_id, survey_id, lease_area, line_no) VALUES (v, p_survey, p_area, 1);
  INSERT INTO lms.case_misc_line (case_id, payment_type, amount) VALUES (v, 'award', p_amount);
  FOR i IN 1 .. coalesce(array_length(p_owners, 1), 0) LOOP
    INSERT INTO lms.case_owner (case_id, landowner_id, owner_status, share_pct) VALUES (v, p_owners[i], 'O', p_shares[i]);
  END LOOP;
  PERFORM api.recalculate_case_totals(v);
  RETURN v;
END $$;

CREATE FUNCTION pg_temp.t21_approve(p_case uuid) RETURNS void LANGUAGE sql AS $$
  UPDATE lms.compensation_case SET stage_code = 'HO Approved', approved_at = now() WHERE id = p_case;
$$;

-- A voucher at 'Verified', ready to release.
CREATE FUNCTION pg_temp.t21_voucher(p_code text, p_project uuid, p_case uuid, p_owner uuid, p_gross numeric, p_wht numeric, p_period date)
RETURNS uuid LANGUAGE sql AS $$
  INSERT INTO lms.payment_request (code, province_code, landowner_id, project_id, case_id, category_code, pay_type,
                                   period_from, gross_amount, wht_pct, payment_mode, stage_code)
  SELECT p_code, p.province_code, p_owner, p.id, p_case, 'Lease Rent', 'One-time', p_period, p_gross, p_wht, 'Cross Cheque', 'Verified'
  FROM lms.project p WHERE p.id = p_project
  RETURNING id;
$$;

-- Released by p_by (the release trigger checks the acting user holds payments:release).
CREATE FUNCTION pg_temp.t21_release(p_payment uuid, p_cheque text, p_by uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v uuid;
BEGIN
  INSERT INTO lms.payment_release (payment_id, province_code, cheque_no, cheque_date, released_amount, released_by)
  SELECT pr.id, pr.province_code, p_cheque, current_date, pr.net_amount, p_by FROM lms.payment_request pr WHERE pr.id = p_payment
  RETURNING id INTO v;
  UPDATE lms.payment_request SET stage_code = 'Released' WHERE id = p_payment;
  RETURN v;
END $$;

DO $$
DECLARE
  v_admin uuid; v_mland uuid; v_dm uuid; v_lofield uuid; v_finance uuid; v_viewer uuid;
  v_dis uuid; v_leaf uuid; v_proj uuid; v_s1 uuid; v_s2 uuid; v_s3 uuid;
  v_o1 uuid; v_o2 uuid; v_o3 uuid; v_lonely uuid;
  v_c1 uuid; v_c2 uuid; v_c3 uuid; v_c4 uuid; v_cx uuid;
  v_p1 uuid; v_p2 uuid; v_p3 uuid; v_p4 uuid; v_r1 uuid; v_r3 uuid; v_r4 uuid;
  v_adj uuid; v_run uuid; m record; v_sum numeric; v_n integer; v_batch uuid; v_row bigint;
BEGIN
  SELECT id INTO v_admin FROM lms.app_user WHERE username = 'admin';
  SELECT id INTO v_mland FROM lms.app_user WHERE username = 'mland';      -- land-manager: approves, releases
  SELECT id INTO v_dm FROM lms.app_user WHERE username = 'dmfield';       -- case-approver, Sindh
  SELECT id INTO v_lofield FROM lms.app_user WHERE username = 'lofield';  -- data-entry, Sindh
  SELECT id INTO v_finance FROM lms.app_user WHERE username = 'finance';  -- finance-approver (no release)
  SELECT id INTO v_viewer FROM lms.app_user WHERE username = 'viewer';
  PERFORM api.set_actor(v_admin);

  -- ---------- units ----------
  PERFORM test.eq(lms.uom_code('Bega'), 'Jireb', 'Bega is the slide-5 alias of Jireb, not of Bigha');
  PERFORM test.eq((SELECT confirmed FROM lms.uom_convert_detail(2, 'Jireb', 'Acre')), false,
                  'a conversion through the Jireb factor is flagged provisional');
  PERFORM test.eq((SELECT confirmed FROM lms.uom_convert_detail(8, 'Kanal', 'Acre')), true, 'a Kanal conversion is confirmed');
  PERFORM test.eq((SELECT value FROM lms.uom_convert_detail(8, 'Kanal', 'Acre')), 1::numeric, '8 kanal = 1 acre, exactly');
  PERFORM test.eq((SELECT value FROM lms.uom_convert_detail(1, 'Acre', 'Hectare')), 0.40468564224::numeric,
                  'acre to hectare uses the exact factor, not a 4 dp one');
  PERFORM test.ok((SELECT value FROM lms.uom_convert_detail(1, 'Acre', 'Furlong')) IS NULL, 'an unknown unit converts to nothing');
  PERFORM test.eq((SELECT count(*) FROM lms.measurement_unit)::int, (SELECT count(DISTINCT display_order) FROM lms.measurement_unit)::int,
                  'every unit has its own display order');
  PERFORM test.ok(NOT EXISTS (SELECT 1 FROM lms.measurement_unit WHERE name ~ '\('), 'unit names no longer carry factors');
  PERFORM test.ok(EXISTS (SELECT 1 FROM lms.province_unit WHERE province_code = 'KPK' AND unit_code = 'Marla' AND NOT confirmed),
                  'KPK lists Marla from the client reference, flagged until confirmed');
  PERFORM test.eq((SELECT source FROM lms.province_unit WHERE province_code = 'SND' AND unit_code = 'Jireb'), 'legacy_prototype',
                  'Jireb for Sindh is marked as not in the client reference');

  SELECT id INTO v_dis FROM lms.admin_unit WHERE province_code = 'SND' AND level = 0 ORDER BY code LIMIT 1;
  SELECT id INTO v_leaf FROM lms.admin_unit WHERE province_code = 'SND' AND level = 2 ORDER BY code LIMIT 1;
  INSERT INTO lms.survey (code, province_code, admin_unit_id, survey_no, land_class, total_area, recorded_area, recorded_unit, status_code)
  VALUES ('T21-S1', 'SND', v_leaf, 'T21-1', 'Private', 1, 4, 'Jireb', 'Proposed') RETURNING id INTO v_s1;
  PERFORM test.eq((SELECT total_area::numeric FROM lms.survey WHERE id = v_s1), 2.0000::numeric, '4 jireb are stored as 2 acres');
  PERFORM test.eq((SELECT recorded_factor_confirmed FROM lms.survey WHERE id = v_s1), false,
                  'the parcel remembers its area came through a provisional factor');
  PERFORM test.throws(format($q$ UPDATE lms.survey SET total_area = 3 WHERE id = %L $q$, v_s1), '23514',
                      'an edit of the derived area alone is refused, not silently overwritten');
  UPDATE lms.survey SET recorded_area = 6 WHERE id = v_s1;
  PERFORM test.eq((SELECT total_area::numeric FROM lms.survey WHERE id = v_s1), 3.0000::numeric, 'changing the recorded area re-derives acres');
  UPDATE lms.survey SET recorded_area = 4 WHERE id = v_s1;

  INSERT INTO lms.survey (code, province_code, admin_unit_id, survey_no, land_class, total_area, status_code)
  VALUES ('T21-S2', 'SND', v_leaf, 'T21-2', 'Private', 10, 'Proposed') RETURNING id INTO v_s2;
  INSERT INTO lms.survey (code, province_code, admin_unit_id, survey_no, land_class, total_area, status_code)
  VALUES ('T21-S3', 'SND', v_leaf, 'T21-3', 'Private', 5, 'Proposed') RETURNING id INTO v_s3;

  -- ---------- land requests ----------
  PERFORM test.ok((SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'land_request_ghunta_ck') LIKE '%< (40)%',
                  'a ghunta value must be below 40 (40 ghunta = 1 acre)');
  PERFORM test.ok((SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'land_request_ghunta_sindh_ck') LIKE '%SND%',
                  'ghunta is accepted only on Sindh requests');
  PERFORM test.ok(NOT EXISTS (SELECT 1 FROM lms.land_request WHERE NOT (area_acres >= 0 AND (area_acres > 0 OR coalesce(area_ghunta, 0) > 0))),
                  'every existing request satisfies the new area rule');

  -- ---------- people and a project ----------
  INSERT INTO lms.project (code, name, type_code, block, province_code, district_id)
  VALUES ('T21-PRJ', 'T21 reporting project', 'Well Location', 'T21', 'SND', v_dis) RETURNING id INTO v_proj;
  INSERT INTO lms.landowner (code, province_code, full_name, father_name, cnic, owner_type, tax_status)
  VALUES ('T21-LO1', 'SND', 'T21 Owner One', 'T21 Father', '99021-0000001-1', 'O', 'Filer') RETURNING id INTO v_o1;
  INSERT INTO lms.landowner (code, province_code, full_name, father_name, cnic, owner_type, tax_status)
  VALUES ('T21-LO2', 'SND', 'T21 Owner Two', 'T21 Father', '99021-0000002-2', 'O', 'Filer') RETURNING id INTO v_o2;
  INSERT INTO lms.landowner (code, province_code, full_name, father_name, cnic, owner_type, tax_status)
  VALUES ('T21-LO3', 'SND', 'T21 Owner Three', 'T21 Father', '99021-0000003-3', 'O', 'Non-Filer') RETURNING id INTO v_o3;
  INSERT INTO lms.landowner (code, province_code, full_name, father_name, cnic, owner_type)
  VALUES ('T21-LO4', 'SND', 'T21 Owner One', 'T21 Father', '99021-0000004-4', 'O') RETURNING id INTO v_lonely;
  INSERT INTO lms.survey_ownership_share (survey_id, landowner_id, share_pct) VALUES
    (v_s2, v_o1, 33.3333), (v_s2, v_o2, 33.3333), (v_s2, v_o3, 33.3334), (v_s3, v_o1, 100);
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;

  -- ---------- a parcel cannot be committed beyond its area ----------
  v_c1 := pg_temp.t21_case('T21-C1', v_proj, v_s2, 6, 100.01, ARRAY[v_o1, v_o2, v_o3], ARRAY[33.3333, 33.3333, 33.3334], current_date, 12);
  SET CONSTRAINTS ALL IMMEDIATE;
  PERFORM test.ok(true, 'six of ten acres can be committed');
  SET CONSTRAINTS ALL DEFERRED;
  v_n := 0;
  BEGIN
    PERFORM pg_temp.t21_case('T21-CX', v_proj, v_s2, 5, 1, ARRAY[v_o1], ARRAY[100], current_date, 12);
    SET CONSTRAINTS ALL IMMEDIATE;
  EXCEPTION WHEN check_violation THEN v_n := 1;
  END;
  SET CONSTRAINTS ALL DEFERRED;
  PERFORM test.eq(v_n, 1, 'five more acres of a ten-acre parcel in the same term are refused');
  v_cx := pg_temp.t21_case('T21-CN', v_proj, v_s2, 5, 1, ARRAY[v_o1], ARRAY[100], (current_date + interval '13 months')::date, 12);
  SET CONSTRAINTS ALL IMMEDIATE;
  PERFORM test.ok(true, 'the same acres can be committed again for a later, non-overlapping term');
  SET CONSTRAINTS ALL DEFERRED;
  v_n := 0;
  BEGIN
    UPDATE lms.survey SET total_area = 4 WHERE id = v_s2;
    SET CONSTRAINTS ALL IMMEDIATE;
  EXCEPTION WHEN check_violation THEN v_n := 1;
  END;
  SET CONSTRAINTS ALL DEFERRED;
  PERFORM test.eq(v_n, 1, 'a parcel cannot shrink below what live cases hold');

  -- ---------- owner attribution: every paisa, once ----------
  PERFORM pg_temp.t21_approve(v_c1);
  PERFORM test.eq((SELECT sum(attributed_payable) FROM lms.case_owner_money WHERE case_id = v_c1), 100.01::numeric,
                  'three owners of 33.3333/33.3333/33.3334% of 100.01 are attributed exactly 100.01');

  -- ---------- money: gross settlement basis ----------
  -- Prepared by a case approver, so the separation-of-duties rule is what refuses them later.
  PERFORM api.set_actor(v_dm);
  v_c2 := pg_temp.t21_case('T21-C2', v_proj, v_s3, 1, 10000, ARRAY[v_o1], ARRAY[100], current_date, 12);
  PERFORM pg_temp.t21_approve(v_c2);
  PERFORM api.set_actor(v_admin);
  PERFORM test.eq((SELECT assessed_amount FROM lms.case_money WHERE case_id = v_cx), 1.00::numeric(18,2),
                  'a case not yet approved is assessed, not approved');
  PERFORM test.eq((SELECT approved_amount FROM lms.case_money WHERE case_id = v_cx), 0.00::numeric(18,2), 'and contributes nothing approved');
  PERFORM test.ok((SELECT outstanding_amount FROM lms.case_money WHERE case_id = v_cx) IS NULL, 'and has no outstanding balance');

  PERFORM api.set_actor(v_mland);
  v_p1 := pg_temp.t21_voucher('T21-VCH-1', v_proj, v_c2, v_o1, 4000.00, 10, current_date);
  v_r1 := pg_temp.t21_release(v_p1, 'T21-CHQ-1', v_finance);
  PERFORM api.allocate_payment(v_p1, v_c2, 3600.00, v_o1, 'first payment');
  SELECT * INTO m FROM lms.case_money WHERE case_id = v_c2;
  PERFORM test.eq(m.paid_amount, 4000.00::numeric(18,2), 'a net 3,600 cheque with 400 tax withheld settles 4,000 of the award');
  PERFORM test.eq(m.wht_amount, 400.00::numeric(18,2), 'the withholding tax is shown');
  PERFORM test.eq(m.paid_net_amount, 3600.00::numeric(18,2), 'and the net paid to the payee');
  PERFORM test.eq(m.outstanding_amount, 6000.00::numeric(18,2), 'outstanding = approved − paid (gross)');
  PERFORM test.eq(m.settlement_status, 'Part paid', 'a part-paid case says so');

  -- A second, final payment brings the balance to exactly zero.
  v_p2 := pg_temp.t21_voucher('T21-VCH-2', v_proj, v_c2, v_o1, 6000.00, 10, current_date + 1);
  PERFORM pg_temp.t21_release(v_p2, 'T21-CHQ-2', v_finance);
  PERFORM api.allocate_payment(v_p2, v_c2, 5400.00, v_o1, 'final payment');
  SELECT * INTO m FROM lms.case_money WHERE case_id = v_c2;
  PERFORM test.eq(m.outstanding_amount, 0.00::numeric(18,2), 'a fully paid case has a zero balance');
  PERFORM test.eq(m.settlement_status, 'Settled', 'and is settled');
  PERFORM test.throws_like(format($q$ SELECT api.allocate_payment(%L, %L, 1) $q$, v_p2, v_c2),
                           '%exceed the net payable%', 'a voucher cannot be allocated beyond its net');

  -- ---------- allocation rules (PAY-H1) ----------
  v_p3 := pg_temp.t21_voucher('T21-VCH-3', v_proj, NULL, v_o1, 100.00, 0, current_date + 2);
  PERFORM test.throws_like(format($q$ SELECT api.allocate_payment(%L, %L, 10) $q$, v_p3, v_cx),
                           '%approved case%', 'money cannot be allocated to a case that is not approved');
  PERFORM test.throws_like(format($q$ SELECT api.allocate_payment(%L, %L, 10, %L) $q$, v_p3, v_c1, v_lonely),
                           '%not an owner%', 'or to a person who is not an owner on the case');
  PERFORM test.throws_like(format($q$ SELECT api.allocate_payment(%L, %L, 10) $q$, v_p1, v_c1),
                           '%raised for another case%', 'a voucher raised for one case cannot settle another');
  PERFORM test.throws_like(format($q$ SELECT api.allocate_payment(%L, %L, 50, %L) $q$, v_p3, v_c1, v_o1),
                           '%their share%', 'an owner cannot be paid beyond their share of the award');

  -- ---------- adjustments (PAY-H2) ----------
  PERFORM api.set_actor(v_viewer);
  PERFORM test.throws(format($q$ SELECT api.adjust_case(%L, -100, 'court reduced the award') $q$, v_c2), '42501',
                      'adjusting an award needs cases:approve');
  PERFORM api.set_actor(v_dm);
  PERFORM test.throws_like(format($q$ SELECT api.adjust_case(%L, -100, 'court reduced the award') $q$, v_c2),
                           '%separation of duties%', 'the person who prepared the case cannot adjust it');
  PERFORM api.set_actor(v_mland);
  PERFORM test.throws(format($q$ SELECT api.adjust_case(%L, -100, 'too short') $q$, v_c2), '22023',
                      'an adjustment needs a reason of at least 10 characters');
  PERFORM test.throws(format($q$ SELECT api.adjust_case(%L, 10, 'adjusting a draft award') $q$, v_cx), '55000',
                      'only an approved award can be adjusted');
  PERFORM test.throws(format($q$ SELECT api.adjust_case(%L, -20000, 'larger than the award itself') $q$, v_c2), '55000',
                      'an adjustment cannot make the award negative');
  v_adj := api.adjust_case(v_c2, -500.00, 'court decree reduced the award by Rs 500');
  SELECT * INTO m FROM lms.case_money WHERE case_id = v_c2;
  PERFORM test.eq(m.adjustment_amount, -500.00::numeric(18,2), 'a negative adjustment is recorded');
  PERFORM test.eq(m.payable_amount, 9500.00::numeric(18,2), 'payable = approved + adjustments');
  PERFORM test.eq(m.outstanding_amount, -500.00::numeric(18,2), 'the over-payment is negative, never clamped to zero');
  PERFORM test.eq(m.settlement_status, 'Overpaid', 'and the case is reported as overpaid');
  PERFORM test.ok(EXISTS (SELECT 1 FROM api.rpt_exception WHERE rule = 'case_overpaid' AND record_id = v_c2),
                  'the over-payment is a data-quality exception');
  PERFORM test.throws(format($q$ UPDATE lms.case_adjustment SET amount = 1 WHERE id = %L $q$, v_adj), '42501',
                      'an adjustment cannot be edited afterwards');
  PERFORM test.ok(EXISTS (SELECT 1 FROM audit.audit_event WHERE entity = 'case_adjustment' AND record_id = v_adj),
                  'the adjustment is in the audit trail');

  -- ---------- reversals (PAY-H2) ----------
  v_c3 := pg_temp.t21_case('T21-C3', v_proj, v_s1, 1, 2000, ARRAY[v_o1, v_o2], ARRAY[50, 50], current_date, 12);
  PERFORM pg_temp.t21_approve(v_c3);
  -- Raised by the land officer: strict SoD refuses a release by whoever raised the voucher.
  PERFORM api.set_actor(v_lofield);
  v_p4 := pg_temp.t21_voucher('T21-VCH-4', v_proj, v_c3, v_o1, 1000.00, 0, current_date);
  PERFORM api.set_actor(v_mland);
  v_r4 := pg_temp.t21_release(v_p4, 'T21-CHQ-4', v_mland);
  PERFORM api.allocate_payment(v_p4, v_c3, 1000.00, v_o1, 'owner one share');
  PERFORM test.eq((SELECT paid_amount FROM lms.case_money WHERE case_id = v_c3), 1000.00::numeric(18,2), 'paid before the reversal');
  PERFORM test.throws(format($q$ SELECT api.reverse_release(%L, 'cheque returned by the bank') $q$, v_r4), '42501',
                      'the person who released a cheque cannot reverse it');
  PERFORM api.set_actor(v_finance);
  PERFORM test.throws(format($q$ SELECT api.reverse_release(%L, 'cheque returned by the bank') $q$, v_r4), '42501',
                      'reversing a release needs payments:release');
  -- Released by someone else: mland may reverse it. Raised by the land officer, so the
  -- releaser (finance) neither raised nor verified it (strict SoD).
  PERFORM api.set_actor(v_lofield);
  v_p3 := pg_temp.t21_voucher('T21-VCH-5', v_proj, v_c3, v_o2, 1000.00, 0, current_date);
  PERFORM api.set_actor(v_mland);
  v_r3 := pg_temp.t21_release(v_p3, 'T21-CHQ-5', v_finance);
  PERFORM api.allocate_payment(v_p3, v_c3, 1000.00, v_o2, 'owner two share');
  PERFORM test.eq((SELECT outstanding_amount FROM lms.case_money WHERE case_id = v_c3), 0.00::numeric(18,2), 'both shares paid');
  PERFORM api.reverse_release(v_r3, 'cheque returned unpaid by the bank');
  SELECT * INTO m FROM lms.case_money WHERE case_id = v_c3;
  PERFORM test.eq(m.paid_amount, 1000.00::numeric(18,2), 'a reversed release no longer counts as paid');
  PERFORM test.eq(m.reversed_amount, 1000.00::numeric(18,2), 'and is shown as reversed');
  PERFORM test.eq(m.outstanding_amount, 1000.00::numeric(18,2), 'the owner is owed again');
  PERFORM test.eq(m.allocated_amount, 1000.00::numeric(18,2), 'and the allocation no longer uses up the award');
  PERFORM test.throws(format($q$ SELECT api.reverse_release(%L, 'cheque returned unpaid again') $q$, v_r3), '55000',
                      'a release is reversed once');
  PERFORM test.ok((SELECT reversed_at FROM lms.payment_request WHERE id = v_p3) IS NOT NULL, 'the voucher records its reversal');
  PERFORM test.throws(format($q$ UPDATE lms.payment_request SET gross_amount = 1 WHERE id = %L $q$, v_p3), '42501',
                      'a reversed voucher stays locked');
  -- A corrected voucher for the same payee, category and period can now be raised.
  PERFORM pg_temp.t21_voucher('T21-VCH-6', v_proj, v_c3, v_o2, 1000.00, 0, current_date);
  PERFORM test.ok(true, 'a replacement voucher for the same payee and period is accepted');

  -- ---------- the person statement ----------
  PERFORM test.eq((SELECT sum(amount * CASE entry_type WHEN 'Compensation paid' THEN -1 WHEN 'Other payment (not compensation)' THEN 0 ELSE 1 END)
                     FROM api.report_landowner_statement(v_o2)),
                  (SELECT sum(payable_amount) - sum(paid_amount) FROM api.rpt_case_owner WHERE landowner_id = v_o2 AND stage_code = 'HO Approved'),
                  'the statement balance equals what the owner is owed across their cases');
  PERFORM test.ok(EXISTS (SELECT 1 FROM api.report_landowner_statement(v_o2) WHERE entry_type = 'Payment reversed'),
                  'a reversal appears on the statement');

  -- ---------- datasets ----------
  PERFORM test.eq((SELECT owner_count FROM api.rpt_parcel WHERE survey_id = v_s2), 3, 'a parcel with three owners counts three');
  PERFORM test.eq((SELECT area_acres FROM api.rpt_parcel WHERE survey_id = v_s2), 10.0000::numeric, 'and its area once, not per owner or case');
  PERFORM test.eq((SELECT sum(owned_area_acres) FROM api.rpt_ownership WHERE survey_id = v_s2), 10.000000::numeric,
                  'the owned areas of all shares add up to the parcel');
  PERFORM test.ok((SELECT flag_no_shares FROM api.rpt_person WHERE landowner_id = v_lonely), 'a person with no share is flagged');
  PERFORM test.ok((SELECT flag_possible_duplicate FROM api.rpt_person WHERE landowner_id = v_lonely),
                  'two people with the same name and father''s name are flagged as possible duplicates');
  PERFORM test.eq((SELECT area_acres FROM api.rpt_exec_project WHERE project_id = v_proj), 17.0000::numeric,
                  'a project''s area counts each of its parcels once, however many cases it has');
  PERFORM api.set_actor(v_lofield);
  PERFORM test.eq((SELECT count(*) FROM api.rpt_exec_province)::int, 1, 'the province summary lists only the caller''s provinces');
  PERFORM api.set_actor(v_admin);
  PERFORM test.eq((SELECT outstanding_amount FROM api.v_outstanding_liability WHERE case_id = v_c2), -500.00::numeric(18,2),
                  'the liability view shows the over-payment as a negative balance');
  PERFORM test.eq((SELECT settlement_status FROM api.v_outstanding_liability WHERE case_id = v_c2), 'over-paid',
                  'and labels it, instead of "settled"');
  PERFORM test.ok((SELECT outstanding_amount FROM api.v_case_status WHERE case_id = v_cx) IS NULL,
                  'an unapproved case has no outstanding liability');

  -- ---------- reconciliation ----------
  PERFORM api.set_actor(v_mland);
  v_run := api.reconcile('project', v_proj, current_date);
  PERFORM test.eq((SELECT province_code::text FROM lms.reconciliation_run WHERE id = v_run), 'SND',
                  'a project run is stamped with the project''s province');
  PERFORM test.ok(EXISTS (SELECT 1 FROM lms.reconciliation_exception WHERE run_id = v_run AND kind = 'over_released' AND entity_id = v_c2),
                  'the over-paid case is an exception');
  v_n := (SELECT count(*) FROM lms.reconciliation_exception WHERE run_id = v_run)::int;
  v_run := api.reconcile('project', v_proj, current_date);
  PERFORM test.eq((SELECT count(*) FROM lms.reconciliation_exception e JOIN lms.reconciliation_run r ON r.id = e.run_id
                   WHERE r.scope = 'project' AND r.scope_ref = v_proj AND e.resolved_at IS NULL)::int, v_n,
                  'running again leaves one open copy of each exception, not two');
  PERFORM api.set_actor(v_lofield);
  PERFORM test.throws(format($q$ SELECT api.reconcile('project', %L, current_date) $q$, v_proj), '42501',
                      'reconciliation needs payments:verify or payments:release');

  -- ---------- imports keep the unit ----------
  PERFORM api.set_actor(v_admin);
  INSERT INTO lms.import_batch (code, target_entity, province_code, source_file, source_sha256, row_count, valid_count, error_count, promoted_count, status, uploaded_by)
  VALUES ('T21-IMP-1', 'survey', 'SND', 't21.csv', decode(repeat('00', 32), 'hex'), 1, 0, 0, 0, 'staged', v_admin) RETURNING id INTO v_batch;
  INSERT INTO lms.import_row (batch_id, source_line, raw, status)
  VALUES (v_batch, 2, jsonb_build_object('survey_no', 'T21-IMP', 'unit_name', (SELECT name FROM lms.admin_unit WHERE id = v_leaf),
                                         'area_value', '16', 'area_unit', ''), 'pending') RETURNING id INTO v_row;
  PERFORM api.validate_import_batch(v_batch);
  PERFORM test.ok(EXISTS (SELECT 1 FROM lms.import_validation_error WHERE row_id = v_row AND field = 'area_unit' AND severity = 'error'),
                  'an imported area without its unit is an error, not silently acres');
END $$;
