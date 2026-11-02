-- role: lms_test
-- tx: rollback
--
-- 0061: an applied mutation re-points open compensation and lease rent to the
-- heirs / buyers. The transferor keeps the share already paid; the unpaid rest
-- moves in proportion to the heir shares; the case still totals 100%; the
-- lessor list follows the land; every move is recorded; and the application
-- still cannot change the owners of an approved case by itself.
--
-- Seed: CC-2026-0001 (HO Approved, parcels 112 + 113) is owned 60% by
-- Mukhtiar (part paid) and 40% by Zubaida (unpaid). LSE-00001 (parcels 112 +
-- 113) has both as lessors. CC-2026-0002 (Checked, parcel 118) is 100%
-- Mukhtiar. Mukhtiar holds 60% and Zubaida 40% of parcel 113.
\set QUIET on

-- ---------- 1. a sale: Mukhtiar sells his share of parcel 113 to Rasool ----------
DO $$
DECLARE fx record; v_mut uuid; v_payable numeric; v_paid numeric; v_kept numeric;
        v_lease uuid; v_ghulam uuid; v_n integer;
BEGIN
  PERFORM test.become('admin');
  SELECT * INTO fx FROM test.fixtures;
  SELECT id INTO v_lease FROM lms.lease WHERE code = 'LSE-00001';

  SELECT payable_amount INTO v_payable FROM lms.case_money WHERE case_id = fx.case_approved;
  SELECT paid_amount INTO v_paid FROM lms.case_owner_money
   WHERE case_id = fx.case_approved AND landowner_id = fx.lo_mukhtiar;
  PERFORM test.ok(v_paid > 0 AND v_paid < v_payable * 0.6, 'before: Mukhtiar is part paid on CC-2026-0001');
  v_kept := least(60, ceil(v_paid * 1000000 / v_payable) / 10000);

  INSERT INTO lms.mutation (code, province_code, mutation_type, transferor_id,
                            revenue_mutation_no, mutation_date, certificate_no, stage_code)
  VALUES (lms.next_code('MUT-'), 'SND', 'Sale / Transfer', fx.lo_mukhtiar,
          'T23-SALE', current_date, 'N/A', 'Legal Cleared')
  RETURNING id INTO v_mut;
  INSERT INTO lms.mutation_survey (mutation_id, survey_id) VALUES (v_mut, fx.survey_113);
  INSERT INTO lms.mutation_heir (mutation_id, landowner_id, relation, share_pct)
  VALUES (v_mut, fx.lo_rasool, 'Buyer', 100.0000);

  PERFORM test.become('mland');
  PERFORM api.advance_workflow('mutations', v_mut, 'Approved & Applied', 'T23 sale applied');
  PERFORM test.become('admin');

  PERFORM test.eq((SELECT share_pct::numeric FROM lms.case_owner
                    WHERE case_id = fx.case_approved AND landowner_id = fx.lo_mukhtiar),
                  v_kept, 'the seller keeps only the share already paid');
  PERFORM test.eq((SELECT share_pct::numeric FROM lms.case_owner
                    WHERE case_id = fx.case_approved AND landowner_id = fx.lo_rasool),
                  60 - v_kept, 'the buyer gets the unpaid rest of the seller''s share');
  PERFORM test.eq((SELECT share_pct::numeric FROM lms.case_owner
                    WHERE case_id = fx.case_approved AND landowner_id = fx.lo_zubaida),
                  40.0000::numeric, 'the other owner is untouched');
  PERFORM test.eq((SELECT sum(share_pct)::numeric FROM lms.case_owner WHERE case_id = fx.case_approved),
                  100.0000::numeric, 'the case still totals exactly 100%');
  PERFORM test.ok((SELECT attributed_payable >= paid_amount FROM lms.case_owner_money
                    WHERE case_id = fx.case_approved AND landowner_id = fx.lo_mukhtiar),
                  'the seller''s kept share still covers what he was paid (not overpaid)');
  PERFORM test.eq((SELECT share_pct::numeric FROM lms.case_owner
                    WHERE case_id = fx.case_draft AND landowner_id = fx.lo_mukhtiar),
                  100.0000::numeric, 'a case on a parcel the mutation does not cover is untouched');

  SELECT count(*) INTO v_n FROM lms.mutation_repoint
   WHERE mutation_id = v_mut AND kind = 'case' AND record_id = fx.case_approved
     AND from_landowner_id = fx.lo_mukhtiar AND to_landowner_id = fx.lo_rasool
     AND share_moved = 60 - v_kept AND share_kept = v_kept AND paid_amount = v_paid;
  PERFORM test.eq(v_n, 1, 'the case move is recorded with share moved, share kept and amount paid');

  PERFORM test.ok(NOT EXISTS (SELECT 1 FROM lms.lease_lessor WHERE lease_id = v_lease AND landowner_id = fx.lo_mukhtiar),
                  'the seller is no longer a lessor (he holds no parcel of the lease)');
  PERFORM test.ok(EXISTS (SELECT 1 FROM lms.lease_lessor WHERE lease_id = v_lease AND landowner_id = fx.lo_rasool),
                  'the buyer is now a lessor, so future rent goes to him');
  PERFORM test.eq((SELECT count(*)::integer FROM lms.mutation_repoint
                    WHERE mutation_id = v_mut AND kind = 'lease' AND record_id = v_lease
                      AND to_landowner_id = fx.lo_rasool), 1, 'the lease move is recorded');

  PERFORM test.ok(EXISTS (SELECT 1 FROM audit.audit_event
                           WHERE txid = txid_current() AND entity = 'case_owner'
                             AND actor_id = fx.u_mland),
                  'the case owner changes are audited under the approver who applied the mutation');

  SET CONSTRAINTS ALL IMMEDIATE;
  PERFORM test.ok(true, 'the deferred share-total checks pass');
  SET CONSTRAINTS ALL DEFERRED;
