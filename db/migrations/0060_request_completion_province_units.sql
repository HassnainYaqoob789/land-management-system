-- =====================================================================
-- 0060  Land request completion loop · province unit sizes · purposes
-- =====================================================================
-- Client requirements of 2 Nov 2026 (docs/reports/CLIENT_REQUIREMENTS_ANALYSIS_2026-11-02.md).
--
-- 1. Land request → acquisition → "land ready".
--    The requester (often an Exploration Planner without access to the
--    acquisition register) must see how the land work is going and be told
--    when the land is ready.
--    * land_request.work_stage / work_stage_at: the stage of the record the
--      land team is working on. An acquisition created from the request copies
--      its stage here on every change (trigger below), so the requester sees
--      the progress through the request alone; row-level security on the
--      acquisition stays as it is.
--    * When that acquisition reaches Handover, its parcels become Acquired
--      (Direct Purchase, LAA 1894) or Leased (private or government lease,
--      ROW / easement: the company holds a right of use, not the title), and
--      the request moves to the new closing stage Completed.
--    * The same parcel update applies to every acquisition reaching Handover,
--      with or without a land request: Handover means the land was handed to
--      the company. Only parcels still Proposed / Under Acquisition change; a
--      Disputed or Released parcel is left for a person to decide.
--    * A request handed over for a lease, compensation case or DBPFC has no
--      acquisition; its Land Officer (Field) closes it as Completed by hand
--      (api/requests/[id]/transition COMPLETE). The guard below allows exactly
--      these two ways into Completed and none out of it.
--
-- 2. Province unit sizes.
--    The client wants unit sizes per province, editable in Settings. A
--    district-varying unit (Jireb, Bigha) can differ by province. The global
--    factors in lms.unit_conversion stay the fallback and keep every existing
--    caller unchanged; lms.province_unit_factor holds dated per-province
--    overrides. Only local units can be overridden: the definitional units
--    (Acre, Hectare, square metre / feet / yard) are exact and never vary.
--    A new factor applies to parcels recorded from then on; a parcel keeps
--    the factor it was recorded with (survey.recorded_factor), so a change
--    never silently rewrites recorded areas.
--    The survey area trigger now converts with the parcel's province factor.
--
-- 3. Purposes: the five land uses of the client's prototype that were missing.

SET ROLE lms_owner;
SELECT set_config('lms.actor_id', '00000000-0000-0000-0000-000000000001', false);

-- ---------------------------------------------------------------------
-- 1. Land request completion
-- ---------------------------------------------------------------------
ALTER TABLE lms.land_request DROP CONSTRAINT land_request_stage_ck;
ALTER TABLE lms.land_request ADD CONSTRAINT land_request_stage_ck CHECK (stage_code = ANY (ARRAY[
  'Draft', 'Submitted', 'Under Review - Ops', 'Under Review - Regional', 'Under Review - Land Affairs',
  'Returned', 'Approved', 'Handed over', 'Completed', 'Rejected', 'Withdrawn']));

ALTER TABLE lms.land_request
  ADD COLUMN work_stage        text,
  ADD COLUMN work_stage_at     timestamptz,
  ADD COLUMN completed_at      timestamptz,
  ADD COLUMN completed_by      uuid REFERENCES lms.app_user(id),
  ADD COLUMN completed_comment text;
COMMENT ON COLUMN lms.land_request.work_stage IS
  'Stage of the record created from this request (the acquisition today), copied by lms.tg_acquisition_progress so the requester sees the progress.';

-- Completed is reached only (a) by the linked acquisition reaching Handover, or
-- (b) for a non-acquisition hand-over, by a Land Officer (Field) in their own
-- name. It is final.
CREATE FUNCTION lms.tg_land_request_completed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_actor uuid := util.actor_id();
BEGIN
  IF OLD.stage_code = 'Completed' AND NEW.stage_code <> 'Completed' THEN
    RAISE EXCEPTION 'a completed land request is closed' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF NEW.stage_code = 'Completed' AND OLD.stage_code <> 'Completed' THEN
    IF OLD.stage_code <> 'Handed over' THEN
      RAISE EXCEPTION 'only a handed-over land request can be completed' USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    IF OLD.handed_over_kind = 'Acquisition' THEN
      IF NOT EXISTS (SELECT 1 FROM lms.acquisition a WHERE a.land_request_id = NEW.id AND a.stage_code = 'Handover') THEN
        RAISE EXCEPTION 'this land request completes when its acquisition reaches Handover'
          USING ERRCODE = 'object_not_in_prerequisite_state';
      END IF;
    ELSIF v_actor IS NULL OR NEW.completed_by IS DISTINCT FROM v_actor
          OR NOT ('Land Officer (Field)' = ANY (lms.actor_groups())) THEN
      RAISE EXCEPTION 'a land request is completed by a Land Officer (Field), in their own name'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION lms.tg_land_request_completed() FROM PUBLIC;
