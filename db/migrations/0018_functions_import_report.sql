-- =====================================================================
-- 0018  Import validation and promotion; parameterised report datasets
-- =====================================================================
SET ROLE lms_owner;

-- ---------------------------------------------------------------------
-- api.validate_import_batch
--
-- Purpose: check every staged row of a batch against the rules that the live
-- tables would enforce, and record each failure as an exception, so that a
-- 4,000-row spreadsheet produces a fixable list rather than a half-loaded
-- register.
-- Inputs: the batch id. Outputs: the counts, also written back onto the batch.
-- Preconditions: the batch is 'staged' or 'validated' (re-validation after a
-- correction is allowed). Postcondition: batch status is 'validated' when
-- there are no errors, 'rejected' when there are.
-- Failure: raises only on a programming error; a data problem is an exception
-- row, not an exception.
--
-- Only landowners and surveys are implemented, because those are the two
-- registers the client's spreadsheets actually hold
-- (requirments/CSV Datasets.zip). An unsupported entity is reported as such
-- rather than silently passing validation.
-- ---------------------------------------------------------------------
CREATE TYPE api.import_result AS (
  batch_id uuid, row_count integer, valid_count integer, error_count integer, status text);

CREATE FUNCTION api.validate_import_batch(p_batch_id uuid) RETURNS api.import_result
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_actor uuid := util.require_actor();
  b       record;
  r       api.import_result;
