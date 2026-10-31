-- =====================================================================
-- 0040  Reporting: one source of unit conversion, provincial reporting
--       units, original recorded areas, report templates, export jobs
-- =====================================================================
-- Units. Two conversion paths existed: lms.unit_conversion (the documented
-- factors, with a validity period and an is_confirmed flag) and
-- lms.convert_area(), whose CASE statement repeated the numbers and did not
-- know 'Bigha' at all. lms.unit_conversion is now the only source:
--   lms.uom_factor()   the factor and whether it is confirmed, NULL if unknown;
--   lms.uom_convert()  exact conversion, NULL when either unit is unknown —
--                      callers flag it instead of guessing;
--   lms.convert_area() keeps its contract (aliases, 4 dp, error on an unknown
--                      unit) but reads the same table.
--
-- Every stored area column is in acres, the primary unit (SoW §3.2, the
-- reference's "primary unit: acre"). The unit a surveyor actually recorded was
-- not kept; lms.survey now keeps it alongside (recorded_area, recorded_unit)
-- and derives total_area from it, so reports can show both. Existing rows have
-- no recorded unit and say so rather than pretend.
--
-- lms.report_unit_default says which unit a province (optionally a land class
-- in it) reports in. Seeded defaults are proposals until the Land Department
-- approves them (approved = false is shown on every report that uses one).
SET ROLE lms_owner;
SELECT set_config('lms.actor_id', '00000000-0000-0000-0000-000000000001', true);

-- ---------------------------------------------------------------------
-- Conversion
-- ---------------------------------------------------------------------
CREATE FUNCTION lms.uom_code(p_unit text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  -- Canonical unit code for a code or a common alias; NULL if not recognised.
  SELECT CASE lower(btrim(coalesce(p_unit, '')))
    WHEN 'acre' THEN 'Acre' WHEN 'acres' THEN 'Acre' WHEN 'killa' THEN 'Acre'
    WHEN 'murabba' THEN 'Murabba'
    WHEN 'jireb' THEN 'Jireb' WHEN 'jarib' THEN 'Jireb'
    WHEN 'bigha' THEN 'Bigha' WHEN 'bega' THEN 'Bigha'
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

CREATE FUNCTION lms.uom_factor(p_unit text, p_on date DEFAULT current_date)
 RETURNS TABLE(unit_code text, sqm_per_unit numeric, confirmed boolean)
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT uc.unit_code, uc.sqm_per_unit, uc.is_confirmed
  FROM lms.unit_conversion uc
  WHERE uc.unit_code = lms.uom_code(p_unit) AND uc.valid_range @> p_on
  ORDER BY lower(uc.valid_range) DESC
  LIMIT 1;
$function$;

-- Exact: no rounding here; presentation rounds.
CREATE FUNCTION lms.uom_convert(p_value numeric, p_from text, p_to text, p_on date DEFAULT current_date)
 RETURNS numeric
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT CASE
    WHEN p_value IS NULL THEN NULL
    WHEN lms.uom_code(p_from) IS NOT NULL AND lms.uom_code(p_from) = lms.uom_code(p_to) THEN p_value
    ELSE p_value * f.sqm_per_unit / t.sqm_per_unit END
  FROM (SELECT 1) one
  LEFT JOIN lms.uom_factor(p_from, p_on) f ON true
  LEFT JOIN lms.uom_factor(p_to, p_on) t ON true;
$function$;

-- Same contract as before (4 dp, error on an unknown unit), one source of factors.
CREATE OR REPLACE FUNCTION lms.convert_area(p_value numeric, p_from_unit text, p_to_unit text, p_province text DEFAULT NULL::text)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE v numeric;
BEGIN
  IF p_value IS NULL THEN RETURN NULL; END IF;
  IF lms.uom_code(p_from_unit) IS NULL OR NOT EXISTS (SELECT 1 FROM lms.uom_factor(p_from_unit)) THEN
    RAISE EXCEPTION 'Unsupported source land measurement unit: %', p_from_unit;
  END IF;
  IF lms.uom_code(p_to_unit) IS NULL OR NOT EXISTS (SELECT 1 FROM lms.uom_factor(p_to_unit)) THEN
    RAISE EXCEPTION 'Unsupported target land measurement unit: %', p_to_unit;
  END IF;
  v := lms.uom_convert(p_value, p_from_unit, p_to_unit);
  RETURN round(v, 4);
END $function$;

REVOKE ALL ON FUNCTION lms.uom_code(text), lms.uom_factor(text, date), lms.uom_convert(numeric, text, text, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.uom_code(text), lms.uom_factor(text, date), lms.uom_convert(numeric, text, text, date)
  TO lms_readwrite, lms_readonly;

-- ---------------------------------------------------------------------
-- Provincial reporting units
-- ---------------------------------------------------------------------
CREATE TABLE lms.report_unit_default (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  province_code char(3) NOT NULL REFERENCES lms.province(code),
  land_class    text CHECK (land_class IN ('Private','Government')),
  unit_code     text NOT NULL REFERENCES lms.measurement_unit(code),
  approved      boolean NOT NULL DEFAULT false,
  note          text,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid,
  UNIQUE NULLS NOT DISTINCT (province_code, land_class)
);
COMMENT ON TABLE lms.report_unit_default IS
  'The unit land quantities are reported in for a province (land_class NULL) or a land class within it. '
  'approved = false marks a proposed default awaiting Land Department confirmation.';
ALTER TABLE lms.report_unit_default ENABLE ROW LEVEL SECURITY;
CREATE POLICY rud_read ON lms.report_unit_default FOR SELECT USING ((SELECT util.actor_id()) IS NOT NULL);
CREATE POLICY rud_write ON lms.report_unit_default FOR ALL
  USING ((SELECT iam.has_permission('settings','update')))
  WITH CHECK ((SELECT iam.has_permission('settings','update')));
GRANT SELECT ON lms.report_unit_default TO lms_readwrite, lms_readonly;
GRANT INSERT, UPDATE, DELETE ON lms.report_unit_default TO lms_readwrite;
CREATE TRIGGER report_unit_default_audit AFTER INSERT OR UPDATE OR DELETE ON lms.report_unit_default
  FOR EACH ROW EXECUTE FUNCTION audit.tg_audit_row();

-- Proposed defaults from the reference's provincial unit lists (lms.province_unit):
-- Sindh and Balochistan record land in acres (Sindh in acre-ghunta), Punjab and
-- Khyber Pakhtunkhwa in kanal-marla. Not approved until the Land Department says so.
INSERT INTO lms.report_unit_default (province_code, land_class, unit_code, approved, note) VALUES
  ('SND', NULL, 'Acre',  false, 'Proposed: Sindh revenue records are kept in acres and ghuntas'),
  ('BAL', NULL, 'Acre',  false, 'Proposed: Balochistan revenue records are kept in acres'),
  ('PNJ', NULL, 'Kanal', false, 'Proposed: Punjab revenue records are kept in kanals and marlas'),
  ('KPK', NULL, 'Kanal', false, 'Proposed: Khyber Pakhtunkhwa revenue records are kept in kanals and marlas');

CREATE FUNCTION lms.report_unit(p_province text, p_land_class text DEFAULT NULL)
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  -- The land-class row wins over the province row; acres (the primary unit) if neither exists.
  SELECT coalesce(
    (SELECT unit_code FROM lms.report_unit_default WHERE province_code = p_province AND land_class = p_land_class),
    (SELECT unit_code FROM lms.report_unit_default WHERE province_code = p_province AND land_class IS NULL),
    'Acre');
$function$;
REVOKE ALL ON FUNCTION lms.report_unit(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.report_unit(text, text) TO lms_readwrite, lms_readonly;

-- ---------------------------------------------------------------------
-- The area a surveyor recorded, in the unit they recorded it in
-- ---------------------------------------------------------------------
ALTER TABLE lms.survey
  ADD COLUMN recorded_area numeric(18,4) CHECK (recorded_area > 0),
  ADD COLUMN recorded_unit text REFERENCES lms.measurement_unit(code),
  ADD CONSTRAINT survey_recorded_pair_ck CHECK ((recorded_area IS NULL) = (recorded_unit IS NULL));
COMMENT ON COLUMN lms.survey.total_area IS 'Area in acres (the primary unit). Derived from recorded_area/recorded_unit when those are set.';
COMMENT ON COLUMN lms.survey.recorded_area IS 'Area as recorded in the revenue record, in recorded_unit. NULL for records captured before 0040 (unit not kept).';

CREATE FUNCTION lms.tg_survey_recorded_area()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE v numeric;
BEGIN
  IF NEW.recorded_area IS NOT NULL THEN
    v := lms.uom_convert(NEW.recorded_area, NEW.recorded_unit, 'Acre');
    IF v IS NULL THEN
      RAISE EXCEPTION 'unit % has no conversion factor', NEW.recorded_unit USING ERRCODE = 'check_violation';
    END IF;
    NEW.total_area := round(v, 4);
  END IF;
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION lms.tg_survey_recorded_area() FROM PUBLIC;
CREATE TRIGGER survey_recorded_area BEFORE INSERT OR UPDATE OF recorded_area, recorded_unit, total_area ON lms.survey
  FOR EACH ROW EXECUTE FUNCTION lms.tg_survey_recorded_area();

-- ---------------------------------------------------------------------
-- Report templates
-- ---------------------------------------------------------------------
CREATE TABLE lms.report_template (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL CHECK (btrim(name) <> '' AND length(name) <= 120),
  description       text CHECK (length(description) <= 500),
  dataset           text NOT NULL CHECK (dataset ~ '^[a-z_]{2,40}$'),
  config            jsonb NOT NULL CHECK (jsonb_typeof(config) = 'object' AND length(config::text) <= 20000),
  owner_id          uuid NOT NULL REFERENCES lms.app_user(id),
  visibility        text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','shared')),
  shared_department text CHECK (length(shared_department) <= 120),
  is_default        boolean NOT NULL DEFAULT false,
  export_format     text CHECK (export_format IN ('pdf','xlsx','csv','html')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  version           integer NOT NULL DEFAULT 1,
  UNIQUE (owner_id, name)
);
CREATE UNIQUE INDEX report_template_one_default_uq ON lms.report_template (owner_id, dataset) WHERE is_default;
CREATE INDEX report_template_shared_idx ON lms.report_template (dataset) WHERE visibility = 'shared';
COMMENT ON TABLE lms.report_template IS
  'Saved report configurations. config holds only field keys, filter operators and values validated by the reporting engine; never SQL.';

CREATE FUNCTION lms.tg_report_template()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.owner_id := coalesce(NEW.owner_id, util.actor_id());
    NEW.created_at := now(); NEW.updated_at := now(); NEW.version := 1;
  ELSE
    IF NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN
      RAISE EXCEPTION 'a template cannot change owner' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.created_at := OLD.created_at; NEW.updated_at := now(); NEW.version := OLD.version + 1;
  END IF;
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION lms.tg_report_template() FROM PUBLIC;
CREATE TRIGGER report_template_stamp BEFORE INSERT OR UPDATE ON lms.report_template
  FOR EACH ROW EXECUTE FUNCTION lms.tg_report_template();
CREATE TRIGGER report_template_audit AFTER INSERT OR UPDATE OR DELETE ON lms.report_template
  FOR EACH ROW EXECUTE FUNCTION audit.tg_audit_row();

ALTER TABLE lms.report_template ENABLE ROW LEVEL SECURITY;
-- Read: your own, or a shared one (optionally limited to your department).
CREATE POLICY rt_read ON lms.report_template FOR SELECT USING (
  owner_id = (SELECT util.actor_id())
  OR (visibility = 'shared' AND (SELECT iam.has_permission('reports','read'))
      AND (shared_department IS NULL
           OR shared_department = (SELECT u.department FROM lms.app_user u WHERE u.id = (SELECT util.actor_id())))));
-- Create: your own; sharing needs reports:share.
CREATE POLICY rt_insert ON lms.report_template FOR INSERT WITH CHECK (
  owner_id = (SELECT util.actor_id()) AND (SELECT iam.has_permission('reports','read'))
  AND (visibility = 'private' OR (SELECT iam.has_permission('reports','share'))));
CREATE POLICY rt_update ON lms.report_template FOR UPDATE
  USING (owner_id = (SELECT util.actor_id()))
  WITH CHECK (owner_id = (SELECT util.actor_id()) AND (visibility = 'private' OR (SELECT iam.has_permission('reports','share'))));
-- Delete: the owner, or a curator (reports:share) for shared templates.
CREATE POLICY rt_delete ON lms.report_template FOR DELETE USING (
  owner_id = (SELECT util.actor_id()) OR (visibility = 'shared' AND (SELECT iam.has_permission('reports','share'))));
GRANT SELECT, INSERT, UPDATE, DELETE ON lms.report_template TO lms_readwrite;
GRANT SELECT ON lms.report_template TO lms_readonly;

-- ---------------------------------------------------------------------
-- Export jobs (large exports run in the background as the requester)
-- ---------------------------------------------------------------------
CREATE TABLE lms.report_export_job (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requested_by uuid NOT NULL REFERENCES lms.app_user(id),
  dataset      text NOT NULL CHECK (dataset ~ '^[a-z_]{2,40}$'),
  config       jsonb NOT NULL,
  format       text NOT NULL CHECK (format IN ('pdf','xlsx','csv','html')),
  status       text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed','expired')),
  row_count    integer CHECK (row_count >= 0),
  file_sha256  text CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  file_name    text,
  mime_type    text,
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  started_at   timestamptz,
  finished_at  timestamptz,
  expires_at   timestamptz NOT NULL DEFAULT now() + interval '24 hours'
);
CREATE INDEX report_export_job_owner_idx ON lms.report_export_job (requested_by, created_at DESC);
ALTER TABLE lms.report_export_job ENABLE ROW LEVEL SECURITY;
CREATE POLICY rej_own ON lms.report_export_job FOR ALL
  USING (requested_by = (SELECT util.actor_id()))
  WITH CHECK (requested_by = (SELECT util.actor_id()));
GRANT SELECT, INSERT, UPDATE ON lms.report_export_job TO lms_readwrite;

RESET ROLE;
