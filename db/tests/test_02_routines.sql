-- role: lms_test
-- tx: rollback
-- actor: lofield
--
-- Stored functions: unit conversion, area display, case totals, share and
-- area validation, budget position, case liability.
\set QUIET on

DO $$
DECLARE fx record; t api.case_total; b api.budget_position; l api.case_liability; v record;
BEGIN
  SELECT * INTO fx FROM test.fixtures;

  -- ---------- unit conversion ----------
  PERFORM test.eq(api.convert_area(1, 'Acre', 'Ghunta'), 40.000000::numeric,
                  '1 acre is 40 ghunta');
  PERFORM test.eq(api.convert_area(8, 'Kanal', 'Acre'), 1.000000::numeric,
                  '8 kanal is 1 acre');
  PERFORM test.eq(api.convert_area(160, 'Marla', 'Acre'), 1.000000::numeric,
                  '160 marla is 1 acre');
  PERFORM test.eq(api.convert_area(4, 'Rod', 'Acre'), 1.000000::numeric,
                  '4 rod is 1 acre');
  PERFORM test.eq(api.convert_area(1, 'Hectare', 'Square Meter'), 10000.000000::numeric,
                  '1 hectare is 10,000 square metres');
  PERFORM test.eq(api.convert_area(43560, 'Square Feet', 'Acre'), 1.000000::numeric,
                  '43,560 square feet is 1 acre');
  -- Round trip: converting out and back must return the input exactly, which
  -- it does because every step is numeric rather than float.
  PERFORM test.eq(api.convert_area(api.convert_area(3.5, 'Acre', 'Kanal'), 'Kanal', 'Acre'),
                  3.500000::numeric, 'acre to kanal and back is exact');
  PERFORM test.eq(api.convert_area(NULL, 'Acre', 'Ghunta'), NULL::numeric,
                  'a null area converts to null');

  -- The two unconfirmed factors are refused unless the caller opts in. This is
  -- the control that stops a provisional figure being presented as measured.
  PERFORM test.throws_like($q$ SELECT api.convert_area(1, 'Jireb', 'Acre') $q$,
    '%has not confirmed%', 'an unconfirmed Jireb factor is refused by default');
  PERFORM test.throws_like($q$ SELECT api.convert_area(1, 'Acre', 'Bigha') $q$,
    '%has not confirmed%', 'an unconfirmed Bigha factor is refused by default');
  PERFORM test.eq(api.convert_area(1, 'Jireb', 'Acre', current_date, true), 0.500000::numeric,
                  'the Jireb factor is usable when the caller opts in');

  PERFORM test.throws($q$ SELECT api.convert_area(1, 'Furlong', 'Acre') $q$, '22023',
    'an unknown unit is refused');
  PERFORM test.throws($q$ SELECT api.convert_area(-1, 'Acre', 'Ghunta') $q$, '22023',
    'a negative area is refused');
  -- A date before any factor was in force has no answer, and says so rather
  -- than silently using today's factor.
  PERFORM test.throws($q$ SELECT api.convert_area(1, 'Acre', 'Ghunta', DATE '1800-01-01') $q$,
    '22023', 'a date with no factor in force is refused');

  -- ---------- acre-ghunta display ----------
  PERFORM test.eq(api.acre_ghunta(1.0),    '1 - 0',    '1.0 acre prints as 1 - 0');
  PERFORM test.eq(api.acre_ghunta(1.5),    '1 - 20',   '1.5 acre prints as 1 - 20');
  PERFORM test.eq(api.acre_ghunta(6.25),   '6 - 10',   '6.25 acre prints as 6 - 10');
  PERFORM test.eq(api.acre_ghunta(0.025),  '0 - 1',    'one ghunta prints as 0 - 1');
  PERFORM test.eq(api.acre_ghunta(0),      '0 - 0',    'zero prints as 0 - 0');
  PERFORM test.eq(api.acre_ghunta(NULL),   NULL::text, 'null prints as null');
  -- The carry: 39.995 ghunta rounds to 40, which is a whole acre, not "2 - 40".
  PERFORM test.eq(api.acre_ghunta(1.99999), '2 - 0', 'a rounded-up ghunta carries into the acre');

  -- ---------- case totals ----------
  t := api.case_totals(fx.case_approved);
  PERFORM test.eq(t.lease_area::numeric, 9.3750::numeric, 'case 1 lease area is 9.375 acres');
  -- 185,000 per acre per year × 9.375 acres × 12/12 months
  PERFORM test.eq(t.lease_amount, 1734375.00::numeric(18,2), 'case 1 lease amount');
  -- 95,000 × 4.5 + 140,000 × 2.0
  PERFORM test.eq(t.crop_amount, 707500.00::numeric(18,2), 'case 1 crop amount');
  -- 4,500 × 18 + 12,000 × 4 + 22,000 × 3
  PERFORM test.eq(t.tree_amount, 195000.00::numeric(18,2), 'case 1 tree amount');
  PERFORM test.eq(t.misc_amount, 645000.00::numeric(18,2), 'case 1 miscellaneous amount');
  PERFORM test.eq(t.total_amount, 3281875.00::numeric(18,2), 'case 1 total compensation');

  -- The stored total agrees with the computed one, which is the invariant the
  -- reconciliation routine exists to keep checking.
  -- Cast away the domain: test.eq is polymorphic and will not unify
  -- lms.money_pkr_nonneg with a bare numeric.
  PERFORM test.eq((SELECT total_amount::numeric(18,2) FROM lms.compensation_case
                   WHERE id = fx.case_approved),
                  t.total_amount, 'the stored case total matches the recomputed one');

  PERFORM test.throws($q$ SELECT api.case_totals('00000000-0000-0000-0000-00000000dead') $q$,
    'P0002', 'case totals for a case that does not exist raise no_data_found');

  -- An approved case is locked, so its totals cannot be recomputed over.
  PERFORM test.throws_like(
    format($q$ SELECT api.recalculate_case_totals(%L) $q$, fx.case_approved),
    '%totals are fixed%', 'an approved case will not have its totals recomputed');

  -- ---------- ownership shares ----------
  PERFORM test.eq(api.ownership_share_total(fx.survey_112), 100.0000::numeric,
                  'parcel 112-7 is fully apportioned');
  SELECT * INTO v FROM api.validate_ownership_shares(fx.survey_112);
  PERFORM test.ok(v.is_valid, 'a fully apportioned parcel validates');
  PERFORM test.eq(v.detail, 'fully apportioned', 'and is reported as such');

  SELECT * INTO v FROM api.validate_ownership_shares(
    (SELECT id FROM lms.survey WHERE survey_no='331' AND province_code='SND'));
  PERFORM test.eq(v.share_total::numeric, 75.0000::numeric, 'parcel 331-14 is 75% apportioned');
  PERFORM test.ok(v.is_valid, 'a partly apportioned parcel is valid, not an error');
  PERFORM test.ok(v.detail LIKE '%unrecorded%', 'and the shortfall is reported');

  -- ---------- committed area ----------
  SELECT * INTO v FROM api.validate_survey_area(fx.survey_112);
  PERFORM test.eq(v.total_area::numeric, 18.7500::numeric, 'parcel 112-7 is 18.75 acres');
  PERFORM test.eq(v.committed_area::numeric, 6.2500::numeric, '6.25 acres are committed on it');
  PERFORM test.ok(v.is_valid, 'the committed area is within the parcel');

  -- ---------- budget ----------
  b := api.budget_status(fx.proj_dhrk1, 2026);
  PERFORM test.eq(b.approved_amount, 120000000.00::numeric(18,2), 'DHRK-001 approved budget');
  -- Released is the GROSS cost to the budget (net cheque + withholding tax), since 0043.
  PERFORM test.eq(b.released_amount, 1041562.50::numeric(18,2), 'DHRK-001 released to date (gross)');
  PERFORM test.ok(b.committed_amount > 0, 'DHRK-001 has committed but unpaid liabilities');
  PERFORM test.eq(b.balance_amount,
                  b.approved_amount - b.released_amount - b.committed_amount,
                  'the balance is approved less released less committed');

  -- A project with no budget row returns NULL rather than zero, so a caller
  -- cannot mistake "no budget control" for "no budget left".
  b := api.budget_status(fx.proj_dhrk1, 1999);
  PERFORM test.eq(b.approved_amount, NULL::numeric(18,2),
                  'a year with no budget returns null, not zero');

  -- ---------- case liability ----------
  l := api.case_liability(fx.case_approved);
  PERFORM test.eq(l.approved_amount, 3281875.00::numeric(18,2), 'liability: approved');
  -- Gross basis since 0043: settled = net cheque + withholding tax (937,406.25 + 104,156.25).
  PERFORM test.eq(l.released_amount, 1041562.50::numeric(18,2), 'liability: released (gross)');
  PERFORM test.eq(l.outstanding_amount, 2240312.50::numeric(18,2), 'liability: outstanding (approved less gross settled)');
  PERFORM test.ok(NOT l.is_settled, 'the case is not settled');

  -- ---------- report datasets ----------
  PERFORM test.ok((SELECT count(*) FROM api.report_compensation_summary('SND')) > 0,
                  'the compensation summary returns Sindh rows');
  PERFORM test.ok((SELECT count(*) FROM api.report_payment_register('SND')) = 1,
                  'the payment register lists the one released Sindh voucher');
  PERFORM test.ok((SELECT count(*) FROM api.report_landowner_statement(fx.lo_mukhtiar)) >= 2,
                  'the landowner statement shows an approval and a payment');
  PERFORM test.ok((SELECT count(*) FROM api.report_approval_turnaround('cases')) > 0,
                  'the approval turnaround report returns rows');
END $$;