END $$;

-- ---------- 2. an inheritance: Zubaida (nothing paid) dies, three heirs ----------
DO $$
DECLARE fx record; v_mut uuid; v_lease uuid; v_ghulam uuid; v_muk_before numeric; v_ras_before numeric;
BEGIN
  PERFORM test.become('admin');
  SELECT * INTO fx FROM test.fixtures;
  SELECT id INTO v_lease FROM lms.lease WHERE code = 'LSE-00001';
  SELECT id INTO v_ghulam FROM lms.landowner WHERE code = 'SND-000005';
  SELECT share_pct INTO v_muk_before FROM lms.case_owner WHERE case_id = fx.case_approved AND landowner_id = fx.lo_mukhtiar;
  SELECT share_pct INTO v_ras_before FROM lms.case_owner WHERE case_id = fx.case_approved AND landowner_id = fx.lo_rasool;

  INSERT INTO lms.mutation (code, province_code, mutation_type, transferor_id, death_date,
                            revenue_mutation_no, mutation_date, certificate_no, stage_code)
  VALUES (lms.next_code('MUT-'), 'SND', 'Inheritance (Virasat)', fx.lo_zubaida, current_date - 30,
          'T23-VIRASAT', current_date, 'SC-T23', 'Legal Cleared')
  RETURNING id INTO v_mut;
  INSERT INTO lms.mutation_survey (mutation_id, survey_id) VALUES (v_mut, fx.survey_113);
  INSERT INTO lms.mutation_heir (mutation_id, landowner_id, relation, share_pct) VALUES
    (v_mut, fx.lo_mukhtiar, 'Son', 33.3333),
    (v_mut, fx.lo_rasool,   'Son', 33.3333),
    (v_mut, v_ghulam,       'Son', 33.3334);

  PERFORM test.become('mland');
  PERFORM api.advance_workflow('mutations', v_mut, 'Approved & Applied', 'T23 virasat applied');
  PERFORM test.become('admin');

  PERFORM test.ok(NOT EXISTS (SELECT 1 FROM lms.case_owner WHERE case_id = fx.case_approved AND landowner_id = fx.lo_zubaida),
                  'a deceased owner with nothing paid leaves the case');
  PERFORM test.eq((SELECT share_pct::numeric FROM lms.case_owner WHERE case_id = fx.case_approved AND landowner_id = fx.lo_mukhtiar),
                  v_muk_before + 13.3333, 'an heir already on the case has the portion added to his row');
  PERFORM test.eq((SELECT share_pct::numeric FROM lms.case_owner WHERE case_id = fx.case_approved AND landowner_id = fx.lo_rasool),
                  v_ras_before + 13.3333, 'and so does the second heir');
  PERFORM test.eq((SELECT share_pct::numeric FROM lms.case_owner WHERE case_id = fx.case_approved AND landowner_id = v_ghulam),
                  13.3334::numeric, 'a new heir joins the case with his proportional portion');
  PERFORM test.eq((SELECT owner_status::text FROM lms.case_owner WHERE case_id = fx.case_approved AND landowner_id = v_ghulam),
                  'O', 'as an owner');
  PERFORM test.eq((SELECT sum(share_pct)::numeric FROM lms.case_owner WHERE case_id = fx.case_approved),
                  100.0000::numeric, 'the case still totals exactly 100%');
  PERFORM test.eq((SELECT status FROM lms.landowner WHERE id = fx.lo_zubaida), 'Deceased', 'the transferor is marked deceased');
  PERFORM test.eq((SELECT count(*)::integer FROM lms.mutation_repoint WHERE mutation_id = v_mut AND kind = 'case'),
                  3, 'one case move recorded per heir');
  PERFORM test.eq((SELECT sum(share_moved)::numeric FROM lms.mutation_repoint WHERE mutation_id = v_mut AND kind = 'case'),
                  40.0000::numeric, 'the moved portions add up to the whole unpaid share');
  PERFORM test.ok(NOT EXISTS (SELECT 1 FROM lms.lease_lessor WHERE lease_id = v_lease AND landowner_id = fx.lo_zubaida),
                  'the deceased lessor is removed from the lease');
  PERFORM test.eq((SELECT count(*)::integer FROM lms.lease_lessor WHERE lease_id = v_lease
                    AND landowner_id IN (fx.lo_mukhtiar, fx.lo_rasool, v_ghulam)), 3,
                  'and all three heirs are lessors');

  SET CONSTRAINTS ALL IMMEDIATE;
  PERFORM test.ok(true, 'the deferred share-total checks pass');
  SET CONSTRAINTS ALL DEFERRED;
