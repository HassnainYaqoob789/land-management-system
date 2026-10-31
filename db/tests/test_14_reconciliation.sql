-- role: lms_owner
-- tx: rollback
-- actor: finance
--
-- Reconciliation: it reports mismatches and rewrites nothing. Runs as the
-- schema owner because one case deliberately disables a trigger to create the
-- kind of inconsistency only a privileged session could produce — which is
-- exactly the case reconciliation exists to catch.
\set QUIET on

-- ---------- reconciliation reports, and changes nothing ----------
DO $$
DECLARE v_run uuid; v_before jsonb; v_after jsonb; v_n integer;
BEGIN
  SELECT jsonb_agg(to_jsonb(t) ORDER BY t.code) INTO v_before
  FROM (SELECT code, total_amount, stage_code FROM lms.compensation_case) t;

  v_run := api.reconcile('all');
  PERFORM test.ok(v_run IS NOT NULL, 'a reconciliation run is recorded');
  -- test_07_concurrency.py runs earlier and must COMMIT the vouchers it races
  -- over (stand-alone, released, never allocated: correctly reported). They are
  -- recognisable by their idempotency key; everything else must reconcile.
  SELECT count(*)::integer INTO v_n FROM lms.reconciliation_exception e
   WHERE e.run_id = v_run
     AND NOT EXISTS (SELECT 1 FROM lms.idempotency_key k
                      WHERE k.result_id = e.entity_id AND k.key LIKE 'conc-%');
  PERFORM test.eq(v_n, 0, 'a consistent database reconciles with no exceptions');

  SELECT jsonb_agg(to_jsonb(t) ORDER BY t.code) INTO v_after
  FROM (SELECT code, total_amount, stage_code FROM lms.compensation_case) t;
  PERFORM test.eq(v_after, v_before, 'reconciliation rewrites no financial record');

  -- Break something the only way a privileged session could, and check the
  -- run notices. This is the check that would catch a disabled trigger.
  ALTER TABLE lms.compensation_case DISABLE TRIGGER case_locked_ck;
  UPDATE lms.compensation_case SET total_misc_amount = total_misc_amount + 1000
   WHERE stage_code = 'HO Approved';
  ALTER TABLE lms.compensation_case ENABLE TRIGGER case_locked_ck;

  v_run := api.reconcile('all');
  SELECT exception_count INTO v_n FROM lms.reconciliation_run WHERE id = v_run;
  PERFORM test.ok(v_n > 0, 'a tampered case total is reported as a reconciliation exception');
  PERFORM test.ok(EXISTS (SELECT 1 FROM lms.reconciliation_exception
                          WHERE run_id = v_run AND kind = 'case_total_vs_lines'),
                  'and is reported as a case-total mismatch specifically');
END $$;
