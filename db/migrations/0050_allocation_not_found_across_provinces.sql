-- =====================================================================
-- 0050  api.allocate_payment: a case in another province reads as not found
-- =====================================================================
-- 0042 (AUTHZ-15) answered an allocation to a case outside the voucher's
-- province with "not found" (P0002) and no record code. 0043 rewrote the
-- routine for the gross basis and lost that: it answered "voucher … belongs to
-- a different project or province than case CC-…" (P0001), and a caller
-- outside the case's provinces got "case CC-… is outside your province
-- access", disclosing the code of a record they may not see. Found by
-- db/tests/test_20 on 2026-10-30. Only those checks change; the gross-basis
-- logic of 0043 is kept exactly.

SET ROLE lms_owner;

CREATE OR REPLACE FUNCTION api.allocate_payment(p_payment_id uuid, p_case_id uuid, p_amount numeric, p_landowner_id uuid DEFAULT NULL::uuid, p_note text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := util.require_actor();
  v_pay   record;
  v_case  record;
  v_hold  record;
  v_allocated numeric;
  v_settles numeric;
  v_live numeric;
  v_payable numeric;
  v_owner record;
  v_id    uuid;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'allocation amount must be positive' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT pr.id, pr.code, pr.gross_amount, pr.net_amount, pr.province_code, pr.project_id, pr.case_id, pr.stage_code, pr.reversed_at
  INTO v_pay FROM lms.payment_request pr WHERE pr.id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such payment %', p_payment_id USING ERRCODE = 'no_data_found';
  END IF;
  IF lms.actor_role() <> 'Admin' AND NOT lms.actor_can_see_province(v_pay.province_code) THEN
    RAISE EXCEPTION 'payment is outside your province access' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_pay.stage_code IN ('Cancelled','Stopped') OR v_pay.reversed_at IS NOT NULL THEN
    RAISE EXCEPTION 'payment % is % and cannot be allocated', v_pay.code,
      CASE WHEN v_pay.reversed_at IS NOT NULL THEN 'reversed' ELSE v_pay.stage_code END
      USING ERRCODE = 'raise_exception';
  END IF;

  SELECT c.id, c.code, c.province_code, c.project_id, c.stage_code INTO v_case
  FROM lms.compensation_case c WHERE c.id = p_case_id FOR UPDATE;
  -- AUTHZ-15 (as in 0042): a case in another province than the voucher, or one the
  -- caller may not see, reads as not found, and its code is not disclosed.
  IF NOT FOUND OR v_case.province_code <> v_pay.province_code
     OR (lms.actor_role() <> 'Admin' AND NOT lms.actor_can_see_province(v_case.province_code)) THEN
    RAISE EXCEPTION 'the compensation case was not found in this voucher''s province' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_case.stage_code <> 'HO Approved' THEN
    RAISE EXCEPTION 'case % is %; payments can only be allocated to an approved case', v_case.code, v_case.stage_code
      USING ERRCODE = 'raise_exception';
  END IF;
  IF v_case.project_id <> v_pay.project_id THEN
    RAISE EXCEPTION 'voucher % belongs to a different project than case %', v_pay.code, v_case.code
      USING ERRCODE = 'raise_exception';
  END IF;
  IF v_pay.case_id IS NOT NULL AND v_pay.case_id <> p_case_id THEN
    RAISE EXCEPTION 'voucher % was raised for another case and cannot be allocated to case %', v_pay.code, v_case.code
      USING ERRCODE = 'raise_exception';
  END IF;
  IF p_landowner_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM lms.case_owner co WHERE co.case_id = p_case_id AND co.landowner_id = p_landowner_id) THEN
    RAISE EXCEPTION 'that landowner is not an owner on case %', v_case.code USING ERRCODE = 'raise_exception';
  END IF;
  SELECT * INTO v_hold FROM lms.hold_for(NULL, p_case_id, p_landowner_id, v_case.project_id, NULL) LIMIT 1;
  IF v_hold.hold_id IS NOT NULL THEN
    RAISE EXCEPTION 'case % is on hold: %', v_case.code, v_hold.reason USING ERRCODE = 'raise_exception';
  END IF;

  SELECT coalesce(sum(amount),0) INTO v_allocated
  FROM lms.payment_allocation WHERE payment_id = p_payment_id;
  IF v_allocated + p_amount > v_pay.net_amount THEN
    RAISE EXCEPTION 'allocating % would exceed the net payable on % (% already allocated of %)',
      p_amount, v_pay.code, v_allocated, v_pay.net_amount USING ERRCODE = 'raise_exception';
  END IF;

  -- What this allocation settles against the award (gross basis).
  v_settles := CASE WHEN v_pay.net_amount > 0 THEN round(p_amount * v_pay.gross_amount / v_pay.net_amount, 2) ELSE p_amount END;
  SELECT m.payable_amount, m.allocated_amount INTO v_payable, v_live FROM lms.case_money m WHERE m.case_id = p_case_id;
  IF v_live + v_settles > v_payable THEN
    RAISE EXCEPTION 'allocating % (settling % gross of tax) would exceed the payable award on % (% of % already allocated)',
      p_amount, v_settles, v_case.code, v_live, v_payable USING ERRCODE = 'raise_exception';
  END IF;
  IF p_landowner_id IS NOT NULL THEN
    SELECT om.attributed_payable, om.allocated_amount INTO v_owner
    FROM lms.case_owner_money om WHERE om.case_id = p_case_id AND om.landowner_id = p_landowner_id;
    IF v_owner.allocated_amount + v_settles > v_owner.attributed_payable + 0.01 THEN
      RAISE EXCEPTION 'allocating % to this owner would exceed their share of case % (% of % already allocated)',
        p_amount, v_case.code, v_owner.allocated_amount, v_owner.attributed_payable USING ERRCODE = 'raise_exception';
    END IF;
  END IF;

  INSERT INTO lms.payment_allocation (payment_id, case_id, landowner_id, amount, note, created_by)
  VALUES (p_payment_id, p_case_id, p_landowner_id, p_amount, p_note, v_actor)
  RETURNING id INTO v_id;
  RETURN v_id;
END $function$;

RESET ROLE;
