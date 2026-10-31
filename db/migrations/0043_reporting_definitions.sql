-- =====================================================================
-- 0043  Reporting definitions: units, money, report datasets
-- =====================================================================
-- One set of definitions behind every report, KPI, statement and export.
--
-- Units (UOM-03/04/05/09/13/15/17/18/21)
--   * lms.uom_convert_detail(): the value and whether every factor used is
--     confirmed; 'Bega' is the slide-5 alias of Jireb, not of Bigha.
--   * A survey keeps the factor its recorded area was converted with, and an
--     edit of total_area alone on a recorded parcel is refused instead of
--     being silently overwritten.
--   * A parcel cannot be committed beyond its area across live cases whose
--     terms overlap (deferred check on lines, case terms and parcel area).
--   * Imports refuse a blank area unit and carry the recorded unit forward.
--   * Province unit lists follow the client's reference, flagged until the
--     Land Department confirms them.
--
-- Money (PAY-*, RPT-02/03/04/06/14) — exact numeric everywhere:
--   assessed     case total while the case is not HO Approved / Cancelled
--   approved     total of HO Approved cases
--   adjustments  signed lms.case_adjustment rows on approved cases
--   payable      approved + adjustments
--   paid         allocations on released, unreversed vouchers, on the GROSS
--                basis: an allocation settles allocation × gross / net of its
--                voucher (the withholding tax deducted from the cheque counts
--                toward the award), rounded to the paisa per allocation.
--                DECISION AWAITING CLIENT CONFIRMATION (PAY-C3).
--   WHT          paid − paid net
--   outstanding  payable − paid per approved case, signed: never clamped;
--                an over-payment is negative and flagged.
--   Reversals    lms.payment_release_reversal: the voucher's allocations stop
--                counting as paid or allocated.
--
-- Report datasets: api.rpt_* views, one row per entity, security_invoker so
-- row-level security limits every report to the caller's provinces.
SET ROLE lms_owner;
SELECT set_config('lms.actor_id', '00000000-0000-0000-0000-000000000001', true);

