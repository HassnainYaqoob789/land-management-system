-- =====================================================================
-- 0011  Workflow transitions and the per-workflow guards
-- =====================================================================
SET ROLE lms_owner;

-- ---------------------------------------------------------------------
-- Guards. One function per workflow, named by convention so the generic
-- transition routine can find it. Each returns NULL to allow the transition or
-- a sentence explaining the refusal.
--
-- These are the rules that cannot be CHECK constraints because they involve
-- counting rows in other tables (are all the required documents ticked? is the
-- budget sufficient? is there a stay order?). They are deliberately not
-- authorisation rules: who may approve is the matrix's job, below.
-- ---------------------------------------------------------------------
CREATE FUNCTION lms.wf_guard_cases(p_id uuid, p_to text) RETURNS text
  LANGUAGE plpgsql STABLE
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_missing text[]; v_has_attorney boolean; v_total numeric;
BEGIN
  IF p_to NOT IN ('Field Approved','HO Approved') THEN RETURN NULL; END IF;

  SELECT total_amount INTO v_total FROM lms.compensation_case WHERE id = p_id;
  IF coalesce(v_total,0) <= 0 THEN
    RETURN 'Case has no compensation amount — add lease, crop, tree or miscellaneous lines.';
  END IF;

  -- Power-of-attorney documents are only required when an attorney is a payee.
  SELECT EXISTS (SELECT 1 FROM lms.case_owner WHERE case_id = p_id AND owner_status <> 'O')
  INTO v_has_attorney;

  SELECT array_agg(i.name ORDER BY i.display_order) INTO v_missing
  FROM lms.case_document_item i
  WHERE (i.required_when = 'always' OR (i.required_when = 'attorney_present' AND v_has_attorney))
    AND NOT EXISTS (SELECT 1 FROM lms.case_document_check c
                    WHERE c.case_id = p_id AND c.item_code = i.code);
  IF v_missing IS NOT NULL THEN
    RETURN 'Missing documents: ' || array_to_string(v_missing, '; ');
  END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION lms.wf_guard_acquisitions(p_id uuid, p_to text) RETURNS text
  LANGUAGE plpgsql STABLE
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_seq smallint; v_missing text[];
BEGIN
  SELECT seq INTO v_seq FROM lms.workflow_stage
   WHERE workflow_code = 'acquisitions' AND code = p_to;
  -- Title validation gates the Acquisition / Lease stage onwards (seq >= 3).
  IF coalesce(v_seq, 0) < 3 THEN RETURN NULL; END IF;

  SELECT array_agg(i.name ORDER BY i.display_order) INTO v_missing
  FROM lms.title_check_item i
  WHERE i.is_mandatory
    AND NOT EXISTS (SELECT 1 FROM lms.acquisition_title_check c
                    WHERE c.acquisition_id = p_id AND c.item_code = i.code);
  IF v_missing IS NOT NULL THEN
    RETURN 'Title validation incomplete: ' || array_to_string(v_missing, '; ');
  END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION lms.wf_guard_dbpfc(p_id uuid, p_to text) RETURNS text
  LANGUAGE plpgsql STABLE
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v numeric;
BEGIN
  IF p_to <> 'Rate Fixed' THEN RETURN NULL; END IF;
  SELECT fixed_rate INTO v FROM lms.dbpfc_estimate WHERE id = p_id;
  IF coalesce(v,0) <= 0 THEN
    RETURN 'Enter the DBPFC fixed rate before marking the rate as fixed.';
  END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION lms.wf_guard_mutations(p_id uuid, p_to text) RETURNS text
  LANGUAGE plpgsql STABLE
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_share numeric; v_n integer;
BEGIN
  IF p_to <> 'Approved & Applied' THEN RETURN NULL; END IF;
  SELECT count(*), coalesce(sum(share_pct),0) INTO v_n, v_share
  FROM lms.mutation_heir WHERE mutation_id = p_id;
  IF v_n = 0 THEN RETURN 'Add at least one heir or transferee.'; END IF;
  IF v_share <> 100 THEN
    RETURN format('Heir shares total %s%%, not 100%%.', v_share);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM lms.mutation_survey WHERE mutation_id = p_id) THEN
    RETURN 'Select the holdings to transfer.';
  END IF;
  RETURN NULL;
END $$;