BEGIN
  SELECT * INTO b FROM lms.import_batch WHERE id = p_batch_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such import batch %', p_batch_id USING ERRCODE = 'no_data_found';
  END IF;
  IF b.status NOT IN ('staged','validated','rejected') THEN
    RAISE EXCEPTION 'batch % is %, which cannot be validated', b.code, b.status
      USING ERRCODE = 'raise_exception';
  END IF;
  IF b.province_code IS NOT NULL
     AND lms.actor_role() <> 'Admin'
     AND NOT lms.actor_can_see_province(b.province_code) THEN
    RAISE EXCEPTION 'batch % is outside your province access', b.code
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE lms.import_batch SET status = 'validating' WHERE id = p_batch_id;
  -- Re-validation starts clean, so a corrected row stops being reported.
  DELETE FROM lms.import_validation_error WHERE batch_id = p_batch_id;
  UPDATE lms.import_row SET status = 'pending' WHERE batch_id = p_batch_id AND status <> 'promoted';

  IF b.target_entity = 'landowner' THEN
    -- Normalise first: strip spaces from the CNIC and insert the punctuation,
    -- which is how the client's spreadsheets vary most.
    UPDATE lms.import_row ir SET normalised = jsonb_build_object(
      'full_name',   btrim(ir.raw ->> 'full_name'),
      'father_name', btrim(ir.raw ->> 'father_name'),
      'cnic',        CASE WHEN regexp_replace(coalesce(ir.raw ->> 'cnic',''), '[^0-9]', '', 'g') ~ '^[0-9]{13}$'
                          THEN substr(regexp_replace(ir.raw ->> 'cnic', '[^0-9]', '', 'g'),1,5) || '-'
                            || substr(regexp_replace(ir.raw ->> 'cnic', '[^0-9]', '', 'g'),6,7) || '-'
                            || substr(regexp_replace(ir.raw ->> 'cnic', '[^0-9]', '', 'g'),13,1)
                          ELSE btrim(coalesce(ir.raw ->> 'cnic','')) END,
      'province_code', upper(btrim(coalesce(ir.raw ->> 'province_code', b.province_code))),
      'owner_type',  upper(btrim(coalesce(nullif(ir.raw ->> 'owner_type',''), 'O'))),
      'phone',       nullif(btrim(coalesce(ir.raw ->> 'phone','')), ''),
      'iban',        nullif(upper(regexp_replace(coalesce(ir.raw ->> 'iban',''), '\s', '', 'g')), '')
    ) WHERE ir.batch_id = p_batch_id;

    INSERT INTO lms.import_validation_error (batch_id, row_id, source_line, field, severity, rule, message, observed)
    SELECT p_batch_id, ir.id, ir.source_line, 'full_name', 'error', 'required',
           'Full name is required', NULL
    FROM lms.import_row ir
    WHERE ir.batch_id = p_batch_id AND coalesce(ir.normalised ->> 'full_name','') = '';

    INSERT INTO lms.import_validation_error (batch_id, row_id, source_line, field, severity, rule, message, observed)
    SELECT p_batch_id, ir.id, ir.source_line, 'cnic', 'error', 'cnic_format',
           'CNIC must be 13 digits in the form 00000-0000000-0', ir.raw ->> 'cnic'
    FROM lms.import_row ir
    WHERE ir.batch_id = p_batch_id
      AND coalesce(ir.normalised ->> 'cnic','') !~ '^[0-9]{5}-[0-9]{7}-[0-9]$';

    -- Against what is already in the register. Compared as text, not cast to
    -- lms.cnic: a row whose CNIC is malformed has already been reported above,
    -- and casting it here would raise a domain violation and take the whole
    -- validation run down with it — one bad cell failing the file is exactly
    -- what this routine exists to avoid.
    INSERT INTO lms.import_validation_error (batch_id, row_id, source_line, field, severity, rule, message, observed)
    SELECT p_batch_id, ir.id, ir.source_line, 'cnic', 'error', 'duplicate_existing',
           format('CNIC already registered as %s', lo.code), ir.normalised ->> 'cnic'
    FROM lms.import_row ir
    JOIN lms.landowner lo ON lo.cnic::text = ir.normalised ->> 'cnic'
    WHERE ir.batch_id = p_batch_id;

    -- And against the rest of the same file, which is the commoner case.
    INSERT INTO lms.import_validation_error (batch_id, row_id, source_line, field, severity, rule, message, observed)
    SELECT p_batch_id, ir.id, ir.source_line, 'cnic', 'error', 'duplicate_in_file',
           format('CNIC appears %s times in this file', cnt), ir.normalised ->> 'cnic'
    FROM lms.import_row ir
    JOIN (SELECT normalised ->> 'cnic' AS c, count(*) AS cnt
          FROM lms.import_row WHERE batch_id = p_batch_id
          GROUP BY 1 HAVING count(*) > 1) d ON d.c = ir.normalised ->> 'cnic'
    WHERE ir.batch_id = p_batch_id;

    INSERT INTO lms.import_validation_error (batch_id, row_id, source_line, field, severity, rule, message, observed)
    SELECT p_batch_id, ir.id, ir.source_line, 'province_code', 'error', 'unknown_province',
           'Province code is not one of SND, BAL, PNJ, KPK', ir.normalised ->> 'province_code'
    FROM lms.import_row ir
    WHERE ir.batch_id = p_batch_id
      AND NOT EXISTS (SELECT 1 FROM lms.province p WHERE p.code = ir.normalised ->> 'province_code');

    -- A warning, not an error: a missing IBAN does not stop the register being
    -- loaded, it stops a payment being made later.
    INSERT INTO lms.import_validation_error (batch_id, row_id, source_line, field, severity, rule, message, observed)
    SELECT p_batch_id, ir.id, ir.source_line, 'iban', 'warning', 'iban_format',
           'IBAN is missing or not a Pakistani IBAN; payment will be blocked until it is corrected',
           ir.normalised ->> 'iban'
    FROM lms.import_row ir
    WHERE ir.batch_id = p_batch_id
      AND coalesce(ir.normalised ->> 'iban','') !~ '^PK[0-9]{2}[A-Z]{4}[0-9A-Z]{16}$';

  ELSIF b.target_entity = 'survey' THEN
    UPDATE lms.import_row ir SET normalised = jsonb_build_object(
      'survey_no',  btrim(coalesce(ir.raw ->> 'survey_no','')),
      'block_no',   nullif(btrim(coalesce(ir.raw ->> 'block_no','')), ''),
      'unit_name',  btrim(coalesce(ir.raw ->> 'unit_name','')),
      'province_code', upper(btrim(coalesce(ir.raw ->> 'province_code', b.province_code))),
      'land_class', btrim(coalesce(nullif(ir.raw ->> 'land_class',''), 'Private')),
      'area_value', btrim(coalesce(ir.raw ->> 'area_value','')),
      'area_unit',  btrim(coalesce(nullif(ir.raw ->> 'area_unit',''), 'Acre'))
    ) WHERE ir.batch_id = p_batch_id;

    INSERT INTO lms.import_validation_error (batch_id, row_id, source_line, field, severity, rule, message, observed)
    SELECT p_batch_id, ir.id, ir.source_line, 'survey_no', 'error', 'required',
           'Survey / Khasra number is required', NULL
    FROM lms.import_row ir
    WHERE ir.batch_id = p_batch_id AND coalesce(ir.normalised ->> 'survey_no','') = '';

    INSERT INTO lms.import_validation_error (batch_id, row_id, source_line, field, severity, rule, message, observed)
    SELECT p_batch_id, ir.id, ir.source_line, 'area_value', 'error', 'numeric',
           'Area must be a positive number', ir.normalised ->> 'area_value'
    FROM lms.import_row ir
    WHERE ir.batch_id = p_batch_id
      AND (coalesce(ir.normalised ->> 'area_value','') !~ '^[0-9]+(\.[0-9]+)?$'
           OR (ir.normalised ->> 'area_value')::numeric <= 0);

    INSERT INTO lms.import_validation_error (batch_id, row_id, source_line, field, severity, rule, message, observed)
    SELECT p_batch_id, ir.id, ir.source_line, 'area_unit', 'error', 'unknown_unit',
           'Area unit has no conversion factor', ir.normalised ->> 'area_unit'
    FROM lms.import_row ir
    WHERE ir.batch_id = p_batch_id
      AND NOT EXISTS (SELECT 1 FROM lms.unit_conversion c
                      WHERE c.unit_code = ir.normalised ->> 'area_unit'
                        AND c.valid_range @> current_date);

    -- An unconfirmed factor is a warning: the row can load, but the area it
    -- produces is provisional and has to be labelled as such downstream.
    INSERT INTO lms.import_validation_error (batch_id, row_id, source_line, field, severity, rule, message, observed)
    SELECT p_batch_id, ir.id, ir.source_line, 'area_unit', 'warning', 'unconfirmed_unit',
           'Conversion factor for this unit is provisional and awaiting client confirmation',
           ir.normalised ->> 'area_unit'
    FROM lms.import_row ir
    JOIN lms.unit_conversion c ON c.unit_code = ir.normalised ->> 'area_unit'
                              AND c.valid_range @> current_date
    WHERE ir.batch_id = p_batch_id AND NOT c.is_confirmed;

    INSERT INTO lms.import_validation_error (batch_id, row_id, source_line, field, severity, rule, message, observed)
    SELECT p_batch_id, ir.id, ir.source_line, 'unit_name', 'error', 'unknown_unit_name',
           'No administrative unit of that name in this province', ir.normalised ->> 'unit_name'
    FROM lms.import_row ir
    WHERE ir.batch_id = p_batch_id
      AND NOT EXISTS (SELECT 1 FROM lms.admin_unit au
                      WHERE au.name = ir.normalised ->> 'unit_name'
                        AND au.province_code = ir.normalised ->> 'province_code');
  ELSE
    -- No validation rules exist for this entity, so no row can be called
    -- valid. The batch-level error says why, and every row is marked invalid
    -- rather than being left 'pending' and counted as loadable.
    INSERT INTO lms.import_validation_error (batch_id, source_line, severity, rule, message, observed)
    VALUES (p_batch_id, NULL, 'error', 'unsupported_entity',
            'Import validation is implemented for landowner and survey only', b.target_entity);
    UPDATE lms.import_row SET status = 'invalid' WHERE batch_id = p_batch_id;
  END IF;

  UPDATE lms.import_row ir SET status = 'invalid'
  WHERE ir.batch_id = p_batch_id
    AND EXISTS (SELECT 1 FROM lms.import_validation_error e
                WHERE e.row_id = ir.id AND e.severity = 'error');
  UPDATE lms.import_row ir SET status = 'valid'
  WHERE ir.batch_id = p_batch_id AND ir.status = 'pending';

  SELECT count(*),
         count(*) FILTER (WHERE status = 'valid'),
         count(*) FILTER (WHERE status = 'invalid')
  INTO r.row_count, r.valid_count, r.error_count
  FROM lms.import_row WHERE batch_id = p_batch_id;

  -- A batch-level error (an unsupported entity) has no row to attach to, and
  -- must still reject the batch. It is not added to error_count, which counts
  -- rows: the counts on lms.import_batch have to stay consistent with
  -- row_count, and the rows were all marked invalid above.
  r.status := CASE
    WHEN r.row_count = 0 THEN 'rejected'
    WHEN r.error_count > 0 THEN 'rejected'
    WHEN EXISTS (SELECT 1 FROM lms.import_validation_error
                 WHERE batch_id = p_batch_id AND row_id IS NULL AND severity = 'error')
      THEN 'rejected'
    ELSE 'validated' END;
  r.batch_id := p_batch_id;

  UPDATE lms.import_batch
     SET row_count = r.row_count, valid_count = r.valid_count, error_count = r.error_count,
         status = r.status, validated_at = clock_timestamp()
   WHERE id = p_batch_id;
  RETURN r;
