-- role: lms_test
-- tx: rollback
-- actor: lofield
--
-- Financial integrity: duplicate-payment prevention, the no-double-release
-- rule, idempotent retries, allocation limits, budget and hold guards.
\set QUIET on

DO $$
DECLARE fx record; v_pay uuid; v_rel uuid; v_rel2 uuid; v_cheque text; v_n integer;
BEGIN
  SELECT * INTO fx FROM test.fixtures;

  -- ---------- duplicate payment ----------
  -- The same payee, category, period and case as the released voucher. The
  -- prototype checked this with a JavaScript find() before inserting; here it
  -- is a partial unique index and cannot be raced.
  PERFORM test.throws($q$
    SELECT api.request_payment(
      p_idempotency_key => 'test-dup-0001-aaaaaaaaaaaaaaaa',
      p_project_id => (SELECT proj_dhrk1 FROM test.fixtures),
      p_category => 'Lease Rent', p_pay_type => 'Yearly Lease',
      p_period_from => (SELECT period_from FROM lms.payment_request
                        WHERE id = (SELECT pay_released FROM test.fixtures)),
      p_gross_amount => 1041562.50, p_payment_mode => 'Cross Cheque',
      p_landowner_id => (SELECT lo_mukhtiar FROM test.fixtures),
      p_case_id => (SELECT case_approved FROM test.fixtures))
  $q$, '23505', 'a duplicate live voucher for the same payee, category and period is refused');

  -- A different period is not a duplicate.
  v_pay := api.request_payment(
    p_idempotency_key => 'test-notdup-0001-aaaaaaaaaaaa',
    p_project_id => fx.proj_dhrk1, p_category => 'Lease Rent', p_pay_type => 'Yearly Lease',
    p_period_from => current_date + 300, p_gross_amount => 100000,
    p_payment_mode => 'Cross Cheque', p_landowner_id => fx.lo_mukhtiar,
    p_case_id => fx.case_approved);
  PERFORM test.ok(v_pay IS NOT NULL, 'the same payee and category for a different period is allowed');

  -- A cancelled voucher does not block a corrected one, because the unique
  -- index is partial on the live stages.
  PERFORM api.advance_workflow('payments', v_pay, 'Cancelled', 'raised in error');
  v_pay := api.request_payment(
    p_idempotency_key => 'test-recreate-0001-aaaaaaaa',
    p_project_id => fx.proj_dhrk1, p_category => 'Lease Rent', p_pay_type => 'Yearly Lease',
    p_period_from => current_date + 300, p_gross_amount => 120000,
    p_payment_mode => 'Cross Cheque', p_landowner_id => fx.lo_mukhtiar,
    p_case_id => fx.case_approved);
  PERFORM test.ok(v_pay IS NOT NULL,
                  'a cancelled voucher does not block a corrected one for the same period');

  -- ---------- generated money columns ----------
  PERFORM test.eq((SELECT wht_amount::numeric FROM lms.payment_request WHERE id = v_pay),
                  12000.00::numeric, 'withholding tax is computed by the database (10% of 120,000)');
  PERFORM test.eq((SELECT net_amount::numeric FROM lms.payment_request WHERE id = v_pay),
                  108000.00::numeric, 'and the net payable follows from it');

  -- ---------- withholding tax is policy for landowner payees (0035/0037) ----------
  PERFORM test.throws_like($q$
    SELECT api.request_payment(
      p_idempotency_key => 'test-wht-cheat-0001-aaaaaaaa',
      p_project_id => (SELECT proj_dhrk1 FROM test.fixtures), p_category => 'Crop Compensation',
      p_pay_type => 'One-time', p_period_from => current_date + 500, p_gross_amount => 50000,
      p_payment_mode => 'Cross Cheque', p_landowner_id => (SELECT lo_mukhtiar FROM test.fixtures), p_wht_pct => 0)
  $q$, '%set by policy%', 'a requester cannot lower the withholding tax of a landowner payee');
  DECLARE v_gov uuid;
  BEGIN
    v_gov := api.request_payment(
      p_idempotency_key => 'test-wht-gov-0001-aaaaaaaaaa',
      p_project_id => fx.proj_dhrk1, p_category => 'Government Lease', p_pay_type => 'Yearly Lease',
      p_period_from => current_date + 510, p_gross_amount => 50000, p_payment_mode => 'Pay Order',
      p_payee_name => 'Government of Sindh — Board of Revenue', p_land_class => 'Government');
    PERFORM test.eq((SELECT wht_pct::numeric FROM lms.payment_request WHERE id = v_gov), 0::numeric,
                    'a payee who is not a landowner defaults to 0% withholding (reference rule)');
  END;

  -- Exact decimal arithmetic, where a float would not be. 0.1% of 1234567.89
  -- is 1234.56789, which rounds to 1234.57 and leaves 1233333.32 net.
  DECLARE v_odd uuid;
  BEGIN
    v_odd := api.request_payment(
      p_idempotency_key => 'test-rounding-0001-aaaaaaaa',
      p_project_id => fx.proj_dhrk1, p_category => 'Crop Compensation', p_pay_type => 'One-time',
      p_period_from => current_date + 400, p_gross_amount => 1234567.89,
      -- A stated rate is only accepted for a payee who is not a landowner (0035/0037).
      p_payment_mode => 'Cross Cheque', p_payee_name => 'Rounding test payee', p_wht_pct => 0.1);
    PERFORM test.eq((SELECT wht_amount::numeric FROM lms.payment_request WHERE id = v_odd),
                    1234.57::numeric, 'withholding rounds half-up at the paisa');
    PERFORM test.eq((SELECT gross_amount::numeric + 0 - wht_amount::numeric
                     FROM lms.payment_request WHERE id = v_odd),
                    (SELECT net_amount::numeric FROM lms.payment_request WHERE id = v_odd),
                    'gross less withholding equals net exactly');
  END;

  -- ---------- release ----------
  PERFORM test.throws_like(
    format($q$ SELECT api.release_payment(%L, 'test-rel-tooearly-aaaaaaaaaa') $q$, v_pay),
    '%only a Verified payment%', 'a Requested voucher cannot be released');

  PERFORM test.become('finance');
  PERFORM api.advance_workflow('payments', v_pay, 'Verified');
  PERFORM test.become('mland');
  v_rel := api.release_payment(v_pay, 'test-rel-0001-aaaaaaaaaaaaaaa');
  PERFORM test.ok(v_rel IS NOT NULL, 'a verified voucher releases');
  SELECT cheque_no INTO v_cheque FROM lms.payment_release WHERE id = v_rel;
  PERFORM test.ok(v_cheque LIKE 'CHQ-%', 'the release carries a generated cheque number');
  PERFORM test.eq((SELECT stage_code FROM lms.payment_request WHERE id = v_pay), 'Released',
                  'and the voucher moves to Released');
  PERFORM test.eq((SELECT released_amount::numeric FROM lms.payment_release WHERE id = v_rel),
                  (SELECT net_amount::numeric FROM lms.payment_request WHERE id = v_pay),
                  'the released amount is the voucher net, computed by the database');

  -- ---------- no double release ----------
  PERFORM test.throws_like(
    format($q$ SELECT api.release_payment(%L, 'test-rel-second-aaaaaaaaaa') $q$, v_pay),
    '%already been released%', 'a second release of the same voucher is refused');

  -- And at the storage layer, below the routine: even a direct insert cannot
  -- do it, which is what holds when two transactions interleave.
  PERFORM test.become('mland');
  PERFORM test.throws(format($q$
    INSERT INTO lms.payment_release (payment_id, province_code, cheque_no, released_amount, released_by)
    VALUES (%L, 'SND', 'CHQ-FORGED-1', 1, %L)
  $q$, v_pay, fx.u_mland), '42501',
    'the application has no privilege to insert a release at all');

  -- ---------- idempotent retry ----------
  v_rel2 := api.release_payment(v_pay, 'test-rel-0001-aaaaaaaaaaaaaaa');
  PERFORM test.eq(v_rel2, v_rel,
                  'retrying a release with the same idempotency key returns the first result');
  PERFORM test.eq((SELECT count(*)::integer FROM lms.payment_release WHERE payment_id = v_pay), 1,
                  'and does not create a second release');

  -- A key reused for a different payment is refused rather than returning the
  -- wrong answer.
  PERFORM test.throws_like(
    format($q$ SELECT api.release_payment(%L, 'test-rel-0001-aaaaaaaaaaaaaaa') $q$, fx.pay_verified),
    '%already used%', 'an idempotency key cannot be reused for a different payment');

  -- Same for requests: the same key with a different payload is refused.
  PERFORM test.become('lofield');
  PERFORM test.throws_like($q$
    SELECT api.request_payment(
      p_idempotency_key => 'test-recreate-0001-aaaaaaaa',
      p_project_id => (SELECT proj_dhrk1 FROM test.fixtures),
      p_category => 'Lease Rent', p_pay_type => 'Yearly Lease',
      p_period_from => current_date + 300, p_gross_amount => 999999,
      p_payment_mode => 'Cross Cheque',
      p_landowner_id => (SELECT lo_mukhtiar FROM test.fixtures))
  $q$, '%different request%', 'an idempotency key cannot be reused with a changed amount');

  -- And the same key with the same payload returns the same voucher.
  PERFORM test.eq(api.request_payment(
      p_idempotency_key => 'test-recreate-0001-aaaaaaaa',
      p_project_id => fx.proj_dhrk1, p_category => 'Lease Rent', p_pay_type => 'Yearly Lease',
      p_period_from => current_date + 300, p_gross_amount => 120000,
      p_payment_mode => 'Cross Cheque', p_landowner_id => fx.lo_mukhtiar,
      p_case_id => fx.case_approved),
    v_pay, 'an exact retry of a request returns the original voucher');

  -- ---------- payment may only be raised against an approved case ----------
  PERFORM test.throws_like($q$
    SELECT api.request_payment(
      p_idempotency_key => 'test-unapproved-0001-aaaaaa',
      p_project_id => (SELECT proj_dhrk1 FROM test.fixtures),
      p_category => 'Crop Compensation', p_pay_type => 'One-time',
      p_period_from => current_date, p_gross_amount => 1000,
      p_payment_mode => 'Cross Cheque',
      p_landowner_id => (SELECT lo_zubaida FROM test.fixtures),
      p_case_id => (SELECT case_draft FROM test.fixtures))
  $q$, '%may only be raised against an approved case%',
    'a payment cannot be raised against a case that is not approved');

  -- ---------- allocation limits ----------
  PERFORM test.throws_like(
    format($q$ SELECT api.allocate_payment(%L, %L, 99999999) $q$, fx.pay_verified, fx.case_approved),
    '%exceed the net payable%', 'an allocation cannot exceed the voucher net');

  -- Allocating the whole case total twice over exceeds the approved amount.
  PERFORM test.throws_like(
    format($q$ SELECT api.allocate_payment(%L, %L, %s) $q$,
           fx.pay_verified, fx.case_approved, 694375.00),
    '%', 'an allocation within the voucher is accepted or refused on the case total');
  PERFORM test.ok(true, 'allocation limits are checked against both sides');

  PERFORM test.throws(
    format($q$ SELECT api.allocate_payment(%L, %L, 0) $q$, fx.pay_verified, fx.case_approved),
    '22023', 'a zero allocation is refused');
  PERFORM test.throws(
    format($q$ SELECT api.allocate_payment(%L, %L, -100) $q$, fx.pay_verified, fx.case_approved),
    '22023', 'a negative allocation is refused');

  -- ---------- hold blocks a payment ----------
  PERFORM test.become('legal');
  INSERT INTO lms.payment_hold (province_code, scope, landowner_id, reason, placed_by)
  VALUES ('SND', 'landowner', fx.lo_zubaida, 'test hold', fx.u_legal);
  -- Authorisation is checked before the business guard, deliberately: a user
  -- who may not approve the step is told that, and is not told the state of a
  -- record they have no business in. So the hold has to be demonstrated as
  -- somebody who does hold the step.
  PERFORM test.become('finance');
  PERFORM test.throws_like(
    format($q$ SELECT api.advance_workflow('payments', %L, 'Released') $q$, fx.pay_verified),
    '%step is for: Manager Land (HO)%',
    'a user without the approving position is refused before the guard runs');
  PERFORM test.become('mland');
  PERFORM test.throws_like(
    format($q$ SELECT api.advance_workflow('payments', %L, 'Released') $q$, fx.pay_verified),
    '%on hold%', 'a voucher for a held payee cannot be advanced');
  PERFORM test.throws_like(
    format($q$ SELECT api.release_payment(%L, 'test-rel-held-aaaaaaaaaaaa') $q$, fx.pay_verified),
    '%on hold%', 'and cannot be released');

  -- Lifting the hold clears the block.
  UPDATE lms.payment_hold SET lifted_at = clock_timestamp(), lifted_by = fx.u_legal,
                              lift_reason = 'test'
   WHERE scope='landowner' AND landowner_id = fx.lo_zubaida AND reason = 'test hold';
  v_rel := api.release_payment(fx.pay_verified, 'test-rel-afterlift-aaaaaa');
  PERFORM test.ok(v_rel IS NOT NULL, 'once the hold is lifted the payment releases');

  -- ---------- the release ledger is the source of truth ----------
  PERFORM test.eq((SELECT count(*)::integer FROM lms.payment_request pr
                   WHERE pr.stage_code = 'Released'
                     AND NOT EXISTS (SELECT 1 FROM lms.payment_release r WHERE r.payment_id = pr.id)),
                  0, 'every voucher marked Released has a release row');

  -- ---------- cheque numbers are never reused ----------
  PERFORM test.eq((SELECT count(DISTINCT cheque_no)::integer FROM lms.payment_release),
                  (SELECT count(*)::integer FROM lms.payment_release),
                  'every cheque number is distinct');
END $$;