-- Payments: a stay order blocks the transition outright, and the Verified step
-- additionally checks the project's budget for the period's year.
CREATE FUNCTION lms.wf_guard_payments(p_id uuid, p_to text) RETURNS text
  LANGUAGE plpgsql STABLE
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE p record; h record; b record;
BEGIN
  SELECT pr.id, pr.landowner_id, pr.case_id, pr.project_id, pr.net_amount, pr.period_from
  INTO p FROM lms.payment_request pr WHERE pr.id = p_id;

  SELECT ph.id, ph.reason, lc.code AS legal_code, lc.court_case_no
  INTO h
  FROM lms.payment_hold ph
  LEFT JOIN lms.legal_case lc ON lc.id = ph.legal_case_id
  WHERE ph.lifted_at IS NULL
    AND (   (ph.scope = 'landowner' AND ph.landowner_id = p.landowner_id)
         OR (ph.scope = 'case'      AND ph.case_id      = p.case_id)
         OR (ph.scope = 'payment'   AND ph.payment_id   = p.id)
         OR (ph.scope = 'project'   AND ph.project_id   = p.project_id)
         OR (ph.scope = 'survey'    AND ph.survey_id IN (
               SELECT l.survey_id FROM lms.case_lease_line l WHERE l.case_id = p.case_id)))
  LIMIT 1;
  IF h.id IS NOT NULL THEN
    RETURN format('Payment is on hold: %s%s', h.reason,
      CASE WHEN h.legal_code IS NOT NULL
           THEN format(' (%s, court case %s)', h.legal_code, h.court_case_no) ELSE '' END);
  END IF;

  IF p_to = 'Verified' THEN
    SELECT * INTO b FROM api.budget_status(p.project_id,
                                           extract(year from p.period_from)::integer);
    IF b.approved_amount IS NOT NULL AND b.balance_amount < p.net_amount THEN
      RETURN format('Budget check failed: releasing %s would exceed the approved budget for %s (balance %s).',
                    p.net_amount, b.fiscal_year, b.balance_amount);
    END IF;
  END IF;
  RETURN NULL;
END $$;
COMMENT ON FUNCTION lms.wf_guard_payments(uuid,text) IS
  'Stay orders and the budget check. Both read other tables and so cannot be '
  'CHECK constraints; the no-double-release rule, which can be a constraint, is one.';

-- ---------------------------------------------------------------------
-- api.advance_workflow — the one way a record changes stage.
--
-- Transaction boundaries: the caller's transaction. Everything this routine
-- does — the stage change, the transition row, the assignment hand-off, the
-- audit event and any entity side effect — either all commits or none does.
-- The record is locked FOR UPDATE first, so two approvers clicking at once
-- serialise rather than both recording an approval of the same stage.
--
-- Failure behaviour: raises. Nothing is partially applied, and the message is
-- the one the user should see.
-- ---------------------------------------------------------------------
CREATE FUNCTION api.advance_workflow(
         p_workflow   text,
         p_record_id  uuid,
         p_to_stage   text DEFAULT NULL,   -- NULL = the next stage in sequence
         p_note       text DEFAULT NULL,
         p_as_group   text DEFAULT NULL)
  RETURNS text
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  w            record;
  v_code       lms.record_code;
  v_province   char(3);
  v_stage      text;
  v_created_by uuid;
  v_actor      uuid := util.require_actor();
  v_role       text := lms.actor_role();
  v_groups     text[] := lms.actor_groups();
  v_to         text;
  v_to_seq     smallint;
  v_from_seq   smallint;
  v_is_terminal boolean;
  v_required   text[];
  v_guard      text;
  v_guard_fn   text;
  v_acted_group text;
  v_sod        text;
  v_admin_override boolean;