-- =====================================================================
-- 1. Units
-- =====================================================================
-- Canonical code for a unit or alias. Bega is the slide-5 alias of Jireb
-- ("Jireb / Bega"); 0040 mapped it to Bigha (UOM-17).
CREATE OR REPLACE FUNCTION lms.uom_code(p_unit text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT CASE lower(btrim(coalesce(p_unit, '')))
    WHEN 'acre' THEN 'Acre' WHEN 'acres' THEN 'Acre' WHEN 'killa' THEN 'Acre'
    WHEN 'murabba' THEN 'Murabba'
    WHEN 'jireb' THEN 'Jireb' WHEN 'jarib' THEN 'Jireb' WHEN 'jareeb' THEN 'Jireb' WHEN 'bega' THEN 'Jireb'
    WHEN 'bigha' THEN 'Bigha'
    WHEN 'rod' THEN 'Rod'
    WHEN 'kanal' THEN 'Kanal'
    WHEN 'ghunta' THEN 'Ghunta' WHEN 'wiswa' THEN 'Ghunta'
    WHEN 'pole' THEN 'Pole'
    WHEN 'marla' THEN 'Marla'
    WHEN 'square yard' THEN 'Square Yard' WHEN 'sq yard' THEN 'Square Yard' WHEN 'sq yd' THEN 'Square Yard'
    WHEN 'square feet' THEN 'Square Feet' WHEN 'sq feet' THEN 'Square Feet' WHEN 'sqft' THEN 'Square Feet' WHEN 'sq ft' THEN 'Square Feet'
    WHEN 'square meter' THEN 'Square Meter' WHEN 'square metre' THEN 'Square Meter' WHEN 'sqm' THEN 'Square Meter' WHEN 'm²' THEN 'Square Meter' WHEN 'm2' THEN 'Square Meter'
    WHEN 'hectare' THEN 'Hectare' WHEN 'ha' THEN 'Hectare'
    ELSE NULL END;
$function$;

-- A conversion with its provenance: NULL value when either unit is unknown,
-- confirmed = false when a provisional factor was used. Exact (no rounding).
CREATE FUNCTION lms.uom_convert_detail(p_value numeric, p_from text, p_to text, p_on date DEFAULT current_date)
 RETURNS TABLE(value numeric, from_unit text, to_unit text, confirmed boolean, from_sqm numeric, to_sqm numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT CASE WHEN p_value IS NULL OR f.sqm_per_unit IS NULL OR t.sqm_per_unit IS NULL THEN NULL
              WHEN f.unit_code = t.unit_code THEN p_value
              ELSE p_value * f.sqm_per_unit / t.sqm_per_unit END,
         f.unit_code, t.unit_code,
         CASE WHEN f.unit_code IS NULL OR t.unit_code IS NULL THEN NULL
              WHEN f.unit_code = t.unit_code THEN true
              ELSE f.confirmed AND t.confirmed END,
         f.sqm_per_unit, t.sqm_per_unit
  FROM (SELECT 1) one
  LEFT JOIN lms.uom_factor(p_from, p_on) f ON true
  LEFT JOIN lms.uom_factor(p_to, p_on) t ON true;
$function$;
REVOKE ALL ON FUNCTION lms.uom_convert_detail(numeric, text, text, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.uom_convert_detail(numeric, text, text, date) TO lms_readwrite, lms_readonly;

-- The factor a recorded area was converted with, kept with the parcel so a
-- provisional conversion can be found and redone once the factor is confirmed.
ALTER TABLE lms.survey
  ADD COLUMN recorded_factor numeric CHECK (recorded_factor > 0),
  ADD COLUMN recorded_factor_confirmed boolean;
COMMENT ON COLUMN lms.survey.recorded_factor IS 'Acres per recorded_unit used to derive total_area (from lms.unit_conversion at the time).';
COMMENT ON COLUMN lms.survey.recorded_factor_confirmed IS 'false when total_area was derived with a provisional factor.';

CREATE OR REPLACE FUNCTION lms.tg_survey_recorded_area()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE f record;
BEGIN
  IF NEW.recorded_area IS NULL THEN
    NEW.recorded_factor := NULL; NEW.recorded_factor_confirmed := NULL;
    RETURN NEW;
  END IF;
  -- total_area is derived; an edit of it alone would be silently replaced.
  IF TG_OP = 'UPDATE' AND NEW.total_area IS DISTINCT FROM OLD.total_area
     AND NEW.recorded_area IS NOT DISTINCT FROM OLD.recorded_area
     AND NEW.recorded_unit IS NOT DISTINCT FROM OLD.recorded_unit THEN
    RAISE EXCEPTION 'the area of parcel % is derived from its recorded area (% %); change the recorded area or unit instead',
      OLD.code, OLD.recorded_area, OLD.recorded_unit USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO f FROM lms.uom_convert_detail(NEW.recorded_area, NEW.recorded_unit, 'Acre');
  IF f.value IS NULL THEN
    RAISE EXCEPTION 'unit % has no conversion factor', NEW.recorded_unit USING ERRCODE = 'check_violation';
  END IF;
  NEW.total_area := round(f.value, 4);
  NEW.recorded_factor := f.from_sqm / f.to_sqm;
  NEW.recorded_factor_confirmed := f.confirmed;
  RETURN NEW;
END $function$;

-- Province unit lists (UOM-05). The client's reference (slide 3 and
-- "Measurement Units.jpg"): Sindh Acre/Ghunta/Sq Ft; Balochistan
-- Acre/Rod/Pole/Sq Ft; Punjab and KPK Acre/Kanal/Marla/Sq Ft. Jireb (Sindh)
-- and Bigha (KPK) came from the earlier prototype and are not in it. All rows
-- stay flagged until the Land Department confirms the list; nothing is deleted.
ALTER TABLE lms.province_unit
  ADD COLUMN source text,
  ADD COLUMN confirmed boolean NOT NULL DEFAULT false,
  ADD COLUMN note text;
UPDATE lms.province_unit pu SET
  source = CASE WHEN (pu.province_code, pu.unit_code) IN (('SND','Jireb'), ('KPK','Bigha')) THEN 'legacy_prototype' ELSE 'client_reference' END,
  note   = CASE WHEN (pu.province_code, pu.unit_code) IN (('SND','Jireb'), ('KPK','Bigha'))
                THEN 'Not in the client''s provincial unit reference (slide 3); awaiting Land Department confirmation'
                ELSE 'From the client''s provincial unit reference (slide 3); awaiting Land Department confirmation' END;
INSERT INTO lms.province_unit (province_code, unit_code, display_order, source, note)
SELECT v.p, v.u, v.o, 'client_reference', 'From the client''s provincial unit reference (slide 3); awaiting Land Department confirmation'
FROM (VALUES ('SND','Square Feet',9), ('BAL','Square Feet',9), ('PNJ','Square Feet',9), ('KPK','Marla',7), ('KPK','Square Feet',9)) v(p, u, o)
WHERE EXISTS (SELECT 1 FROM lms.province WHERE code = v.p)
ON CONFLICT (province_code, unit_code) DO NOTHING;
COMMENT ON COLUMN lms.province_unit.confirmed IS 'true once the Land Department has confirmed the unit for the province.';

-- Unit names without factors (the factor and its confirmation live in
-- lms.unit_conversion) and a unique display order (UOM-18).
UPDATE lms.measurement_unit SET
  name = CASE code
    WHEN 'Murabba' THEN 'Murabba' WHEN 'Acre' THEN 'Acre / Killa' WHEN 'Jireb' THEN 'Jireb / Bega'
    WHEN 'Rod' THEN 'Rod' WHEN 'Kanal' THEN 'Kanal' WHEN 'Ghunta' THEN 'Ghunta / Wiswa'
    WHEN 'Pole' THEN 'Pole' WHEN 'Marla' THEN 'Marla' WHEN 'Square Yard' THEN 'Square Yard'
    WHEN 'Bigha' THEN 'Bigha' WHEN 'Square Feet' THEN 'Square Feet' WHEN 'Square Meter' THEN 'Square Metre'
    WHEN 'Hectare' THEN 'Hectare' ELSE name END,
  display_order = CASE code
    WHEN 'Acre' THEN 1 WHEN 'Murabba' THEN 2 WHEN 'Jireb' THEN 3 WHEN 'Bigha' THEN 4 WHEN 'Rod' THEN 5
    WHEN 'Kanal' THEN 6 WHEN 'Ghunta' THEN 7 WHEN 'Marla' THEN 8 WHEN 'Pole' THEN 9 WHEN 'Square Yard' THEN 10
    WHEN 'Square Feet' THEN 11 WHEN 'Square Meter' THEN 12 WHEN 'Hectare' THEN 13 ELSE display_order END;
ALTER TABLE lms.measurement_unit ADD CONSTRAINT measurement_unit_display_order_uq UNIQUE (display_order);

-- Imports (UOM-13): a blank area unit used to load as acres without warning
-- (a kanal sheet would load 8x too large). It is now a validation error, and
-- a promoted survey keeps its recorded area and unit, so it carries the same
-- provisional marker as manual entry.
CREATE FUNCTION lms.tg_import_row_area_unit()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  IF NEW.normalised IS NOT NULL AND NEW.normalised ? 'area_value'
     AND coalesce(btrim(NEW.raw ->> 'area_unit'), '') = ''
     AND EXISTS (SELECT 1 FROM lms.import_batch b WHERE b.id = NEW.batch_id AND b.target_entity = 'survey') THEN
    INSERT INTO lms.import_validation_error (batch_id, row_id, source_line, field, severity, rule, message, observed)
    VALUES (NEW.batch_id, NEW.id, NEW.source_line, 'area_unit', 'error', 'required',
            'Area unit is required (an area without its unit cannot be converted safely)', NULL);
  END IF;
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION lms.tg_import_row_area_unit() FROM PUBLIC;
CREATE TRIGGER import_row_area_unit_required AFTER UPDATE OF normalised ON lms.import_row
  FOR EACH ROW EXECUTE FUNCTION lms.tg_import_row_area_unit();

CREATE FUNCTION lms.tg_import_row_recorded_area()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE v_unit text;
BEGIN
  IF NEW.promoted_id IS NULL OR NEW.promoted_id IS NOT DISTINCT FROM OLD.promoted_id
     OR NOT EXISTS (SELECT 1 FROM lms.import_batch b WHERE b.id = NEW.batch_id AND b.target_entity = 'survey') THEN
    RETURN NEW;
  END IF;
  v_unit := lms.uom_code(NEW.normalised ->> 'area_unit');
  IF v_unit IS NOT NULL AND coalesce(NEW.normalised ->> 'area_value', '') ~ '^[0-9]+(\.[0-9]+)?$' THEN
    UPDATE lms.survey SET recorded_area = (NEW.normalised ->> 'area_value')::numeric, recorded_unit = v_unit
     WHERE id = NEW.promoted_id AND recorded_area IS NULL;
  END IF;
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION lms.tg_import_row_recorded_area() FROM PUBLIC;
CREATE TRIGGER import_row_recorded_area AFTER UPDATE OF promoted_id ON lms.import_row
  FOR EACH ROW EXECUTE FUNCTION lms.tg_import_row_recorded_area();

-- Land requests (UOM-15): ghunta is a fraction of an acre (0-39.9999) and a
-- Sindh unit; a request of "0 acre 20 ghunta" is valid.
ALTER TABLE lms.land_request DROP CONSTRAINT land_request_area_acres_check;
ALTER TABLE lms.land_request
  ADD CONSTRAINT land_request_area_ck CHECK (area_acres >= 0 AND (area_acres > 0 OR coalesce(area_ghunta, 0) > 0)),
  ADD CONSTRAINT land_request_ghunta_ck CHECK (area_ghunta IS NULL OR (area_ghunta >= 0 AND area_ghunta < 40)),
  ADD CONSTRAINT land_request_ghunta_sindh_ck CHECK (coalesce(area_ghunta, 0) = 0 OR province_code = 'SND');

-- =====================================================================
-- 2. A parcel cannot be committed beyond its area (UOM-09)
-- =====================================================================
-- The term a case commits land for: from its effective date (or case date)
-- for its lease term; open-ended when no term is recorded.
CREATE FUNCTION lms.case_term(p_effective date, p_case_date date, p_months integer)
 RETURNS daterange
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT daterange(coalesce(p_effective, p_case_date),
                   CASE WHEN p_months IS NULL OR p_months <= 0 THEN NULL
                        ELSE (coalesce(p_effective, p_case_date) + make_interval(months => p_months))::date END, '[)');
$function$;
REVOKE ALL ON FUNCTION lms.case_term(date, date, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.case_term(date, date, integer) TO lms_readwrite, lms_readonly;

-- Acres of a parcel committed by live (not cancelled) cases whose term
-- overlaps p_term (all live cases when p_term is NULL).
CREATE FUNCTION lms.survey_committed_area(p_survey uuid, p_term daterange DEFAULT NULL)
 RETURNS numeric
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT coalesce(sum(coalesce(l.subsequent_area, l.lease_area)), 0)::numeric
  FROM lms.case_lease_line l
  JOIN lms.compensation_case c ON c.id = l.case_id
  WHERE l.survey_id = p_survey AND c.stage_code <> 'Cancelled'
    AND (p_term IS NULL OR lms.case_term(c.effective_date, c.case_date, c.lease_term_months) && p_term);
$function$;
REVOKE ALL ON FUNCTION lms.survey_committed_area(uuid, daterange) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.survey_committed_area(uuid, daterange) TO lms_readwrite, lms_readonly;

-- Checks one parcel against every live case on it. SECURITY DEFINER: the
-- rule must see cases in every province, not only the ones the user can read.
CREATE FUNCTION lms.check_survey_commitment(p_survey uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE s record; w record;
BEGIN
  -- Serialise concurrent cases on the same parcel.
  SELECT id, code, total_area INTO s FROM lms.survey WHERE id = p_survey FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT c.code, lms.survey_committed_area(p_survey, lms.case_term(c.effective_date, c.case_date, c.lease_term_months)) AS committed
    INTO w
  FROM lms.case_lease_line l
  JOIN lms.compensation_case c ON c.id = l.case_id
  WHERE l.survey_id = p_survey AND c.stage_code <> 'Cancelled'
  ORDER BY 2 DESC LIMIT 1;
  IF w.committed IS NOT NULL AND w.committed > s.total_area + 0.0001 THEN
    RAISE EXCEPTION 'parcel % is % acres but % acres of it would be committed to live compensation cases in the term of case %',
      s.code, s.total_area, round(w.committed, 4), w.code
      USING ERRCODE = 'check_violation',
            HINT = 'Reduce the lease area, or cancel the case it replaces, before committing more of this parcel.';
  END IF;
END $function$;
REVOKE ALL ON FUNCTION lms.check_survey_commitment(uuid) FROM PUBLIC;

CREATE FUNCTION lms.tg_case_line_commitment()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  PERFORM lms.check_survey_commitment(NEW.survey_id);
  RETURN NULL;
END $function$;
REVOKE ALL ON FUNCTION lms.tg_case_line_commitment() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER case_lease_line_commitment_ck
  AFTER INSERT OR UPDATE OF survey_id, lease_area, subsequent_area ON lms.case_lease_line
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION lms.tg_case_line_commitment();

-- A case's term moving, or the case advancing to an approval stage, re-checks
-- its parcels (catches commitments recorded before this rule existed).
CREATE FUNCTION lms.tg_case_term_commitment()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE v_survey uuid;
BEGIN
  IF NEW.stage_code = 'Cancelled' THEN RETURN NULL; END IF;
  IF NEW.effective_date IS NOT DISTINCT FROM OLD.effective_date
     AND NEW.case_date IS NOT DISTINCT FROM OLD.case_date
     AND NEW.lease_term_months IS NOT DISTINCT FROM OLD.lease_term_months
     AND NOT (NEW.stage_code IS DISTINCT FROM OLD.stage_code AND NEW.stage_code IN ('Field Approved', 'HO Approved')) THEN
    RETURN NULL;
  END IF;
  FOR v_survey IN SELECT DISTINCT survey_id FROM lms.case_lease_line WHERE case_id = NEW.id LOOP
    PERFORM lms.check_survey_commitment(v_survey);
  END LOOP;
  RETURN NULL;
END $function$;
REVOKE ALL ON FUNCTION lms.tg_case_term_commitment() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER case_term_commitment_ck
  AFTER UPDATE OF effective_date, case_date, lease_term_months, stage_code ON lms.compensation_case
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION lms.tg_case_term_commitment();

-- A parcel's area shrinking below what live cases already hold.
CREATE FUNCTION lms.tg_survey_area_commitment()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  IF NEW.total_area < OLD.total_area THEN
    PERFORM lms.check_survey_commitment(NEW.id);
  END IF;
  RETURN NULL;
END $function$;
REVOKE ALL ON FUNCTION lms.tg_survey_area_commitment() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER survey_area_commitment_ck
  AFTER UPDATE OF total_area ON lms.survey
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION lms.tg_survey_area_commitment();



-- =====================================================================
-- 3. Award adjustments and release reversals (PAY-H2)
-- =====================================================================
-- Both are append-only ledgers written only through the definer routines
-- below (no INSERT grant), audited, and visible by province.
CREATE TABLE lms.case_adjustment (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id       uuid NOT NULL REFERENCES lms.compensation_case(id) ON DELETE RESTRICT,
  province_code char(3) NOT NULL REFERENCES lms.province(code),
  amount        numeric(18,2) NOT NULL CHECK (amount <> 0),
  reason        text NOT NULL CHECK (length(btrim(reason)) >= 10 AND length(reason) <= 1000),
  created_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by    uuid NOT NULL REFERENCES lms.app_user(id)
);
CREATE INDEX case_adjustment_case_idx ON lms.case_adjustment (case_id);
COMMENT ON TABLE lms.case_adjustment IS
  'Signed revisions of an approved award (enhancement, decree, correction). payable = approved total + sum(amount).';
ALTER TABLE lms.case_adjustment ENABLE ROW LEVEL SECURITY;
CREATE POLICY province_scope ON lms.case_adjustment FOR SELECT USING (
  (( SELECT lms.actor_role() AS actor_role) = 'Admin'::text)
  OR (province_code = ANY (( SELECT lms.actor_provinces() AS actor_provinces)::bpchar[])));
GRANT SELECT ON lms.case_adjustment TO lms_readwrite, lms_readonly;
CREATE TRIGGER case_adjustment_append_only BEFORE UPDATE OR DELETE ON lms.case_adjustment
  FOR EACH ROW EXECUTE FUNCTION audit.tg_append_only();
CREATE TRIGGER case_adjustment_audit AFTER INSERT ON lms.case_adjustment
  FOR EACH ROW EXECUTE FUNCTION audit.tg_audit_row();

CREATE TABLE lms.payment_release_reversal (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  release_id    uuid NOT NULL UNIQUE REFERENCES lms.payment_release(id) ON DELETE RESTRICT,
  payment_id    uuid NOT NULL UNIQUE REFERENCES lms.payment_request(id) ON DELETE RESTRICT,
  province_code char(3) NOT NULL REFERENCES lms.province(code),
  amount        numeric(18,2) NOT NULL CHECK (amount > 0),
  reason        text NOT NULL CHECK (length(btrim(reason)) >= 10 AND length(reason) <= 1000),
  reversed_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  reversed_by   uuid NOT NULL REFERENCES lms.app_user(id)
);
COMMENT ON TABLE lms.payment_release_reversal IS
  'A released cheque returned, stopped or cancelled after release. The voucher''s allocations stop counting as paid or allocated.';
ALTER TABLE lms.payment_release_reversal ENABLE ROW LEVEL SECURITY;
CREATE POLICY province_scope ON lms.payment_release_reversal FOR SELECT USING (
  (( SELECT lms.actor_role() AS actor_role) = 'Admin'::text)
  OR (province_code = ANY (( SELECT lms.actor_provinces() AS actor_provinces)::bpchar[])));
GRANT SELECT ON lms.payment_release_reversal TO lms_readwrite, lms_readonly;
CREATE TRIGGER payment_release_reversal_append_only BEFORE UPDATE OR DELETE ON lms.payment_release_reversal
  FOR EACH ROW EXECUTE FUNCTION audit.tg_append_only();
CREATE TRIGGER payment_release_reversal_audit AFTER INSERT ON lms.payment_release_reversal
  FOR EACH ROW EXECUTE FUNCTION audit.tg_audit_row();

-- A reversed voucher leaves the "live" set, so a corrected voucher can be
-- raised for the same payee, category and period.
ALTER TABLE lms.payment_request
  ADD COLUMN reversed_at timestamptz,
  ADD CONSTRAINT payment_reversed_released_ck CHECK (reversed_at IS NULL OR stage_code = 'Released');
DROP INDEX lms.payment_no_duplicate_live_uq;
CREATE UNIQUE INDEX payment_no_duplicate_live_uq ON lms.payment_request
  USING btree (payee_key, category_code, period_from,
               COALESCE(case_id, '00000000-0000-0000-0000-000000000000'::uuid),
               COALESCE(lease_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE stage_code <> ALL (ARRAY['Cancelled'::text, 'Stopped'::text]) AND reversed_at IS NULL;

-- A released voucher stays locked; the one change allowed is recording its
-- reversal, once, after the reversal row exists.
CREATE OR REPLACE FUNCTION lms.tg_payment_locked()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE v_changed text[]; v_old jsonb := to_jsonb(OLD); v_new jsonb := to_jsonb(NEW);
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM lms.payment_release WHERE payment_id = OLD.id) THEN
      RAISE EXCEPTION 'voucher % has been released and cannot be deleted', OLD.code
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.stage_code <> 'Released' THEN RETURN NEW; END IF;

  SELECT array_agg(k ORDER BY k) INTO v_changed
  FROM jsonb_object_keys(v_new) AS k
  WHERE v_new -> k IS DISTINCT FROM v_old -> k
    AND k NOT IN ('updated_at','updated_by','version','remarks')
    AND NOT (k = ANY (util.generated_columns(TG_RELID)))
    AND NOT (k = 'reversed_at' AND OLD.reversed_at IS NULL AND NEW.reversed_at IS NOT NULL
             AND EXISTS (SELECT 1 FROM lms.payment_release_reversal rv WHERE rv.payment_id = OLD.id));
  IF v_changed IS NOT NULL THEN
    RAISE EXCEPTION 'voucher % has been released; % cannot be changed',
      OLD.code, array_to_string(v_changed, ', ')
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $function$;

-- Award adjustment: signed amount, reason of 10+ characters, cases:approve in
-- the case's province, never by the person who prepared the case.
CREATE FUNCTION api.adjust_case(p_case_id uuid, p_amount numeric, p_reason text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE v_actor uuid := util.require_actor(); c record; v_payable numeric; v_id uuid;
BEGIN
  IF p_amount IS NULL OR p_amount = 0 OR p_amount <> round(p_amount, 2) OR abs(p_amount) >= 1e15 THEN
    RAISE EXCEPTION 'an adjustment needs a non-zero amount in rupees and paisa' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 10 OR length(p_reason) > 1000 THEN
    RAISE EXCEPTION 'give a reason of 10 to 1000 characters' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT cc.id, cc.code, cc.province_code, cc.project_id, cc.stage_code, cc.total_amount, cc.created_by
    INTO c FROM lms.compensation_case cc WHERE cc.id = p_case_id FOR UPDATE;
  IF NOT FOUND OR NOT (lms.actor_role() = 'Admin' OR lms.actor_can_see_province(c.province_code)) THEN
    RAISE EXCEPTION 'no such compensation case' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT iam.has_permission_in('cases', 'approve', c.province_code, c.project_id) THEN
    RAISE EXCEPTION 'permission denied: cases:approve' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF c.created_by = v_actor OR EXISTS (
       SELECT 1 FROM lms.workflow_transition t
       WHERE t.workflow_code = 'cases' AND t.record_id = c.id AND t.to_stage = 'Prepared' AND t.acted_by = v_actor) THEN
    RAISE EXCEPTION 'separation of duties: the person who prepared case % cannot adjust its award', c.code
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF c.stage_code <> 'HO Approved' THEN
    RAISE EXCEPTION 'case % is %; only an approved award can be adjusted', c.code, c.stage_code
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  v_payable := c.total_amount + coalesce((SELECT sum(a.amount) FROM lms.case_adjustment a WHERE a.case_id = c.id), 0);
  IF v_payable + p_amount < 0 THEN
    RAISE EXCEPTION 'the adjustment would make the payable award of case % negative (payable now %)', c.code, v_payable
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  INSERT INTO lms.case_adjustment (case_id, province_code, amount, reason, created_by)
  VALUES (c.id, c.province_code, p_amount, btrim(p_reason), v_actor) RETURNING id INTO v_id;
  RETURN v_id;
END $function$;
REVOKE ALL ON FUNCTION api.adjust_case(uuid, numeric, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.adjust_case(uuid, numeric, text) TO lms_readwrite;

-- Release reversal: reason of 10+ characters, payments:release in the
-- voucher's province, never by the person who released it. Accepts the
-- release id or the voucher id.
CREATE FUNCTION api.reverse_release(p_release_id uuid, p_reason text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE v_actor uuid := util.require_actor(); r record; v_id uuid;
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason)) < 10 OR length(p_reason) > 1000 THEN
    RAISE EXCEPTION 'give a reason of 10 to 1000 characters' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT rel.id, rel.payment_id, rel.province_code, rel.released_amount, rel.released_by, pr.code, pr.project_id
    INTO r
  FROM lms.payment_release rel JOIN lms.payment_request pr ON pr.id = rel.payment_id
  WHERE rel.id = p_release_id OR rel.payment_id = p_release_id
  FOR UPDATE OF pr;
  IF NOT FOUND OR NOT (lms.actor_role() = 'Admin' OR lms.actor_can_see_province(r.province_code)) THEN
    RAISE EXCEPTION 'no such payment release' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT iam.has_permission_in('payments', 'release', r.province_code, r.project_id) THEN
    RAISE EXCEPTION 'permission denied: payments:release' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF r.released_by = v_actor THEN
    RAISE EXCEPTION 'separation of duties: the person who released voucher % cannot reverse it', r.code
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF EXISTS (SELECT 1 FROM lms.payment_release_reversal WHERE release_id = r.id) THEN
    RAISE EXCEPTION 'the release of voucher % has already been reversed', r.code
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  INSERT INTO lms.payment_release_reversal (release_id, payment_id, province_code, amount, reason, reversed_by)
  VALUES (r.id, r.payment_id, r.province_code, r.released_amount, btrim(p_reason), v_actor) RETURNING id INTO v_id;
  UPDATE lms.payment_request SET reversed_at = clock_timestamp() WHERE id = r.payment_id;
  RETURN v_id;
END $function$;
REVOKE ALL ON FUNCTION api.reverse_release(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.reverse_release(uuid, text) TO lms_readwrite;

-- =====================================================================
-- 4. Settlement on the gross basis (PAY-C1/C3/C4, RPT-02/03)
-- =====================================================================
-- One row per allocation: what it settles against the award.
CREATE VIEW lms.allocation_settlement WITH (security_invoker = true) AS
SELECT al.id AS allocation_id, al.payment_id, al.case_id, al.landowner_id,
       pr.province_code, pr.project_id, pr.category_code,
       al.amount AS allocated_net,
       pr.gross_amount AS voucher_gross, pr.wht_amount AS voucher_wht, pr.net_amount AS voucher_net,
       (CASE WHEN pr.net_amount > 0 THEN round(al.amount * pr.gross_amount / pr.net_amount, 2)
             ELSE al.amount END)::numeric(18,2) AS settled_gross,
       pr.stage_code AS voucher_stage,
       rel.id AS release_id, rel.cheque_no, rel.cheque_date, rel.released_at,
       rv.id AS reversal_id, rv.reversed_at,
       (pr.stage_code NOT IN ('Cancelled','Stopped') AND rv.id IS NULL) AS is_live,
       (rel.id IS NOT NULL AND rv.id IS NULL) AS is_paid,
       al.created_at
FROM lms.payment_allocation al
JOIN lms.payment_request pr ON pr.id = al.payment_id
LEFT JOIN lms.payment_release rel ON rel.payment_id = al.payment_id
LEFT JOIN lms.payment_release_reversal rv ON rv.release_id = rel.id;
REVOKE ALL ON lms.allocation_settlement FROM PUBLIC;
GRANT SELECT ON lms.allocation_settlement TO lms_readwrite, lms_readonly;

-- Same columns as 0038 (allocated_amount, released_amount), now gross basis
-- and net of reversals, plus the net, reversed and unattributed parts.
CREATE OR REPLACE VIEW lms.case_settlement_totals WITH (security_invoker = true) AS
SELECT s.case_id,
       coalesce(sum(s.settled_gross) FILTER (WHERE s.is_live), 0)::numeric(18,2)::numeric AS allocated_amount,
       coalesce(sum(s.settled_gross) FILTER (WHERE s.is_paid), 0)::numeric(18,2)::numeric AS released_amount,
       coalesce(sum(s.allocated_net) FILTER (WHERE s.is_paid), 0)::numeric(18,2)::numeric AS released_net_amount,
       coalesce(sum(s.settled_gross) FILTER (WHERE s.reversal_id IS NOT NULL), 0)::numeric(18,2)::numeric AS reversed_amount,
       coalesce(sum(s.settled_gross) FILTER (WHERE s.is_paid AND s.landowner_id IS NULL), 0)::numeric(18,2)::numeric AS unattributed_paid_amount
FROM lms.allocation_settlement s
GROUP BY s.case_id;

-- The money of one case, under the definitions in the header.
CREATE VIEW lms.case_money WITH (security_invoker = true) AS
SELECT c.id AS case_id, c.code AS case_code, c.province_code, c.project_id, c.stage_code,
       (CASE WHEN c.stage_code NOT IN ('HO Approved','Cancelled') THEN c.total_amount ELSE 0 END)::numeric(18,2) AS assessed_amount,
       (CASE WHEN c.stage_code = 'HO Approved' THEN c.total_amount ELSE 0 END)::numeric(18,2) AS approved_amount,
       coalesce(adj.amount, 0)::numeric(18,2) AS adjustment_amount,
       (CASE WHEN c.stage_code = 'HO Approved' THEN c.total_amount + coalesce(adj.amount, 0) ELSE 0 END)::numeric(18,2) AS payable_amount,
       coalesce(st.allocated_amount, 0)::numeric(18,2) AS allocated_amount,
       coalesce(st.released_amount, 0)::numeric(18,2) AS paid_amount,
       coalesce(st.released_net_amount, 0)::numeric(18,2) AS paid_net_amount,
       (coalesce(st.released_amount, 0) - coalesce(st.released_net_amount, 0))::numeric(18,2) AS wht_amount,
       coalesce(st.reversed_amount, 0)::numeric(18,2) AS reversed_amount,
       coalesce(st.unattributed_paid_amount, 0)::numeric(18,2) AS unattributed_paid_amount,
       (CASE WHEN c.stage_code = 'HO Approved'
             THEN c.total_amount + coalesce(adj.amount, 0) - coalesce(st.released_amount, 0) END)::numeric(18,2) AS outstanding_amount,
       CASE WHEN c.stage_code = 'Cancelled' THEN 'Cancelled'
            WHEN c.stage_code <> 'HO Approved' THEN 'Not approved'
            WHEN c.total_amount + coalesce(adj.amount, 0) - coalesce(st.released_amount, 0) < 0 THEN 'Overpaid'
            WHEN c.total_amount + coalesce(adj.amount, 0) - coalesce(st.released_amount, 0) = 0 THEN 'Settled'
            WHEN coalesce(st.released_amount, 0) = 0 THEN 'Unpaid'
            ELSE 'Part paid' END AS settlement_status
FROM lms.compensation_case c
LEFT JOIN (SELECT a.case_id, sum(a.amount) AS amount FROM lms.case_adjustment a GROUP BY a.case_id) adj ON adj.case_id = c.id
LEFT JOIN lms.case_settlement_totals st ON st.case_id = c.id;
REVOKE ALL ON lms.case_money FROM PUBLIC;
GRANT SELECT ON lms.case_money TO lms_readwrite, lms_readonly;

-- Each owner's part of a case: the payable split by share, the rounding
-- residue given to the largest remainders (so every paisa is attributed,
-- PAY-L2), and the payments attributed to the owner. A payment allocated to
-- the case without an owner is attributed only when the case has one owner;
-- otherwise it is reported as unattributed, never guessed.
CREATE VIEW lms.case_owner_money WITH (security_invoker = true) AS
WITH o AS (
  SELECT co.id AS case_owner_id, co.case_id, co.landowner_id, co.share_pct, lo.code AS owner_code,
         m.payable_amount, m.stage_code,
         count(*) OVER (PARTITION BY co.case_id) AS owner_count,
         m.payable_amount * co.share_pct / 100 AS raw_share
  FROM lms.case_owner co
  JOIN lms.landowner lo ON lo.id = co.landowner_id
  JOIN lms.case_money m ON m.case_id = co.case_id
), r AS (
  SELECT o.*,
         trunc(o.raw_share, 2) AS base_share,
         round((o.payable_amount - sum(trunc(o.raw_share, 2)) OVER (PARTITION BY o.case_id)) * 100) AS residue_cents,
         row_number() OVER (PARTITION BY o.case_id ORDER BY o.raw_share - trunc(o.raw_share, 2) DESC, o.owner_code) AS rnk_up,
         row_number() OVER (PARTITION BY o.case_id ORDER BY o.raw_share - trunc(o.raw_share, 2), o.owner_code DESC) AS rnk_down
  FROM o
), pd AS (
  SELECT s.case_id, s.landowner_id,
         coalesce(sum(s.settled_gross) FILTER (WHERE s.is_paid), 0) AS paid_gross,
         coalesce(sum(s.allocated_net) FILTER (WHERE s.is_paid), 0) AS paid_net,
         coalesce(sum(s.settled_gross) FILTER (WHERE s.is_live), 0) AS live_gross
  FROM lms.allocation_settlement s WHERE s.landowner_id IS NOT NULL
  GROUP BY s.case_id, s.landowner_id
), pu AS (
  SELECT s.case_id,
         coalesce(sum(s.settled_gross) FILTER (WHERE s.is_paid), 0) AS paid_gross,
         coalesce(sum(s.allocated_net) FILTER (WHERE s.is_paid), 0) AS paid_net,
         coalesce(sum(s.settled_gross) FILTER (WHERE s.is_live), 0) AS live_gross
  FROM lms.allocation_settlement s WHERE s.landowner_id IS NULL
  GROUP BY s.case_id
)
SELECT r.case_owner_id, r.case_id, r.landowner_id, r.share_pct, r.owner_count, r.stage_code,
       (r.base_share + CASE WHEN r.residue_cents > 0 AND r.rnk_up <= r.residue_cents THEN 0.01
                            WHEN r.residue_cents < 0 AND r.rnk_down <= -r.residue_cents THEN -0.01
                            ELSE 0 END)::numeric(18,2) AS attributed_payable,
       (coalesce(pd.paid_gross, 0) + CASE WHEN r.owner_count = 1 THEN coalesce(pu.paid_gross, 0) ELSE 0 END)::numeric(18,2) AS paid_amount,
       (coalesce(pd.paid_net, 0) + CASE WHEN r.owner_count = 1 THEN coalesce(pu.paid_net, 0) ELSE 0 END)::numeric(18,2) AS paid_net_amount,
       (coalesce(pd.live_gross, 0) + CASE WHEN r.owner_count = 1 THEN coalesce(pu.live_gross, 0) ELSE 0 END)::numeric(18,2) AS allocated_amount,
       (CASE WHEN r.owner_count > 1 THEN coalesce(pu.paid_gross, 0) ELSE 0 END)::numeric(18,2) AS case_unattributed_paid
FROM r
LEFT JOIN pd ON pd.case_id = r.case_id AND pd.landowner_id = r.landowner_id
LEFT JOIN pu ON pu.case_id = r.case_id;
REVOKE ALL ON lms.case_owner_money FROM PUBLIC;
GRANT SELECT ON lms.case_owner_money TO lms_readwrite, lms_readonly;

-- api.case_settlement / api.case_liability keep their signatures, on the same basis.
CREATE OR REPLACE FUNCTION api.case_settlement(p_case_id uuid)
 RETURNS TABLE(allocated_amount numeric, released_amount numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT coalesce(sum(s.settled_gross) FILTER (WHERE s.is_live), 0)::numeric(18,2),
         coalesce(sum(s.settled_gross) FILTER (WHERE s.is_paid), 0)::numeric(18,2)
  FROM lms.allocation_settlement s
  WHERE s.case_id = p_case_id;
$function$;

-- approved_amount is the payable award (approved total + adjustments).
CREATE OR REPLACE FUNCTION api.case_liability(p_case_id uuid)
 RETURNS api.case_liability
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE r api.case_liability;
BEGIN
  SELECT c.id, c.code,
         c.total_amount + coalesce((SELECT sum(a.amount) FROM lms.case_adjustment a WHERE a.case_id = c.id), 0)
    INTO r.case_id, r.case_code, r.approved_amount
  FROM lms.compensation_case c WHERE c.id = p_case_id;
  IF r.case_id IS NULL THEN
    RAISE EXCEPTION 'no such compensation case %', p_case_id USING ERRCODE = 'no_data_found';
  END IF;
  SELECT s.allocated_amount, s.released_amount INTO r.allocated_amount, r.released_amount
  FROM api.case_settlement(p_case_id) s;
  r.outstanding_amount := r.approved_amount - r.released_amount;
  r.is_settled := r.outstanding_amount <= 0;
  RETURN r;
END $function$;

-- Caps: the voucher side stays in net terms (allocations split the cheque);
-- the case side is what live allocations settle (gross) against the payable
-- award. SECURITY DEFINER so the cap counts allocations in every province.
CREATE OR REPLACE FUNCTION lms.tg_allocation_limits()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE v_pay uuid; v_case uuid; v_sum numeric; v_limit numeric; v_code text;
BEGIN
  v_pay  := coalesce(NEW.payment_id, OLD.payment_id);
  v_case := coalesce(NEW.case_id, OLD.case_id);

  SELECT coalesce(sum(amount),0) INTO v_sum FROM lms.payment_allocation WHERE payment_id = v_pay;
  SELECT net_amount, code INTO v_limit, v_code FROM lms.payment_request WHERE id = v_pay;
  IF v_limit IS NOT NULL AND v_sum > v_limit + 0.001 THEN
    RAISE EXCEPTION 'allocations on voucher % total % but its net payable is %',
      v_code, v_sum, v_limit USING ERRCODE = 'check_violation';
  END IF;

  SELECT coalesce(sum(s.settled_gross) FILTER (WHERE s.is_live), 0) INTO v_sum
  FROM lms.allocation_settlement s WHERE s.case_id = v_case;
  SELECT c.total_amount + coalesce((SELECT sum(a.amount) FROM lms.case_adjustment a WHERE a.case_id = c.id), 0), c.code
    INTO v_limit, v_code FROM lms.compensation_case c WHERE c.id = v_case;
  IF v_limit IS NOT NULL AND v_sum > v_limit + 0.001 THEN
    RAISE EXCEPTION 'allocations against case % settle % (gross of withholding tax) but its payable award is %',
      v_code, v_sum, v_limit USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $function$;
REVOKE ALL ON FUNCTION lms.tg_allocation_limits() FROM PUBLIC;

-- Holds resolved one way everywhere (PAY-M2): through the voucher header
-- and through every allocation target (case, owner, the case's parcels).
CREATE FUNCTION lms.hold_for(p_payment uuid, p_case uuid, p_landowner uuid, p_project uuid, p_lease uuid)
 RETURNS TABLE(hold_id uuid, reason text, legal_case_id uuid, placed_at timestamptz)
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
    OR (h.scope = 'survey'    AND (EXISTS (SELECT 1 FROM lms.case_lease_line l WHERE l.case_id = p_case AND l.survey_id = h.survey_id)
                                OR EXISTS (SELECT 1 FROM lms.lease_survey ls WHERE ls.lease_id = p_lease AND ls.survey_id = h.survey_id))));
$function$;
REVOKE ALL ON FUNCTION lms.hold_for(uuid, uuid, uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.hold_for(uuid, uuid, uuid, uuid, uuid) TO lms_readwrite, lms_readonly;

CREATE FUNCTION lms.payment_active_hold(p_payment uuid)
 RETURNS TABLE(hold_id uuid, reason text, legal_case_id uuid)
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT x.hold_id, x.reason, x.legal_case_id
  FROM lms.payment_request pr
  CROSS JOIN LATERAL (
    SELECT * FROM lms.hold_for(pr.id, pr.case_id, pr.landowner_id, pr.project_id, pr.lease_id)
    UNION ALL
    SELECT h.* FROM lms.payment_allocation al
    CROSS JOIN LATERAL lms.hold_for(NULL, al.case_id, al.landowner_id, NULL, NULL) h
    WHERE al.payment_id = pr.id
  ) x
  WHERE pr.id = p_payment
  ORDER BY x.placed_at DESC
  LIMIT 1;
$function$;
REVOKE ALL ON FUNCTION lms.payment_active_hold(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.payment_active_hold(uuid) TO lms_readwrite, lms_readonly;

-- Allocation (PAY-H1): money can only settle an approved case of the same
-- project and province, the case the voucher was raised for, an owner on the
-- case within the owner's share, and nothing on hold.
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
    RAISE EXCEPTION 'payment % is outside your province access', v_pay.code
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_pay.stage_code IN ('Cancelled','Stopped') OR v_pay.reversed_at IS NOT NULL THEN
    RAISE EXCEPTION 'payment % is % and cannot be allocated', v_pay.code,
      CASE WHEN v_pay.reversed_at IS NOT NULL THEN 'reversed' ELSE v_pay.stage_code END
      USING ERRCODE = 'raise_exception';
  END IF;

  SELECT c.id, c.code, c.province_code, c.project_id, c.stage_code INTO v_case
  FROM lms.compensation_case c WHERE c.id = p_case_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such compensation case %', p_case_id USING ERRCODE = 'no_data_found';
  END IF;
  IF lms.actor_role() <> 'Admin' AND NOT lms.actor_can_see_province(v_case.province_code) THEN
    RAISE EXCEPTION 'case % is outside your province access', v_case.code USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_case.stage_code <> 'HO Approved' THEN
    RAISE EXCEPTION 'case % is %; payments can only be allocated to an approved case', v_case.code, v_case.stage_code
      USING ERRCODE = 'raise_exception';
  END IF;
  IF v_case.project_id <> v_pay.project_id OR v_case.province_code <> v_pay.province_code THEN
    RAISE EXCEPTION 'voucher % belongs to a different project or province than case %', v_pay.code, v_case.code
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

-- Budget (PAY-M1): cost is the gross of released, unreversed vouchers.
-- Committed = what approved awards still owe (payable − paid, never below 0
-- per case) + the part of pending vouchers not allocated to a case; a pending
-- voucher allocated to a case is inside its case's balance, so it is counted
-- once. Years remain calendar years of period_from / approval (unchanged).
CREATE OR REPLACE FUNCTION api.budget_status(p_project_id uuid, p_year integer)
 RETURNS api.budget_position
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE r api.budget_position; v_pending numeric; v_open_cases numeric;
BEGIN
  r.project_id := p_project_id;
  r.fiscal_year := p_year;

  SELECT b.approved_amount INTO r.approved_amount
  FROM lms.budget b WHERE b.project_id = p_project_id AND b.fiscal_year = p_year;

  SELECT coalesce(sum(pr.gross_amount), 0) INTO r.released_amount
  FROM lms.payment_release rel
  JOIN lms.payment_request pr ON pr.id = rel.payment_id
  WHERE pr.project_id = p_project_id
    AND extract(year from pr.period_from) = p_year
    AND NOT EXISTS (SELECT 1 FROM lms.payment_release_reversal rv WHERE rv.release_id = rel.id);

  SELECT coalesce(sum(pr.gross_amount - coalesce(a.settled, 0)), 0) INTO v_pending
  FROM lms.payment_request pr
  LEFT JOIN (SELECT s.payment_id, sum(s.settled_gross) AS settled FROM lms.allocation_settlement s GROUP BY s.payment_id) a
         ON a.payment_id = pr.id
  WHERE pr.project_id = p_project_id
    AND pr.stage_code IN ('Requested','Verified')
    AND extract(year from pr.period_from) = p_year;

  SELECT coalesce(sum(greatest(m.payable_amount - m.paid_amount, 0)), 0) INTO v_open_cases
  FROM lms.case_money m
  JOIN lms.compensation_case c ON c.id = m.case_id
  WHERE c.project_id = p_project_id
    AND c.stage_code = 'HO Approved'
    AND extract(year from coalesce(c.approved_at::date, c.case_date)) = p_year;

  r.committed_amount := v_pending + v_open_cases;
  r.balance_amount := coalesce(r.approved_amount, 0) - r.released_amount - r.committed_amount;
  r.utilisation_pct := CASE WHEN coalesce(r.approved_amount,0) > 0
    THEN round((r.released_amount + r.committed_amount) * 100 / r.approved_amount, 2)
    ELSE NULL END;
  RETURN r;
END $function$;

-- The release guard: one hold rule, and a budget check that does not count
-- the voucher under test twice (it is already inside committed).
CREATE OR REPLACE FUNCTION lms.wf_guard_payments(p_id uuid, p_to text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE p record; h record; b record;
BEGIN
  SELECT pr.id, pr.project_id, pr.period_from INTO p FROM lms.payment_request pr WHERE pr.id = p_id;

  SELECT x.hold_id, x.reason, lc.code AS legal_code, lc.court_case_no
  INTO h
  FROM lms.payment_active_hold(p_id) x
  LEFT JOIN lms.legal_case lc ON lc.id = x.legal_case_id;
  IF h.hold_id IS NOT NULL THEN
    RETURN format('Payment is on hold: %s%s', h.reason,
      CASE WHEN h.legal_code IS NOT NULL
           THEN format(' (%s, court case %s)', h.legal_code, h.court_case_no) ELSE '' END);
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

-- Person statement (RPT-06/PAY-C4), same signature: credits are the owner's
-- share of each approved award and its adjustments; debits are the payments
-- attributed to the owner on the gross basis; a reversal credits back. Other
-- money paid to the person (lease rent and anything not allocated to a case)
-- is listed but does not move the compensation balance.
CREATE OR REPLACE FUNCTION api.report_landowner_statement(p_landowner_id uuid)
 RETURNS TABLE(landowner_code record_code, full_name text, cnic cnic, entry_date date, entry_type text, reference record_code, description text, amount numeric, running_total numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  WITH lo AS (
    SELECT l.id, l.code, l.full_name, l.cnic FROM lms.landowner l WHERE l.id = p_landowner_id
  ), own AS (
    SELECT om.case_id, om.share_pct, om.owner_count, om.attributed_payable, c.code AS case_code, c.approved_at, c.total_amount
    FROM lms.case_owner_money om JOIN lms.compensation_case c ON c.id = om.case_id
    WHERE om.landowner_id = p_landowner_id AND om.stage_code = 'HO Approved'
  ), adj AS (
    SELECT a.case_id, a.created_at, a.amount, a.reason, round(a.amount * own.share_pct / 100, 2) AS share_amount
    FROM lms.case_adjustment a JOIN own ON own.case_id = a.case_id
  ), pays AS (
    SELECT s.*, own.case_code, pr.code AS voucher_code
    FROM lms.allocation_settlement s
    JOIN own ON own.case_id = s.case_id
    JOIN lms.payment_request pr ON pr.id = s.payment_id
    WHERE s.release_id IS NOT NULL
      AND (s.landowner_id = p_landowner_id OR (s.landowner_id IS NULL AND own.owner_count = 1))
  ), entries AS (
    SELECT own.approved_at::date AS entry_date, 1 AS ord, 'Compensation approved'::text AS entry_type, own.case_code::text AS reference,
           format('share %s%% of the approved award of %s', own.share_pct, own.total_amount) AS description,
           (own.attributed_payable - coalesce((SELECT sum(adj.share_amount) FROM adj WHERE adj.case_id = own.case_id), 0))::numeric AS amount,
           1 AS sign
    FROM own
    UNION ALL
    SELECT adj.created_at::date, 2, 'Award adjustment', (SELECT case_code FROM own WHERE own.case_id = adj.case_id)::text,
           format('share of an adjustment of %s: %s', adj.amount, adj.reason), adj.share_amount, 1
    FROM adj
    UNION ALL
    SELECT pays.cheque_date, 3, 'Compensation paid', pays.voucher_code::text,
           format('case %s · cheque %s · net %s + withholding tax %s', pays.case_code, pays.cheque_no,
                  pays.allocated_net, pays.settled_gross - pays.allocated_net),
           pays.settled_gross, -1
    FROM pays
    UNION ALL
    SELECT pays.reversed_at::date, 4, 'Payment reversed', pays.voucher_code::text,
           format('case %s · cheque %s reversed', pays.case_code, pays.cheque_no), pays.settled_gross, 1
    FROM pays WHERE pays.reversal_id IS NOT NULL
    UNION ALL
    SELECT rel.cheque_date, 5, 'Other payment (not compensation)', pr.code::text,
           format('%s · cheque %s · not allocated to a compensation case', pr.category_code, rel.cheque_no),
           (rel.released_amount - coalesce((SELECT sum(al.amount) FROM lms.payment_allocation al WHERE al.payment_id = pr.id), 0))::numeric, 0
    FROM lms.payment_release rel
    JOIN lms.payment_request pr ON pr.id = rel.payment_id
    WHERE pr.landowner_id = p_landowner_id
      AND NOT EXISTS (SELECT 1 FROM lms.payment_release_reversal rv WHERE rv.release_id = rel.id)
      AND rel.released_amount > coalesce((SELECT sum(al.amount) FROM lms.payment_allocation al WHERE al.payment_id = pr.id), 0)
  )
  SELECT lo.code, lo.full_name, lo.cnic, e.entry_date, e.entry_type, e.reference::lms.record_code, e.description, e.amount,
         sum(e.amount * e.sign) OVER (ORDER BY e.entry_date, e.ord, e.reference ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
  FROM entries e CROSS JOIN lo
  ORDER BY e.entry_date, e.ord, e.reference;
$function$;

-- Views other screens use: same columns and names, corrected values, new
-- columns at the end. outstanding_amount exists only for approved cases
-- (PAY-L1) and is signed (an over-payment is negative).
CREATE OR REPLACE VIEW api.v_case_status WITH (security_invoker = true) AS
 SELECT c.id AS case_id,
    c.code AS case_code,
    c.lease_no,
    c.province_code,
    p.code AS project_code,
    p.name AS project_name,
    c.land_use_code,
    c.case_date,
    c.effective_date,
    c.stage_code,
    st.seq AS stage_seq,
    c.approved_at,
    c.total_lease_area,
    c.total_lease_amount,
    c.total_crop_amount,
    c.total_tree_amount,
    c.total_misc_amount,
    c.total_amount,
    api.acre_ghunta((c.total_lease_area)::numeric) AS lease_area_acre_ghunta,
    o.owner_count,
    o.owner_codes,
    (CURRENT_DATE - COALESCE(t.last_acted, c.case_date)) AS days_at_stage,
    wa.assigned_group AS waiting_on_group,
    m.allocated_amount::numeric AS allocated_amount,
    m.paid_amount::numeric AS released_amount,
    m.outstanding_amount::numeric(18,2) AS outstanding_amount,
    m.adjustment_amount,
    m.payable_amount,
    m.paid_net_amount AS released_net_amount,
    m.wht_amount,
    m.reversed_amount,
    m.settlement_status
   FROM lms.compensation_case c
     JOIN lms.project p ON p.id = c.project_id
     JOIN lms.workflow_stage st ON st.workflow_code = 'cases'::text AND st.code = c.stage_code
     JOIN lms.case_money m ON m.case_id = c.id
     LEFT JOIN LATERAL ( SELECT count(*) AS owner_count,
            string_agg((lo.code)::text, ', '::text ORDER BY lo.code) AS owner_codes
           FROM lms.case_owner co
             JOIN lms.landowner lo ON lo.id = co.landowner_id
          WHERE co.case_id = c.id) o ON true
     LEFT JOIN LATERAL ( SELECT (max(wt.acted_at))::date AS last_acted
           FROM lms.workflow_transition wt
          WHERE wt.workflow_code = 'cases'::text AND wt.record_id = c.id) t ON true
     LEFT JOIN lms.workflow_assignment wa ON wa.workflow_code = 'cases'::text AND wa.record_id = c.id AND wa.closed_at IS NULL;

CREATE OR REPLACE VIEW api.v_outstanding_liability WITH (security_invoker = true) AS
 SELECT c.id AS case_id,
    c.code AS case_code,
    c.province_code,
    p.code AS project_code,
    p.name AS project_name,
    c.approved_at,
    c.total_amount AS approved_amount,
    m.allocated_amount::numeric AS allocated_amount,
    m.paid_amount::numeric AS released_amount,
    m.outstanding_amount::numeric(18,2) AS outstanding_amount,
    (CURRENT_DATE - (c.approved_at)::date) AS days_since_approval,
        CASE
            WHEN m.outstanding_amount < 0 THEN 'over-paid'::text
            WHEN m.outstanding_amount = 0 THEN 'settled'::text
            WHEN m.paid_amount = 0 THEN 'unpaid'::text
            ELSE 'part paid'::text
        END AS settlement_status,
    o.payees,
    m.adjustment_amount,
    m.payable_amount,
    m.paid_net_amount AS released_net_amount,
    m.wht_amount
   FROM lms.compensation_case c
     JOIN lms.project p ON p.id = c.project_id
     JOIN lms.case_money m ON m.case_id = c.id
     LEFT JOIN LATERAL ( SELECT string_agg(DISTINCT lo.full_name, ', '::text) AS payees
           FROM lms.case_owner co
             JOIN lms.landowner lo ON lo.id = co.landowner_id
          WHERE co.case_id = c.id) o ON true
  WHERE c.stage_code = 'HO Approved'::text;

-- Unreleased vouchers by age, with the one hold rule.
CREATE OR REPLACE VIEW api.v_finance_aging WITH (security_invoker = true) AS
 SELECT pr.id AS payment_id,
    pr.code AS payment_code,
    pr.province_code,
    pr.project_id,
    p.name AS project_name,
    pr.landowner_id,
    lo.full_name AS landowner_name,
    lo.cnic AS landowner_cnic,
    pr.case_id,
    c.code AS case_code,
    pr.category_code AS payment_category,
    pr.gross_amount,
    pr.wht_amount,
    pr.net_amount,
    pr.stage_code AS payment_status,
    (ph.hold_id IS NOT NULL) AS is_on_hold,
    ph.reason AS hold_reason,
    pr.created_at AS request_date,
    CURRENT_DATE - pr.created_at::date AS days_pending,
        CASE
            WHEN (CURRENT_DATE - pr.created_at::date) <= 30 THEN '0-30 Days'::text
            WHEN (CURRENT_DATE - pr.created_at::date) <= 60 THEN '31-60 Days'::text
            WHEN (CURRENT_DATE - pr.created_at::date) <= 90 THEN '61-90 Days'::text
            ELSE 'Over 90 Days'::text
        END AS aging_bracket
   FROM lms.payment_request pr
     LEFT JOIN lms.project p ON p.id = pr.project_id
     LEFT JOIN lms.landowner lo ON lo.id = pr.landowner_id
     LEFT JOIN lms.compensation_case c ON c.id = pr.case_id
     LEFT JOIN LATERAL lms.payment_active_hold(pr.id) ph ON true
  WHERE pr.stage_code <> ALL (ARRAY['Released'::text, 'Cancelled'::text, 'Stopped'::text]);

-- =====================================================================
-- 5. Report datasets (api.rpt_*): one row per entity, security_invoker
-- =====================================================================
-- Area columns are acres (the primary unit) named *_acres; where the unit a
-- surveyor recorded is kept, the same quantity in that unit is *_recorded
-- with recorded_unit. flag_* columns feed the per-row data-quality flags.

-- District / tehsil (or taluka) / village (deh, mouza) of every admin unit.
CREATE VIEW lms.admin_unit_lineage WITH (security_invoker = true) AS
WITH RECURSIVE up AS (
  SELECT au.id AS unit_id, au.level AS anc_level, au.name AS anc_name, au.province_code, au.parent_id AS next_id
  FROM lms.admin_unit au
  UNION ALL
  SELECT up.unit_id, p.level, p.name, up.province_code, p.parent_id
  FROM up JOIN lms.admin_unit p ON p.id = up.next_id
), lv AS (
  SELECT province_code,
         min(depth) FILTER (WHERE name ~* '^(tehsil|taluka)') AS tehsil_depth,
         max(depth) AS leaf_depth
  FROM lms.province_level GROUP BY province_code
)
SELECT up.unit_id,
       max(up.anc_name) FILTER (WHERE up.anc_level = 0) AS district,
       max(up.anc_name) FILTER (WHERE up.anc_level = lv.tehsil_depth) AS tehsil,
       max(up.anc_name) FILTER (WHERE up.anc_level = lv.leaf_depth) AS village,
       string_agg(up.anc_name, ' › ' ORDER BY up.anc_level) AS path
FROM up JOIN lv ON lv.province_code = up.province_code
GROUP BY up.unit_id;
REVOKE ALL ON lms.admin_unit_lineage FROM PUBLIC;
GRANT SELECT ON lms.admin_unit_lineage TO lms_readwrite, lms_readonly;

-- A project's parcels (UOM-08): linked through project_survey, or under a
-- live compensation case of the project. Each parcel once per project.
CREATE VIEW lms.project_parcel WITH (security_invoker = true) AS
SELECT x.project_id, x.survey_id, bool_or(x.kind = 'linked') AS linked, bool_or(x.kind = 'case') AS under_case
FROM (
  SELECT ps.project_id, ps.survey_id, 'linked'::text AS kind FROM lms.project_survey ps
  UNION ALL
  SELECT c.project_id, l.survey_id, 'case'::text
  FROM lms.case_lease_line l JOIN lms.compensation_case c ON c.id = l.case_id
  WHERE c.stage_code <> 'Cancelled'
) x
GROUP BY x.project_id, x.survey_id;
REVOKE ALL ON lms.project_parcel FROM PUBLIC;
GRANT SELECT ON lms.project_parcel TO lms_readwrite, lms_readonly;

-- The live lease register (approved, not terminated): one definition for
-- every lease count (RPT-22/27).
CREATE VIEW lms.live_lease WITH (security_invoker = true) AS
SELECT l.id AS lease_id, l.province_code, l.project_id, l.end_date, l.is_on_hold,
       coalesce(l.subsequent_area, l.initial_area)::numeric AS current_area,
       (l.end_date >= CURRENT_DATE) AS in_force,
       (l.end_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 90) AS expiring_90d
FROM lms.lease l
WHERE l.stage_code = 'Approved' AND l.terminated_on IS NULL;
REVOKE ALL ON lms.live_lease FROM PUBLIC;
GRANT SELECT ON lms.live_lease TO lms_readwrite, lms_readonly;

-- An active stay order, one definition (RPT-26).
CREATE FUNCTION lms.stay_is_active(p_stay boolean, p_status text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT coalesce(p_stay, false)
     AND p_status NOT IN ('Decided — In Favour', 'Decided — Against', 'Settled', 'Withdrawn');
$function$;
REVOKE ALL ON FUNCTION lms.stay_is_active(boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.stay_is_active(boolean, text) TO lms_readwrite, lms_readonly;

-- Parcels
CREATE VIEW api.rpt_parcel WITH (security_invoker = true) AS
WITH sh AS (
  SELECT o.survey_id, count(*) AS owner_count, sum(o.share_pct) AS share_total
  FROM lms.survey_ownership_share o GROUP BY o.survey_id
), pp AS (
  SELECT x.survey_id, count(*) AS project_count, string_agg(p.code::text, ', ' ORDER BY p.code) AS project_codes
  FROM lms.project_parcel x JOIN lms.project p ON p.id = x.project_id GROUP BY x.survey_id
), cl AS (
  SELECT l.survey_id, count(DISTINCT l.case_id) AS case_count,
         sum(coalesce(l.subsequent_area, l.lease_area))
           FILTER (WHERE lms.case_term(c.effective_date, c.case_date, c.lease_term_months) @> CURRENT_DATE) AS committed_now
  FROM lms.case_lease_line l JOIN lms.compensation_case c ON c.id = l.case_id
  WHERE c.stage_code <> 'Cancelled'
  GROUP BY l.survey_id
)
SELECT s.id AS survey_id, s.code AS parcel_code, s.survey_no, s.block_no, s.khasra_type,
       s.province_code, pv.name AS province_name, au.district, au.tehsil, au.village, au.path AS admin_path,
       s.land_class, s.status_code,
       s.total_area::numeric AS area_acres, s.recorded_area::numeric AS area_recorded, s.recorded_unit,
       coalesce(cl.committed_now, 0)::numeric AS committed_area_acres,
       coalesce(sh.owner_count, 0)::int AS owner_count,
       coalesce(sh.share_total, 0)::numeric AS share_total_pct,
       coalesce(pp.project_count, 0)::int AS project_count, pp.project_codes,
       coalesce(cl.case_count, 0)::int AS case_count,
       (s.created_at AT TIME ZONE 'Asia/Karachi')::date AS created_on,
       (s.updated_at AT TIME ZONE 'Asia/Karachi')::date AS updated_on,
       (s.land_class = 'Private' AND abs(coalesce(sh.share_total, 0) - 100) > 0.0001) AS flag_shares_not_100,
       (coalesce(cl.committed_now, 0) > s.total_area + 0.0001) AS flag_area_over_committed,
       (s.recorded_factor_confirmed IS FALSE) AS flag_recorded_provisional
FROM lms.survey s
JOIN lms.province pv ON pv.code = s.province_code
LEFT JOIN lms.admin_unit_lineage au ON au.unit_id = s.admin_unit_id
LEFT JOIN sh ON sh.survey_id = s.id
LEFT JOIN pp ON pp.survey_id = s.id
LEFT JOIN cl ON cl.survey_id = s.id;

-- Ownership shares
CREATE VIEW api.rpt_ownership WITH (security_invoker = true) AS
WITH tot AS (
  SELECT o.survey_id, sum(o.share_pct) AS share_total FROM lms.survey_ownership_share o GROUP BY o.survey_id
)
SELECT sh.id AS share_id, sh.survey_id, sh.landowner_id,
       lo.code AS owner_code, lo.full_name AS owner_name, lo.father_name, lo.cnic::text AS cnic,
       lo.owner_type::text AS owner_type, lo.status AS owner_status,
       s.province_code, au.district, au.tehsil, au.village,
       s.code AS parcel_code, s.survey_no, s.land_class, s.status_code AS parcel_status,
       sh.share_pct::numeric AS share_pct,
       s.total_area::numeric AS parcel_area_acres, s.recorded_area::numeric AS parcel_area_recorded, s.recorded_unit,
       (s.total_area * sh.share_pct / 100)::numeric AS owned_area_acres,
       (s.recorded_area * sh.share_pct / 100)::numeric AS owned_area_recorded,
       sh.effective_from, sh.revenue_doc_ref,
       (abs(coalesce(tot.share_total, 0) - 100) > 0.0001) AS flag_shares_not_100,
       (s.recorded_factor_confirmed IS FALSE) AS flag_recorded_provisional
FROM lms.survey_ownership_share sh
JOIN lms.survey s ON s.id = sh.survey_id
JOIN lms.landowner lo ON lo.id = sh.landowner_id
LEFT JOIN lms.admin_unit_lineage au ON au.unit_id = s.admin_unit_id
LEFT JOIN tot ON tot.survey_id = sh.survey_id;

-- Persons (landowners), with what is owed to and paid to each.
CREATE VIEW api.rpt_person WITH (security_invoker = true) AS
WITH holdings AS (
  SELECT o.landowner_id, count(DISTINCT o.survey_id) AS parcel_count, sum(s.total_area * o.share_pct / 100) AS owned_acres
  FROM lms.survey_ownership_share o JOIN lms.survey s ON s.id = o.survey_id
  GROUP BY o.landowner_id
), money AS (
  SELECT om.landowner_id,
         count(*) FILTER (WHERE om.stage_code <> 'Cancelled') AS case_count,
         sum(om.attributed_payable) AS payable, sum(om.paid_amount) AS paid, sum(om.paid_net_amount) AS paid_net,
         sum(om.case_unattributed_paid) AS unattributed
  FROM lms.case_owner_money om GROUP BY om.landowner_id
), other AS (
  SELECT pr.landowner_id, sum(rel.released_amount - coalesce(a.alloc, 0)) AS other_net
  FROM lms.payment_release rel
  JOIN lms.payment_request pr ON pr.id = rel.payment_id
  LEFT JOIN (SELECT al.payment_id, sum(al.amount) AS alloc FROM lms.payment_allocation al GROUP BY al.payment_id) a ON a.payment_id = pr.id
  WHERE pr.landowner_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM lms.payment_release_reversal rv WHERE rv.release_id = rel.id)
  GROUP BY pr.landowner_id
), dup AS (
  SELECT lower(btrim(l.full_name)) AS n, lower(btrim(l.father_name)) AS f
  FROM lms.landowner l GROUP BY 1, 2 HAVING count(*) > 1
)
SELECT lo.id AS landowner_id, lo.code AS owner_code, lo.full_name, lo.father_name, lo.cnic::text AS cnic,
       lo.owner_type::text AS owner_type, lo.status, lo.tax_status, lo.province_code,
       coalesce(h.parcel_count, 0)::int AS parcel_count,
       coalesce(h.owned_acres, 0)::numeric AS owned_area_acres,
       coalesce(m.case_count, 0)::int AS case_count,
       coalesce(m.payable, 0)::numeric(18,2) AS payable_amount,
       coalesce(m.paid, 0)::numeric(18,2) AS paid_amount,
       (coalesce(m.paid, 0) - coalesce(m.paid_net, 0))::numeric(18,2) AS wht_amount,
       coalesce(m.paid_net, 0)::numeric(18,2) AS paid_net_amount,
       (coalesce(m.payable, 0) - coalesce(m.paid, 0))::numeric(18,2) AS outstanding_amount,
       coalesce(o.other_net, 0)::numeric(18,2) AS other_payments_net,
       (lo.created_at AT TIME ZONE 'Asia/Karachi')::date AS created_on,
       (h.landowner_id IS NULL) AS flag_no_shares,
       (dup.n IS NOT NULL) AS flag_possible_duplicate,
       (coalesce(m.unattributed, 0) > 0) AS flag_unattributed_payment,
       (coalesce(m.payable, 0) - coalesce(m.paid, 0) < 0) AS flag_overpaid
FROM lms.landowner lo
LEFT JOIN holdings h ON h.landowner_id = lo.id
LEFT JOIN money m ON m.landowner_id = lo.id
LEFT JOIN other o ON o.landowner_id = lo.id
LEFT JOIN dup ON dup.n = lower(btrim(lo.full_name)) AND dup.f = lower(btrim(lo.father_name));

-- Acquisitions; status comes from the workflow stage, never a label.
CREATE VIEW api.rpt_acquisition WITH (security_invoker = true) AS
WITH ps AS (
  SELECT x.acquisition_id, count(*) AS parcel_count, sum(s.total_area) AS parcel_acres
  FROM lms.acquisition_survey x JOIN lms.survey s ON s.id = x.survey_id GROUP BY x.acquisition_id
), t AS (
  SELECT wt.record_id, max(wt.acted_at)::date AS last_acted
  FROM lms.workflow_transition wt WHERE wt.workflow_code = 'acquisitions' GROUP BY wt.record_id
)
SELECT a.id AS acquisition_id, a.code AS acquisition_code, a.province_code,
       p.code AS project_code, p.name AS project_name, d.name AS district,
       a.mode, a.stage_code, st.seq::int AS stage_seq,
       CASE WHEN a.stage_code = 'Handover' THEN 'Acquired'
            WHEN a.stage_code = 'Cancelled' THEN 'Cancelled' ELSE 'In progress' END AS acquisition_status,
       a.area_required::numeric AS area_required_acres,
       coalesce(ps.parcel_count, 0)::int AS parcel_count,
       coalesce(ps.parcel_acres, 0)::numeric AS parcel_area_acres,
       a.negotiated_rate::numeric AS negotiated_rate, a.target_handover_date,
       (CURRENT_DATE - coalesce(t.last_acted, a.created_at::date))::int AS days_at_stage,
       lms.user_full_name(a.negotiator_id) AS negotiator,
       (a.created_at AT TIME ZONE 'Asia/Karachi')::date AS created_on
FROM lms.acquisition a
JOIN lms.project p ON p.id = a.project_id
LEFT JOIN lms.admin_unit d ON d.id = p.district_id
LEFT JOIN lms.workflow_stage st ON st.workflow_code = 'acquisitions' AND st.code = a.stage_code
LEFT JOIN ps ON ps.acquisition_id = a.id
LEFT JOIN t ON t.record_id = a.id;

-- Compensation cases
CREATE VIEW api.rpt_case WITH (security_invoker = true) AS
WITH o AS (
  SELECT co.case_id, count(*) AS owner_count, string_agg(lo.code::text, ', ' ORDER BY lo.code) AS owner_codes
  FROM lms.case_owner co JOIN lms.landowner lo ON lo.id = co.landowner_id GROUP BY co.case_id
), t AS (
  SELECT wt.record_id, max(wt.acted_at)::date AS last_acted
  FROM lms.workflow_transition wt WHERE wt.workflow_code = 'cases' GROUP BY wt.record_id
)
SELECT c.id AS case_id, c.code AS case_code, c.lease_no, c.province_code, d.name AS district,
       p.code AS project_code, p.name AS project_name, c.land_use_code, c.stage_code, st.seq::int AS stage_seq,
       c.case_date, c.effective_date,
       (c.approved_at AT TIME ZONE 'Asia/Karachi')::date AS approved_on,
       to_char(c.approved_at AT TIME ZONE 'Asia/Karachi', 'YYYY-MM') AS approved_month,
       c.lease_term_months::int AS lease_term_months,
       c.total_lease_area::numeric AS lease_area_acres,
       coalesce(o.owner_count, 0)::int AS owner_count, o.owner_codes,
       m.assessed_amount, m.approved_amount, m.adjustment_amount, m.payable_amount, m.allocated_amount,
       m.paid_amount, m.wht_amount, m.paid_net_amount, m.reversed_amount, m.outstanding_amount,
       greatest(-coalesce(m.outstanding_amount, 0), 0)::numeric(18,2) AS overpaid_amount,
       m.settlement_status,
       (CURRENT_DATE - coalesce(t.last_acted, c.case_date))::int AS days_at_stage,
       wa.groups AS waiting_on_group,
       lms.user_full_name(c.created_by) AS prepared_by,
       (c.created_at AT TIME ZONE 'Asia/Karachi')::date AS created_on,
       (m.outstanding_amount < 0) AS flag_overpaid,
       (m.unattributed_paid_amount > 0 AND coalesce(o.owner_count, 0) > 1) AS flag_unattributed_payment
FROM lms.compensation_case c
JOIN lms.project p ON p.id = c.project_id
LEFT JOIN lms.admin_unit d ON d.id = p.district_id
JOIN lms.workflow_stage st ON st.workflow_code = 'cases' AND st.code = c.stage_code
JOIN lms.case_money m ON m.case_id = c.id
LEFT JOIN o ON o.case_id = c.id
LEFT JOIN t ON t.record_id = c.id
LEFT JOIN LATERAL (
  SELECT string_agg(DISTINCT w.assigned_group, ', ') AS groups
  FROM lms.workflow_assignment w
  WHERE w.workflow_code = 'cases' AND w.record_id = c.id AND w.closed_at IS NULL) wa ON true;

-- Case owners: each owner's part of each case.
CREATE VIEW api.rpt_case_owner WITH (security_invoker = true) AS
SELECT om.case_owner_id, om.case_id, om.landowner_id,
       c.code AS case_code, c.province_code, p.code AS project_code, c.stage_code,
       lo.code AS owner_code, lo.full_name AS owner_name, lo.cnic::text AS cnic,
       om.share_pct::numeric AS share_pct, om.owner_count::int AS owner_count,
       om.attributed_payable AS payable_amount, om.allocated_amount, om.paid_amount,
       (om.paid_amount - om.paid_net_amount)::numeric(18,2) AS wht_amount, om.paid_net_amount,
       (CASE WHEN c.stage_code = 'HO Approved' THEN om.attributed_payable - om.paid_amount END)::numeric(18,2) AS outstanding_amount,
       CASE WHEN c.stage_code = 'Cancelled' THEN 'Cancelled'
            WHEN c.stage_code <> 'HO Approved' THEN 'Not approved'
            WHEN om.attributed_payable - om.paid_amount < 0 THEN 'Overpaid'
            WHEN om.attributed_payable - om.paid_amount = 0 THEN 'Settled'
            WHEN om.paid_amount = 0 THEN 'Unpaid'
            ELSE 'Part paid' END AS settlement_status,
       om.case_unattributed_paid,
       (om.case_unattributed_paid > 0) AS flag_unattributed_payment,
       (c.stage_code = 'HO Approved' AND om.attributed_payable - om.paid_amount < 0) AS flag_overpaid
FROM lms.case_owner_money om
JOIN lms.compensation_case c ON c.id = om.case_id
JOIN lms.project p ON p.id = c.project_id
JOIN lms.landowner lo ON lo.id = om.landowner_id;

-- Payment vouchers. Periods come from the release (cheque) date (RPT-16).
CREATE VIEW api.rpt_voucher WITH (security_invoker = true) AS
WITH a AS (
  SELECT al.payment_id, sum(al.amount) AS allocated FROM lms.payment_allocation al GROUP BY al.payment_id
)
SELECT pr.id AS payment_id, pr.code AS voucher_code, pr.province_code,
       p.code AS project_code, p.name AS project_name,
       pr.category_code, pr.pay_type, pr.payment_mode,
       coalesce(lo.full_name, pr.payee_name) AS payee_name, lo.code AS payee_code, lo.cnic::text AS payee_cnic,
       c.code AS case_code, l.code AS lease_code,
       pr.period_from, pr.period_to,
       pr.gross_amount::numeric(18,2) AS gross_amount, pr.wht_pct::numeric AS wht_pct,
       pr.wht_amount::numeric(18,2) AS wht_amount, pr.net_amount::numeric(18,2) AS net_amount,
       pr.stage_code,
       (rel.id IS NOT NULL AND rv.id IS NULL) AS is_released,
       (rv.id IS NOT NULL) AS is_reversed,
       rel.cheque_no, rel.cheque_date, rel.released_amount::numeric(18,2) AS released_amount,
       to_char(rel.cheque_date, 'YYYY-MM') AS release_month,
       to_char(rel.cheque_date, 'YYYY') || '-Q' || to_char(rel.cheque_date, 'Q') AS release_quarter,
       CASE WHEN rel.cheque_date IS NULL THEN NULL
            WHEN extract(month FROM rel.cheque_date) >= 7
              THEN 'FY' || to_char(rel.cheque_date, 'YYYY') || '-' || lpad(((extract(year FROM rel.cheque_date)::int + 1) % 100)::text, 2, '0')
            ELSE 'FY' || (extract(year FROM rel.cheque_date)::int - 1)::text || '-' || to_char(rel.cheque_date, 'YY') END AS release_fiscal_year,
       (rel.released_at AT TIME ZONE 'Asia/Karachi')::date AS released_on,
       (rv.reversed_at AT TIME ZONE 'Asia/Karachi')::date AS reversed_on,
       coalesce(a.allocated, 0)::numeric(18,2) AS allocated_net,
       (pr.net_amount - coalesce(a.allocated, 0))::numeric(18,2) AS unallocated_net,
       (CASE WHEN pr.stage_code IN ('Requested','Verified') THEN CURRENT_DATE - pr.created_at::date END)::int AS days_pending,
       CASE WHEN pr.stage_code NOT IN ('Requested','Verified') THEN NULL
            WHEN CURRENT_DATE - pr.created_at::date <= 30 THEN '0-30 Days'
            WHEN CURRENT_DATE - pr.created_at::date <= 60 THEN '31-60 Days'
            WHEN CURRENT_DATE - pr.created_at::date <= 90 THEN '61-90 Days'
            ELSE 'Over 90 Days' END AS aging_bracket,
       (h.hold_id IS NOT NULL) AS on_hold, h.reason AS hold_reason,
       (pr.created_at AT TIME ZONE 'Asia/Karachi')::date AS requested_on,
       (rel.id IS NOT NULL AND rv.id IS NULL AND pr.lease_id IS NULL AND pr.dbpfc_id IS NULL
        AND pr.net_amount - coalesce(a.allocated, 0) > 0) AS flag_unallocated_payment
FROM lms.payment_request pr
JOIN lms.project p ON p.id = pr.project_id
LEFT JOIN lms.landowner lo ON lo.id = pr.landowner_id
LEFT JOIN lms.compensation_case c ON c.id = pr.case_id
LEFT JOIN lms.lease l ON l.id = pr.lease_id
LEFT JOIN lms.payment_release rel ON rel.payment_id = pr.id
LEFT JOIN lms.payment_release_reversal rv ON rv.release_id = rel.id
LEFT JOIN a ON a.payment_id = pr.id
LEFT JOIN LATERAL lms.payment_active_hold(pr.id) h ON pr.stage_code IN ('Requested','Verified');

-- Allocations: what each part of a voucher settles, and for whom.
CREATE VIEW api.rpt_allocation WITH (security_invoker = true) AS
WITH oc AS (SELECT co.case_id, count(*) AS n FROM lms.case_owner co GROUP BY co.case_id)
SELECT s.allocation_id, s.payment_id, s.case_id, s.landowner_id,
       pr.code AS voucher_code, c.code AS case_code, s.province_code, p.code AS project_code, s.category_code,
       lo.code AS owner_code, lo.full_name AS owner_name, lo.cnic::text AS cnic,
       s.allocated_net, s.settled_gross, (s.settled_gross - s.allocated_net)::numeric(18,2) AS wht_share,
       s.voucher_stage, s.is_live, s.is_paid, (s.reversal_id IS NOT NULL) AS is_reversed,
       s.cheque_no, s.cheque_date, to_char(s.cheque_date, 'YYYY-MM') AS release_month,
       (s.created_at AT TIME ZONE 'Asia/Karachi')::date AS allocated_on,
       (s.landowner_id IS NULL AND coalesce(oc.n, 0) > 1) AS flag_unattributed_payment
FROM lms.allocation_settlement s
JOIN lms.payment_request pr ON pr.id = s.payment_id
JOIN lms.compensation_case c ON c.id = s.case_id
JOIN lms.project p ON p.id = s.project_id
LEFT JOIN lms.landowner lo ON lo.id = s.landowner_id
LEFT JOIN oc ON oc.case_id = s.case_id;

-- Leases, from the canonical register.
CREATE VIEW api.rpt_lease WITH (security_invoker = true) AS
SELECT r.lease_id, r.lease_code, r.province_code, r.project_code, r.project_name, d.name AS district,
       r.case_code, r.kind, r.registration_no,
       r.initial_area::numeric AS initial_area_acres, r.current_area::numeric AS current_area_acres,
       r.start_date, r.term_years::int AS term_years, r.end_date, r.terminated_on,
       r.rate_per_acre::numeric AS rate_per_acre, r.escalation_pct::numeric AS escalation_pct,
       r.annual_rent::numeric(18,2) AS annual_rent, r.stage_code, r.lease_status,
       r.days_to_expiry::int AS days_to_expiry, r.renewal_count::int AS renewal_count,
       r.lessors, r.parcels, r.is_on_hold, r.hold_reason
FROM api.v_lease_register r
JOIN lms.lease l ON l.id = r.lease_id
JOIN lms.project p ON p.id = l.project_id
LEFT JOIN lms.admin_unit d ON d.id = p.district_id;

-- Executive summary per province, built from the registers directly (never
-- by adding up project rows) and only for the caller's provinces (DSP-17).
CREATE VIEW api.rpt_exec_province WITH (security_invoker = true) AS
WITH prov AS (
  SELECT pv.code, pv.name, pv.display_order FROM lms.province pv
  WHERE (SELECT lms.actor_role()) = 'Admin' OR pv.code = ANY ((SELECT lms.actor_provinces())::bpchar[])
), land AS (
  SELECT s.province_code, count(*) AS parcels, sum(s.total_area) AS area,
         count(*) FILTER (WHERE s.land_class = 'Government') AS gov_parcels,
         sum(s.total_area) FILTER (WHERE s.land_class = 'Government') AS gov_area,
         sum(s.total_area) FILTER (WHERE s.land_class = 'Private') AS private_area
  FROM lms.survey s GROUP BY s.province_code
), acq AS (
  SELECT a.province_code,
         count(*) FILTER (WHERE a.stage_code NOT IN ('Handover','Cancelled')) AS open_acquisitions,
         sum(a.area_required) FILTER (WHERE a.stage_code = 'Handover') AS acquired_area,
         (SELECT count(DISTINCT x.survey_id) FROM lms.acquisition a2 JOIN lms.acquisition_survey x ON x.acquisition_id = a2.id
           WHERE a2.province_code = a.province_code AND a2.stage_code = 'Handover') AS acquired_parcels
  FROM lms.acquisition a GROUP BY a.province_code
), lparcel AS (
  SELECT l.province_code, count(DISTINCT ls.survey_id) AS leased_parcels
  FROM lms.live_lease l JOIN lms.lease_survey ls ON ls.lease_id = l.lease_id WHERE l.in_force GROUP BY l.province_code
), feat AS (
  SELECT p.province_code, count(*) AS mapped_features
  FROM lms.project_spatial_feature f JOIN lms.project p ON p.id = f.project_id GROUP BY p.province_code
), lse AS (
  SELECT l.province_code, count(*) AS leases,
         count(*) FILTER (WHERE l.in_force) AS leases_in_force,
         count(*) FILTER (WHERE NOT l.in_force) AS leases_expired,
         count(*) FILTER (WHERE l.expiring_90d) AS leases_expiring_90d,
         count(*) FILTER (WHERE l.is_on_hold) AS leases_on_hold,
         sum(l.current_area) FILTER (WHERE l.in_force) AS leased_area
  FROM lms.live_lease l GROUP BY l.province_code
), cm AS (
  SELECT m.province_code, count(*) AS cases,
         count(*) FILTER (WHERE m.stage_code NOT IN ('HO Approved','Cancelled')) AS pending_cases,
         count(*) FILTER (WHERE m.stage_code = 'HO Approved') AS approved_cases,
         sum(m.assessed_amount) AS assessed, sum(m.approved_amount) AS approved,
         sum(m.adjustment_amount) FILTER (WHERE m.stage_code = 'HO Approved') AS adjustments,
         sum(m.payable_amount) AS payable, sum(m.paid_amount) AS paid, sum(m.paid_net_amount) AS paid_net,
         sum(greatest(m.outstanding_amount, 0)) AS outstanding,
         sum(greatest(-m.outstanding_amount, 0)) AS overpaid,
         count(*) FILTER (WHERE m.outstanding_amount < 0) AS overpaid_cases
  FROM lms.case_money m GROUP BY m.province_code
), vch AS (
  SELECT pr.province_code,
         sum(pr.net_amount) FILTER (WHERE pr.stage_code IN ('Requested','Verified')) AS pending_net,
         sum(pr.net_amount - coalesce(a.alloc, 0))
           FILTER (WHERE rel.id IS NOT NULL AND rv.id IS NULL AND pr.lease_id IS NULL AND pr.dbpfc_id IS NULL) AS unallocated_released,
         sum(rel.released_amount)
           FILTER (WHERE rel.id IS NOT NULL AND rv.id IS NULL AND (pr.lease_id IS NOT NULL OR pr.dbpfc_id IS NOT NULL)) AS other_released
  FROM lms.payment_request pr
  LEFT JOIN lms.payment_release rel ON rel.payment_id = pr.id
  LEFT JOIN lms.payment_release_reversal rv ON rv.release_id = rel.id
  LEFT JOIN (SELECT al.payment_id, sum(al.amount) AS alloc FROM lms.payment_allocation al GROUP BY al.payment_id) a ON a.payment_id = pr.id
  GROUP BY pr.province_code
), own AS (
  SELECT l.province_code, count(*) AS landowners FROM lms.landowner l GROUP BY l.province_code
), prj AS (
  SELECT p.province_code, count(*) AS projects, count(*) FILTER (WHERE p.status = 'Active') AS active_projects
  FROM lms.project p GROUP BY p.province_code
), grv AS (
  SELECT g.province_code, count(*) FILTER (WHERE g.stage_code NOT IN ('Resolved','Closed')) AS open_grievances
  FROM lms.grievance g GROUP BY g.province_code
), stay AS (
  SELECT lc.province_code, count(*) FILTER (WHERE lms.stay_is_active(lc.stay_order, lc.status)) AS active_stay_orders
  FROM lms.legal_case lc GROUP BY lc.province_code
)
SELECT prov.code::text AS province_code, prov.name AS province_name,
       coalesce(prj.projects, 0)::int AS projects, coalesce(prj.active_projects, 0)::int AS active_projects,
       coalesce(land.parcels, 0)::int AS parcels,
       coalesce(land.area, 0)::numeric AS area_acres,
       coalesce(land.gov_area, 0)::numeric AS gov_area_acres,
       coalesce(land.private_area, 0)::numeric AS private_area_acres,
       coalesce(acq.acquired_area, 0)::numeric AS acquired_area_acres,
       coalesce(lse.leased_area, 0)::numeric AS leased_area_acres,
       coalesce(own.landowners, 0)::int AS landowners,
       coalesce(cm.cases, 0)::int AS cases, coalesce(cm.pending_cases, 0)::int AS pending_cases,
       coalesce(cm.approved_cases, 0)::int AS approved_cases,
       coalesce(acq.open_acquisitions, 0)::int AS open_acquisitions,
       coalesce(cm.assessed, 0)::numeric(18,2) AS assessed_amount,
       coalesce(cm.approved, 0)::numeric(18,2) AS approved_amount,
       coalesce(cm.adjustments, 0)::numeric(18,2) AS adjustment_amount,
       coalesce(cm.payable, 0)::numeric(18,2) AS payable_amount,
       coalesce(cm.paid, 0)::numeric(18,2) AS paid_amount,
       (coalesce(cm.paid, 0) - coalesce(cm.paid_net, 0))::numeric(18,2) AS wht_amount,
       coalesce(cm.paid_net, 0)::numeric(18,2) AS paid_net_amount,
       coalesce(cm.outstanding, 0)::numeric(18,2) AS outstanding_amount,
       coalesce(cm.overpaid, 0)::numeric(18,2) AS overpaid_amount,
       coalesce(cm.overpaid_cases, 0)::int AS overpaid_cases,
       (coalesce(cm.payable, 0) - coalesce(cm.paid, 0))::numeric(18,2) AS net_outstanding_amount,
       coalesce(vch.pending_net, 0)::numeric(18,2) AS pending_vouchers_net,
       coalesce(vch.unallocated_released, 0)::numeric(18,2) AS unallocated_released_net,
       coalesce(vch.other_released, 0)::numeric(18,2) AS lease_and_other_released_net,
       coalesce(lse.leases, 0)::int AS leases, coalesce(lse.leases_in_force, 0)::int AS leases_in_force,
       coalesce(lse.leases_expired, 0)::int AS leases_expired, coalesce(lse.leases_expiring_90d, 0)::int AS leases_expiring_90d,
       coalesce(lse.leases_on_hold, 0)::int AS leases_on_hold,
       coalesce(grv.open_grievances, 0)::int AS open_grievances,
       coalesce(stay.active_stay_orders, 0)::int AS active_stay_orders,
       coalesce(land.gov_parcels, 0)::int AS gov_parcels,
       coalesce(acq.acquired_parcels, 0)::int AS acquired_parcels,
       coalesce(lparcel.leased_parcels, 0)::int AS leased_parcels,
       coalesce(feat.mapped_features, 0)::int AS mapped_features,
       (coalesce(cm.overpaid_cases, 0) > 0) AS flag_overpaid,
       (coalesce(vch.unallocated_released, 0) > 0) AS flag_unallocated_payment
FROM prov
LEFT JOIN land ON land.province_code = prov.code
LEFT JOIN acq ON acq.province_code = prov.code
LEFT JOIN lse ON lse.province_code = prov.code
LEFT JOIN cm ON cm.province_code = prov.code
LEFT JOIN vch ON vch.province_code = prov.code
LEFT JOIN own ON own.province_code = prov.code
LEFT JOIN prj ON prj.province_code = prov.code
LEFT JOIN grv ON grv.province_code = prov.code
LEFT JOIN stay ON stay.province_code = prov.code
LEFT JOIN lparcel ON lparcel.province_code = prov.code
LEFT JOIN feat ON feat.province_code = prov.code;

-- Executive summary per project (physical and financial progress).
CREATE VIEW api.rpt_exec_project WITH (security_invoker = true) AS
WITH land AS (
  SELECT x.project_id, count(*) AS parcels, sum(s.total_area) AS area,
         count(*) FILTER (WHERE x.linked) AS linked_parcels, count(*) FILTER (WHERE x.under_case) AS case_parcels,
         sum(s.total_area) FILTER (WHERE s.land_class = 'Government') AS gov_area
  FROM lms.project_parcel x JOIN lms.survey s ON s.id = x.survey_id GROUP BY x.project_id
), acq AS (
  SELECT a.project_id, count(*) FILTER (WHERE a.stage_code NOT IN ('Handover','Cancelled')) AS open_acquisitions,
         sum(a.area_required) FILTER (WHERE a.stage_code = 'Handover') AS acquired_area
  FROM lms.acquisition a GROUP BY a.project_id
), lse AS (
  SELECT l.project_id, count(*) AS leases, count(*) FILTER (WHERE NOT l.in_force) AS leases_expired,
         count(*) FILTER (WHERE l.expiring_90d) AS leases_expiring_90d,
         sum(l.current_area) FILTER (WHERE l.in_force) AS leased_area
  FROM lms.live_lease l GROUP BY l.project_id
), cm AS (
  SELECT m.project_id, count(*) AS cases,
         count(*) FILTER (WHERE m.stage_code NOT IN ('HO Approved','Cancelled')) AS pending_cases,
         count(*) FILTER (WHERE m.stage_code = 'HO Approved') AS approved_cases,
         sum(m.assessed_amount) AS assessed, sum(m.approved_amount) AS approved,
         sum(m.adjustment_amount) FILTER (WHERE m.stage_code = 'HO Approved') AS adjustments,
         sum(m.payable_amount) AS payable, sum(m.paid_amount) AS paid, sum(m.paid_net_amount) AS paid_net,
         sum(greatest(m.outstanding_amount, 0)) AS outstanding,
         sum(greatest(-m.outstanding_amount, 0)) AS overpaid,
         count(*) FILTER (WHERE m.outstanding_amount < 0) AS overpaid_cases
  FROM lms.case_money m GROUP BY m.project_id
), own AS (
  SELECT x.project_id, count(DISTINCT o.landowner_id) AS landowners
  FROM lms.project_parcel x JOIN lms.survey_ownership_share o ON o.survey_id = x.survey_id GROUP BY x.project_id
)
SELECT p.id AS project_id, p.code AS project_code, p.name AS project_name, p.province_code::text AS province_code,
       d.name AS district, p.type_code, p.status AS project_status,
       coalesce(land.parcels, 0)::int AS parcels, coalesce(land.linked_parcels, 0)::int AS linked_parcels,
       coalesce(land.case_parcels, 0)::int AS case_parcels,
       coalesce(land.area, 0)::numeric AS area_acres, coalesce(land.gov_area, 0)::numeric AS gov_area_acres,
       coalesce(acq.acquired_area, 0)::numeric AS acquired_area_acres,
       coalesce(lse.leased_area, 0)::numeric AS leased_area_acres,
       p.required_area::numeric AS required_area_acres,
       coalesce(own.landowners, 0)::int AS landowners,
       coalesce(cm.cases, 0)::int AS cases, coalesce(cm.pending_cases, 0)::int AS pending_cases,
       coalesce(cm.approved_cases, 0)::int AS approved_cases,
       coalesce(acq.open_acquisitions, 0)::int AS open_acquisitions,
       coalesce(cm.assessed, 0)::numeric(18,2) AS assessed_amount,
       coalesce(cm.approved, 0)::numeric(18,2) AS approved_amount,
       coalesce(cm.adjustments, 0)::numeric(18,2) AS adjustment_amount,
       coalesce(cm.payable, 0)::numeric(18,2) AS payable_amount,
       coalesce(cm.paid, 0)::numeric(18,2) AS paid_amount,
       (coalesce(cm.paid, 0) - coalesce(cm.paid_net, 0))::numeric(18,2) AS wht_amount,
       coalesce(cm.paid_net, 0)::numeric(18,2) AS paid_net_amount,
       coalesce(cm.outstanding, 0)::numeric(18,2) AS outstanding_amount,
       coalesce(cm.overpaid, 0)::numeric(18,2) AS overpaid_amount,
       (coalesce(cm.payable, 0) - coalesce(cm.paid, 0))::numeric(18,2) AS net_outstanding_amount,
       CASE WHEN coalesce(cm.overpaid_cases, 0) > 0 THEN 'Overpaid'
            WHEN coalesce(cm.payable, 0) = 0 AND coalesce(cm.paid, 0) = 0 THEN 'No activity'
            WHEN coalesce(cm.outstanding, 0) = 0 THEN 'Balanced'
            WHEN coalesce(cm.paid, 0) = 0 THEN 'Unpaid'
            ELSE 'Part paid' END AS reconciliation_status,
       coalesce(lse.leases, 0)::int AS leases, coalesce(lse.leases_expired, 0)::int AS leases_expired,
       coalesce(lse.leases_expiring_90d, 0)::int AS leases_expiring_90d,
       (coalesce(cm.overpaid_cases, 0) > 0) AS flag_overpaid
FROM lms.project p
LEFT JOIN lms.admin_unit d ON d.id = p.district_id
LEFT JOIN land ON land.project_id = p.id
LEFT JOIN acq ON acq.project_id = p.id
LEFT JOIN lse ON lse.project_id = p.id
LEFT JOIN cm ON cm.project_id = p.id
LEFT JOIN own ON own.project_id = p.id;

-- Project parcels: one row per (project, parcel), with the parcel's share of
-- the project's land (RPT-08: computed, never a literal '100%').
CREATE VIEW api.rpt_project_parcel WITH (security_invoker = true) AS
SELECT x.project_id, x.survey_id, p.code AS project_code, p.name AS project_name, p.province_code::text AS province_code,
       au.district, au.tehsil, au.village, s.code AS parcel_code, s.survey_no, s.land_class, s.status_code,
       CASE WHEN x.linked AND x.under_case THEN 'Linked and under a case' WHEN x.linked THEN 'Linked' ELSE 'Under a case only' END AS link_kind,
       s.total_area::numeric AS area_acres, s.recorded_area::numeric AS area_recorded, s.recorded_unit,
       (100 * s.total_area / nullif(sum(s.total_area) OVER (PARTITION BY x.project_id), 0))::numeric AS pct_of_project,
       (s.recorded_factor_confirmed IS FALSE) AS flag_recorded_provisional
FROM lms.project_parcel x
JOIN lms.project p ON p.id = x.project_id
JOIN lms.survey s ON s.id = x.survey_id
LEFT JOIN lms.admin_unit_lineage au ON au.unit_id = s.admin_unit_id;

-- Units of measure (the reference report r11).
CREATE VIEW api.rpt_unit WITH (security_invoker = true) AS
SELECT mu.code AS unit_code, mu.name AS unit_name, mu.display_order::int AS display_order,
       uc.sqm_per_unit::numeric AS sqm_per_unit,
       (a.sqm_per_unit / uc.sqm_per_unit)::numeric AS units_per_acre,
       (uc.sqm_per_unit / a.sqm_per_unit)::numeric AS acres_per_unit,
       coalesce(uc.is_confirmed, false) AS is_confirmed,
       uc.source_ref, uc.note, lower(uc.valid_range) AS valid_from,
       (SELECT string_agg(pu.province_code::text, ', ' ORDER BY pu.province_code)
          FROM lms.province_unit pu WHERE pu.unit_code = mu.code) AS provinces,
       (SELECT bool_and(pu.confirmed) FROM lms.province_unit pu WHERE pu.unit_code = mu.code) AS provinces_confirmed,
       (uc.id IS NULL) AS flag_unsupported_unit,
       (uc.id IS NOT NULL AND NOT uc.is_confirmed) AS flag_provisional_factor
FROM lms.measurement_unit mu
LEFT JOIN lms.unit_conversion uc ON uc.unit_code = mu.code AND uc.valid_range @> CURRENT_DATE
LEFT JOIN lms.unit_conversion a ON a.unit_code = 'Acre' AND a.valid_range @> CURRENT_DATE
WHERE mu.is_area;

-- Data-quality exceptions (DSP-09, RPT-24): rules that find the defects the
-- registers actually contain. One row per finding.
CREATE VIEW api.rpt_exception WITH (security_invoker = true) AS
WITH alloc AS (
  SELECT al.payment_id, sum(al.amount) AS allocated FROM lms.payment_allocation al GROUP BY al.payment_id
), shares AS (
  SELECT o.survey_id, sum(o.share_pct) AS total FROM lms.survey_ownership_share o GROUP BY o.survey_id
)
SELECT 'shares_not_100'::text AS rule, 'Share discrepancy'::text AS issue, 'error'::text AS severity,
       s.province_code::text AS province_code, 'survey'::text AS entity, s.id AS record_id, s.code::text AS record_code,
       format('Parcel %s ownership shares total %s%% (expected 100%%)', s.code, coalesce(sh.total, 0)) AS description,
       NULL::numeric(18,2) AS amount, s.updated_at AS detected_at
FROM lms.survey s LEFT JOIN shares sh ON sh.survey_id = s.id
WHERE s.land_class = 'Private' AND abs(coalesce(sh.total, 0) - 100) > 0.0001
UNION ALL
SELECT 'area_over_committed', 'Parcel area over-committed', 'error', s.province_code, 'survey', s.id, s.code,
       format('Parcel %s is %s acres; %s acres are committed to live cases in force today',
              s.code, s.total_area, lms.survey_committed_area(s.id, daterange(CURRENT_DATE, CURRENT_DATE, '[]'))),
       NULL, s.updated_at
FROM lms.survey s
WHERE EXISTS (SELECT 1 FROM lms.case_lease_line l WHERE l.survey_id = s.id)
  AND lms.survey_committed_area(s.id, daterange(CURRENT_DATE, CURRENT_DATE, '[]')) > s.total_area + 0.0001
UNION ALL
SELECT 'case_overpaid', 'Case paid above its award', 'error', m.province_code, 'compensation_case', m.case_id, m.case_code,
       format('Case %s: paid %s against a payable award of %s', m.case_code, m.paid_amount, m.payable_amount),
       (-m.outstanding_amount)::numeric(18,2), now()
FROM lms.case_money m WHERE m.outstanding_amount < 0
UNION ALL
SELECT 'released_unallocated', 'Released voucher not allocated', 'error', pr.province_code, 'payment_request', pr.id, pr.code,
       format('Voucher %s (%s) was released for %s but only %s is allocated to compensation cases',
              pr.code, pr.category_code, pr.net_amount, coalesce(a.allocated, 0)),
       (pr.net_amount - coalesce(a.allocated, 0))::numeric(18,2), rel.released_at
FROM lms.payment_request pr
JOIN lms.payment_release rel ON rel.payment_id = pr.id
LEFT JOIN alloc a ON a.payment_id = pr.id
WHERE pr.lease_id IS NULL AND pr.dbpfc_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM lms.payment_release_reversal rv WHERE rv.release_id = rel.id)
  AND pr.net_amount - coalesce(a.allocated, 0) > 0
UNION ALL
SELECT 'allocation_case_mismatch', 'Allocation to another case', 'error', pr.province_code, 'payment_allocation', al.id, pr.code,
       format('Voucher %s was raised for case %s but is allocated to case %s', pr.code, vc.code, c.code),
       al.amount, al.created_at
FROM lms.payment_allocation al
JOIN lms.payment_request pr ON pr.id = al.payment_id
JOIN lms.compensation_case c ON c.id = al.case_id
JOIN lms.compensation_case vc ON vc.id = pr.case_id
WHERE pr.case_id <> al.case_id
UNION ALL
SELECT 'allocation_unapproved_case', 'Allocation to a case that is not approved', 'error', c.province_code, 'payment_allocation', al.id, c.code,
       format('Voucher %s is allocated to case %s, which is %s', pr.code, c.code, c.stage_code),
       al.amount, al.created_at
FROM lms.payment_allocation al
JOIN lms.payment_request pr ON pr.id = al.payment_id
JOIN lms.compensation_case c ON c.id = al.case_id
WHERE c.stage_code <> 'HO Approved' AND pr.stage_code NOT IN ('Cancelled','Stopped')
UNION ALL
SELECT 'allocation_owner_not_case_owner', 'Allocation to a person who is not a case owner', 'error', c.province_code, 'payment_allocation', al.id, c.code,
       format('Voucher %s is allocated on case %s to %s, who is not an owner on the case', pr.code, c.code, lo.code),
       al.amount, al.created_at
FROM lms.payment_allocation al
JOIN lms.payment_request pr ON pr.id = al.payment_id
JOIN lms.compensation_case c ON c.id = al.case_id
JOIN lms.landowner lo ON lo.id = al.landowner_id
WHERE NOT EXISTS (SELECT 1 FROM lms.case_owner co WHERE co.case_id = al.case_id AND co.landowner_id = al.landowner_id)
UNION ALL
SELECT 'cross_province_allocation', 'Allocation across provinces', 'error', pr.province_code, 'payment_allocation', al.id, pr.code,
       format('Voucher %s (%s) is allocated to case %s (%s)', pr.code, pr.province_code, c.code, c.province_code),
       al.amount, al.created_at
FROM lms.payment_allocation al
JOIN lms.payment_request pr ON pr.id = al.payment_id
JOIN lms.compensation_case c ON c.id = al.case_id
WHERE pr.province_code <> c.province_code
UNION ALL
SELECT 'unattributed_payment', 'Payment not attributed to an owner', 'warning', m.province_code, 'compensation_case', m.case_id, m.case_code,
       format('Case %s has %s paid without naming which of its owners received it', m.case_code, m.unattributed_paid_amount),
       m.unattributed_paid_amount, now()
FROM lms.case_money m
WHERE m.unattributed_paid_amount > 0 AND (SELECT count(*) FROM lms.case_owner co WHERE co.case_id = m.case_id) > 1
UNION ALL
SELECT 'release_without_receipt', 'Release without a receipt', 'warning', rel.province_code, 'payment_release', rel.id, pr.code,
       format('Voucher %s: cheque %s of %s released on %s has no acknowledgement receipt', pr.code, rel.cheque_no, rel.released_amount, rel.cheque_date),
       rel.released_amount, rel.released_at
FROM lms.payment_release rel JOIN lms.payment_request pr ON pr.id = rel.payment_id
WHERE rel.released_at < now() - interval '30 days'
  AND NOT EXISTS (SELECT 1 FROM lms.payment_receipt r WHERE r.release_id = rel.id)
  AND NOT EXISTS (SELECT 1 FROM lms.payment_release_reversal rv WHERE rv.release_id = rel.id)
UNION ALL
SELECT 'future_cheque_date', 'Cheque dated in the future', 'warning', rel.province_code, 'payment_release', rel.id, pr.code,
       format('Voucher %s: cheque %s is dated %s', pr.code, rel.cheque_no, rel.cheque_date),
       rel.released_amount, rel.released_at
FROM lms.payment_release rel JOIN lms.payment_request pr ON pr.id = rel.payment_id
WHERE rel.cheque_date > CURRENT_DATE
UNION ALL
SELECT 'parcel_not_in_project', 'Parcel not linked to a project', 'warning', s.province_code, 'survey', s.id, s.code,
       format('Parcel %s is in no project and under no live case', s.code), NULL, s.updated_at
FROM lms.survey s
WHERE NOT EXISTS (SELECT 1 FROM lms.project_parcel x WHERE x.survey_id = s.id)
UNION ALL
SELECT 'case_parcel_outside_project', 'Case parcel not linked to the case''s project', 'warning', c.province_code, 'compensation_case', c.id, c.code,
       format('Case %s commits parcel %s, which is not linked to project %s', c.code, s.code, p.code), NULL, c.updated_at
FROM lms.case_lease_line l
JOIN lms.compensation_case c ON c.id = l.case_id
JOIN lms.survey s ON s.id = l.survey_id
JOIN lms.project p ON p.id = c.project_id
WHERE c.stage_code <> 'Cancelled'
  AND NOT EXISTS (SELECT 1 FROM lms.project_survey ps WHERE ps.project_id = c.project_id AND ps.survey_id = l.survey_id)
UNION ALL
SELECT 'case_owner_not_parcel_owner', 'Case owner holds no share in the case''s parcels', 'warning', c.province_code, 'compensation_case', c.id, c.code,
       format('Case %s names %s as an owner, who has no recorded share in any parcel of the case', c.code, lo.code), NULL, c.updated_at
FROM lms.case_owner co
JOIN lms.compensation_case c ON c.id = co.case_id
JOIN lms.landowner lo ON lo.id = co.landowner_id
WHERE c.stage_code <> 'Cancelled'
  AND EXISTS (SELECT 1 FROM lms.case_lease_line l WHERE l.case_id = c.id)
  AND NOT EXISTS (SELECT 1 FROM lms.case_lease_line l JOIN lms.survey_ownership_share o ON o.survey_id = l.survey_id
                  WHERE l.case_id = c.id AND o.landowner_id = co.landowner_id)
UNION ALL
SELECT 'possible_duplicate_person', 'Possible duplicate person', 'warning', lo.province_code, 'landowner', lo.id, lo.code,
       format('%s (%s) has the same name and father''s name as another landowner', lo.code, lo.province_code), NULL, lo.updated_at
FROM lms.landowner lo
WHERE EXISTS (SELECT 1 FROM lms.landowner o2 WHERE o2.id <> lo.id
                AND lower(btrim(o2.full_name)) = lower(btrim(lo.full_name))
                AND lower(btrim(o2.father_name)) = lower(btrim(lo.father_name)))
UNION ALL
SELECT 'lease_expired_unrenewed', 'Lease expired, not renewed', 'warning', l.province_code, 'lease', l.id, l.code,
       format('Lease %s expired on %s with no renewal', l.code, l.end_date), NULL, l.updated_at
FROM lms.lease l
WHERE l.end_date < CURRENT_DATE AND l.stage_code = 'Approved' AND l.terminated_on IS NULL
  AND NOT EXISTS (SELECT 1 FROM lms.lease_renewal lr WHERE lr.lease_id = l.id)
UNION ALL
-- Items needing management intervention (legacy report r15).
SELECT 'active_stay_order', 'Court stay order in force', 'intervention', lc.province_code, 'legal_case', lc.id, lc.code,
       format('%s, suit %s (%s): suspend acquisition and freeze payment releases on the affected land', lc.court, lc.court_case_no, lc.case_type),
       lc.financial_exposure::numeric(18,2), lc.updated_at
FROM lms.legal_case lc WHERE lms.stay_is_active(lc.stay_order, lc.status)
UNION ALL
SELECT 'payment_hold', 'Payment hold in force', 'intervention', coalesce(h.province_code, p.province_code), 'payment_hold', h.id, NULL,
       format('%s hold placed on %s: %s', h.scope, (h.placed_at AT TIME ZONE 'Asia/Karachi')::date, h.reason), NULL, h.placed_at
FROM lms.payment_hold h LEFT JOIN lms.project p ON p.id = h.project_id
WHERE h.lifted_at IS NULL
UNION ALL
SELECT 'open_grievance', 'Open grievance', 'intervention', g.province_code, 'grievance', g.id, g.code,
       format('%s grievance (%s, %s) received %s%s', g.category_code, g.grievance_type, g.severity, g.received_date,
              CASE WHEN g.due_date < CURRENT_DATE THEN ', overdue since ' || g.due_date ELSE '' END), NULL, g.updated_at
FROM lms.grievance g WHERE g.stage_code NOT IN ('Resolved','Closed');

-- Government land rate fixation (DBPFC) estimates (legacy report r7).
CREATE VIEW api.rpt_dbpfc WITH (security_invoker = true) AS
SELECT d.id AS dbpfc_id, d.code AS dbpfc_code, d.province_code, p.code AS project_code, p.name AS project_name,
       au.name AS district, d.area_acres::numeric AS area_acres,
       d.estimated_rate::numeric AS estimated_rate, d.fixed_rate::numeric AS fixed_rate, d.applied_rate::numeric AS applied_rate,
       d.annual_amount::numeric(18,2) AS annual_amount, d.committee_ref, d.meeting_date, d.stage_code, d.remarks,
       (d.fixed_rate IS NULL) AS rate_pending
FROM lms.dbpfc_estimate d
JOIN lms.project p ON p.id = d.project_id
LEFT JOIN lms.admin_unit au ON au.id = d.district_id;
REVOKE ALL ON api.rpt_dbpfc FROM PUBLIC;
GRANT SELECT ON api.rpt_dbpfc TO lms_readwrite, lms_readonly;

-- The data-quality view the dashboard reads keeps its columns; it now lists
-- every rule above. The "Missing CNIC" branch is gone: CNIC is mandatory.
CREATE OR REPLACE VIEW api.v_data_quality_audit WITH (security_invoker = true) AS
SELECT e.issue AS issue_type, e.description, e.province_code::character(3) AS province_code, e.record_id::text AS record_id,
       e.entity AS entity_name, e.detected_at AS created_at
FROM api.rpt_exception e
WHERE e.severity IN ('error', 'warning');

REVOKE ALL ON api.rpt_parcel, api.rpt_ownership, api.rpt_person, api.rpt_acquisition, api.rpt_case,
              api.rpt_case_owner, api.rpt_voucher, api.rpt_allocation, api.rpt_lease, api.rpt_exec_province,
              api.rpt_exec_project, api.rpt_project_parcel, api.rpt_unit, api.rpt_exception
  FROM PUBLIC;
GRANT SELECT ON api.rpt_parcel, api.rpt_ownership, api.rpt_person, api.rpt_acquisition, api.rpt_case,
                api.rpt_case_owner, api.rpt_voucher, api.rpt_allocation, api.rpt_lease, api.rpt_exec_province,
                api.rpt_exec_project, api.rpt_project_parcel, api.rpt_unit, api.rpt_exception
  TO lms_readwrite, lms_readonly;

-- =====================================================================
-- 6. Executive and portfolio views (same columns, corrected values)
-- =====================================================================
-- paid = gross basis on allocations (never every Released voucher in the
-- province); outstanding = sum of what each approved case still owes (an
-- over-payment never offsets another case's debt; it is reported in
-- overpaid_amount); leases from the live register; acquired and leased area
-- are the acquired / leased portions, not whole-parcel areas (UOM-11).
CREATE OR REPLACE VIEW api.v_executive_kpis WITH (security_invoker = true) AS
WITH proj_stats AS (
  SELECT count(*) AS total_projects, count(*) FILTER (WHERE p.status = 'Active') AS active_projects FROM lms.project p
), parcel_stats AS (
  SELECT count(*) AS total_parcels, coalesce(sum(s.total_area), 0)::numeric AS total_acres,
         count(*) FILTER (WHERE s.land_class = 'Government') AS gov_parcels,
         coalesce(sum(s.total_area) FILTER (WHERE s.land_class = 'Government'), 0)::numeric AS gov_acres
  FROM lms.survey s
), acq_stats AS (
  SELECT count(DISTINCT x.survey_id) AS acquired_parcels,
         coalesce((SELECT sum(a2.area_required) FROM lms.acquisition a2 WHERE a2.stage_code = 'Handover'), 0)::numeric AS acquired_acres
  FROM lms.acquisition a JOIN lms.acquisition_survey x ON x.acquisition_id = a.id
  WHERE a.stage_code = 'Handover'
), lease_land AS (
  SELECT count(DISTINCT ls.survey_id) AS leased_parcels,
         coalesce((SELECT sum(l2.current_area) FROM lms.live_lease l2 WHERE l2.in_force), 0)::numeric AS leased_acres
  FROM lms.live_lease l JOIN lms.lease_survey ls ON ls.lease_id = l.lease_id
  WHERE l.in_force
), owner_stats AS (
  SELECT count(*) AS total_landowners, count(*) FILTER (WHERE lo.cnic IS NOT NULL) AS cnic_verified_owners FROM lms.landowner lo
), comp_stats AS (
  SELECT coalesce(sum(m.approved_amount), 0)::numeric AS total_approved_compensation,
         count(*) AS total_cases,
         count(*) FILTER (WHERE m.stage_code = 'HO Approved') AS approved_cases,
         count(*) FILTER (WHERE m.stage_code NOT IN ('HO Approved','Cancelled')) AS pending_cases,
         coalesce(sum(m.paid_amount), 0)::numeric AS total_compensation_paid,
         coalesce(sum(greatest(m.outstanding_amount, 0)), 0)::numeric AS outstanding_liability,
         coalesce(sum(m.assessed_amount), 0)::numeric AS total_assessed,
         coalesce(sum(m.adjustment_amount) FILTER (WHERE m.stage_code = 'HO Approved'), 0)::numeric AS total_adjustments,
         coalesce(sum(m.payable_amount), 0)::numeric AS total_payable,
         coalesce(sum(m.wht_amount), 0)::numeric AS total_wht,
         coalesce(sum(m.paid_net_amount), 0)::numeric AS total_net_paid,
         coalesce(sum(greatest(-m.outstanding_amount, 0)), 0)::numeric AS overpaid_amount,
         count(*) FILTER (WHERE m.outstanding_amount < 0) AS overpaid_cases
  FROM lms.case_money m
), pay_stats AS (
  SELECT coalesce(sum(pr.net_amount) FILTER (WHERE pr.stage_code IN ('Requested','Verified')), 0)::numeric AS pending_payments,
         coalesce(sum(pr.net_amount - coalesce(a.alloc, 0))
           FILTER (WHERE rel.id IS NOT NULL AND rv.id IS NULL AND pr.lease_id IS NULL AND pr.dbpfc_id IS NULL), 0)::numeric AS unallocated_released,
         coalesce(sum(rel.released_amount)
           FILTER (WHERE rel.id IS NOT NULL AND rv.id IS NULL AND (pr.lease_id IS NOT NULL OR pr.dbpfc_id IS NOT NULL)), 0)::numeric AS other_released
  FROM lms.payment_request pr
  LEFT JOIN lms.payment_release rel ON rel.payment_id = pr.id
  LEFT JOIN lms.payment_release_reversal rv ON rv.release_id = rel.id
  LEFT JOIN (SELECT al.payment_id, sum(al.amount) AS alloc FROM lms.payment_allocation al GROUP BY al.payment_id) a ON a.payment_id = pr.id
), lease_stats AS (
  SELECT count(*) AS total_leases,
         count(*) FILTER (WHERE NOT l.in_force) AS expired_leases,
         count(*) FILTER (WHERE l.expiring_90d) AS expiring_90d_leases,
         count(*) FILTER (WHERE l.is_on_hold) AS hold_leases
  FROM lms.live_lease l
), risk_stats AS (
  SELECT count(*) FILTER (WHERE g.stage_code NOT IN ('Resolved','Closed')) AS open_grievances FROM lms.grievance g
), stay_stats AS (
  SELECT count(*) FILTER (WHERE lms.stay_is_active(lc.stay_order, lc.status)) AS active_stay_orders FROM lms.legal_case lc
), gis_stats AS (
  SELECT count(*) AS mapped_features FROM lms.project_spatial_feature f
)
SELECT proj_stats.total_projects::bigint, proj_stats.active_projects::bigint,
       parcel_stats.total_parcels::bigint, parcel_stats.total_acres::numeric,
       parcel_stats.gov_parcels::bigint, parcel_stats.gov_acres::numeric,
       acq_stats.acquired_parcels::bigint, acq_stats.acquired_acres::numeric,
       lease_land.leased_parcels::bigint, lease_land.leased_acres::numeric,
       owner_stats.total_landowners::bigint, owner_stats.cnic_verified_owners::bigint,
       comp_stats.total_approved_compensation::numeric, comp_stats.total_cases::bigint,
       comp_stats.approved_cases::bigint, comp_stats.pending_cases::bigint,
       comp_stats.total_compensation_paid::numeric, pay_stats.pending_payments::numeric,
       comp_stats.outstanding_liability::numeric,
       lease_stats.total_leases::bigint, lease_stats.expired_leases::bigint,
       lease_stats.expiring_90d_leases::bigint, lease_stats.hold_leases::bigint,
       risk_stats.open_grievances::bigint, stay_stats.active_stay_orders::bigint, gis_stats.mapped_features::bigint,
       comp_stats.total_assessed AS total_assessed_compensation,
       comp_stats.total_adjustments AS total_adjustments,
       comp_stats.total_payable AS total_payable_compensation,
       comp_stats.total_wht AS total_wht_on_paid,
       comp_stats.total_net_paid AS total_net_paid,
       comp_stats.overpaid_amount AS overpaid_amount,
       comp_stats.overpaid_cases::bigint AS overpaid_cases,
       (comp_stats.total_payable - comp_stats.total_compensation_paid)::numeric AS net_outstanding,
       pay_stats.unallocated_released AS unallocated_released,
       pay_stats.other_released AS lease_and_other_released
FROM proj_stats, parcel_stats, acq_stats, lease_land, owner_stats, comp_stats, pay_stats, lease_stats, risk_stats, stay_stats, gis_stats;

CREATE OR REPLACE VIEW api.v_project_portfolio WITH (security_invoker = true) AS
WITH sv AS (
  SELECT x.project_id, count(*) AS parcel_count, coalesce(sum(s.total_area), 0)::numeric AS total_area_acres,
         coalesce(sum(s.total_area) FILTER (WHERE s.land_class = 'Government'), 0)::numeric AS gov_area_acres
  FROM lms.project_parcel x JOIN lms.survey s ON s.id = x.survey_id GROUP BY x.project_id
), acq AS (
  SELECT a.project_id, coalesce(sum(a.area_required), 0)::numeric AS acquired_area_acres
  FROM lms.acquisition a WHERE a.stage_code = 'Handover' GROUP BY a.project_id
), own AS (
  SELECT x.project_id, count(DISTINCT o.landowner_id) AS landowner_count
  FROM lms.project_parcel x JOIN lms.survey_ownership_share o ON o.survey_id = x.survey_id GROUP BY x.project_id
), cs AS (
  SELECT m.project_id, count(*) AS case_count,
         coalesce(sum(m.approved_amount), 0)::numeric AS approved_compensation,
         coalesce(sum(m.paid_amount), 0)::numeric AS paid_compensation,
         coalesce(sum(greatest(m.outstanding_amount, 0)), 0)::numeric AS outstanding_liability,
         coalesce(sum(m.payable_amount), 0)::numeric AS payable_compensation,
         coalesce(sum(m.wht_amount), 0)::numeric AS wht_on_paid,
         coalesce(sum(greatest(-m.outstanding_amount, 0)), 0)::numeric AS overpaid_amount
  FROM lms.case_money m GROUP BY m.project_id
), ls AS (
  SELECT l.project_id, count(*) AS lease_count,
         count(*) FILTER (WHERE NOT l.in_force) AS expired_lease_count,
         count(*) FILTER (WHERE l.expiring_90d) AS expiring_lease_count,
         coalesce(sum(l.current_area) FILTER (WHERE l.in_force), 0)::numeric AS leased_area_acres
  FROM lms.live_lease l GROUP BY l.project_id
), ft AS (
  SELECT f.project_id, count(*) AS gis_feature_count FROM lms.project_spatial_feature f GROUP BY f.project_id
)
SELECT p.id AS project_id, p.code AS project_code, p.name AS project_name, p.province_code,
       p.status AS project_status, p.created_at AS project_created_at,
       coalesce(sv.parcel_count, 0)::bigint AS parcel_count,
       coalesce(sv.total_area_acres, 0)::numeric AS total_area_acres,
       coalesce(sv.gov_area_acres, 0)::numeric AS gov_area_acres,
       coalesce(acq.acquired_area_acres, 0)::numeric AS acquired_area_acres,
       coalesce(ls.leased_area_acres, 0)::numeric AS leased_area_acres,
       coalesce(own.landowner_count, 0)::bigint AS landowner_count,
       coalesce(cs.case_count, 0)::bigint AS case_count,
       coalesce(cs.approved_compensation, 0)::numeric AS approved_compensation,
       coalesce(cs.paid_compensation, 0)::numeric AS paid_compensation,
       coalesce(cs.outstanding_liability, 0)::numeric AS outstanding_liability,
       coalesce(ls.lease_count, 0)::bigint AS lease_count,
       coalesce(ls.expired_lease_count, 0)::bigint AS expired_lease_count,
       coalesce(ls.expiring_lease_count, 0)::bigint AS expiring_lease_count,
       coalesce(ft.gis_feature_count, 0)::bigint AS gis_feature_count,
       coalesce(cs.payable_compensation, 0)::numeric AS payable_compensation,
       coalesce(cs.wht_on_paid, 0)::numeric AS wht_on_paid,
       coalesce(cs.overpaid_amount, 0)::numeric AS overpaid_amount
FROM lms.project p
LEFT JOIN sv ON sv.project_id = p.id
LEFT JOIN acq ON acq.project_id = p.id
LEFT JOIN own ON own.project_id = p.id
LEFT JOIN cs ON cs.project_id = p.id
LEFT JOIN ls ON ls.project_id = p.id
LEFT JOIN ft ON ft.project_id = p.id;

-- The province a workflow record belongs to, from the record itself.
CREATE FUNCTION lms.record_province(p_workflow text, p_record uuid)
 RETURNS character
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE v_table text; v_prov character(3);
BEGIN
  SELECT w.entity_table INTO v_table FROM lms.workflow w WHERE w.code = p_workflow;
  IF v_table IS NULL THEN RETURN NULL; END IF;
  EXECUTE format('SELECT province_code FROM lms.%I WHERE id = $1', v_table) INTO v_prov USING p_record;
  RETURN v_prov;
END $function$;
REVOKE ALL ON FUNCTION lms.record_province(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.record_province(text, uuid) TO lms_readwrite, lms_readonly;

-- Approval bottlenecks (RPT-19): every open assignment, including those with
-- no transition yet; the province comes from the record.
CREATE OR REPLACE VIEW api.v_approval_bottleneck WITH (security_invoker = true) AS
 SELECT wf.code AS workflow_code,
    wf.label AS workflow_label,
    wa.stage_code,
    wa.assigned_group,
    (coalesce(lms.record_province(wa.workflow_code, wa.record_id), rec.province_code))::character(3) AS province_code,
    count(*) AS waiting_count,
    min(wa.assigned_at) AS oldest_assigned_at,
    round(avg(EXTRACT(epoch FROM now() - wa.assigned_at) / 86400::numeric), 1) AS avg_days_waiting,
    max(EXTRACT(epoch FROM now() - wa.assigned_at) / 86400::numeric)::integer AS max_days_waiting,
    count(*) FILTER (WHERE wa.due_at < now()) AS overdue_count
   FROM lms.workflow_assignment wa
     JOIN lms.workflow wf ON wf.code = wa.workflow_code
     LEFT JOIN LATERAL ( SELECT t.province_code
           FROM lms.workflow_transition t
          WHERE t.workflow_code = wa.workflow_code AND t.record_id = wa.record_id
          ORDER BY t.acted_at DESC
         LIMIT 1) rec ON true
  WHERE wa.closed_at IS NULL
  GROUP BY wf.code, wf.label, wa.stage_code, wa.assigned_group,
           (coalesce(lms.record_province(wa.workflow_code, wa.record_id), rec.province_code))::character(3);

-- GIS coverage (RPT-31): a feature counts only for a parcel of its own project.
CREATE OR REPLACE VIEW api.v_gis_coverage WITH (security_invoker = true) AS
 SELECT p.id AS project_id,
    p.code AS project_code,
    p.name AS project_name,
    p.province_code,
    count(DISTINCT x.survey_id) AS total_surveys,
    (SELECT count(*) FROM lms.project_spatial_feature f WHERE f.project_id = p.id) AS mapped_features,
    count(DISTINCT x.survey_id) - count(DISTINCT feat.survey_id) AS unmapped_surveys,
    round(
        CASE
            WHEN count(DISTINCT x.survey_id) > 0 THEN count(DISTINCT feat.survey_id)::numeric / count(DISTINCT x.survey_id)::numeric * 100::numeric
            ELSE 0::numeric
        END, 1) AS coverage_percentage
   FROM lms.project p
     LEFT JOIN lms.project_survey x ON x.project_id = p.id
     LEFT JOIN lms.project_spatial_feature feat ON feat.project_id = p.id AND feat.survey_id = x.survey_id
  GROUP BY p.id, p.code, p.name, p.province_code;

-- =====================================================================
-- 7. Reconciliation (PAY-H4)
-- =====================================================================
-- Keeps 0041's authorization check. Adds the checks that catch the
-- attribution gaps, applies the scope (and the caller's provinces) to every
-- check, uses the gross basis for over-release, stamps the run's province
-- when the scope has one, and closes earlier open exceptions in the same
-- scope (superseded, or cleared when no longer detected), so only the latest
-- run's exceptions are open.
CREATE OR REPLACE FUNCTION api.reconcile(p_scope text DEFAULT 'all'::text, p_scope_ref uuid DEFAULT NULL::uuid, p_as_of date DEFAULT CURRENT_DATE)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE v_actor uuid := util.require_actor(); v_run uuid; v_n integer;
        v_all boolean; v_provs character(3)[]; v_prov character(3); v_as_of timestamptz;
BEGIN
  IF NOT (iam.has_permission('payments','verify') OR iam.has_permission('payments','release')) THEN
    RAISE EXCEPTION 'permission denied: payments:verify' USING ERRCODE='insufficient_privilege';
  END IF;
  IF p_scope NOT IN ('all','project','case') THEN
    RAISE EXCEPTION 'scope must be all, project or case' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_scope <> 'all' AND p_scope_ref IS NULL THEN
    RAISE EXCEPTION 'a % scope needs its record id', p_scope USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_all := lms.actor_role() = 'Admin';
  v_provs := lms.actor_provinces();
  v_as_of := (coalesce(p_as_of, CURRENT_DATE) + 1)::timestamptz;
  v_prov := CASE p_scope
    WHEN 'project' THEN (SELECT p.province_code FROM lms.project p WHERE p.id = p_scope_ref)
    WHEN 'case' THEN (SELECT c.province_code FROM lms.compensation_case c WHERE c.id = p_scope_ref)
    ELSE CASE WHEN NOT v_all AND cardinality(v_provs) = 1 THEN v_provs[1] END END;
  IF p_scope <> 'all' AND (v_prov IS NULL OR NOT (v_all OR v_prov = ANY (v_provs))) THEN
    RAISE EXCEPTION 'no such % in your provinces', p_scope USING ERRCODE = 'no_data_found';
  END IF;

  INSERT INTO lms.reconciliation_run (scope, scope_ref, province_code, as_of, run_by)
  VALUES (p_scope, p_scope_ref, v_prov, coalesce(p_as_of, CURRENT_DATE), v_actor) RETURNING id INTO v_run;

  CREATE TEMP TABLE IF NOT EXISTS pg_temp.recon_case (case_id uuid PRIMARY KEY) ON COMMIT DROP;
  TRUNCATE pg_temp.recon_case;
  INSERT INTO pg_temp.recon_case
  SELECT c.id FROM lms.compensation_case c
  WHERE (p_scope <> 'case' OR c.id = p_scope_ref)
    AND (p_scope <> 'project' OR c.project_id = p_scope_ref)
    AND (v_all OR c.province_code = ANY (v_provs));

  -- 1. A case whose stored totals disagree with its lines.
  INSERT INTO lms.reconciliation_exception
    (run_id, kind, severity, entity, entity_id, entity_code, province_code, expected, actual, difference, detail)
  SELECT v_run, 'case_total_vs_lines', 'error', 'compensation_case', c.id, c.code, c.province_code,
         t.total_amount, c.total_amount, c.total_amount - t.total_amount,
         'stored case total does not match the sum of its lines'
  FROM lms.compensation_case c JOIN pg_temp.recon_case rc ON rc.case_id = c.id
  CROSS JOIN LATERAL api.case_totals(c.id) t
  WHERE c.stage_code NOT IN ('Cancelled','Stopped') AND c.total_amount <> t.total_amount;

  -- 2. Paid (gross basis) more than the payable award.
  INSERT INTO lms.reconciliation_exception
    (run_id, kind, severity, entity, entity_id, entity_code, province_code, expected, actual, difference, detail)
  SELECT v_run, 'over_released', 'error', 'compensation_case', m.case_id, m.case_code, m.province_code,
         m.payable_amount, m.paid_amount, m.paid_amount - m.payable_amount,
         'paid against this case (gross of withholding tax) exceeds the payable award'
  FROM lms.case_money m JOIN pg_temp.recon_case rc ON rc.case_id = m.case_id
  WHERE m.stage_code = 'HO Approved' AND m.paid_amount > m.payable_amount;

  -- 3./4. Stage label and release ledger disagree.
  INSERT INTO lms.reconciliation_exception
    (run_id, kind, severity, entity, entity_id, entity_code, province_code, detail)
  SELECT v_run, 'stage_without_release', 'error', 'payment_request', pr.id, pr.code, pr.province_code,
         'voucher stage is Released but there is no release row'
  FROM lms.payment_request pr
  WHERE pr.stage_code = 'Released'
    AND NOT EXISTS (SELECT 1 FROM lms.payment_release r WHERE r.payment_id = pr.id)
    AND (p_scope <> 'case' OR pr.case_id = p_scope_ref) AND (p_scope <> 'project' OR pr.project_id = p_scope_ref)
    AND (v_all OR pr.province_code = ANY (v_provs));

  INSERT INTO lms.reconciliation_exception
    (run_id, kind, severity, entity, entity_id, entity_code, province_code, detail)
  SELECT v_run, 'release_without_stage', 'error', 'payment_request', pr.id, pr.code, pr.province_code,
         format('a release exists but the voucher stage is %s', pr.stage_code)
  FROM lms.payment_release r JOIN lms.payment_request pr ON pr.id = r.payment_id
  WHERE pr.stage_code <> 'Released' AND r.released_at < v_as_of
    AND (p_scope <> 'case' OR pr.case_id = p_scope_ref) AND (p_scope <> 'project' OR pr.project_id = p_scope_ref)
    AND (v_all OR pr.province_code = ANY (v_provs));

  -- 5. Released amount not equal to the voucher net payable.
  INSERT INTO lms.reconciliation_exception
    (run_id, kind, severity, entity, entity_id, entity_code, province_code, expected, actual, difference, detail)
  SELECT v_run, 'release_amount_mismatch', 'error', 'payment_release', r.id, pr.code, pr.province_code,
         pr.net_amount, r.released_amount, r.released_amount - pr.net_amount,
         'released amount differs from the voucher net payable'
  FROM lms.payment_release r JOIN lms.payment_request pr ON pr.id = r.payment_id
  WHERE r.released_amount <> pr.net_amount AND r.released_at < v_as_of
    AND (p_scope <> 'case' OR pr.case_id = p_scope_ref) AND (p_scope <> 'project' OR pr.project_id = p_scope_ref)
    AND (v_all OR pr.province_code = ANY (v_provs));

  -- 6. Released money with no attribution to a case (not lease rent under a
  --    lease, not a DBPFC payment).
  INSERT INTO lms.reconciliation_exception
    (run_id, kind, severity, entity, entity_id, entity_code, province_code, expected, actual, difference, detail)
  SELECT v_run, 'released_unallocated', 'error', 'payment_request', pr.id, pr.code, pr.province_code,
         pr.net_amount, coalesce(a.alloc, 0), pr.net_amount - coalesce(a.alloc, 0),
         'released voucher is not fully allocated to compensation cases'
  FROM lms.payment_request pr
  JOIN lms.payment_release r ON r.payment_id = pr.id
  LEFT JOIN (SELECT al.payment_id, sum(al.amount) AS alloc FROM lms.payment_allocation al GROUP BY al.payment_id) a ON a.payment_id = pr.id
  WHERE pr.lease_id IS NULL AND pr.dbpfc_id IS NULL AND r.released_at < v_as_of
    AND NOT EXISTS (SELECT 1 FROM lms.payment_release_reversal rv WHERE rv.release_id = r.id)
    AND pr.net_amount - coalesce(a.alloc, 0) > 0
    AND (p_scope <> 'case' OR pr.case_id = p_scope_ref) AND (p_scope <> 'project' OR pr.project_id = p_scope_ref)
    AND (v_all OR pr.province_code = ANY (v_provs));

  -- 7. Allocation rules: another case than the voucher's, a case that is not
  --    approved, an owner not on the case, across provinces.
  INSERT INTO lms.reconciliation_exception
    (run_id, kind, severity, entity, entity_id, entity_code, province_code, actual, detail)
  SELECT v_run, x.kind, 'error', 'payment_allocation', al.id, pr.code, c.province_code, al.amount, x.detail
  FROM lms.payment_allocation al
  JOIN lms.payment_request pr ON pr.id = al.payment_id
  JOIN lms.compensation_case c ON c.id = al.case_id
  JOIN pg_temp.recon_case rc ON rc.case_id = c.id
  CROSS JOIN LATERAL (VALUES
    (CASE WHEN pr.case_id IS NOT NULL AND pr.case_id <> al.case_id THEN 'allocation_case_mismatch' END,
     format('voucher %s was raised for another case than %s', pr.code, c.code)),
    (CASE WHEN c.stage_code <> 'HO Approved' AND pr.stage_code NOT IN ('Cancelled','Stopped') THEN 'allocation_unapproved_case' END,
     format('voucher %s is allocated to case %s, which is %s', pr.code, c.code, c.stage_code)),
    (CASE WHEN al.landowner_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM lms.case_owner co WHERE co.case_id = al.case_id AND co.landowner_id = al.landowner_id)
          THEN 'allocation_owner_not_case_owner' END,
     format('voucher %s names an owner who is not on case %s', pr.code, c.code)),
    (CASE WHEN pr.province_code <> c.province_code THEN 'cross_province_allocation' END,
     format('voucher %s (%s) is allocated to case %s (%s)', pr.code, pr.province_code, c.code, c.province_code))
  ) x(kind, detail)
  WHERE x.kind IS NOT NULL AND al.created_at < v_as_of;

  -- 8. A release older than 30 days with no acknowledgement receipt (warning).
  INSERT INTO lms.reconciliation_exception
    (run_id, kind, severity, entity, entity_id, entity_code, province_code, actual, detail)
  SELECT v_run, 'release_without_receipt', 'warning', 'payment_release', r.id, pr.code, pr.province_code, r.released_amount,
         format('cheque %s released on %s has no acknowledgement receipt', r.cheque_no, r.cheque_date)
  FROM lms.payment_release r JOIN lms.payment_request pr ON pr.id = r.payment_id
  WHERE r.released_at < least(v_as_of, now()) - interval '30 days'
    AND NOT EXISTS (SELECT 1 FROM lms.payment_receipt rc WHERE rc.release_id = r.id)
    AND NOT EXISTS (SELECT 1 FROM lms.payment_release_reversal rv WHERE rv.release_id = r.id)
    AND (p_scope <> 'case' OR pr.case_id = p_scope_ref) AND (p_scope <> 'project' OR pr.project_id = p_scope_ref)
    AND (v_all OR pr.province_code = ANY (v_provs));

  -- 9. Ownership shares over 100% on a parcel, and committed area over the parcel.
  INSERT INTO lms.reconciliation_exception
    (run_id, kind, severity, entity, entity_id, entity_code, province_code, expected, actual, difference, detail)
  SELECT v_run, 'ownership_over_100', 'error', 'survey', s.id, s.code, s.province_code,
         100, tot.share_total, tot.share_total - 100, 'ownership shares on this parcel exceed 100%'
  FROM lms.survey s
  CROSS JOIN LATERAL (SELECT api.ownership_share_total(s.id) AS share_total) tot
  WHERE tot.share_total > 100 AND p_scope = 'all' AND (v_all OR s.province_code = ANY (v_provs));

  INSERT INTO lms.reconciliation_exception
    (run_id, kind, severity, entity, entity_id, entity_code, province_code, expected, actual, difference, detail)
  SELECT v_run, 'area_over_committed', 'error', 'survey', s.id, s.code, s.province_code,
         s.total_area, v.committed, v.committed - s.total_area,
         format('%s acres committed to live cases in force on %s on a %s acre parcel', v.committed, coalesce(p_as_of, CURRENT_DATE), s.total_area)
  FROM lms.survey s
  CROSS JOIN LATERAL (SELECT lms.survey_committed_area(s.id, daterange(coalesce(p_as_of, CURRENT_DATE), coalesce(p_as_of, CURRENT_DATE), '[]')) AS committed) v
  WHERE v.committed > s.total_area + 0.0001
    AND (v_all OR s.province_code = ANY (v_provs))
    AND (p_scope = 'all' OR EXISTS (SELECT 1 FROM lms.case_lease_line l JOIN pg_temp.recon_case rc ON rc.case_id = l.case_id WHERE l.survey_id = s.id));

  -- 10. Budget overspend, as a warning.
  INSERT INTO lms.reconciliation_exception
    (run_id, kind, severity, entity, entity_id, entity_code, province_code, expected, actual, difference, detail)
  SELECT v_run, 'budget_exceeded', 'warning', 'budget', b.id, b.code, b.province_code,
         b.approved_amount, b.approved_amount - pos.balance_amount, -pos.balance_amount,
         format('project is over its %s budget by %s', b.fiscal_year, -pos.balance_amount)
  FROM lms.budget b
  CROSS JOIN LATERAL api.budget_status(b.project_id, b.fiscal_year) pos
  WHERE pos.balance_amount < 0
    AND (p_scope <> 'project' OR b.project_id = p_scope_ref) AND p_scope <> 'case'
    AND (v_all OR b.province_code = ANY (v_provs));

  -- Earlier open exceptions in this scope: superseded when found again,
  -- cleared when not.
  UPDATE lms.reconciliation_exception e
     SET resolved_at = clock_timestamp(), resolved_by = v_actor,
         resolution = CASE WHEN EXISTS (SELECT 1 FROM lms.reconciliation_exception n
                                         WHERE n.run_id = v_run AND n.kind = e.kind AND n.entity_id IS NOT DISTINCT FROM e.entity_id)
                           THEN format('superseded by reconciliation run %s', v_run)
                           ELSE format('cleared: not found by reconciliation run %s', v_run) END
   FROM lms.reconciliation_run r
   WHERE e.run_id = r.id AND e.run_id <> v_run AND e.resolved_at IS NULL
     AND r.scope = p_scope AND r.scope_ref IS NOT DISTINCT FROM p_scope_ref
     AND (v_all OR e.province_code = ANY (v_provs));

  SELECT count(*) INTO v_n FROM lms.reconciliation_exception WHERE run_id = v_run;
  UPDATE lms.reconciliation_run SET finished_at = clock_timestamp(), exception_count = v_n WHERE id = v_run;
  RETURN v_run;
END $function$;
REVOKE ALL ON FUNCTION api.reconcile(text, uuid, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.reconcile(text, uuid, date) TO lms_readwrite;

-- Finance users see the runs they started and the exceptions in their
-- provinces, whatever province the run was stamped with.
CREATE POLICY own_runs ON lms.reconciliation_run FOR SELECT USING (run_by = (SELECT util.actor_id()));
CREATE POLICY exceptions_in_my_provinces ON lms.reconciliation_exception FOR SELECT USING (
  province_code = ANY (( SELECT lms.actor_provinces() AS actor_provinces)::bpchar[]));

-- Audit trail on receipts and runs (exceptions have bigint ids, which the
-- row audit cannot key; their state changes are recorded on the row).
CREATE TRIGGER payment_receipt_audit AFTER INSERT OR UPDATE OR DELETE ON lms.payment_receipt
  FOR EACH ROW EXECUTE FUNCTION audit.tg_audit_row();
CREATE TRIGGER reconciliation_run_audit AFTER INSERT OR UPDATE OR DELETE ON lms.reconciliation_run
  FOR EACH ROW EXECUTE FUNCTION audit.tg_audit_row();

-- =====================================================================
-- 8. Indexes for report and person filters (DSP-14)
-- =====================================================================
CREATE INDEX IF NOT EXISTS landowner_province_idx ON lms.landowner (province_code);
CREATE INDEX IF NOT EXISTS landowner_cnic_trgm_idx ON lms.landowner USING gin ((cnic::text) ext.gin_trgm_ops);
CREATE INDEX IF NOT EXISTS landowner_code_trgm_idx ON lms.landowner USING gin ((code::text) ext.gin_trgm_ops);
CREATE INDEX IF NOT EXISTS payment_request_province_stage_idx ON lms.payment_request (province_code, stage_code);
CREATE INDEX IF NOT EXISTS payment_request_created_idx ON lms.payment_request (created_at);
CREATE INDEX IF NOT EXISTS payment_allocation_landowner_idx ON lms.payment_allocation (landowner_id) WHERE landowner_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS lease_province_idx ON lms.lease (province_code);
CREATE INDEX IF NOT EXISTS survey_ownership_survey_idx ON lms.survey_ownership_share (survey_id);
CREATE INDEX IF NOT EXISTS acquisition_project_stage_idx ON lms.acquisition (project_id, stage_code);
CREATE INDEX IF NOT EXISTS workflow_transition_record_idx ON lms.workflow_transition (workflow_code, record_id, acted_at DESC);

RESET ROLE;