END $$;
COMMENT ON FUNCTION api.validate_import_batch(uuid) IS
  'Validates a staged import and writes an exception per failing row. '
  'SECURITY DEFINER so it can write lms.import_validation_error with the '
  'batch locked; re-checks province access itself.';

-- ---------------------------------------------------------------------
-- api.promote_import_batch — move the validated rows into the live register.
--
-- Only a 'validated' batch may be promoted, so a file with unresolved errors
-- cannot reach the live tables. One transaction: either every valid row lands
-- or none does, and the batch records who promoted it and when. Each promoted
-- record gets a provenance row, so a figure that came from a spreadsheet can
-- always be traced back to the line it came from.
-- ---------------------------------------------------------------------
CREATE FUNCTION api.promote_import_batch(p_batch_id uuid) RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_actor uuid := util.require_actor();
  b       record;
  ir      record;
  v_id    uuid;
  v_n     integer := 0;
BEGIN
  IF lms.actor_role() NOT IN ('Admin','Approver') THEN
    RAISE EXCEPTION 'promoting an import requires an Admin or Approver'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO b FROM lms.import_batch WHERE id = p_batch_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such import batch %', p_batch_id USING ERRCODE = 'no_data_found';
  END IF;
  IF b.status <> 'validated' THEN
    RAISE EXCEPTION 'batch % is % — only a validated batch may be promoted', b.code, b.status
      USING ERRCODE = 'raise_exception',
            HINT = 'run api.validate_import_batch() and clear every error first';
  END IF;

  UPDATE lms.import_batch SET status = 'promoting' WHERE id = p_batch_id;

  FOR ir IN SELECT * FROM lms.import_row
            WHERE batch_id = p_batch_id AND status = 'valid' ORDER BY source_line
  LOOP
    IF b.target_entity = 'landowner' THEN
      INSERT INTO lms.landowner (code, province_code, full_name, father_name, cnic,
                                 phone, owner_type, status, iban, created_by, updated_by)
      VALUES (lms.next_code((ir.normalised ->> 'province_code') || '-'),
              (ir.normalised ->> 'province_code')::char(3),
              ir.normalised ->> 'full_name',
              coalesce(nullif(ir.normalised ->> 'father_name',''), '(not recorded)'),
              (ir.normalised ->> 'cnic')::lms.cnic,
              ir.normalised ->> 'phone',
              (ir.normalised ->> 'owner_type')::char(1),
              'Active', ir.normalised ->> 'iban', v_actor, v_actor)
      RETURNING id INTO v_id;

    ELSIF b.target_entity = 'survey' THEN
      INSERT INTO lms.survey (code, province_code, admin_unit_id, survey_no, block_no,
                              total_area, land_class, status_code, created_by, updated_by)
      SELECT lms.next_code('AREA-'), au.province_code, au.id,
             ir.normalised ->> 'survey_no', ir.normalised ->> 'block_no',
             -- Converted through the one conversion routine, so an imported
             -- area is the same number the application would have computed.
             api.convert_area((ir.normalised ->> 'area_value')::numeric,
                              ir.normalised ->> 'area_unit', 'Acre', current_date, true),
             ir.normalised ->> 'land_class', 'Proposed', v_actor, v_actor
      FROM lms.admin_unit au
      WHERE au.name = ir.normalised ->> 'unit_name'
        AND au.province_code = ir.normalised ->> 'province_code'
      ORDER BY au.level DESC LIMIT 1
      RETURNING id INTO v_id;
    END IF;

    UPDATE lms.import_row SET status = 'promoted', promoted_id = v_id WHERE id = ir.id;

    INSERT INTO lms.data_provenance (entity, record_id, source_kind, batch_id,
                                     source_system, source_key, source_line, confidence)
    VALUES (b.target_entity, v_id, 'import', p_batch_id, b.source_file,
            ir.normalised ->> 'cnic', ir.source_line, 'medium');
    v_n := v_n + 1;
  END LOOP;

  UPDATE lms.import_batch
     SET status = 'promoted', promoted_count = v_n,
         promoted_at = clock_timestamp(), promoted_by = v_actor
   WHERE id = p_batch_id;
  RETURN v_n;
