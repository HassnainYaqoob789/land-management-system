-- role: lms_owner
-- tx: rollback
--
-- Runs as the owner: since 0042 the application roles may not write ownership
-- shares directly (only api.register_ownership may), and these cases test the
-- deferred triggers themselves, which the routine cannot reach mid-way.
-- The deferred constraint triggers, and why they are deferred.
--
-- Each of these rules spans rows, so none can be a CHECK. Each is DEFERRABLE
-- INITIALLY DEFERRED, so it is enforced on the transaction's result rather
-- than on each statement — which is what lets a redistribution of shares pass
-- through intermediate states that are individually invalid.
\set QUIET on

-- ---------- the catalogue says what the migrations intended ----------
DO $$
DECLARE t record; v_n integer;
BEGIN
  FOR t IN
    SELECT tg.tgname, c.relname
    FROM pg_trigger tg
    JOIN pg_class c ON c.oid = tg.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'lms' AND tg.tgname LIKE '%share_total_ck'
       OR (n.nspname = 'lms' AND tg.tgname = 'allocation_limits_ck')
  LOOP
    PERFORM test.ok(
      (SELECT tgdeferrable AND tginitdeferred FROM pg_trigger
       WHERE tgname = t.tgname AND tgrelid = (SELECT oid FROM pg_class
                                              WHERE relname = t.relname
                                                AND relnamespace = 'lms'::regnamespace)),
      format('%s on %s is DEFERRABLE INITIALLY DEFERRED', t.tgname, t.relname));
  END LOOP;
END $$;

-- ---------- ownership shares: redistribution passes through an invalid state ----------
DO $$
DECLARE fx record; v_owner uuid;
BEGIN
  PERFORM test.become('admin');
  -- Put the constraints back to deferred: a previous case in this file forced
  -- them immediate, and that setting lasts for the rest of the transaction.
  SET CONSTRAINTS ALL DEFERRED;
  SELECT * INTO fx FROM test.fixtures;

  SELECT landowner_id INTO v_owner FROM lms.survey_ownership_share
   WHERE survey_id = fx.survey_112 LIMIT 1;
  PERFORM test.eq(api.ownership_share_total(fx.survey_112), 100.0000::numeric,
                  'the parcel starts fully apportioned');

  -- Add a second 50% holder before reducing the first. Between the two
  -- statements the parcel is at 150%, which an immediate check would refuse —
  -- and the transaction as a whole is perfectly valid.
  INSERT INTO lms.survey_ownership_share (survey_id, landowner_id, share_pct)
  VALUES (fx.survey_112, fx.lo_rasool, 50.0000);
  PERFORM test.eq(api.ownership_share_total(fx.survey_112), 150.0000::numeric,
                  'mid-transaction the parcel is over-apportioned, and that is allowed');
  UPDATE lms.survey_ownership_share SET share_pct = 50.0000
   WHERE survey_id = fx.survey_112 AND landowner_id = v_owner;
  PERFORM test.eq(api.ownership_share_total(fx.survey_112), 100.0000::numeric,
                  'and by the end of the transaction it is back to 100%');

  -- Forcing the check now is the same thing COMMIT would do.
  SET CONSTRAINTS ALL IMMEDIATE;
  PERFORM test.ok(true, 'the deferred check passes on the transaction''s result');
END $$;

-- ---------- and refuses a result that is genuinely wrong ----------
DO $$
DECLARE fx record; v_msg text;
BEGIN
  PERFORM test.become('admin');
  -- Put the constraints back to deferred: the previous case forced them
  -- immediate, and that setting lasts for the rest of the transaction.
  SET CONSTRAINTS ALL DEFERRED;
  SELECT * INTO fx FROM test.fixtures;

  -- The offending insert and the check have to sit in the same subtransaction.
  -- A deferred violation stays pending until something forces it, so if the
  -- insert were outside the handled block the row would survive the rollback
  -- and fire later, in whichever unrelated statement next forced the check.
  BEGIN
    INSERT INTO lms.survey_ownership_share (survey_id, landowner_id, share_pct)
    VALUES (fx.survey_113, fx.lo_rasool, 50.0000);
    -- 113-7 already holds 60 + 40, so this leaves it at 150%.
    SET CONSTRAINTS ALL IMMEDIATE;
    PERFORM test.ok(false, 'an over-apportioned parcel should have been refused');
  EXCEPTION WHEN check_violation THEN
    v_msg := SQLERRM;
  END;
  PERFORM test.ok(v_msg ILIKE '%exceeds 100%',
                  'a transaction that leaves a parcel over-apportioned is refused at the check');
  PERFORM test.eq(api.ownership_share_total(fx.survey_113), 100.0000::numeric,
                  'and the offending row is gone, so the parcel is back to 100%');
END $$;

-- ---------- case payee shares must total exactly 100% ----------
DO $$
DECLARE fx record; v_case uuid;
BEGIN
  PERFORM test.become('admin');
  -- Put the constraints back to deferred: a previous case in this file forced
  -- them immediate, and that setting lasts for the rest of the transaction.
  SET CONSTRAINTS ALL DEFERRED;
  SELECT * INTO fx FROM test.fixtures;

  -- Build a case one payee at a time. At 60% it is incomplete, which is a
  -- valid intermediate state while the form is being filled in.
  INSERT INTO lms.compensation_case
    (code, province_code, project_id, land_use_code, case_date, lease_rate,
     lease_term_months, stage_code)
  VALUES (lms.next_code_year('CC'), 'SND', fx.proj_dhrk1, 'Well Location',
          current_date, 100000, 12, 'Prepared')
  RETURNING id INTO v_case;
  INSERT INTO lms.case_owner (case_id, landowner_id, owner_status, share_pct)
  VALUES (v_case, fx.lo_mukhtiar, 'O', 60.0000);
  PERFORM test.ok(true, 'a case with 60% apportioned can exist mid-transaction');

  INSERT INTO lms.case_owner (case_id, landowner_id, owner_status, share_pct)
  VALUES (v_case, fx.lo_zubaida, 'O', 40.0000);
  SET CONSTRAINTS ALL IMMEDIATE;
  PERFORM test.ok(true, 'and is accepted once the payees total 100%');
