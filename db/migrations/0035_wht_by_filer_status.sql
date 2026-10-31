-- =====================================================================
-- 0035  Withholding tax by filer status, never from the request
-- =====================================================================
-- Two defects in api.request_payment (SECURITY DEFINER):
--   1. p_wht_pct, supplied by the caller, overrode the configured rate, so a
--      requester could raise a voucher with 0% withholding tax.
--   2. The documented rule (reference HTML, Settings: "Default WHT % (filer;
--      non-filer = 2x)") was not applied; every payee got the filer rate.
-- The rate is now always derived here: finance.wht_pct, multiplied by
-- finance.wht_nonfiler_multiplier for a non-filer landowner. A caller-supplied
-- rate that differs is refused. Existing vouchers keep the rate they were
-- raised at (historical figures are not rewritten).
SET ROLE lms_owner;

INSERT INTO lms.system_setting (key, value, value_type, description) VALUES
  ('finance.wht_nonfiler_multiplier', '2'::jsonb, 'number',
   'Multiplier applied to finance.wht_pct for payees whose landowner record is Non-Filer')
ON CONFLICT (key) DO NOTHING;

UPDATE lms.system_setting
   SET description = 'Withholding-tax percentage for filers; non-filers pay this times finance.wht_nonfiler_multiplier'
 WHERE key = 'finance.wht_pct';

CREATE OR REPLACE FUNCTION api.request_payment(p_idempotency_key text, p_project_id uuid, p_category text, p_pay_type text, p_period_from date, p_gross_amount numeric, p_payment_mode text, p_landowner_id uuid DEFAULT NULL::uuid, p_payee_name text DEFAULT NULL::text, p_case_id uuid DEFAULT NULL::uuid, p_lease_id uuid DEFAULT NULL::uuid, p_dbpfc_id uuid DEFAULT NULL::uuid, p_period_to date DEFAULT NULL::date, p_wht_pct numeric DEFAULT NULL::numeric, p_land_class text DEFAULT NULL::text, p_remarks text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  v_actor    uuid := util.require_actor();
  v_existing uuid;
  v_hash     text;
  v_province char(3);
  v_case     record;
  v_wht      numeric;
  v_tax      text;
  v_mult     numeric;
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

  -- Withholding tax is policy, never the requester's choice: the configured
  -- filer rate, times the non-filer multiplier when the payee landowner is a
  -- non-filer (reference: "non-filer = 2x"). A payee who is not a registered
  -- landowner has no recorded filer status and takes the filer rate, as in
  -- the reference. A caller that names a different rate is refused.
  SELECT (value #>> '{}')::numeric INTO v_wht
  FROM lms.system_setting WHERE key = 'finance.wht_pct';
  IF v_wht IS NULL THEN
    RAISE EXCEPTION 'finance.wht_pct is not configured' USING ERRCODE = 'raise_exception';
  END IF;
  IF p_landowner_id IS NOT NULL THEN
    SELECT lo.tax_status INTO v_tax FROM lms.landowner lo WHERE lo.id = p_landowner_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'no such landowner %', p_landowner_id USING ERRCODE = 'no_data_found';
    END IF;
    IF v_tax = 'Non-Filer' THEN
      SELECT (value #>> '{}')::numeric INTO v_mult
      FROM lms.system_setting WHERE key = 'finance.wht_nonfiler_multiplier';
      IF v_mult IS NULL THEN
        RAISE EXCEPTION 'finance.wht_nonfiler_multiplier is not configured' USING ERRCODE = 'raise_exception';
      END IF;
      v_wht := v_wht * v_mult;
    END IF;
  END IF;
  IF p_wht_pct IS NOT NULL AND p_wht_pct <> v_wht THEN
    RAISE EXCEPTION 'withholding tax is set by policy (% %%), not by the request', v_wht
      USING ERRCODE = 'raise_exception';
  END IF;

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
END $function$;

RESET ROLE;
