-- role: lms_test
-- tx: rollback
--
-- Mutation: approving one moves the shares, in the approving transaction, and
-- leaves the ownership history behind.
--
-- The share-total rule is a DEFERRABLE constraint trigger, so it fires at
-- COMMIT. This file forces it with SET CONSTRAINTS ALL IMMEDIATE at the end of
-- each case instead of committing, which runs the same trigger at a point the
-- test can observe. test_13 covers the deferral itself.
\set QUIET on

DO $$
DECLARE fx record; v_mut uuid; v_before numeric; v_hist integer; v_n integer;
        v_mukhtiar numeric; v_zubaida numeric;
BEGIN
  PERFORM test.become('admin');
  SELECT * INTO fx FROM test.fixtures;

  -- Before: the late Allah Dino holds all of parcel 112-7.
  SELECT share_pct INTO v_before FROM lms.survey_ownership_share
   WHERE survey_id = fx.survey_112
     AND landowner_id = (SELECT id FROM lms.landowner WHERE cnic = '45102-1100011-1');
  PERFORM test.eq(v_before::numeric, 100.0000::numeric,
                  'before the mutation, the transferor holds the whole parcel');
  PERFORM test.eq(api.ownership_share_total(fx.survey_112), 100.0000::numeric,
                  'and the parcel is fully apportioned');

  -- The mutation is at Legal Cleared and needs the Manager Land approval.
  PERFORM test.eq((SELECT stage_code FROM lms.mutation WHERE id = fx.mutation1),
                  'Legal Cleared', 'the seeded mutation is awaiting final approval');

  PERFORM test.become('mland');
  PERFORM api.advance_workflow('mutations', fx.mutation1, 'Approved & Applied',
                               'Shares transferred per mutation 1452');

  PERFORM test.eq((SELECT stage_code FROM lms.mutation WHERE id = fx.mutation1),
                  'Approved & Applied', 'the mutation is approved');
  PERFORM test.ok((SELECT applied_at FROM lms.mutation WHERE id = fx.mutation1) IS NOT NULL,
                  'and stamped with when it was applied');

  -- After: the transferor holds nothing and the two heirs hold their shares.
  PERFORM test.eq((SELECT count(*)::integer FROM lms.survey_ownership_share
                   WHERE survey_id = fx.survey_112
                     AND landowner_id = (SELECT id FROM lms.landowner
                                         WHERE cnic = '45102-1100011-1')), 0,
                  'the transferor''s holding is gone');

  SELECT share_pct INTO v_mukhtiar FROM lms.survey_ownership_share
   WHERE survey_id = fx.survey_112 AND landowner_id = fx.lo_mukhtiar;
  SELECT share_pct INTO v_zubaida FROM lms.survey_ownership_share
   WHERE survey_id = fx.survey_112 AND landowner_id = fx.lo_zubaida;
  -- Heir shares are a percentage of the transferor's share: 66.6667% and
  -- 33.3333% of 100%.
  PERFORM test.eq(v_mukhtiar::numeric, 66.6667::numeric, 'the son receives his share');
  PERFORM test.eq(v_zubaida::numeric,  33.3333::numeric, 'the daughter receives hers');
  -- They total 99.9999 rather than 100: two thirds and one third cannot both
  -- be exact at four decimal places. The residue is 0.0001% of one parcel and
  -- is documented in docs/DATABASE_ENGINEERING_REPORT.md; what matters is that
  -- it is under, never over, so the 100% ceiling is never breached.
  PERFORM test.ok(api.ownership_share_total(fx.survey_112) <= 100,
                  'and the parcel total never exceeds 100% after a thirds split');
  PERFORM test.ok(api.ownership_share_total(fx.survey_112) >= 99.999,
                  'while still accounting for essentially all of the parcel');

  -- History: one row closing the transferor out, one per heir opening.
  SELECT count(*) INTO v_hist FROM lms.survey_ownership_history
   WHERE mutation_id = fx.mutation1;
  PERFORM test.eq(v_hist, 3, 'the ownership history records the transfer out and both receipts');
  PERFORM test.ok(EXISTS (SELECT 1 FROM lms.survey_ownership_history
                          WHERE mutation_id = fx.mutation1
                            AND change_reason LIKE '%transferred out%'),
                  'with the transferor''s row closed out');
  PERFORM test.ok((SELECT bool_and(valid_from IS NOT NULL)
                   FROM lms.survey_ownership_history WHERE mutation_id = fx.mutation1),
                  'and every row dated, so "who owned this in 2023" stays answerable');

  -- An inheritance marks the transferor deceased.
  PERFORM test.eq((SELECT status FROM lms.landowner WHERE cnic = '45102-1100011-1'),
                  'Deceased', 'an inheritance marks the transferor deceased');

  -- The transfer, the stage change, the history and the audit rows are all one
  -- transaction: every audit row the transfer produced carries this
  -- transaction's id, which is what makes "what else happened when this was
  -- approved" a single query.
  PERFORM test.eq((SELECT count(*)::integer FROM audit.audit_event
                   WHERE entity = 'survey_ownership_share'
                     AND txid <> txid_current()
                     AND occurred_at >= (SELECT applied_at FROM lms.mutation
                                         WHERE id = fx.mutation1)), 0,
                  'every share change the transfer made belongs to this transaction');
  PERFORM test.ok((SELECT count(*) FROM audit.audit_event
                   WHERE txid = txid_current() AND entity = 'survey_ownership_share') >= 3,
                  'and there are share changes in it to account for');
  PERFORM test.ok((SELECT count(*) FROM audit.audit_event
                   WHERE txid = txid_current() AND entity = 'mutation') >= 1,
                  'along with the mutation''s own stage change');

  -- Force the deferred share-total check now, since this transaction will be
  -- rolled back rather than committed.
  SET CONSTRAINTS ALL IMMEDIATE;
  PERFORM test.ok(true, 'the resulting share totals satisfy the deferred constraint');

  -- It cannot be applied twice: the mutation is now at its locking stage.
  PERFORM test.throws_like(
    format($q$ SELECT api.advance_workflow('mutations', %L, 'Approved & Applied') $q$, fx.mutation1),
    '%is locked%', 'an applied mutation cannot be applied again');