END $$;

DO $$
DECLARE fx record; v_case uuid; v_msg text;
BEGIN
  PERFORM test.become('admin');
  SET CONSTRAINTS ALL DEFERRED;
  SELECT * INTO fx FROM test.fixtures;
  BEGIN
    INSERT INTO lms.compensation_case
      (code, province_code, project_id, land_use_code, case_date, lease_rate,
       lease_term_months, stage_code)
    VALUES (lms.next_code_year('CC'), 'SND', fx.proj_dhrk1, 'Well Location',
            current_date, 100000, 12, 'Prepared')
    RETURNING id INTO v_case;
    INSERT INTO lms.case_owner (case_id, landowner_id, owner_status, share_pct)
    VALUES (v_case, fx.lo_mukhtiar, 'O', 70.0000);
    SET CONSTRAINTS ALL IMMEDIATE;
    PERFORM test.ok(false, 'a 70% case should have been refused');
  EXCEPTION WHEN check_violation THEN
    v_msg := SQLERRM;
  END;
  PERFORM test.ok(v_msg ILIKE '%not 100%',
                  'a case whose payee shares do not total 100% is refused at the check');
END $$;

-- ---------- bulk load ----------
-- A deferred check is evaluated per row at COMMIT, so a bulk import has to
-- work. This inserts a batch of parcels and their holdings in one transaction.
DO $$
DECLARE fx record; v_unit uuid; v_lo uuid; i integer; v_survey uuid;
BEGIN
  PERFORM test.become('admin');
  -- Put the constraints back to deferred: a previous case in this file forced
  -- them immediate, and that setting lasts for the rest of the transaction.
  SET CONSTRAINTS ALL DEFERRED;
  SELECT * INTO fx FROM test.fixtures;
  SELECT admin_unit_id INTO v_unit FROM lms.survey WHERE id = fx.survey_112;

  FOR i IN 1 .. 50 LOOP
    INSERT INTO lms.survey (code, province_code, admin_unit_id, survey_no,
                            total_area, land_class, status_code)
    VALUES (lms.next_code('AREA-'), 'SND', v_unit, 'BULK-' || i,
            10.0, 'Private', 'Proposed')
    RETURNING id INTO v_survey;
    -- Two holders at 50% each, inserted in the order a spreadsheet would give
    -- them.
    INSERT INTO lms.survey_ownership_share (survey_id, landowner_id, share_pct)
    VALUES (v_survey, fx.lo_mukhtiar, 50.0000),
           (v_survey, fx.lo_zubaida,  50.0000);
  END LOOP;

  SET CONSTRAINTS ALL IMMEDIATE;
  PERFORM test.eq((SELECT count(*)::integer FROM lms.survey WHERE survey_no LIKE 'BULK-%'), 50,
                  'a 50-parcel bulk load with ownership passes the deferred checks');
  PERFORM test.eq((SELECT count(*)::integer FROM lms.survey_ownership_share s
                   JOIN lms.survey v ON v.id = s.survey_id
                   WHERE v.survey_no LIKE 'BULK-%'), 100,
                  'with all 100 holdings recorded');
END $$;

-- ---------- allocation limits ----------
DO $$
DECLARE fx record; v_net numeric; v_msg text;
BEGIN
  PERFORM test.become('lofield');
  SET CONSTRAINTS ALL DEFERRED;
  SELECT * INTO fx FROM test.fixtures;
  SELECT net_amount INTO v_net FROM lms.payment_request WHERE id = fx.pay_verified;

  -- Two allocations, each comfortably within the voucher, that together
  -- exceed it. api.allocate_payment() refuses the second with a readable
  -- message because it checks the running total first.
  PERFORM api.allocate_payment(fx.pay_verified, fx.case_approved,
                               round(v_net * 0.7, 2), NULL, 'first tranche');
  PERFORM test.throws_like(
    format($q$ SELECT api.allocate_payment(%L, %L, %s) $q$,
           fx.pay_verified, fx.case_approved, round(v_net * 0.5, 2)),
    '%exceed the net payable%',
    'a second allocation that would take the voucher past its net is refused by the routine');

  -- And the deferred trigger is the backstop for a batch that bypassed the
  -- routine: the application does hold INSERT on lms.payment_allocation, so
  -- the rule has to hold there too.
  BEGIN
    INSERT INTO lms.payment_allocation (payment_id, case_id, amount, note)
    VALUES (fx.pay_verified, fx.case_approved, round(v_net * 0.5, 2), 'bypassing the routine');
    SET CONSTRAINTS ALL IMMEDIATE;
    PERFORM test.ok(false, 'an over-allocation inserted directly should have been refused');
  EXCEPTION WHEN check_violation THEN
    v_msg := SQLERRM;
  END;
  PERFORM test.ok(v_msg ILIKE '%net payable is%',
                  'and by the deferred trigger when the routine is bypassed');
END $$;
