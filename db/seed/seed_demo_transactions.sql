-- =====================================================================
-- Fictional demonstration data, part 2: the transactional records
-- =====================================================================
-- ALL FICTIONAL. Run after db/seed/seed_demo.sql:
--   psql -d lms_dev -U lms_migrator -f db/seed/seed_demo_transactions.sql
--
-- This part deliberately goes through the api routines rather than inserting
-- end states directly. Creating a case and then walking it Prepared → Checked
-- → Reviewed → Verified → Field Approved → HO Approved as six different
-- people exercises the approval matrix, segregation of duties, the document
-- gate, the audit trail and the version snapshots — so loading the seed is
-- itself a smoke test of the whole workflow layer.
-- =====================================================================
\set ON_ERROR_STOP on
BEGIN;
SET ROLE lms_owner;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM lms.compensation_case LIMIT 1) THEN
    RAISE EXCEPTION 'transactional demo data is already present';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM lms.project LIMIT 1) THEN
    RAISE EXCEPTION 'load db/seed/seed_demo.sql first';
  END IF;
END $$;

CREATE TEMP TABLE _ids (k text PRIMARY KEY, v uuid);

DO $$
DECLARE
  u_lofield uuid; u_nego uuid; u_legal uuid; u_sradmin uuid; u_dm uuid; u_mland uuid;
  u_finance uuid; u_lobal uuid; u_negoqta uuid; u_sradmqta uuid; u_dmqta uuid;
  u_lopnj uuid; u_sradmpnj uuid;
  p_dhrk1 uuid; p_dhrk10p uuid; p_dhrk2 uuid; p_sui uuid; p_jmpr uuid;
  s112 uuid; s113 uuid; s118 uuid; s204 uuid; s331 uuid; s1187 uuid; s556 uuid;
  lo_dino uuid; lo_mukhtiar uuid; lo_zubaida uuid; lo_rasool uuid; lo_qadir uuid;
  lo_shahbaz uuid; lo_gul uuid; lo_aslam uuid;
  c1 uuid; c2 uuid; c3 uuid; l1 uuid; r1 uuid; d1 uuid; m1 uuid; lit1 uuid;
  pay1 uuid; pay2 uuid; pay3 uuid; g1 uuid; e1 uuid; rel uuid;