END $$;

-- ---------------------------------------------------------------------
-- Parameterised report datasets.
--
-- One routine per report the client's document pack asks for, rather than the
-- application assembling SQL. Two reasons: the figures come out the same
-- wherever the report is run from, and the application never has to build a
-- query string from user input.
-- ---------------------------------------------------------------------
CREATE FUNCTION api.report_compensation_summary(
         p_province char(3) DEFAULT NULL,
         p_project  uuid    DEFAULT NULL,
         p_from     date    DEFAULT NULL,
         p_to       date    DEFAULT NULL)
  RETURNS TABLE (
    province_code char(3), province_name text, project_code lms.record_code,
    project_name text, case_count bigint, approved_count bigint,
    lease_amount numeric(18,2), crop_amount numeric(18,2), tree_amount numeric(18,2),
    misc_amount numeric(18,2), total_approved numeric(18,2),
    released_amount numeric(18,2), outstanding_amount numeric(18,2))
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT c.province_code, pv.name, p.code, p.name,
         count(*),
         count(*) FILTER (WHERE c.stage_code = 'HO Approved'),
         sum(c.total_lease_amount) FILTER (WHERE c.stage_code = 'HO Approved'),
         sum(c.total_crop_amount)  FILTER (WHERE c.stage_code = 'HO Approved'),
         sum(c.total_tree_amount)  FILTER (WHERE c.stage_code = 'HO Approved'),
         sum(c.total_misc_amount)  FILTER (WHERE c.stage_code = 'HO Approved'),
         coalesce(sum(c.total_amount) FILTER (WHERE c.stage_code = 'HO Approved'), 0),
         coalesce(sum(lia.released_amount) FILTER (WHERE c.stage_code = 'HO Approved'), 0),
         coalesce(sum(lia.outstanding_amount) FILTER (WHERE c.stage_code = 'HO Approved'), 0)
  FROM lms.compensation_case c
  JOIN lms.project p  ON p.id = c.project_id
  JOIN lms.province pv ON pv.code = c.province_code
  CROSS JOIN LATERAL api.case_liability(c.id) lia
  WHERE c.stage_code NOT IN ('Cancelled','Stopped')
    AND (p_province IS NULL OR c.province_code = p_province)
    AND (p_project  IS NULL OR c.project_id = p_project)
    AND (p_from     IS NULL OR c.case_date >= p_from)
    AND (p_to       IS NULL OR c.case_date <= p_to)
  GROUP BY c.province_code, pv.name, p.code, p.name
  ORDER BY c.province_code, p.code;
