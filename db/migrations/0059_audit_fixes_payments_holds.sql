-- =====================================================================
-- 0059  Fixes from the 2026-10-31 end-to-end audit (payments, holds, cases)
-- =====================================================================
-- Report: docs/reports/E2E_AUDIT_2026-10-31.md
--
-- 1. api.request_payment
--    a. A voucher on a compensation case or a lease names the landowner it
--       pays (landowner_id). A typed payee name skipped the policy WHT rate
--       and every landowner hold.
--    b. A deceased landowner is not paid (until Wirasat / Intiqal).
--    c. Vouchers on a case cannot add up to more than the case's payable
--       award (approved total + adjustments), counting every voucher not
--       reversed. Before, 120,000 could be raised and 40,000 released
--       against a 50,000 award.
-- 2. lms.wf_guard_payments: the deceased check again at verification and
--    release (the owner may die after the voucher is raised).
-- 3. lms.hold_for
--    a. A lease on hold holds its vouchers (the hold route said so; nothing did).
--    b. A stay order on a parcel (scope 'survey') holds crop, tree and
--       miscellaneous lines and DBPFC estimates on that parcel, not only lease lines.
-- 4. lms.tg_receipt_sod: no receipt on a reversed cheque.
-- 5. lms.wf_guard_cases: a case needs at least one landowner before Field / HO approval.
-- 6. Reversed releases no longer count as paid in api.v_landowner_summary
--    (paid_to_date), api.v_project_land_status and api.v_province_summary
--    (released_amount). api.v_payment_release gains reversed_at, which the
--    Payments page already reads.

SET ROLE lms_owner;
SELECT set_config('lms.actor_id', '00000000-0000-0000-0000-000000000001', false);

-- ---------------------------------------------------------------------
-- 1. request_payment: payee, deceased owner, case cap (wraps the existing body)
-- ---------------------------------------------------------------------
ALTER FUNCTION api.request_payment(text, uuid, text, text, date, numeric, text, uuid, text, uuid, uuid, uuid, date, numeric, text, text)
  RENAME TO request_payment_core;
REVOKE ALL ON FUNCTION api.request_payment_core(text, uuid, text, text, date, numeric, text, uuid, text, uuid, uuid, uuid, date, numeric, text, text) FROM PUBLIC, lms_readwrite;

