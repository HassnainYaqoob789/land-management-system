-- =====================================================================
-- 0012  Financial routines: budgets, liabilities, payment lifecycle,
--       allocations, reconciliation, mutations
-- =====================================================================
SET ROLE lms_owner;

-- ---------------------------------------------------------------------
-- Budget position for a project and year.
--
--   approved  — the sanctioned amount
--   released  — money actually out (from payment_release, not from a stage)
--   committed — requested or verified payments, plus approved cases with no
--               payment raised yet: liabilities that are certain but unpaid
--   balance   — approved − released − committed
--
-- "released" deliberately reads lms.payment_release rather than
-- payment_request.stage_code, because the release row is the fact and the
-- stage is a label. If the two ever disagree, the reconciliation routine
-- reports it instead of either one quietly winning.
-- ---------------------------------------------------------------------
CREATE TYPE api.budget_position AS (
  project_id      uuid,
  fiscal_year     integer,
  approved_amount numeric(18,2),
  released_amount numeric(18,2),
  committed_amount numeric(18,2),
  balance_amount  numeric(18,2),
  utilisation_pct numeric(7,2)
);

CREATE FUNCTION api.budget_status(p_project_id uuid, p_year integer)
  RETURNS api.budget_position
  LANGUAGE plpgsql STABLE
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE r api.budget_position; v_pending numeric; v_unpaid_cases numeric;
BEGIN
  r.project_id := p_project_id;
  r.fiscal_year := p_year;

  SELECT b.approved_amount INTO r.approved_amount
  FROM lms.budget b WHERE b.project_id = p_project_id AND b.fiscal_year = p_year;

  SELECT coalesce(sum(rel.released_amount), 0) INTO r.released_amount
  FROM lms.payment_release rel
  JOIN lms.payment_request pr ON pr.id = rel.payment_id
  WHERE pr.project_id = p_project_id
    AND extract(year from pr.period_from) = p_year;

  SELECT coalesce(sum(pr.net_amount), 0) INTO v_pending
  FROM lms.payment_request pr
  WHERE pr.project_id = p_project_id
    AND pr.stage_code IN ('Requested','Verified')
    AND extract(year from pr.period_from) = p_year;

  -- Approved cases with nothing allocated against them yet.
  SELECT coalesce(sum(c.total_amount), 0) INTO v_unpaid_cases
  FROM lms.compensation_case c
  WHERE c.project_id = p_project_id
    AND c.stage_code = 'HO Approved'
    AND extract(year from coalesce(c.approved_at::date, c.case_date)) = p_year
    AND NOT EXISTS (SELECT 1 FROM lms.payment_allocation a WHERE a.case_id = c.id);

  r.committed_amount := v_pending + v_unpaid_cases;
  r.balance_amount := coalesce(r.approved_amount, 0) - r.released_amount - r.committed_amount;
  r.utilisation_pct := CASE WHEN coalesce(r.approved_amount,0) > 0
    THEN round((r.released_amount + r.committed_amount) * 100 / r.approved_amount, 2)
    ELSE NULL END;
  RETURN r;
END $$;
COMMENT ON FUNCTION api.budget_status(uuid,integer) IS
  'Budget position. Returns approved_amount NULL when no budget exists for the '
  'year, which callers must treat as "no budget control", not as zero.';

-- ---------------------------------------------------------------------
-- Outstanding liability on a case: what was approved, less what has been
-- allocated to it, less what has actually been released against it.
-- ---------------------------------------------------------------------
CREATE TYPE api.case_liability AS (
  case_id          uuid,
  case_code        lms.record_code,
  approved_amount  numeric(18,2),
  allocated_amount numeric(18,2),
  released_amount  numeric(18,2),
  outstanding_amount numeric(18,2),
  is_settled       boolean
);