$$;
COMMENT ON FUNCTION api.report_compensation_summary(char,uuid,date,date) IS
  'Compensation approved and paid, by province and project. STABLE and '
  'SECURITY INVOKER, so row-level security applies and a province account '
  'gets its own figures.';

CREATE FUNCTION api.report_payment_register(
         p_province char(3) DEFAULT NULL,
         p_from     date    DEFAULT NULL,
         p_to       date    DEFAULT NULL,
         p_released_only boolean DEFAULT true)
  RETURNS TABLE (
    voucher_code lms.record_code, province_code char(3), project_code lms.record_code,
    payee text, landowner_code lms.record_code, category_code text,
    period_from date, period_to date, gross_amount numeric(18,2),
    wht_amount numeric(18,2), net_amount numeric(18,2), stage_code text,
    cheque_no text, cheque_date date, released_at timestamptz, has_receipt boolean)
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT pr.code, pr.province_code, p.code,
         coalesce(lo.full_name, pr.payee_name), lo.code, pr.category_code,
         pr.period_from, pr.period_to, pr.gross_amount, pr.wht_amount, pr.net_amount,
         pr.stage_code, rel.cheque_no, rel.cheque_date, rel.released_at,
         EXISTS (SELECT 1 FROM lms.payment_receipt rc WHERE rc.release_id = rel.id)
  FROM lms.payment_request pr
  JOIN lms.project p ON p.id = pr.project_id
  LEFT JOIN lms.landowner lo ON lo.id = pr.landowner_id
  LEFT JOIN lms.payment_release rel ON rel.payment_id = pr.id
  WHERE (p_province IS NULL OR pr.province_code = p_province)
    AND (p_from IS NULL OR pr.period_from >= p_from)
    AND (p_to   IS NULL OR pr.period_from <= p_to)
    AND (NOT p_released_only OR rel.id IS NOT NULL)
  ORDER BY pr.province_code, pr.period_from DESC, pr.code;
$$;