CREATE FUNCTION api.request_payment(p_idempotency_key text, p_project_id uuid, p_category text, p_pay_type text, p_period_from date,
  p_gross_amount numeric, p_payment_mode text, p_landowner_id uuid DEFAULT NULL::uuid, p_payee_name text DEFAULT NULL::text,
  p_case_id uuid DEFAULT NULL::uuid, p_lease_id uuid DEFAULT NULL::uuid, p_dbpfc_id uuid DEFAULT NULL::uuid,
  p_period_to date DEFAULT NULL::date, p_wht_pct numeric DEFAULT NULL::numeric, p_land_class text DEFAULT NULL::text,
  p_remarks text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  v_status  text;
  v_payable numeric;
  v_raised  numeric;
  v_code    text;
  v_prov    char(3);
  v_valid_case  boolean;
  v_valid_lease boolean;
BEGIN
  -- A replay of an idempotency key returns the original voucher untouched.
  IF EXISTS (SELECT 1 FROM lms.idempotency_key k WHERE k.key = p_idempotency_key) THEN
    RETURN api.request_payment_core(p_idempotency_key, p_project_id, p_category, p_pay_type, p_period_from, p_gross_amount,
      p_payment_mode, p_landowner_id, p_payee_name, p_case_id, p_lease_id, p_dbpfc_id, p_period_to, p_wht_pct, p_land_class, p_remarks);
  END IF;

  -- The new rules apply only to a case / lease the core would accept (approved, this
  -- project's province); anything else falls through so the core gives its own answer.
  SELECT p.province_code INTO v_prov FROM lms.project p WHERE p.id = p_project_id;
  v_valid_case := p_case_id IS NOT NULL AND EXISTS (SELECT 1 FROM lms.compensation_case c
                    WHERE c.id = p_case_id AND c.stage_code = 'HO Approved' AND c.province_code = v_prov AND c.project_id = p_project_id);
  v_valid_lease := p_lease_id IS NOT NULL AND EXISTS (SELECT 1 FROM lms.lease l
                    WHERE l.id = p_lease_id AND l.province_code = v_prov AND l.project_id = p_project_id);
  IF NOT coalesce(lms.actor_role() = 'Admin' OR lms.actor_can_see_province(v_prov), false) THEN
    v_valid_case := false; v_valid_lease := false;
  END IF;

  IF (v_valid_case OR v_valid_lease) AND p_landowner_id IS NULL THEN
    RAISE EXCEPTION 'a payment on a compensation case or a lease must name the landowner it pays (choose the payee from the owners)'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_landowner_id IS NOT NULL THEN
    SELECT lo.status INTO v_status FROM lms.landowner lo WHERE lo.id = p_landowner_id;
    IF v_status = 'Deceased' THEN
      RAISE EXCEPTION 'the landowner is recorded as deceased: payment waits for the Wirasat / Intiqal mutation'
        USING ERRCODE = 'raise_exception';
    END IF;
  END IF;

  IF v_valid_case THEN
    -- Serialise vouchers on one case so two concurrent requests cannot both pass the cap.
    PERFORM 1 FROM lms.compensation_case c WHERE c.id = p_case_id FOR UPDATE;
    SELECT m.payable_amount, m.case_code INTO v_payable, v_code FROM lms.case_money m WHERE m.case_id = p_case_id;
    SELECT coalesce(sum(pr.gross_amount), 0) INTO v_raised
      FROM lms.payment_request pr
     WHERE pr.case_id = p_case_id
       AND NOT EXISTS (SELECT 1 FROM lms.payment_release rel JOIN lms.payment_release_reversal rv ON rv.release_id = rel.id
                        WHERE rel.payment_id = pr.id);
    IF v_payable IS NOT NULL AND v_raised + p_gross_amount > v_payable THEN
      RAISE EXCEPTION 'case % award is % and vouchers of % are already raised against it; at most % can still be requested',
        v_code, v_payable, v_raised, greatest(v_payable - v_raised, 0) USING ERRCODE = 'raise_exception';
    END IF;
  END IF;

  RETURN api.request_payment_core(p_idempotency_key, p_project_id, p_category, p_pay_type, p_period_from, p_gross_amount,
    p_payment_mode, p_landowner_id, p_payee_name, p_case_id, p_lease_id, p_dbpfc_id, p_period_to, p_wht_pct, p_land_class, p_remarks);
END $function$;
REVOKE ALL ON FUNCTION api.request_payment(text, uuid, text, text, date, numeric, text, uuid, text, uuid, uuid, uuid, date, numeric, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.request_payment(text, uuid, text, text, date, numeric, text, uuid, text, uuid, uuid, uuid, date, numeric, text, text) TO lms_readwrite;

-- ---------------------------------------------------------------------
-- 2. Deceased payee at verification and release
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION lms.wf_guard_payments(p_id uuid, p_to text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE p record; h record; b record;
BEGIN
  SELECT pr.id, pr.project_id, pr.period_from, lo.status AS payee_status, lo.full_name AS payee_name
    INTO p FROM lms.payment_request pr LEFT JOIN lms.landowner lo ON lo.id = pr.landowner_id WHERE pr.id = p_id;

  SELECT x.hold_id, x.reason, lc.code AS legal_code, lc.court_case_no
  INTO h
  FROM lms.payment_active_hold(p_id) x
  LEFT JOIN lms.legal_case lc ON lc.id = x.legal_case_id;
  IF h.hold_id IS NOT NULL THEN
    RETURN format('Payment is on hold: %s%s', h.reason,
      CASE WHEN h.legal_code IS NOT NULL
           THEN format(' (%s, court case %s)', h.legal_code, h.court_case_no) ELSE '' END);
  END IF;

  IF p.payee_status = 'Deceased' THEN
    RETURN format('%s is recorded as deceased: payment waits for the Wirasat / Intiqal mutation.', p.payee_name);
  END IF;

  IF p_to = 'Verified' THEN
    SELECT * INTO b FROM api.budget_status(p.project_id, extract(year from p.period_from)::integer);
    IF b.approved_amount IS NOT NULL AND b.balance_amount < 0 THEN
      RETURN format('Budget check failed: this voucher would take the %s budget over by %s.',
                    b.fiscal_year, -b.balance_amount);
    END IF;
  END IF;
  RETURN NULL;
END $function$;

-- ---------------------------------------------------------------------
-- 3. Holds: held lease; stay order on a parcel reaches every line kind
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION lms.hold_for(p_payment uuid, p_case uuid, p_landowner uuid, p_project uuid, p_lease uuid)
 RETURNS TABLE(hold_id uuid, reason text, legal_case_id uuid, placed_at timestamp with time zone)
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT h.id, h.reason, h.legal_case_id, h.placed_at
  FROM lms.payment_hold h
  WHERE h.lifted_at IS NULL AND (
       (h.scope = 'payment'   AND h.payment_id   = p_payment)
    OR (h.scope = 'case'      AND h.case_id      = p_case)
    OR (h.scope = 'landowner' AND h.landowner_id = p_landowner)
    OR (h.scope = 'project'   AND h.project_id   = p_project)
    OR (h.scope = 'survey'    AND (
            EXISTS (SELECT 1 FROM lms.case_lease_line l WHERE l.case_id = p_case AND l.survey_id = h.survey_id)
         OR EXISTS (SELECT 1 FROM lms.case_crop_line l  WHERE l.case_id = p_case AND l.survey_id = h.survey_id)
         OR EXISTS (SELECT 1 FROM lms.case_tree_line l  WHERE l.case_id = p_case AND l.survey_id = h.survey_id)
         OR EXISTS (SELECT 1 FROM lms.case_misc_line l  WHERE l.case_id = p_case AND l.survey_id = h.survey_id)
         OR EXISTS (SELECT 1 FROM lms.lease_survey ls  WHERE ls.lease_id = p_lease AND ls.survey_id = h.survey_id)
         OR EXISTS (SELECT 1 FROM lms.payment_request pr JOIN lms.dbpfc_survey ds ON ds.dbpfc_id = pr.dbpfc_id
                     WHERE pr.id = p_payment AND ds.survey_id = h.survey_id))))
  UNION ALL
  -- A lease on hold (leases/[id]/hold) holds every voucher on it.
  SELECT l.id, coalesce('Lease ' || l.code || ' is on hold: ' || l.hold_reason, 'Lease ' || l.code || ' is on hold'), NULL::uuid, l.hold_placed_at
  FROM lms.lease l WHERE l.id = p_lease AND l.is_on_hold;
$function$;

-- ---------------------------------------------------------------------
-- 4. No receipt on a reversed cheque
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION lms.tg_receipt_sod()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE r record;
BEGIN
  IF pg_has_role(current_user, 'lms_owner', 'MEMBER') THEN RETURN NEW; END IF;
  SELECT pr.created_by, rel.released_by, pr.code INTO r
  FROM lms.payment_release rel JOIN lms.payment_request pr ON pr.id = rel.payment_id
  WHERE rel.id = NEW.release_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the release was not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF EXISTS (SELECT 1 FROM lms.payment_release_reversal rv WHERE rv.release_id = NEW.release_id) THEN
    RAISE EXCEPTION 'cheque for voucher % was reversed: no receipt can be recorded against it', r.code
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  NEW.recorded_by := util.actor_id();
  IF NEW.recorded_by = r.created_by OR NEW.recorded_by = r.released_by THEN
    RAISE EXCEPTION 'segregation of duties: the person who raised or released voucher % cannot also record its receipt', r.code
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $function$;

-- ---------------------------------------------------------------------
-- 5. A case needs its landowners before approval
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION lms.wf_guard_cases(p_id uuid, p_to text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE v_missing text[]; v_has_attorney boolean; v_total numeric;
BEGIN
  IF p_to NOT IN ('Field Approved','HO Approved') THEN RETURN NULL; END IF;

  SELECT total_amount INTO v_total FROM lms.compensation_case WHERE id = p_id;
  IF coalesce(v_total,0) <= 0 THEN
    RETURN 'Case has no compensation amount — add lease, crop, tree or miscellaneous lines.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM lms.case_owner WHERE case_id = p_id) THEN
    RETURN 'Case has no landowners — add the owners (payees) and their shares.';
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
END $function$;

-- ---------------------------------------------------------------------
-- 6. Reversed releases are not "paid"; v_payment_release shows reversed_at
-- ---------------------------------------------------------------------
DO $$
DECLARE
  v text; n text;
  not_rev constant text := ' AND NOT EXISTS (SELECT 1 FROM lms.payment_release_reversal rvx WHERE rvx.release_id = %s.id)';
BEGIN
  -- v_landowner_summary.paid_to_date
  v := pg_get_viewdef('api.v_landowner_summary'::regclass);
  n := replace(v, 'WHERE (pr.landowner_id = lo.id)), (0)::numeric))::numeric(18,2) AS paid_to_date',
                  'WHERE (pr.landowner_id = lo.id)' || format(not_rev, 'r') || '), (0)::numeric))::numeric(18,2) AS paid_to_date');
  IF n = v THEN RAISE EXCEPTION '0059: v_landowner_summary pattern not found'; END IF;
  EXECUTE 'CREATE OR REPLACE VIEW api.v_landowner_summary WITH (security_invoker = true) AS ' || n;

  -- v_project_land_status.released_amount
  v := pg_get_viewdef('api.v_project_land_status'::regclass);
  n := replace(v, 'JOIN payment_request pq ON ((pq.id = rel.payment_id)))
          GROUP BY pq.project_id) rl',
                  'JOIN payment_request pq ON ((pq.id = rel.payment_id)))
          WHERE true' || format(not_rev, 'rel') || '
          GROUP BY pq.project_id) rl');
  IF n = v THEN RAISE EXCEPTION '0059: v_project_land_status pattern not found'; END IF;
  EXECUTE 'CREATE OR REPLACE VIEW api.v_project_land_status WITH (security_invoker = true) AS ' || n;

  -- v_province_summary.released_amount
  v := pg_get_viewdef('api.v_province_summary'::regclass);
  n := replace(v, 'WHERE (r.province_code = pv.code)) AS released_amount',
                  'WHERE (r.province_code = pv.code)' || format(not_rev, 'r') || ') AS released_amount');
  IF n = v THEN RAISE EXCEPTION '0059: v_province_summary pattern not found'; END IF;
  EXECUTE 'CREATE OR REPLACE VIEW api.v_province_summary WITH (security_invoker = true) AS ' || n;

  -- v_payment_release: + reversed_at (appended column)
  v := pg_get_viewdef('api.v_payment_release'::regclass);
  n := replace(v, 'l.code AS lease_code
   FROM', 'l.code AS lease_code,
    ( SELECT rvx.reversed_at FROM lms.payment_release_reversal rvx WHERE rvx.release_id = r.id LIMIT 1) AS reversed_at
   FROM');
  IF n = v THEN RAISE EXCEPTION '0059: v_payment_release pattern not found'; END IF;
  EXECUTE 'CREATE OR REPLACE VIEW api.v_payment_release WITH (security_invoker = true) AS ' || n;
END $$;

-- ---------------------------------------------------------------------
-- 7. Land request resubmitted after a return: the tiers decide again, so the
--    requester's SUBMIT clears all three tier stamps (history stays in audit).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION lms.tg_land_request_tier()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE v_groups text[]; v_actor uuid := util.actor_id();
BEGIN
  IF pg_has_role(session_user, 'lms_owner', 'MEMBER') THEN RETURN NEW; END IF;
  IF OLD.stage_code = 'Returned' AND NEW.stage_code = 'Submitted' AND NEW.created_by = v_actor
     AND NEW.director_ops_id IS NULL AND NEW.regional_mgr_id IS NULL AND NEW.land_affairs_id IS NULL THEN
    RETURN NEW;
  END IF;
  -- Identity administration and business approval stay apart (as 0041 does for workflow positions).
  IF v_actor IS NULL OR iam.holds_system_admin(v_actor) THEN
    RAISE EXCEPTION 'separation of duties: a system administrator does not decide land requests'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  v_groups := lms.actor_groups();
  IF NEW.director_ops_id IS DISTINCT FROM OLD.director_ops_id
     AND (NEW.director_ops_id IS DISTINCT FROM v_actor OR NOT ('Director Operations' = ANY (v_groups))) THEN
    RAISE EXCEPTION 'the Director Operations tier is decided by a holder of that position, in their own name'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.regional_mgr_id IS DISTINCT FROM OLD.regional_mgr_id
     AND (NEW.regional_mgr_id IS DISTINCT FROM v_actor OR NOT ('Regional Manager' = ANY (v_groups))) THEN
    RAISE EXCEPTION 'the Regional Manager tier is decided by a holder of that position, in their own name'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.land_affairs_id IS DISTINCT FROM OLD.land_affairs_id
     AND (NEW.land_affairs_id IS DISTINCT FROM v_actor OR NOT ('DM / TL Land Affairs' = ANY (v_groups))) THEN
    RAISE EXCEPTION 'the Land Affairs tier is decided by a holder of that position, in their own name'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $function$;

RESET ROLE;