BEGIN
  SELECT id INTO u_lofield FROM lms.app_user WHERE username='lofield';
  SELECT id INTO u_nego    FROM lms.app_user WHERE username='nego';
  SELECT id INTO u_legal   FROM lms.app_user WHERE username='legal';
  SELECT id INTO u_sradmin FROM lms.app_user WHERE username='sradmin';
  SELECT id INTO u_dm      FROM lms.app_user WHERE username='dmfield';
  SELECT id INTO u_mland   FROM lms.app_user WHERE username='mland';
  SELECT id INTO u_finance FROM lms.app_user WHERE username='finance';
  SELECT id INTO u_lobal   FROM lms.app_user WHERE username='loquetta';
  SELECT id INTO u_negoqta  FROM lms.app_user WHERE username='negoqta';
  SELECT id INTO u_sradmqta FROM lms.app_user WHERE username='sradmqta';
  SELECT id INTO u_dmqta    FROM lms.app_user WHERE username='dmqta';
  SELECT id INTO u_lopnj    FROM lms.app_user WHERE username='lopnj';
  SELECT id INTO u_sradmpnj FROM lms.app_user WHERE username='sradmpnj';

  SELECT id INTO p_dhrk1    FROM lms.project WHERE code='DHRK-001';
  SELECT id INTO p_dhrk10p  FROM lms.project WHERE code='DHRK-10P';
  SELECT id INTO p_dhrk2    FROM lms.project WHERE code='DHRK-002';
  SELECT id INTO p_sui      FROM lms.project WHERE code='SUI-004';
  SELECT id INTO p_jmpr     FROM lms.project WHERE code='JMPR-003';

  SELECT id INTO s112  FROM lms.survey WHERE survey_no='112'  AND province_code='SND';
  SELECT id INTO s113  FROM lms.survey WHERE survey_no='113'  AND province_code='SND';
  SELECT id INTO s118  FROM lms.survey WHERE survey_no='118'  AND province_code='SND';
  SELECT id INTO s204  FROM lms.survey WHERE survey_no='204'  AND province_code='SND';
  SELECT id INTO s331  FROM lms.survey WHERE survey_no='331'  AND province_code='SND';
  SELECT id INTO s1187 FROM lms.survey WHERE survey_no='1187' AND province_code='BAL';
  SELECT id INTO s556  FROM lms.survey WHERE survey_no='556'  AND province_code='PNJ';

  SELECT id INTO lo_dino     FROM lms.landowner WHERE cnic='45102-1100011-1';
  SELECT id INTO lo_mukhtiar FROM lms.landowner WHERE cnic='45102-1100012-3';
  SELECT id INTO lo_zubaida  FROM lms.landowner WHERE cnic='45102-1100013-6';
  SELECT id INTO lo_rasool   FROM lms.landowner WHERE cnic='45102-1100014-9';
  SELECT id INTO lo_qadir    FROM lms.landowner WHERE cnic='45102-1100015-2';
  SELECT id INTO lo_shahbaz  FROM lms.landowner WHERE cnic='52101-1200021-4';
  SELECT id INTO lo_gul      FROM lms.landowner WHERE cnic='52101-1200022-7';
  SELECT id INTO lo_aslam    FROM lms.landowner WHERE cnic='32303-1300031-8';

  -- =================================================================
  -- Case 1: fully approved, then paid. Prepared by the Land Officer and
  -- advanced by five different people, which is what strict segregation of
  -- duties requires.
  -- =================================================================
  PERFORM api.set_actor(u_lofield);

  INSERT INTO lms.compensation_case
    (code, lease_no, province_code, project_id, land_use_code, business_unit, block_code,
     case_date, lease_rate, lease_term_months, effective_date, case_remarks, stage_code)
  VALUES (lms.next_code_year('CC'), lms.next_code('LN-'), 'SND', p_dhrk1, 'Well Location',
          'Daharki D&PL', 'Daharki D&PL', current_date - 120, 185000.0000, 12,
          current_date - 110, 'Well-01 pad and access road, first year', 'Prepared')
  RETURNING id INTO c1;

  INSERT INTO lms.case_owner (case_id, landowner_id, owner_status, share_pct) VALUES
    (c1, lo_mukhtiar, 'O', 60.0000),
    (c1, lo_zubaida,  'O', 40.0000);
  INSERT INTO lms.case_lease_line (case_id, survey_id, survey_share_pct, lease_area, line_no) VALUES
    (c1, s112, 100.0000, 6.2500, 1),
    (c1, s113,  60.0000, 3.1250, 1);
  INSERT INTO lms.case_crop_line (case_id, survey_id, crop_type, rate_per_acre, damage_area) VALUES
    (c1, s112, 'Wheat',     95000.0000, 4.5000),
    (c1, s113, 'Sugarcane',140000.0000, 2.0000);
  INSERT INTO lms.case_tree_line (case_id, survey_id, species_code, size, rate, qty) VALUES
    (c1, s112, 'Babul',  'Medium',  4500.0000, 18),
    (c1, s112, 'Neem',   'Large',  12000.0000,  4),
    (c1, s113, 'Date Palm','Large', 22000.0000, 3);
  INSERT INTO lms.case_misc_line (case_id, survey_id, payment_type, amount) VALUES
    (c1, s112, 'Boundary wall demolition', 165000.00),
    (c1, s113, 'Tube well relocation',     480000.00);
  INSERT INTO lms.case_document_check (case_id, item_code, checked_by)
  SELECT c1, code, u_lofield FROM lms.case_document_item WHERE required_when = 'always';

  PERFORM api.recalculate_case_totals(c1);

  PERFORM api.set_actor(u_nego);    PERFORM api.advance_workflow('cases', c1, 'Checked',  'Rates verified against the district schedule');
  PERFORM api.set_actor(u_legal);   PERFORM api.advance_workflow('cases', c1, 'Reviewed', 'Title clear, no litigation on 112-7 or 113-7');
  PERFORM api.set_actor(u_sradmin); PERFORM api.advance_workflow('cases', c1, 'Verified', 'Joint measurement report attached');
  PERFORM api.set_actor(u_dm);      PERFORM api.advance_workflow('cases', c1, 'Field Approved', 'Field approval 1');
  PERFORM api.set_actor(u_mland);   PERFORM api.advance_workflow('cases', c1, 'HO Approved',    'Kharat approval');
  INSERT INTO _ids VALUES ('case1', c1);

  -- Case 2: mid-workflow, waiting on legal review.
  PERFORM api.set_actor(u_lofield);
  INSERT INTO lms.compensation_case
    (code, lease_no, province_code, project_id, land_use_code, business_unit, block_code,
     case_date, lease_rate, lease_term_months, effective_date, case_remarks, stage_code)
  VALUES (lms.next_code_year('CC'), lms.next_code('LN-'), 'SND', p_dhrk10p, 'Pipeline ROW',
          'Daharki D&PL','Daharki D&PL', current_date - 30, 150000.0000, 12,
          current_date - 20, 'Flowline corridor, 118-7', 'Prepared')
  RETURNING id INTO c2;
  INSERT INTO lms.case_owner (case_id, landowner_id, owner_status, share_pct)
    VALUES (c2, lo_mukhtiar, 'O', 100.0000);
  INSERT INTO lms.case_lease_line (case_id, survey_id, survey_share_pct, lease_area, line_no)
    VALUES (c2, s118, 100.0000, 4.8000, 1);
  INSERT INTO lms.case_crop_line (case_id, survey_id, crop_type, rate_per_acre, damage_area)
    VALUES (c2, s118, 'Cotton', 110000.0000, 4.8000);
  INSERT INTO lms.case_document_check (case_id, item_code, checked_by)
  SELECT c2, code, u_lofield FROM lms.case_document_item WHERE code IN ('cnic_copies','fard','site_photos');
  PERFORM api.recalculate_case_totals(c2);
  PERFORM api.set_actor(u_nego); PERFORM api.advance_workflow('cases', c2, 'Checked', 'Crop rates confirmed');
  INSERT INTO _ids VALUES ('case2', c2);

  -- Case 3: Balochistan, approved. Gives the cross-province tests two
  -- provinces' records to tell apart.
  PERFORM api.set_actor(u_lobal);
  INSERT INTO lms.compensation_case
    (code, lease_no, province_code, project_id, land_use_code, business_unit, block_code,
     case_date, lease_rate, lease_term_months, effective_date, case_remarks, stage_code)
  VALUES (lms.next_code_year('CC'), lms.next_code('LN-'), 'BAL', p_sui, 'Well Location',
          'Sui Block','Sui Block', current_date - 200, 95000.0000, 12,
          current_date - 190, 'Pirkoh well-04 pad', 'Prepared')
  RETURNING id INTO c3;
  INSERT INTO lms.case_owner (case_id, landowner_id, owner_status, share_pct) VALUES
    (c3, lo_shahbaz, 'O', 50.0000), (c3, lo_gul, 'O', 50.0000);
  INSERT INTO lms.case_lease_line (case_id, survey_id, survey_share_pct, lease_area, line_no)
    VALUES (c3, s1187, 100.0000, 9.0000, 1);
  INSERT INTO lms.case_misc_line (case_id, survey_id, payment_type, amount)
    VALUES (c3, s1187, 'Access track levelling', 320000.00);
  INSERT INTO lms.case_document_check (case_id, item_code, checked_by)
  SELECT c3, code, u_lobal FROM lms.case_document_item WHERE required_when = 'always';
  PERFORM api.recalculate_case_totals(c3);
  -- Approved by Balochistan staff throughout. The Sindh field officers cannot
  -- touch it, which is the point.
  PERFORM api.set_actor(u_negoqta);  PERFORM api.advance_workflow('cases', c3, 'Checked');
  PERFORM api.set_actor(u_legal);    PERFORM api.advance_workflow('cases', c3, 'Reviewed');
  PERFORM api.set_actor(u_sradmqta); PERFORM api.advance_workflow('cases', c3, 'Verified');
  PERFORM api.set_actor(u_dmqta);    PERFORM api.advance_workflow('cases', c3, 'Field Approved');
  PERFORM api.set_actor(u_mland);    PERFORM api.advance_workflow('cases', c3, 'HO Approved');
  INSERT INTO _ids VALUES ('case3', c3);

  -- =================================================================
  -- Lease, approved: this is what blocks parcel 112-7 against a second lease.
  -- =================================================================
  PERFORM api.set_actor(u_lofield);
  INSERT INTO lms.lease
    (code, province_code, project_id, case_id, kind, registration_no, initial_area,
     start_date, term_years, rate_per_acre, escalation_pct, auto_extend,
     renewal_clause, obligations, stage_code)
  VALUES (lms.next_code('LSE-'), 'SND', p_dhrk1, c1, 'Private Land', 'REG/DHRK/2026/0041',
          9.3750, current_date - 110, 5, 185000.0000, 10.0000, true,
          'Extends for a further five years unless terminated by the lessee with 90 days notice.',
          'Lessee to maintain boundary, restore on surrender, pay rent annually in advance.',
          'Draft')
  RETURNING id INTO l1;
  INSERT INTO lms.lease_lessor (lease_id, landowner_id) VALUES (l1, lo_mukhtiar), (l1, lo_zubaida);
  INSERT INTO lms.lease_survey (lease_id, survey_id) VALUES (l1, s112), (l1, s113);
  PERFORM api.set_actor(u_sradmin); PERFORM api.advance_workflow('leases', l1, 'Under Review');
  PERFORM api.set_actor(u_mland);   PERFORM api.advance_workflow('leases', l1, 'Approved');
  INSERT INTO _ids VALUES ('lease1', l1);

  -- A lease that expires soon, so the expiry-alert view has something in it.
  -- Punjab, so it is handled by the regional office throughout.
  PERFORM api.set_actor(u_lopnj);
  INSERT INTO lms.lease
    (code, province_code, project_id, kind, registration_no, initial_area,
     start_date, term_years, rate_per_acre, escalation_pct, auto_extend, stage_code)
  VALUES (lms.next_code('LSE-'), 'PNJ', p_jmpr, 'Private Land', 'REG/JMPR/2021/0012',
          6.5000, current_date - (365*5 - 45), 5, 120000.0000, 8.0000, false, 'Draft')
  RETURNING id INTO l1;
  INSERT INTO lms.lease_lessor (lease_id, landowner_id) VALUES (l1, lo_aslam);
  INSERT INTO lms.lease_survey (lease_id, survey_id) VALUES (l1, s556);
  PERFORM api.set_actor(u_sradmpnj); PERFORM api.advance_workflow('leases', l1, 'Under Review');
  PERFORM api.set_actor(u_mland);    PERFORM api.advance_workflow('leases', l1, 'Approved');

  -- =================================================================
  -- ROW corridor
  -- =================================================================
  PERFORM api.set_actor(u_lofield);
  INSERT INTO lms.row_corridor
    (code, province_code, project_id, name, row_type, from_point, to_point,
     length_m, width_m, agreement_date, tenure_years, annual_rent, obligations, stage_code)
  VALUES (lms.next_code('ROW-'), 'SND', p_dhrk10p, 'KP 0+000 to KP 4+500', 'Flowline ROW',
          'KP 0+000','KP 4+500', 4500.00, 10.00, current_date - 300, 20, 1250000.00,
          'Restore topsoil after laying; no permanent structures within the corridor.', 'Draft')
  RETURNING id INTO r1;
  INSERT INTO lms.row_survey (row_id, survey_id) VALUES (r1, s118);
  INSERT INTO lms.row_landowner (row_id, landowner_id) VALUES (r1, lo_mukhtiar);
  PERFORM api.set_actor(u_sradmin); PERFORM api.advance_workflow('rows', r1, 'Under Review');
  PERFORM api.set_actor(u_mland);   PERFORM api.advance_workflow('rows', r1, 'Approved');

  -- =================================================================
  -- DBPFC: Sindh government land, rate still to be fixed
  -- =================================================================
  PERFORM api.set_actor(u_lofield);
  INSERT INTO lms.dbpfc_estimate
    (code, province_code, project_id, district_id, area_acres, estimated_rate,
     committee_ref, remarks, stage_code)
  SELECT lms.next_code('DBP-'), 'SND', p_dhrk2, au.id, 18.5000, 72000.0000,
         'DBPFC/GHK/2026/07', 'Estimated pending committee notification', 'Estimated'
  FROM lms.admin_unit au WHERE au.name='Ghotki' AND au.level=0
  RETURNING id INTO d1;
  INSERT INTO lms.dbpfc_survey (dbpfc_id, survey_id) VALUES (d1, s204);
  PERFORM api.set_actor(u_sradmin); PERFORM api.advance_workflow('dbpfc', d1, 'Referred to DBPFC',
    'Referred to the District Base Price Fixation Committee');
  INSERT INTO _ids VALUES ('dbpfc1', d1);

  -- =================================================================
  -- Payments. Case 1 is approved, so it can be paid.
  -- =================================================================
  PERFORM api.set_actor(u_lofield);
  pay1 := api.request_payment(
    p_idempotency_key => 'seed-pay-0001-mukhtiar-lease-2026',
    p_project_id => p_dhrk1, p_category => 'Lease Rent', p_pay_type => 'Yearly Lease',
    p_period_from => current_date - 110, p_gross_amount => 1041562.50,
    p_payment_mode => 'Cross Cheque', p_landowner_id => lo_mukhtiar, p_case_id => c1,
    p_land_class => 'Private', p_remarks => 'Year 1 lease rent, 60% share');
  PERFORM api.allocate_payment(pay1, c1, 937406.25, lo_mukhtiar, 'Mukhtiar Ali, 60% of case 1');
  PERFORM api.set_actor(u_finance); PERFORM api.advance_workflow('payments', pay1, 'Verified', 'Budget and bank details verified');
  PERFORM api.set_actor(u_mland);
  -- Released today: the case is approved when the seed runs, and a cheque cannot predate its approval.
  rel := api.release_payment(pay1, 'seed-rel-0001-mukhtiar-lease-2026', current_date);
  INSERT INTO lms.payment_receipt (release_id, receipt_no, received_on, acknowledged_by,
                                   acknowledged_cnic, recorded_by)
  VALUES (rel, 'RCPT-2026-0001', current_date, 'Mukhtiar Ali Jarwar',
          '45102-1100012-3', u_mland);
  INSERT INTO _ids VALUES ('payment1', pay1);

  -- A second voucher, verified but not released: this is what the no-double-
  -- release and budget tests act on.
  PERFORM api.set_actor(u_lofield);
  pay2 := api.request_payment(
    p_idempotency_key => 'seed-pay-0002-zubaida-lease-2026',
    p_project_id => p_dhrk1, p_category => 'Lease Rent', p_pay_type => 'Yearly Lease',
    p_period_from => current_date - 110, p_gross_amount => 694375.00,
    p_payment_mode => 'Direct Credit (IBFT)', p_landowner_id => lo_zubaida, p_case_id => c1,
    p_land_class => 'Private', p_remarks => 'Year 1 lease rent, 40% share');
  PERFORM api.set_actor(u_finance); PERFORM api.advance_workflow('payments', pay2, 'Verified');
  INSERT INTO _ids VALUES ('payment2', pay2);

  -- A government-land voucher against the DBPFC estimate, still requested.
  PERFORM api.set_actor(u_lofield);
  pay3 := api.request_payment(
    p_idempotency_key => 'seed-pay-0003-gos-dbpfc-2026',
    p_project_id => p_dhrk2, p_category => 'Government Lease', p_pay_type => 'Yearly Lease',
    p_period_from => current_date - 60, p_gross_amount => 1332000.00,
    p_payment_mode => 'Pay Order', p_payee_name => 'Government of Sindh — Board of Revenue',
    p_dbpfc_id => d1, p_land_class => 'Government', p_wht_pct => 0,
    p_remarks => 'Estimated annual lease, government land 204-11');
  INSERT INTO _ids VALUES ('payment3', pay3);

  -- =================================================================
  -- Litigation with a stay order. The trigger places payment holds on the
  -- landowner and the parcel, which is why no payment is raised for 331-14.
  -- =================================================================
  PERFORM api.set_actor(u_legal);
  INSERT INTO lms.legal_case
    (code, province_code, court_case_no, court, case_type, company_role, parties,
     project_id, filing_date, next_hearing, counsel, officer_id, financial_exposure,
     stay_order, status, remarks)
  VALUES (lms.next_code('LIT-'), 'SND', 'CS-234/2025', 'Senior Civil Judge',
          'Title / Ownership Suit', 'Proforma Party',
          'Heirs of Ghulam Qadir Mahar vs Province of Sindh & others',
          p_dhrk2, current_date - 240, current_date + 21, 'Khan & Associates',
          u_legal, 4500000.00, true, 'Under Hearing',
          'Succession disputed between two sets of claimants; parcel 331-14 is under stay.')
  RETURNING id INTO lit1;
  INSERT INTO lms.legal_case_landowner (legal_case_id, landowner_id) VALUES (lit1, lo_qadir);
  INSERT INTO lms.legal_case_survey (legal_case_id, survey_id) VALUES (lit1, s331);
  -- The trigger fires on the stay_order column, so re-assert it now that the
  -- parties are attached.
  UPDATE lms.legal_case SET stay_order = true WHERE id = lit1;
  INSERT INTO lms.legal_hearing (legal_case_id, hearing_date, proceedings, next_date, recorded_by)
  VALUES (lit1, current_date - 60, 'Arguments heard; interim stay confirmed.', current_date + 21, u_legal);
  INSERT INTO _ids VALUES ('legal1', lit1);

  -- =================================================================
  -- Mutation: Allah Dino (deceased) → his two children, on parcel 112-7.
  -- Left at Legal Cleared so a test can approve it and watch the shares move.
  -- =================================================================
  PERFORM api.set_actor(u_lofield);
  INSERT INTO lms.mutation
    (code, province_code, mutation_type, transferor_id, death_date, revenue_mutation_no,
     mutation_date, revenue_office, certificate_no, remarks, stage_code)
  VALUES (lms.next_code('MUT-'), 'SND', 'Inheritance (Virasat)', lo_dino,
          current_date - 400, '1452', current_date - 150, 'Mukhtiarkar Daharki',
          'FRC-2025-0881', 'Succession of the late Allah Dino Jarwar', 'Initiated')
  RETURNING id INTO m1;
  INSERT INTO lms.mutation_survey (mutation_id, survey_id) VALUES (m1, s112);
  INSERT INTO lms.mutation_heir (mutation_id, landowner_id, relation, share_pct) VALUES
    (m1, lo_mukhtiar, 'Son',      66.6667),
    (m1, lo_zubaida,  'Daughter', 33.3333);
  PERFORM api.set_actor(u_sradmin); PERFORM api.advance_workflow('mutations', m1, 'Revenue Verified');
  PERFORM api.set_actor(u_legal);   PERFORM api.advance_workflow('mutations', m1, 'Legal Cleared');
  INSERT INTO _ids VALUES ('mutation1', m1);

  -- =================================================================
  -- Grievance and encroachment
  -- =================================================================
  PERFORM api.set_actor(u_lofield);
  INSERT INTO lms.grievance
    (code, province_code, grievance_type, landowner_id, complainant, complainant_cnic,
     mobile, project_id, survey_id, category_code, severity, channel, received_date,
     due_date, description, stage_code)
  VALUES (lms.next_code_year('GRV'), 'SND', 'Landowner Complaint', lo_rasool,
          'Rasool Bux Khoso', '45102-1100014-9', '+92 301 1110014', p_dhrk2, s204,
          'Payment Delay', 'High', 'Written application', current_date - 22,
          current_date - 7, 'Annual government lease payment for 204-11 is overdue by two months.',
          'Registered')
  RETURNING id INTO g1;
  PERFORM api.set_actor(u_dm); PERFORM api.advance_workflow('grievances', g1, 'Assigned', 'Assigned to the field land officer');
  UPDATE lms.grievance SET assigned_to = u_lofield WHERE id = g1;
  PERFORM api.set_actor(u_sradmin); PERFORM api.advance_workflow('grievances', g1, 'In Progress', 'DBPFC rate pending; interim estimate raised');
  INSERT INTO _ids VALUES ('grievance1', g1);

  PERFORM api.set_actor(u_lofield);
  INSERT INTO lms.encroachment
    (code, province_code, category_code, project_id, survey_id, row_id, lat, lng,
     detected_on, reported_by, encroacher, area_affected, risk, description, impact, stage_code)
  VALUES (lms.next_code_year('ENC'), 'SND', 'Cultivation on ROW', p_dhrk10p, s118, r1,
          28.052000, 69.676000, current_date - 14, u_lofield, 'Unknown tenant farmer',
          0.7500, 'High', 'Cotton planted directly over the flowline corridor at KP 2+100.',
          'Deep ploughing risks the pipeline coating; access for inspection is obstructed.',
          'Reported')
  RETURNING id INTO e1;
  PERFORM api.set_actor(u_sradmin); PERFORM api.advance_workflow('encroachments', e1, 'Assessed', 'Site visit completed, depth of ploughing measured');
  INSERT INTO _ids VALUES ('encroach1', e1);

  -- =================================================================
  -- Acquisition in progress
  -- =================================================================
  PERFORM api.set_actor(u_lofield);
  INSERT INTO lms.acquisition
    (code, province_code, project_id, mode, area_required, negotiated_rate,
     target_handover_date, negotiator_id, remarks, stage_code)
  VALUES (lms.next_code_year('ACQ'), 'SND', p_dhrk2, 'Private Lease', 12.0000,
          175000.0000, current_date + 60, u_nego,
          'Gathering station extension on 207-11', 'Identification')
  RETURNING id INTO c1;
  INSERT INTO lms.acquisition_survey (acquisition_id, survey_id)
  SELECT c1, id FROM lms.survey WHERE survey_no='207' AND province_code='SND';
  INSERT INTO lms.acquisition_title_check (acquisition_id, item_code, checked_by)
  SELECT c1, code, u_lofield FROM lms.title_check_item WHERE code IN ('fard','mutation','cnic');
  PERFORM api.set_actor(u_nego); PERFORM api.advance_workflow('acquisitions', c1, 'Negotiation', 'Rate negotiation opened with the owner');
  INSERT INTO _ids VALUES ('acquisition1', c1);
END $$;

COMMIT;