CREATE TRIGGER land_request_completed BEFORE UPDATE OF stage_code ON lms.land_request
  FOR EACH ROW EXECUTE FUNCTION lms.tg_land_request_completed();

-- An acquisition's stage → its land request; Handover → parcels and the request.
CREATE FUNCTION lms.tg_acquisition_progress() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_actor  uuid := util.actor_id();
  v_status text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.stage_code IS NOT DISTINCT FROM OLD.stage_code THEN RETURN NULL; END IF;

  IF NEW.stage_code = 'Handover' THEN
    v_status := CASE WHEN NEW.mode IN ('Direct Purchase', 'LAA 1894 Acquisition') THEN 'Acquired' ELSE 'Leased' END;
    UPDATE lms.survey s
       SET status_code = v_status, updated_at = now(), updated_by = coalesce(v_actor, s.updated_by)
      FROM lms.acquisition_survey x
     WHERE x.acquisition_id = NEW.id AND x.survey_id = s.id
       AND s.status_code IN ('Proposed', 'Under Acquisition');
  END IF;

  IF NEW.land_request_id IS NOT NULL THEN
    UPDATE lms.land_request
       SET work_stage = NEW.stage_code, work_stage_at = now(),
           updated_at = now(), updated_by = coalesce(v_actor, updated_by)
     WHERE id = NEW.land_request_id;
    IF NEW.stage_code = 'Handover' THEN
      UPDATE lms.land_request
         SET stage_code = 'Completed', pending_approver_role = 'None',
             completed_at = now(), completed_by = v_actor,
             completed_comment = 'Acquisition ' || NEW.code || ' handed over: the land is ready.'
       WHERE id = NEW.land_request_id AND stage_code = 'Handed over';
    END IF;
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION lms.tg_acquisition_progress() FROM PUBLIC;
CREATE TRIGGER acquisition_progress AFTER INSERT OR UPDATE OF stage_code ON lms.acquisition
  FOR EACH ROW EXECUTE FUNCTION lms.tg_acquisition_progress();

-- The land-request roles see their queue and notices in Approvals & Alerts.
INSERT INTO iam.role_permission (role_id, permission_id, scope_level)
SELECT r.id, p.id, 'province'
  FROM iam.role r JOIN iam.permission p ON p.resource = 'inbox' AND p.action = 'read'
 WHERE r.code IN ('exploration-planner', 'land-request-reviewer')
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- Requests already linked before this migration: copy the current stage once.
UPDATE lms.land_request lr SET work_stage = a.stage_code, work_stage_at = a.updated_at
  FROM lms.acquisition a WHERE a.land_request_id = lr.id;

-- ---------------------------------------------------------------------
-- 2. Province unit sizes
-- ---------------------------------------------------------------------
CREATE TABLE lms.province_unit_factor (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  province_code char(3) NOT NULL REFERENCES lms.province(code) ON DELETE RESTRICT,
  unit_code     text NOT NULL REFERENCES lms.measurement_unit(code) ON DELETE RESTRICT,
  sqm_per_unit  numeric(20,10) NOT NULL CHECK (sqm_per_unit > 0),
  valid_from    date NOT NULL DEFAULT current_date,
  valid_to      date,
  valid_range   daterange GENERATED ALWAYS AS (daterange(valid_from, coalesce(valid_to, 'infinity'::date), '[)')) STORED,
  is_confirmed  boolean NOT NULL DEFAULT false,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  CONSTRAINT province_unit_factor_period_ck CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT province_unit_factor_local_ck CHECK (unit_code NOT IN ('Acre', 'Hectare', 'Square Meter', 'Square Feet', 'Square Yard')),
  CONSTRAINT province_unit_factor_no_overlap EXCLUDE USING gist (province_code WITH =, unit_code WITH =, valid_range WITH &&)
);
COMMENT ON TABLE lms.province_unit_factor IS
  'Dated per-province size of a local land unit (m² per unit). Overrides lms.unit_conversion for that province; changed only through api.set_province_unit_factor.';
ALTER TABLE lms.province_unit_factor ENABLE ROW LEVEL SECURITY;
CREATE POLICY puf_read ON lms.province_unit_factor FOR SELECT USING ((SELECT util.actor_id()) IS NOT NULL);
GRANT SELECT ON lms.province_unit_factor TO lms_readwrite, lms_readonly;
CREATE TRIGGER province_unit_factor_audit AFTER INSERT OR UPDATE OR DELETE ON lms.province_unit_factor
  FOR EACH ROW EXECUTE FUNCTION audit.tg_audit_row();