END $$;

-- ---------- 3. the application still cannot do this by itself ----------
DO $$
DECLARE fx record; v_mut uuid;
BEGIN
  PERFORM test.become('admin');
  SELECT * INTO fx FROM test.fixtures;
  SELECT mutation_id INTO v_mut FROM lms.mutation_repoint LIMIT 1;

  PERFORM test.become('lofield');
  PERFORM test.throws_like(
    format($q$ UPDATE lms.case_owner SET share_pct = 50 WHERE case_id = %L $q$, fx.case_draft),
    '%approved or is closed%', 'a direct UPDATE of the owners of a Checked case is still refused');
  PERFORM test.throws_like(
    format($q$ UPDATE lms.case_owner SET owner_status = 'B' WHERE case_id = %L $q$, fx.case_approved),
    '%cannot be changed%', 'and of an HO Approved case');
  PERFORM set_config('lms.mutation_repoint', v_mut::text, true);
  PERFORM test.throws_like(
    format($q$ UPDATE lms.case_owner SET owner_status = 'B' WHERE case_id = %L $q$, fx.case_approved),
    '%cannot be changed%', 'setting the re-point flag oneself does not open the guard');
  PERFORM set_config('lms.mutation_repoint', '', true);

  PERFORM test.throws_like(format($q$ SELECT lms.mutation_repoint_payments(%L) $q$, v_mut),
    '%permission denied%', 'the application cannot run the re-pointing routine');
  PERFORM test.throws_like(format($q$ SELECT api.apply_mutation(%L) $q$, v_mut),
    '%permission denied%', 'nor apply a mutation outside its approval');
  PERFORM test.throws_like(
    format($q$ INSERT INTO lms.mutation_repoint (mutation_id, province_code, kind, record_id, record_code,
               from_landowner_id, share_moved) VALUES (%L, 'SND', 'case', %L, 'X', %L, 0) $q$,
           v_mut, fx.case_approved, fx.lo_mukhtiar),
    '%permission denied%', 'nor write re-pointing records');
  PERFORM test.throws_like('UPDATE lms.mutation_repoint SET note = ''x''',
    '%permission denied%', 'nor change them');

  PERFORM test.ok((SELECT count(*) FROM api.v_mutation_repoint) >= 6,
                  'the field officer of the province reads the re-pointing records');
  PERFORM test.become('loquetta');
  PERFORM test.eq((SELECT count(*)::integer FROM api.v_mutation_repoint), 0,
                  'another province sees none of them');
END $$;