END $$;

-- ---------- guards ----------
DO $$
DECLARE fx record; v_mut uuid;
BEGIN
  PERFORM test.become('admin');
  -- The previous block forced the constraints immediate to observe the
  -- deferred check; put them back, since this block builds an intermediate
  -- state on purpose.
  SET CONSTRAINTS ALL DEFERRED;
  SELECT * INTO fx FROM test.fixtures;

  -- A mutation whose heir shares do not total 100% cannot be approved. The
  -- guard catches it at the transition, before the deferred constraint would.
  INSERT INTO lms.mutation (code, province_code, mutation_type, transferor_id,
                            revenue_mutation_no, mutation_date, certificate_no, stage_code)
  VALUES (lms.next_code('MUT-'), 'SND', 'Sale / Transfer', fx.lo_mukhtiar,
          '9999', current_date, 'N/A', 'Legal Cleared')
  RETURNING id INTO v_mut;
  INSERT INTO lms.mutation_survey (mutation_id, survey_id) VALUES (v_mut, fx.survey_113);
  INSERT INTO lms.mutation_heir (mutation_id, landowner_id, relation, share_pct)
  VALUES (v_mut, fx.lo_zubaida, 'Buyer', 60.0000);

  PERFORM test.become('mland');
  PERFORM test.throws_like(
    format($q$ SELECT api.advance_workflow('mutations', %L, 'Approved & Applied') $q$, v_mut),
    '%total 60.0000%', 'a mutation whose heir shares do not total 100% cannot be approved');

  -- A mutation with no holdings selected cannot be approved either.
  PERFORM test.become('admin');
  UPDATE lms.mutation_heir SET share_pct = 100.0000 WHERE mutation_id = v_mut;
  DELETE FROM lms.mutation_survey WHERE mutation_id = v_mut;
  PERFORM test.become('mland');
  PERFORM test.throws_like(
    format($q$ SELECT api.advance_workflow('mutations', %L, 'Approved & Applied') $q$, v_mut),
    '%Select the holdings%', 'a mutation with no holdings cannot be approved');

  -- And one where the transferor holds nothing on the chosen parcel fails in
  -- the routine rather than silently transferring nothing. Parcel 207-11 is
  -- held entirely by a different landowner.
  PERFORM test.become('admin');
  INSERT INTO lms.mutation_survey (mutation_id, survey_id) VALUES (v_mut, fx.survey_207);
  PERFORM test.become('mland');
  PERFORM test.throws_like(
    format($q$ SELECT api.advance_workflow('mutations', %L, 'Approved & Applied') $q$, v_mut),
    '%holds no share%', 'a transferor with no holding on the parcel is refused');

  -- The transferor cannot also be an heir: they would be transferring part of
  -- their holding back to themselves.
  PERFORM test.become('admin');
  PERFORM test.throws_like(format($q$
    INSERT INTO lms.mutation_heir (mutation_id, landowner_id, relation, share_pct)
    VALUES (%L, %L, 'Son', 1) $q$, v_mut, fx.lo_mukhtiar),
    '%cannot also be an heir%',
    'the transferring owner cannot be listed among the heirs');

  -- And nobody can be listed twice.
  PERFORM test.throws(format($q$
    INSERT INTO lms.mutation_heir (mutation_id, landowner_id, relation, share_pct)
    VALUES (%L, %L, 'Daughter', 1) $q$, v_mut, fx.lo_zubaida), '23505',
    'the same heir cannot be listed twice on one mutation');
END $$;