-- Which units a province uses (the list its forms offer first) becomes editable too.
ALTER TABLE lms.province_unit ENABLE ROW LEVEL SECURITY;
CREATE POLICY pu_read ON lms.province_unit FOR SELECT USING (true);
CREATE POLICY pu_write ON lms.province_unit FOR ALL
  USING ((SELECT iam.has_permission('settings','update')))
  WITH CHECK ((SELECT iam.has_permission('settings','update')));
GRANT INSERT, UPDATE, DELETE ON lms.province_unit TO lms_readwrite;
CREATE TRIGGER province_unit_audit AFTER INSERT OR UPDATE OR DELETE ON lms.province_unit
  FOR EACH ROW EXECUTE FUNCTION audit.tg_audit_row();

-- Factor in force for a unit in a province: the province's own, else the global one.
CREATE FUNCTION lms.uom_factor_in(p_unit text, p_on date, p_province text)
RETURNS TABLE(unit_code text, sqm_per_unit numeric, confirmed boolean, province_specific boolean)
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT x.unit_code, x.sqm_per_unit, x.confirmed, x.province_specific FROM (
    SELECT f.unit_code, f.sqm_per_unit, f.is_confirmed AS confirmed, true AS province_specific
      FROM lms.province_unit_factor f
     WHERE p_province IS NOT NULL AND f.province_code = p_province
       AND f.unit_code = lms.uom_code(p_unit) AND f.valid_range @> p_on
    UNION ALL
    SELECT g.unit_code, g.sqm_per_unit, g.confirmed, false FROM lms.uom_factor(p_unit, p_on) g
  ) x ORDER BY x.province_specific DESC LIMIT 1;
$$;

CREATE FUNCTION lms.uom_convert_detail_in(p_value numeric, p_from text, p_to text, p_on date, p_province text)
RETURNS TABLE(value numeric, from_unit text, to_unit text, confirmed boolean, from_sqm numeric, to_sqm numeric)
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE WHEN p_value IS NULL OR f.sqm_per_unit IS NULL OR t.sqm_per_unit IS NULL THEN NULL
              WHEN f.unit_code = t.unit_code THEN p_value
              ELSE p_value * f.sqm_per_unit / t.sqm_per_unit END,
         f.unit_code, t.unit_code,
         CASE WHEN f.unit_code IS NULL OR t.unit_code IS NULL THEN NULL
              WHEN f.unit_code = t.unit_code THEN true
              ELSE f.confirmed AND t.confirmed END,
         f.sqm_per_unit, t.sqm_per_unit
  FROM (SELECT 1) one
  LEFT JOIN lms.uom_factor_in(p_from, p_on, p_province) f ON true
  LEFT JOIN lms.uom_factor_in(p_to, p_on, p_province) t ON true;