CREATE FUNCTION api.case_liability(p_case_id uuid) RETURNS api.case_liability
  LANGUAGE plpgsql STABLE
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE r api.case_liability;
BEGIN
  SELECT c.id, c.code, c.total_amount INTO r.case_id, r.case_code, r.approved_amount
  FROM lms.compensation_case c WHERE c.id = p_case_id;
  IF r.case_id IS NULL THEN
    RAISE EXCEPTION 'no such compensation case %', p_case_id USING ERRCODE = 'no_data_found';
  END IF;

  SELECT coalesce(sum(a.amount), 0) INTO r.allocated_amount
  FROM lms.payment_allocation a
  JOIN lms.payment_request pr ON pr.id = a.payment_id
  WHERE a.case_id = p_case_id AND pr.stage_code NOT IN ('Cancelled','Stopped');

  SELECT coalesce(sum(a.amount), 0) INTO r.released_amount
  FROM lms.payment_allocation a
  JOIN lms.payment_release rel ON rel.payment_id = a.payment_id
  WHERE a.case_id = p_case_id;

  r.outstanding_amount := r.approved_amount - r.released_amount;
  r.is_settled := r.outstanding_amount <= 0;
  RETURN r;
END $$;

-- ---------------------------------------------------------------------
-- api.request_payment — raise a voucher, idempotently.
--
-- Preconditions: an actor is set; the project is in the actor's province; the
-- referenced case, if any, is HO Approved; no active hold applies.
-- Postcondition: exactly one voucher exists for this idempotency key.
-- Failure: raises, and nothing is written.
--
-- The retry story: the key is inserted first. A retry of a call that already
-- succeeded finds the key and returns the same voucher id without creating a
-- second one. A retry of a call that failed finds no key, because the failed
-- transaction took the key row down with it, and proceeds normally.
-- ---------------------------------------------------------------------
CREATE FUNCTION api.request_payment(
         p_idempotency_key text,
         p_project_id   uuid,
         p_category     text,
         p_pay_type     text,
         p_period_from  date,
         p_gross_amount numeric,
         p_payment_mode text,
         p_landowner_id uuid DEFAULT NULL,
         p_payee_name   text DEFAULT NULL,
         p_case_id      uuid DEFAULT NULL,
         p_lease_id     uuid DEFAULT NULL,
         p_dbpfc_id     uuid DEFAULT NULL,
         p_period_to    date DEFAULT NULL,
         p_wht_pct      numeric DEFAULT NULL,
         p_land_class   text DEFAULT NULL,
         p_remarks      text DEFAULT NULL)
  RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_actor    uuid := util.require_actor();
  v_existing uuid;
  v_hash     text;
  v_province char(3);
  v_case     record;
  v_wht      numeric;
  v_id       uuid;
  v_code     lms.record_code;
  v_prior_hash text;
