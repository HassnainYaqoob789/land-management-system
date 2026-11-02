-- role: lms_test
-- tx: rollback
--
-- 0062: a transferor who keeps another parcel of the same case keeps the share
-- for that parcel (parcel-wise split by the case's line values); the
-- transferor's unreleased vouchers are put on hold and cannot be released
-- until Finance decides.
--
-- Seed: CC-2026-0001 (HO Approved) has lines on parcels 112 and 113. Parcel
-- 112 is 100% SND-000001; parcel 113 is 60% Mukhtiar, 40% Zubaida. Case
-- owners: Mukhtiar 60% (part paid), Zubaida 40% (VCH-2026-00002 Verified, not
-- released).
\set QUIET on

DO $$
DECLARE fx record; v_owner112 uuid; v_mut uuid; v_v112 numeric; v_v113 numeric; v_paid numeric; v_payable numeric;
        v_target numeric; v_paidpct numeric; v_kept numeric; v_vch uuid;
BEGIN
  PERFORM test.become('admin');
  SELECT * INTO fx FROM test.fixtures;
  SELECT landowner_id INTO v_owner112 FROM lms.survey_ownership_share WHERE survey_id = fx.survey_112;

  -- ---------- set-up: Mukhtiar buys parcel 112, so he holds 112 and 113 ----------
  PERFORM test.become('admin');
  INSERT INTO lms.mutation (code, province_code, mutation_type, transferor_id, revenue_mutation_no, mutation_date, certificate_no, stage_code)
  VALUES (lms.next_code('MUT-'), 'SND', 'Sale / Transfer', v_owner112, 'T25-A', current_date, 'N/A', 'Legal Cleared') RETURNING id INTO v_mut;
  INSERT INTO lms.mutation_survey (mutation_id, survey_id) VALUES (v_mut, fx.survey_112);
  INSERT INTO lms.mutation_heir (mutation_id, landowner_id, relation, share_pct) VALUES (v_mut, fx.lo_mukhtiar, 'Buyer', 100);
  PERFORM test.become('mland');
  PERFORM api.advance_workflow('mutations', v_mut, 'Approved & Applied', 'T25 set-up');
  PERFORM test.become('admin');
  PERFORM test.eq((SELECT share_pct::numeric FROM lms.survey_ownership_share WHERE survey_id = fx.survey_112 AND landowner_id = fx.lo_mukhtiar),
    100.0000::numeric, 'set-up: Mukhtiar now owns parcel 112 as well');
  PERFORM test.eq((SELECT share_pct::numeric FROM lms.case_owner WHERE case_id = fx.case_approved AND landowner_id = fx.lo_mukhtiar),
    60.0000::numeric, 'a seller who is not a case owner changes no case shares');

  -- ---------- 1. Mukhtiar sells 113 but keeps 112: parcel-wise ----------
  SELECT value INTO v_v112 FROM lms.case_parcel_value(fx.case_approved) WHERE survey_id = fx.survey_112;
  SELECT value INTO v_v113 FROM lms.case_parcel_value(fx.case_approved) WHERE survey_id = fx.survey_113;
  SELECT coalesce(paid_amount, 0) INTO v_paid FROM lms.case_owner_money WHERE case_id = fx.case_approved AND landowner_id = fx.lo_mukhtiar;
  SELECT payable_amount INTO v_payable FROM lms.case_money WHERE case_id = fx.case_approved;
  v_target := round(60 * v_v112 / (v_v112 + v_v113 * 0.6), 4);
  v_paidpct := least(60, ceil(v_paid * 1000000 / v_payable) / 10000);
  v_kept := greatest(v_target, v_paidpct);
  PERFORM test.ok(v_target > 0 AND v_target < 60, format('the kept parcel carries part of his 60%% (%s%%)', v_target));

  INSERT INTO lms.mutation (code, province_code, mutation_type, transferor_id, revenue_mutation_no, mutation_date, certificate_no, stage_code)
  VALUES (lms.next_code('MUT-'), 'SND', 'Sale / Transfer', fx.lo_mukhtiar, 'T25-B', current_date, 'N/A', 'Legal Cleared') RETURNING id INTO v_mut;
  INSERT INTO lms.mutation_survey (mutation_id, survey_id) VALUES (v_mut, fx.survey_113);
  INSERT INTO lms.mutation_heir (mutation_id, landowner_id, relation, share_pct) VALUES (v_mut, fx.lo_rasool, 'Buyer', 100);
  PERFORM test.become('mland');
  PERFORM api.advance_workflow('mutations', v_mut, 'Approved & Applied', 'T25 parcel-wise');
  PERFORM test.become('admin');

  PERFORM test.eq((SELECT share_pct::numeric FROM lms.case_owner WHERE case_id = fx.case_approved AND landowner_id = fx.lo_mukhtiar),
    v_kept, 'the seller keeps the share for the parcel he still holds (or what he was paid, if more)');
  PERFORM test.eq((SELECT share_pct::numeric FROM lms.case_owner WHERE case_id = fx.case_approved AND landowner_id = fx.lo_rasool),
    60 - v_kept, 'the buyer gets only the transferred parcel''s unpaid part');
  PERFORM test.eq((SELECT sum(share_pct)::numeric FROM lms.case_owner WHERE case_id = fx.case_approved), 100.0000::numeric,
    'the case still totals 100%');
  PERFORM test.ok(EXISTS (SELECT 1 FROM lms.mutation_repoint WHERE mutation_id = v_mut AND kind = 'case'
                           AND to_landowner_id = fx.lo_rasool AND note LIKE 'Parcel-wise%'),
    'the move is recorded as parcel-wise, not left for a manual re-apportion');
  PERFORM test.ok(NOT EXISTS (SELECT 1 FROM lms.mutation_repoint WHERE mutation_id = v_mut AND note LIKE 'Not re-pointed%'),
    'no case is skipped any more');
  PERFORM test.ok((SELECT attributed_payable >= paid_amount FROM lms.case_owner_money
                    WHERE case_id = fx.case_approved AND landowner_id = fx.lo_mukhtiar), 'the seller is not left overpaid');

  -- ---------- 2. Zubaida sells her 40% of 113: her unreleased voucher is held ----------
  SELECT id INTO v_vch FROM lms.payment_request WHERE code = 'VCH-2026-00002';
  PERFORM test.ok((SELECT stage_code FROM lms.payment_request WHERE id = v_vch) = 'Verified'
                  AND NOT EXISTS (SELECT 1 FROM lms.payment_active_hold(v_vch)), 'before: her verified voucher is releasable');
  INSERT INTO lms.mutation (code, province_code, mutation_type, transferor_id, revenue_mutation_no, mutation_date, certificate_no, stage_code)
  VALUES (lms.next_code('MUT-'), 'SND', 'Sale / Transfer', fx.lo_zubaida, 'T25-C', current_date, 'N/A', 'Legal Cleared') RETURNING id INTO v_mut;
  INSERT INTO lms.mutation_survey (mutation_id, survey_id) VALUES (v_mut, fx.survey_113);
  INSERT INTO lms.mutation_heir (mutation_id, landowner_id, relation, share_pct) VALUES (v_mut, fx.lo_rasool, 'Buyer', 100);
  PERFORM test.become('mland');
  PERFORM api.advance_workflow('mutations', v_mut, 'Approved & Applied', 'T25 hold');

  PERFORM test.eq((SELECT stage_code FROM lms.payment_request WHERE id = v_vch), 'Verified', 'the voucher is not cancelled');
  PERFORM test.ok((SELECT reason FROM lms.payment_active_hold(v_vch)) LIKE 'Ownership changed by mutation%',
    'it is put on hold with the mutation named');
  PERFORM test.throws_like(format($q$ SELECT api.advance_workflow('payments', %L, 'Released', 't25') $q$, v_vch),
    '%hold%', 'and it cannot be released while held');
  PERFORM test.become('admin');
  PERFORM test.ok(EXISTS (SELECT 1 FROM lms.mutation_repoint WHERE mutation_id = v_mut AND note LIKE '%put on hold for Finance%'),
    'the re-point record tells Finance');
  PERFORM test.eq((SELECT count(*)::int FROM lms.payment_hold WHERE payment_id = v_vch AND lifted_at IS NULL), 1, 'exactly one hold');
END $$;