CREATE FUNCTION api.report_landowner_statement(p_landowner_id uuid)
  RETURNS TABLE (
    landowner_code lms.record_code, full_name text, cnic lms.cnic,
    entry_date date, entry_type text, reference lms.record_code,
    description text, amount numeric(18,2), running_total numeric(18,2))
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp
AS $$
  WITH entries AS (
    SELECT lo.code, lo.full_name, lo.cnic,
           rel.cheque_date AS entry_date, 'Payment released'::text AS entry_type,
           pr.code AS reference,
           (pr.category_code || ' · cheque ' || rel.cheque_no)::text AS description,
           rel.released_amount AS amount
    FROM lms.payment_release rel
    JOIN lms.payment_request pr ON pr.id = rel.payment_id
    JOIN lms.landowner lo ON lo.id = pr.landowner_id
    WHERE lo.id = p_landowner_id
    UNION ALL
    SELECT lo.code, lo.full_name, lo.cnic,
           c.approved_at::date, 'Compensation approved'::text, c.code,
           ('case share ' || o.share_pct || '%')::text,
           round(c.total_amount * o.share_pct / 100, 2)
    FROM lms.compensation_case c
    JOIN lms.case_owner o ON o.case_id = c.id
    JOIN lms.landowner lo ON lo.id = o.landowner_id
    WHERE lo.id = p_landowner_id AND c.stage_code = 'HO Approved'
  )
  SELECT code, full_name, cnic, entry_date, entry_type, reference, description, amount,
         sum(CASE WHEN entry_type = 'Compensation approved' THEN amount ELSE -amount END)
           OVER (ORDER BY entry_date, reference
                 ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
  FROM entries
  ORDER BY entry_date, reference;
$$;
COMMENT ON FUNCTION api.report_landowner_statement(uuid) IS
  'A landowner account statement: compensation approved less payments '
  'released, with a running balance. The figure a landowner is read out at a '
  'grievance hearing.';

CREATE FUNCTION api.report_approval_turnaround(
         p_workflow text DEFAULT 'cases',
         p_province char(3) DEFAULT NULL,
         p_days integer DEFAULT 365)
  RETURNS TABLE (
    workflow_code text, from_stage text, to_stage text, province_code char(3),
    transitions bigint, avg_days numeric(10,2), median_days numeric(10,2),
    p90_days numeric(10,2), max_days numeric(10,2))
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp
AS $$
  WITH steps AS (
    SELECT t.workflow_code, t.from_stage, t.to_stage, t.province_code,
           extract(epoch FROM (t.acted_at - lag(t.acted_at)
             OVER (PARTITION BY t.workflow_code, t.record_id ORDER BY t.acted_at))) / 86400.0 AS days
    FROM lms.workflow_transition t
    WHERE t.workflow_code = p_workflow
      AND t.acted_at >= now() - make_interval(days => p_days)
      AND (p_province IS NULL OR t.province_code = p_province)
  )
  SELECT workflow_code, from_stage, to_stage, province_code,
         count(*),
         round(avg(days)::numeric, 2),
         round(percentile_cont(0.5) WITHIN GROUP (ORDER BY days)::numeric, 2),
         round(percentile_cont(0.9) WITHIN GROUP (ORDER BY days)::numeric, 2),
         round(max(days)::numeric, 2)
  FROM steps
  WHERE days IS NOT NULL
  GROUP BY workflow_code, from_stage, to_stage, province_code
  ORDER BY avg(days) DESC NULLS LAST;
$$;
COMMENT ON FUNCTION api.report_approval_turnaround(text,char,integer) IS
  'How long each approval step actually takes, with the median and 90th '
  'percentile as well as the mean — one stalled case drags a mean and leaves '
  'the median alone, and the difference is the useful signal.';

GRANT EXECUTE ON FUNCTION
  api.validate_import_batch(uuid),
  api.promote_import_batch(uuid),
  api.report_compensation_summary(char,uuid,date,date),
  api.report_payment_register(char,date,date,boolean),
  api.report_landowner_statement(uuid),
  api.report_approval_turnaround(text,char,integer)
  TO lms_readwrite;

GRANT EXECUTE ON FUNCTION
  api.report_compensation_summary(char,uuid,date,date),
  api.report_payment_register(char,date,date,boolean),
  api.report_approval_turnaround(text,char,integer)
  TO lms_readonly;
-- The landowner statement carries a CNIC, so it is not granted to the
-- reporting role; the masked views are that role's route to payment data.

-- The routines above were created after migration 0017's sweep, so repeat it:
-- a routine that is executable by PUBLIC undoes the role design above it.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA lms, api, audit, util FROM PUBLIC;