$$;
REVOKE ALL ON FUNCTION lms.uom_factor_in(text, date, text), lms.uom_convert_detail_in(numeric, text, text, date, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.uom_factor_in(text, date, text), lms.uom_convert_detail_in(numeric, text, text, date, text)
  TO lms_readwrite, lms_readonly;

-- The parcel area trigger converts with the parcel's province factor.
CREATE OR REPLACE FUNCTION lms.tg_survey_recorded_area()
 RETURNS trigger LANGUAGE plpgsql SET search_path TO 'pg_catalog', 'pg_temp' AS $function$
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
  -- An unrelated edit (province, admin unit) keeps the factor the parcel was recorded with.
  IF TG_OP = 'UPDATE' AND NEW.recorded_area IS NOT DISTINCT FROM OLD.recorded_area
     AND NEW.recorded_unit IS NOT DISTINCT FROM OLD.recorded_unit AND OLD.recorded_factor IS NOT NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO f FROM lms.uom_convert_detail_in(NEW.recorded_area, NEW.recorded_unit, 'Acre', current_date, NEW.province_code);
  IF f.value IS NULL THEN
    RAISE EXCEPTION 'unit % has no conversion factor', NEW.recorded_unit USING ERRCODE = 'check_violation';
  END IF;
  NEW.total_area := round(f.value, 4);
  NEW.recorded_factor := f.from_sqm / f.to_sqm;
  NEW.recorded_factor_confirmed := f.confirmed;
  RETURN NEW;
END $function$;

-- Set (or confirm) a province's size for a local unit, given as "units per acre".
-- Same-day changes replace the day's row; otherwise the old row is closed today
-- and a new one starts, so the history stays.
CREATE FUNCTION api.set_province_unit_factor(p_province text, p_unit text, p_units_per_acre numeric,
                                             p_confirmed boolean, p_note text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_actor uuid := util.require_actor();
  v_unit  text := lms.uom_code(p_unit);
  v_acre  numeric;
  v_sqm   numeric;
  v_cur   record;
  v_id    uuid;
BEGIN
  IF NOT iam.has_permission('settings', 'update') THEN
    RAISE EXCEPTION 'changing unit sizes needs settings:update' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM lms.province WHERE code = p_province) THEN
    RAISE EXCEPTION 'unknown province %', p_province USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_unit IS NULL OR NOT EXISTS (SELECT 1 FROM lms.measurement_unit WHERE code = v_unit) THEN
    RAISE EXCEPTION 'unknown unit %', p_unit USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_unit IN ('Acre', 'Hectare', 'Square Meter', 'Square Feet', 'Square Yard') THEN
    RAISE EXCEPTION '% is a fixed unit; its size cannot change', v_unit USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_units_per_acre IS NULL OR p_units_per_acre <= 0 OR p_units_per_acre > 1000000 THEN
    RAISE EXCEPTION 'units per acre must be a positive number' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT sqm_per_unit INTO v_acre FROM lms.uom_factor('Acre', current_date);
  v_sqm := round(v_acre / p_units_per_acre, 10);

  SELECT * INTO v_cur FROM lms.province_unit_factor
   WHERE province_code = p_province AND unit_code = v_unit AND valid_range @> current_date FOR UPDATE;
  IF FOUND AND v_cur.valid_from = current_date THEN
    UPDATE lms.province_unit_factor SET sqm_per_unit = v_sqm, is_confirmed = coalesce(p_confirmed, false),
           note = nullif(btrim(coalesce(p_note, '')), '')
     WHERE id = v_cur.id RETURNING id INTO v_id;
    RETURN v_id;
  ELSIF FOUND THEN
    UPDATE lms.province_unit_factor SET valid_to = current_date WHERE id = v_cur.id;
  END IF;
  INSERT INTO lms.province_unit_factor (province_code, unit_code, sqm_per_unit, valid_from, is_confirmed, note, created_by)
  VALUES (p_province, v_unit, v_sqm, current_date, coalesce(p_confirmed, false), nullif(btrim(coalesce(p_note, '')), ''), v_actor)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- Go back to the national factor for a unit in a province (from today on).
CREATE FUNCTION api.clear_province_unit_factor(p_province text, p_unit text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_cur record;
BEGIN
  PERFORM util.require_actor();
  IF NOT iam.has_permission('settings', 'update') THEN
    RAISE EXCEPTION 'changing unit sizes needs settings:update' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO v_cur FROM lms.province_unit_factor
   WHERE province_code = p_province AND unit_code = lms.uom_code(p_unit) AND valid_range @> current_date FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF v_cur.valid_from = current_date THEN
    DELETE FROM lms.province_unit_factor WHERE id = v_cur.id;
  ELSE
    UPDATE lms.province_unit_factor SET valid_to = current_date WHERE id = v_cur.id;
  END IF;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION api.set_province_unit_factor(text, text, numeric, boolean, text), api.clear_province_unit_factor(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.set_province_unit_factor(text, text, numeric, boolean, text), api.clear_province_unit_factor(text, text) TO lms_readwrite;

-- ---------------------------------------------------------------------
-- 3. Purposes from the client's prototype
-- ---------------------------------------------------------------------
INSERT INTO lms.land_use (code, name, display_order) VALUES
  ('Gathering Station', 'Gathering Station', 8),
  ('Processing Facility', 'Processing Facility', 9),
  ('Borrow Area (Green Area)', 'Borrow Area (Green Area)', 10),
  ('Extra Land', 'Extra Land', 11),
  ('Seismic / Exploration', 'Seismic / Exploration', 12)
ON CONFLICT (code) DO NOTHING;
UPDATE lms.land_use SET display_order = 99 WHERE code = 'Other';

DO $$
BEGIN
  IF (SELECT count(*) FROM pg_proc WHERE oid IN ('lms.tg_land_request_completed()'::regprocedure, 'lms.tg_acquisition_progress()'::regprocedure,
        'api.set_province_unit_factor(text,text,numeric,boolean,text)'::regprocedure, 'api.clear_province_unit_factor(text,text)'::regprocedure)
        AND prosecdef AND proconfig IS NOT NULL) <> 4 THEN
    RAISE EXCEPTION '0060: expected 4 definer functions with a pinned search_path';
  END IF;
END $$;

RESET ROLE;