BEGIN
  SELECT * INTO w FROM lms.workflow WHERE code = p_workflow;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown workflow %', p_workflow USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Read and lock the record. The table name comes from lms.workflow, which no
  -- application role can write to, and is still passed through format(%I).
  EXECUTE format(
    'SELECT code, province_code, stage_code, created_by FROM lms.%I WHERE id = $1 FOR UPDATE',
    w.entity_table)
    INTO v_code, v_province, v_stage, v_created_by
    USING p_record_id;
  IF v_code IS NULL THEN
    RAISE EXCEPTION 'no such % record %', p_workflow, p_record_id USING ERRCODE = 'no_data_found';
  END IF;

  -- Province scope. SECURITY DEFINER bypasses row-level security, so the check
  -- that RLS would have made has to be made explicitly here. Leaving it out is
  -- exactly how a definer-rights routine becomes a way around the policies.
  IF v_role <> 'Admin' AND NOT lms.actor_can_see_province(v_province) THEN
    RAISE EXCEPTION 'record % is outside your province access', v_code
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_role = 'Viewer' THEN
    RAISE EXCEPTION 'the Viewer role is read-only' USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT seq, is_terminal INTO v_from_seq, v_is_terminal
  FROM lms.workflow_stage WHERE workflow_code = p_workflow AND code = v_stage;
  IF v_is_terminal THEN
    RAISE EXCEPTION 'record % is % and cannot move', v_code, v_stage USING ERRCODE = 'raise_exception';
  END IF;
  IF w.lock_at_stage IS NOT NULL AND v_stage = w.lock_at_stage THEN
    RAISE EXCEPTION 'record % is % and is locked', v_code, v_stage USING ERRCODE = 'raise_exception';
  END IF;

  -- Resolve the target stage.
  IF p_to_stage IS NULL THEN
    SELECT code, seq, is_terminal INTO v_to, v_to_seq, v_is_terminal
    FROM lms.workflow_stage
    WHERE workflow_code = p_workflow AND NOT is_terminal AND seq > v_from_seq
    ORDER BY seq LIMIT 1;
    IF v_to IS NULL THEN
      RAISE EXCEPTION 'record % is already at the final stage', v_code USING ERRCODE = 'raise_exception';
    END IF;
  ELSE
    SELECT code, seq, is_terminal INTO v_to, v_to_seq, v_is_terminal
    FROM lms.workflow_stage WHERE workflow_code = p_workflow AND code = p_to_stage;
    IF v_to IS NULL THEN
      RAISE EXCEPTION 'stage % does not belong to workflow %', p_to_stage, p_workflow
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    -- Forward one step, or sideways into a terminal stage. No skipping and no
    -- going back: a reopened record is a new decision, recorded as 'Reopened'
    -- by a separate routine, not by moving a stage pointer backwards.
    IF NOT v_is_terminal AND v_to_seq <> v_from_seq + 1 THEN
      RAISE EXCEPTION 'cannot move % from % to %: stages advance one at a time',
        v_code, v_stage, v_to USING ERRCODE = 'raise_exception';
    END IF;
    IF v_is_terminal THEN
      IF v_to = 'Cancelled' AND NOT w.allows_cancel THEN
        RAISE EXCEPTION '% records cannot be cancelled', p_workflow USING ERRCODE = 'raise_exception';
      END IF;
      IF v_to = 'Stopped' AND NOT w.allows_stop THEN
        RAISE EXCEPTION '% records cannot be stopped', p_workflow USING ERRCODE = 'raise_exception';
      END IF;
    END IF;
  END IF;

  -- The approval matrix: which positions may move a record into this stage.
  SELECT array_agg(group_code ORDER BY group_code) INTO v_required
  FROM lms.workflow_step_group WHERE workflow_code = p_workflow AND to_stage = v_to;

  SELECT (value ->> 0)::boolean INTO v_admin_override
  FROM lms.system_setting WHERE key = 'workflow.admin_override';
  v_admin_override := coalesce(v_admin_override, false);

  IF v_required IS NOT NULL AND array_length(v_required, 1) > 0 THEN
    IF p_as_group IS NOT NULL THEN
      IF NOT (p_as_group = ANY (v_required)) THEN
        RAISE EXCEPTION 'the % position does not approve the % step', p_as_group, v_to
          USING ERRCODE = 'insufficient_privilege';
      END IF;
      IF NOT (p_as_group = ANY (v_groups)) THEN
        RAISE EXCEPTION 'you do not hold the % position', p_as_group
          USING ERRCODE = 'insufficient_privilege';
      END IF;
      v_acted_group := p_as_group;
    ELSE
      SELECT g INTO v_acted_group FROM unnest(v_required) AS g
      WHERE g = ANY (v_groups) ORDER BY g LIMIT 1;
    END IF;

    IF v_acted_group IS NULL THEN
      IF v_role = 'Admin' AND v_admin_override THEN
        v_acted_group := NULL;   -- recorded as an administrative override below
      ELSE
        RAISE EXCEPTION 'the % step is for: %. You hold: %',
          v_to, array_to_string(v_required, ', '),
          CASE WHEN array_length(v_groups,1) > 0 THEN array_to_string(v_groups, ', ')
               ELSE 'no approval position' END
          USING ERRCODE = 'insufficient_privilege';
      END IF;
    END IF;
  END IF;

  -- Segregation of duties. Whoever prepared the record, and whoever already
  -- approved an earlier step of it, may not approve a later one. Terminal
  -- transitions (cancel, stop) are exempt: the preparer is normally the right
  -- person to withdraw their own record.
  v_sod := w.sod_mode;
  IF v_sod = 'strict' AND NOT v_is_terminal THEN
    IF v_created_by = v_actor THEN
      RAISE EXCEPTION 'segregation of duties: you prepared % and cannot also approve it', v_code
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF EXISTS (SELECT 1 FROM lms.workflow_transition t
               WHERE t.workflow_code = p_workflow AND t.record_id = p_record_id
                 AND t.acted_by = v_actor AND t.action = 'Advanced') THEN
      RAISE EXCEPTION 'segregation of duties: you already approved an earlier step of %', v_code
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  -- Entity-specific guard, if this workflow has one.
  v_guard_fn := 'lms.wf_guard_' || p_workflow;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'lms' AND p.proname = 'wf_guard_' || p_workflow) THEN
    EXECUTE format('SELECT %s($1,$2)', v_guard_fn) INTO v_guard USING p_record_id, v_to;
    IF v_guard IS NOT NULL THEN
      RAISE EXCEPTION '%', v_guard USING ERRCODE = 'raise_exception';
    END IF;
  END IF;

  -- Apply the stage change together with the timestamps that the entity's own
  -- CHECK constraints require at that stage. One statement, not two: the
  -- lock trigger refuses an edit to a record that is already at its locking
  -- stage, so setting approved_at afterwards would be refused by the very
  -- rule that is protecting the approved case.
  IF p_workflow = 'cases' AND v_to = 'HO Approved' THEN
    UPDATE lms.compensation_case
       SET stage_code = v_to, approved_at = clock_timestamp()
     WHERE id = p_record_id;
  ELSIF p_workflow = 'cases' AND v_to = 'Cancelled' THEN
    UPDATE lms.compensation_case
       SET stage_code = v_to, cancelled_at = clock_timestamp()
     WHERE id = p_record_id;
  ELSIF p_workflow = 'mutations' AND v_to = 'Approved & Applied' THEN
    UPDATE lms.mutation
       SET stage_code = v_to, applied_at = clock_timestamp()
     WHERE id = p_record_id;
    PERFORM api.apply_mutation(p_record_id);
  ELSE
    EXECUTE format('UPDATE lms.%I SET stage_code = $1 WHERE id = $2', w.entity_table)
      USING v_to, p_record_id;
    IF p_workflow = 'leases' AND v_to = 'Approved' THEN
      -- An approved lease is what blocks the parcel against a second lease.
      UPDATE lms.lease_survey SET is_blocking = true WHERE lease_id = p_record_id;
    END IF;
  END IF;

  INSERT INTO lms.workflow_transition
    (workflow_code, record_id, record_code, province_code, from_stage, to_stage,
     action, acted_by, acted_as_group, note)
  VALUES (p_workflow, p_record_id, v_code, v_province, v_stage, v_to,
          CASE v_to WHEN 'Cancelled' THEN 'Cancelled' WHEN 'Stopped' THEN 'Stopped'
                    ELSE 'Advanced' END,
          v_actor, v_acted_group,
          CASE WHEN v_acted_group IS NULL AND v_required IS NOT NULL
               THEN coalesce(p_note || ' · ', '') || 'administrative override'
               ELSE p_note END);

  -- Hand the record to the next queue.
  UPDATE lms.workflow_assignment SET closed_at = clock_timestamp()
  WHERE workflow_code = p_workflow AND record_id = p_record_id AND closed_at IS NULL;

  IF NOT v_is_terminal
     AND (w.lock_at_stage IS NULL OR v_to <> w.lock_at_stage) THEN
    INSERT INTO lms.workflow_assignment (workflow_code, record_id, stage_code, assigned_group)
    SELECT p_workflow, p_record_id, ns.code, sg.group_code
    FROM lms.workflow_stage ns
    JOIN lms.workflow_step_group sg
      ON sg.workflow_code = p_workflow AND sg.to_stage = ns.code
    WHERE ns.workflow_code = p_workflow AND NOT ns.is_terminal AND ns.seq = v_to_seq + 1
    ORDER BY sg.group_code LIMIT 1;
  END IF;

  INSERT INTO audit.audit_event
    (actor_id, actor_username, actor_role, entity, record_id, record_code, province_code,
     action, old_data, new_data, changed_fields, note)
  SELECT v_actor, u.username, u.role_code, w.entity_table, p_record_id, v_code, v_province,
         'TRANSITION',
         jsonb_build_object('stage_code', v_stage),
         jsonb_build_object('stage_code', v_to, 'acted_as_group', v_acted_group),
         ARRAY['stage_code'], p_note
  FROM lms.app_user u WHERE u.id = v_actor;

  RETURN v_to;
END $$;
COMMENT ON FUNCTION api.advance_workflow(text,uuid,text,text,text) IS
  'SECURITY DEFINER, and deliberately so: it must write lms.workflow_transition '
  'and audit.audit_event, which the application role has no INSERT privilege on, '
  'so that a workflow decision cannot be fabricated by an UPDATE. Because '
  'definer rights bypass row-level security, the routine re-checks province '
  'access itself before touching anything. search_path is pinned; every table '
  'is schema-qualified; the one dynamic identifier comes from lms.workflow, '
  'which no application role can write to, and is still passed through format(%I).';