BEGIN
  IF lms.actor_role() = 'Viewer' THEN
    RAISE EXCEPTION 'the Viewer role is read-only' USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_hash := encode(ext.digest(
    concat_ws('|', p_project_id, p_category, p_pay_type, p_period_from, p_gross_amount,
                   p_landowner_id, lower(btrim(coalesce(p_payee_name,''))), p_case_id, p_lease_id),
    'sha256'), 'hex');

  SELECT k.result_id, k.request_hash INTO v_existing, v_prior_hash
  FROM lms.idempotency_key k WHERE k.key = p_idempotency_key;
  IF FOUND THEN
    IF v_prior_hash <> v_hash THEN
      RAISE EXCEPTION 'idempotency key % was already used for a different request', p_idempotency_key
        USING ERRCODE = 'unique_violation';
    END IF;
    RETURN v_existing;
  END IF;

  SELECT p.province_code INTO v_province FROM lms.project p WHERE p.id = p_project_id;
  IF v_province IS NULL THEN
    RAISE EXCEPTION 'no such project %', p_project_id USING ERRCODE = 'no_data_found';
  END IF;
  IF lms.actor_role() <> 'Admin' AND NOT lms.actor_can_see_province(v_province) THEN
    RAISE EXCEPTION 'project is outside your province access' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- A payment may only be raised against an approved case. The prototype
  -- filtered the dropdown; here it is refused outright.
  IF p_case_id IS NOT NULL THEN
    SELECT c.stage_code, c.code, c.total_amount INTO v_case
    FROM lms.compensation_case c WHERE c.id = p_case_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'no such compensation case %', p_case_id USING ERRCODE = 'no_data_found';
    END IF;
    IF v_case.stage_code <> 'HO Approved' THEN
      RAISE EXCEPTION 'case % is % — a payment may only be raised against an approved case',
        v_case.code, v_case.stage_code USING ERRCODE = 'raise_exception';
    END IF;
  END IF;

  SELECT (value #>> '{}')::numeric INTO v_wht
  FROM lms.system_setting WHERE key = 'finance.wht_pct';
  v_wht := coalesce(p_wht_pct, v_wht, 0);

  INSERT INTO lms.idempotency_key (key, operation, request_hash, created_by)
  VALUES (p_idempotency_key, 'request_payment', v_hash, v_actor);

  v_code := lms.next_code_year('VCH');
  INSERT INTO lms.payment_request
    (code, province_code, landowner_id, payee_name, project_id, case_id, lease_id, dbpfc_id,
     category_code, pay_type, land_class, period_from, period_to, gross_amount, wht_pct,
     payment_mode, remarks, stage_code, created_by, updated_by)
  VALUES
    (v_code, v_province, p_landowner_id, p_payee_name, p_project_id, p_case_id, p_lease_id,
     p_dbpfc_id, p_category, p_pay_type, p_land_class, p_period_from, p_period_to,
     p_gross_amount, v_wht, p_payment_mode, p_remarks, 'Requested', v_actor, v_actor)
  RETURNING id INTO v_id;

  UPDATE lms.idempotency_key SET result_id = v_id,
         result = jsonb_build_object('payment_id', v_id, 'code', v_code::text)
  WHERE key = p_idempotency_key;

  INSERT INTO lms.workflow_transition
    (workflow_code, record_id, record_code, province_code, from_stage, to_stage,
     action, acted_by, note)
  VALUES ('payments', v_id, v_code, v_province, NULL, 'Requested', 'Created', v_actor, p_remarks);

  RETURN v_id;
END $$;
COMMENT ON FUNCTION api.request_payment IS
  'SECURITY DEFINER: writes lms.idempotency_key and lms.workflow_transition, '
  'which the application role cannot insert into directly. Re-checks province '
  'access itself because definer rights bypass row-level security.';

-- ---------------------------------------------------------------------
-- api.release_payment — the one place money leaves.
--
-- Preconditions: actor set, not a Viewer, voucher is Verified, no active hold,
-- no existing release.
-- Postcondition: exactly one row in lms.payment_release for this voucher, with
-- a cheque number that has never been issued before, and the voucher at
-- 'Released'.
-- Failure: raises; nothing is written; the cheque number is burned.
--
-- Three independent things stop a double payment, and that redundancy is the
-- point: the stage check (cheap, catches the ordinary case), the explicit
-- release lookup (gives a good error message), and UNIQUE(payment_id) on
-- lms.payment_release (the one that holds when two transactions interleave,
-- because the first to commit makes the second's insert fail).
-- ---------------------------------------------------------------------
CREATE FUNCTION api.release_payment(
         p_payment_id      uuid,
         p_idempotency_key text,
         p_cheque_date     date DEFAULT NULL,
         p_note            text DEFAULT NULL)
  RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_actor   uuid := util.require_actor();
  v_p       record;
  v_hash    text;
  v_prior   record;
  v_guard   text;
  v_cheque  text;
  v_rel     uuid;
BEGIN
  IF lms.actor_role() = 'Viewer' THEN
    RAISE EXCEPTION 'the Viewer role is read-only' USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_hash := encode(ext.digest(concat_ws('|', 'release', p_payment_id), 'sha256'), 'hex');

  SELECT k.result_id, k.request_hash INTO v_prior
  FROM lms.idempotency_key k WHERE k.key = p_idempotency_key;
  IF FOUND THEN
    IF v_prior.request_hash <> v_hash THEN
      RAISE EXCEPTION 'idempotency key % was already used to release a different payment',
        p_idempotency_key USING ERRCODE = 'unique_violation';
    END IF;
    RETURN v_prior.result_id;
  END IF;

  -- Lock the voucher. Everything after this point is serialised per voucher.
  SELECT pr.id, pr.code, pr.province_code, pr.stage_code, pr.net_amount, pr.project_id
  INTO v_p
  FROM lms.payment_request pr WHERE pr.id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such payment %', p_payment_id USING ERRCODE = 'no_data_found';
  END IF;

  IF lms.actor_role() <> 'Admin' AND NOT lms.actor_can_see_province(v_p.province_code) THEN
    RAISE EXCEPTION 'payment % is outside your province access', v_p.code
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF EXISTS (SELECT 1 FROM lms.payment_release WHERE payment_id = p_payment_id) THEN
    RAISE EXCEPTION 'payment % has already been released', v_p.code
      USING ERRCODE = 'unique_violation';
  END IF;

  IF v_p.stage_code <> 'Verified' THEN
    RAISE EXCEPTION 'payment % is % — only a Verified payment can be released', v_p.code, v_p.stage_code
      USING ERRCODE = 'raise_exception';
  END IF;

  v_guard := lms.wf_guard_payments(p_payment_id, 'Released');
  IF v_guard IS NOT NULL THEN
    RAISE EXCEPTION '%', v_guard USING ERRCODE = 'raise_exception';
  END IF;

  INSERT INTO lms.idempotency_key (key, operation, request_hash, created_by)
  VALUES (p_idempotency_key, 'release_payment', v_hash, v_actor);

  v_cheque := 'CHQ-' || nextval('lms.cheque_no_seq')::text;

  INSERT INTO lms.payment_release
    (payment_id, province_code, cheque_no, cheque_date, released_amount,
     idempotency_key, released_by)
  VALUES (p_payment_id, v_p.province_code, v_cheque, coalesce(p_cheque_date, current_date),
          v_p.net_amount, p_idempotency_key, v_actor)
  RETURNING id INTO v_rel;

  UPDATE lms.payment_request SET stage_code = 'Released' WHERE id = p_payment_id;

  UPDATE lms.idempotency_key SET result_id = v_rel,
    result = jsonb_build_object('release_id', v_rel, 'cheque_no', v_cheque,
                                'amount', v_p.net_amount)
  WHERE key = p_idempotency_key;

  INSERT INTO lms.workflow_transition
    (workflow_code, record_id, record_code, province_code, from_stage, to_stage,
     action, acted_by, note)
  VALUES ('payments', p_payment_id, v_p.code, v_p.province_code, 'Verified', 'Released',
          'Advanced', v_actor, coalesce(p_note, 'cheque ' || v_cheque));

  -- The outbox row goes in the same transaction as the release, so finance is
  -- told exactly once about exactly the releases that happened.
  INSERT INTO lms.integration_outbox
    (endpoint_code, event_type, entity, record_id, payload, idempotency_key)
  SELECT 'erp_finance', 'payment.released', 'payment_request', p_payment_id,
         jsonb_build_object('voucher', v_p.code::text, 'cheque_no', v_cheque,
                            'amount', v_p.net_amount, 'province', v_p.province_code),
         p_idempotency_key
  WHERE EXISTS (SELECT 1 FROM lms.integration_endpoint WHERE code = 'erp_finance');

  INSERT INTO audit.audit_event
    (actor_id, actor_username, actor_role, entity, record_id, record_code, province_code,
     action, new_data, note)
  SELECT v_actor, u.username, u.role_code, 'payment_release', v_rel, v_p.code, v_p.province_code,
         'EXECUTE',
         jsonb_build_object('cheque_no', v_cheque, 'amount', v_p.net_amount),
         'payment released'
  FROM lms.app_user u WHERE u.id = v_actor;

  RETURN v_rel;
END $$;
COMMENT ON FUNCTION api.release_payment(uuid,text,date,text) IS
  'Releases a verified payment exactly once. SECURITY DEFINER because it must '
  'write the release, the audit event, the workflow transition and the '
  'integration outbox, none of which the application role may insert into '
  'directly — that is what stops a release being fabricated by an UPDATE.';

-- ---------------------------------------------------------------------
-- Allocation. An allocation may not take a case past its approved total, nor
-- a payment past its net. Both are checked here for a good error message and
-- again by deferred constraint triggers (0013), which is what holds when two
-- allocations are inserted concurrently.
-- ---------------------------------------------------------------------
CREATE FUNCTION api.allocate_payment(
         p_payment_id  uuid,
         p_case_id     uuid,
         p_amount      numeric,
         p_landowner_id uuid DEFAULT NULL,
         p_note        text DEFAULT NULL)
  RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_actor uuid := util.require_actor();
  v_pay   record;
  v_liab  api.case_liability;
  v_allocated numeric;
  v_id    uuid;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'allocation amount must be positive' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT pr.id, pr.code, pr.net_amount, pr.province_code, pr.stage_code
  INTO v_pay FROM lms.payment_request pr WHERE pr.id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such payment %', p_payment_id USING ERRCODE = 'no_data_found';
  END IF;
  IF lms.actor_role() <> 'Admin' AND NOT lms.actor_can_see_province(v_pay.province_code) THEN
    RAISE EXCEPTION 'payment % is outside your province access', v_pay.code
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_pay.stage_code IN ('Cancelled','Stopped') THEN
    RAISE EXCEPTION 'payment % is % and cannot be allocated', v_pay.code, v_pay.stage_code
      USING ERRCODE = 'raise_exception';
  END IF;

  SELECT coalesce(sum(amount),0) INTO v_allocated
  FROM lms.payment_allocation WHERE payment_id = p_payment_id;
  IF v_allocated + p_amount > v_pay.net_amount THEN
    RAISE EXCEPTION 'allocating % would exceed the net payable on % (% already allocated of %)',
      p_amount, v_pay.code, v_allocated, v_pay.net_amount USING ERRCODE = 'raise_exception';
  END IF;

  v_liab := api.case_liability(p_case_id);
  IF v_liab.allocated_amount + p_amount > v_liab.approved_amount THEN
    RAISE EXCEPTION 'allocating % would exceed the approved compensation on % (% of % already allocated)',
      p_amount, v_liab.case_code, v_liab.allocated_amount, v_liab.approved_amount
      USING ERRCODE = 'raise_exception';
  END IF;

  INSERT INTO lms.payment_allocation (payment_id, case_id, landowner_id, amount, note, created_by)
  VALUES (p_payment_id, p_case_id, p_landowner_id, p_amount, p_note, v_actor)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- ---------------------------------------------------------------------
-- Reconciliation. Reports, never corrects.
-- ---------------------------------------------------------------------
CREATE FUNCTION api.reconcile(
         p_scope      text DEFAULT 'all',
         p_scope_ref  uuid DEFAULT NULL,
         p_as_of      date DEFAULT current_date)
  RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_actor uuid := util.require_actor(); v_run uuid; v_n integer;
BEGIN
  INSERT INTO lms.reconciliation_run (scope, scope_ref, as_of, run_by)
  VALUES (p_scope, p_scope_ref, p_as_of, v_actor) RETURNING id INTO v_run;

  -- 1. A case whose stored totals disagree with its lines. This is the check
  --    that would catch a trigger having been disabled, or a direct UPDATE.
  INSERT INTO lms.reconciliation_exception
    (run_id, kind, severity, entity, entity_id, entity_code, province_code,
     expected, actual, difference, detail)
  SELECT v_run, 'case_total_vs_lines', 'error', 'compensation_case', c.id, c.code, c.province_code,
         t.total_amount, c.total_amount, c.total_amount - t.total_amount,
         'stored case total does not match the sum of its lines'
  FROM lms.compensation_case c
  CROSS JOIN LATERAL api.case_totals(c.id) t
  WHERE c.stage_code NOT IN ('Cancelled','Stopped')
    AND c.total_amount <> t.total_amount
    AND (p_scope <> 'case' OR c.id = p_scope_ref)
    AND (p_scope <> 'project' OR c.project_id = p_scope_ref);

  -- 2. Released more against a case than was approved.
  INSERT INTO lms.reconciliation_exception
    (run_id, kind, severity, entity, entity_id, entity_code, province_code,
     expected, actual, difference, detail)
  SELECT v_run, 'over_released', 'error', 'compensation_case', l.case_id, l.case_code, c.province_code,
         l.approved_amount, l.released_amount, l.released_amount - l.approved_amount,
         'released against this case exceeds the approved compensation'
  FROM lms.compensation_case c
  CROSS JOIN LATERAL api.case_liability(c.id) l
  WHERE l.released_amount > l.approved_amount
    AND (p_scope <> 'case' OR c.id = p_scope_ref)
    AND (p_scope <> 'project' OR c.project_id = p_scope_ref);

  -- 3. A voucher marked Released with no release row, or the reverse. Either
  --    direction means the stage label and the ledger have come apart.
  INSERT INTO lms.reconciliation_exception
    (run_id, kind, severity, entity, entity_id, entity_code, province_code, detail)
  SELECT v_run, 'stage_without_release', 'error', 'payment_request', pr.id, pr.code, pr.province_code,
         'voucher stage is Released but there is no release row'
  FROM lms.payment_request pr
  WHERE pr.stage_code = 'Released'
    AND NOT EXISTS (SELECT 1 FROM lms.payment_release r WHERE r.payment_id = pr.id);

  INSERT INTO lms.reconciliation_exception
    (run_id, kind, severity, entity, entity_id, entity_code, province_code, detail)
  SELECT v_run, 'release_without_stage', 'error', 'payment_request', pr.id, pr.code, pr.province_code,
         format('a release exists but the voucher stage is %s', pr.stage_code)
  FROM lms.payment_release r
  JOIN lms.payment_request pr ON pr.id = r.payment_id
  WHERE pr.stage_code <> 'Released';

  -- 4. Released amount not equal to the voucher's net payable.
  INSERT INTO lms.reconciliation_exception
    (run_id, kind, severity, entity, entity_id, entity_code, province_code,
     expected, actual, difference, detail)
  SELECT v_run, 'release_amount_mismatch', 'error', 'payment_release', r.id, pr.code, pr.province_code,
         pr.net_amount, r.released_amount, r.released_amount - pr.net_amount,
         'released amount differs from the voucher net payable'
  FROM lms.payment_release r
  JOIN lms.payment_request pr ON pr.id = r.payment_id
  WHERE r.released_amount <> pr.net_amount;

  -- 5. Ownership shares over 100% on a parcel.
  INSERT INTO lms.reconciliation_exception
    (run_id, kind, severity, entity, entity_id, entity_code, province_code,
     expected, actual, difference, detail)
  SELECT v_run, 'ownership_over_100', 'error', 'survey', s.id, s.code, s.province_code,
         100, tot.share_total, tot.share_total - 100,
         'ownership shares on this parcel exceed 100%'
  FROM lms.survey s
  CROSS JOIN LATERAL (SELECT api.ownership_share_total(s.id) AS share_total) tot
  WHERE tot.share_total > 100;

  -- 6. Committed lease area exceeding the parcel.
  INSERT INTO lms.reconciliation_exception
    (run_id, kind, severity, entity, entity_id, entity_code, province_code,
     expected, actual, difference, detail)
  SELECT v_run, 'area_over_committed', 'error', 'survey', s.id, s.code, s.province_code,
         v.total_area, v.committed_area, v.committed_area - v.total_area,
         v.detail
  FROM lms.survey s
  CROSS JOIN LATERAL api.validate_survey_area(s.id) v
  WHERE NOT v.is_valid;

  -- 7. Budget overspend, as a warning: a sanctioned overrun is a management
  --    decision, not a data error.
  INSERT INTO lms.reconciliation_exception
    (run_id, kind, severity, entity, entity_id, entity_code, province_code,
     expected, actual, difference, detail)
  SELECT v_run, 'budget_exceeded', 'warning', 'budget', b.id, b.code, b.province_code,
         b.approved_amount, b.approved_amount - pos.balance_amount, -pos.balance_amount,
         format('project is over its %s budget by %s', b.fiscal_year, -pos.balance_amount)
  FROM lms.budget b
  CROSS JOIN LATERAL api.budget_status(b.project_id, b.fiscal_year) pos
  WHERE pos.balance_amount < 0;

  SELECT count(*) INTO v_n FROM lms.reconciliation_exception WHERE run_id = v_run;
  UPDATE lms.reconciliation_run
     SET finished_at = clock_timestamp(), exception_count = v_n
   WHERE id = v_run;
  RETURN v_run;
END $$;
COMMENT ON FUNCTION api.reconcile(text,uuid,date) IS
  'Runs every reconciliation check and records what it found. It writes no '
  'financial record: a mismatch becomes an exception for a person to decide '
  'on. Silently repairing financial history is how an error stops being auditable.';

-- ---------------------------------------------------------------------
-- api.apply_mutation — move the shares, keep the history.
--
-- Called by api.advance_workflow() on the final approval and not otherwise.
-- One transaction: the transferor's holding is closed out, the heirs' holdings
-- are opened, and the ownership history records both. If any part fails, the
-- approval fails with it and nobody's ownership has changed.
-- ---------------------------------------------------------------------
CREATE FUNCTION api.apply_mutation(p_mutation_id uuid) RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_actor uuid := util.require_actor();
  m       record;
  s       record;
  h       record;
  v_src   numeric;
  v_moved integer := 0;
BEGIN
  SELECT * INTO m FROM lms.mutation WHERE id = p_mutation_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such mutation %', p_mutation_id USING ERRCODE = 'no_data_found';
  END IF;

  FOR s IN SELECT ms.survey_id FROM lms.mutation_survey ms WHERE ms.mutation_id = p_mutation_id
  LOOP
    -- The transferor's share of this parcel is what gets divided.
    SELECT share_pct INTO v_src
    FROM lms.survey_ownership_share
    WHERE survey_id = s.survey_id AND landowner_id = m.transferor_id
    FOR UPDATE;
    IF v_src IS NULL THEN
      RAISE EXCEPTION 'the transferor holds no share of parcel % to transfer', s.survey_id
        USING ERRCODE = 'raise_exception';
    END IF;

    INSERT INTO lms.survey_ownership_history
      (survey_id, landowner_id, share_pct, valid_from, valid_to, change_reason,
       mutation_id, recorded_by)
    VALUES (s.survey_id, m.transferor_id, v_src,
            coalesce(m.mutation_date, current_date), coalesce(m.mutation_date, current_date),
            m.mutation_type || ' — transferred out', p_mutation_id, v_actor);

    DELETE FROM lms.survey_ownership_share
    WHERE survey_id = s.survey_id AND landowner_id = m.transferor_id;

    FOR h IN SELECT landowner_id, share_pct FROM lms.mutation_heir WHERE mutation_id = p_mutation_id
    LOOP
      -- Heir shares are a percentage of the transferor's share, not of the
      -- parcel, so they are scaled. Rounded to 4 dp, the precision of the
      -- share domain; the residue is documented in the engineering report.
      INSERT INTO lms.survey_ownership_share
        (survey_id, landowner_id, share_pct, revenue_doc_ref, effective_from, created_by, updated_by)
      VALUES (s.survey_id, h.landowner_id, round(v_src * h.share_pct / 100, 4),
              m.revenue_mutation_no, coalesce(m.mutation_date, current_date), v_actor, v_actor)
      ON CONFLICT (survey_id, landowner_id) DO UPDATE
        SET share_pct = lms.survey_ownership_share.share_pct
                        + round(v_src * h.share_pct / 100, 4),
            updated_by = v_actor, updated_at = clock_timestamp();

      INSERT INTO lms.survey_ownership_history
        (survey_id, landowner_id, share_pct, valid_from, change_reason, mutation_id, recorded_by)
      VALUES (s.survey_id, h.landowner_id, round(v_src * h.share_pct / 100, 4),
              coalesce(m.mutation_date, current_date),
              m.mutation_type || ' — received', p_mutation_id, v_actor);
      v_moved := v_moved + 1;
    END LOOP;
  END LOOP;

  -- An inheritance marks the transferor deceased; a sale leaves their record
  -- active, because they may still own other parcels.
  IF m.mutation_type = 'Inheritance (Virasat)' THEN
    UPDATE lms.landowner SET status = 'Deceased', updated_by = v_actor
    WHERE id = m.transferor_id AND status <> 'Deceased';
  END IF;

  RETURN v_moved;
END $$;
COMMENT ON FUNCTION api.apply_mutation(uuid) IS
  'Transfers ownership on final mutation approval, inside the approving '
  'transaction. SECURITY DEFINER: it writes lms.survey_ownership_history, '
  'which the application role cannot insert into, so an ownership transfer '
  'cannot be recorded without its history.';
