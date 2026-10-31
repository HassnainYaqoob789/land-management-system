-- =====================================================================
-- 0057  Exploration land requests drawn on the GIS map
-- =====================================================================
-- Plan: docs/plans/EXPLORATION_LAND_REQUEST_GIS_PLAN.md (v2, agreed
-- 2026-10-31: land requests stay the one register; both the Exploration
-- Planner and the Land Officer may raise them).
--
-- 1. Two roles.
--    exploration-planner   The "Initiator" the land-request workflow names.
--                          Draws the land it needs on the map and raises the
--                          request. Reads projects, parcel locations and land
--                          status; no landowners, no PII, no payments.
--    land-request-reviewer Holds the Director Operations or Regional Manager
--                          position. Reads requests, parcels and the map and
--                          decides its own tier; nothing else.
--    The DM / TL Land Affairs tier is decided by a case-approver who holds
--    that position, as before.
-- 2. lms.land_request_area: the polygon of a request, one row per version.
--    A version is never changed or deleted; editing a returned request adds
--    the next version. Only the requester adds one, and only while the
--    request is a draft, returned, or has no polygon yet.
-- 3. Two stages on land_request: 'Draft' (saved, not yet sent) and
--    'Handed over' (the land team has taken the approved request up), plus
--    'Withdrawn' (the requester withdrew a draft or returned request).
--    The hand-over is recorded by a holder of the Land Officer (Field)
--    position, in their own name, on an approved request (checked here).

SET ROLE lms_owner;
SELECT set_config('lms.actor_id', '00000000-0000-0000-0000-000000000001', false);

-- ---------------------------------------------------------------------
-- 1. Roles and their permissions (province scope: the provinces a user is
--    given in lms.app_user_province, enforced by row-level security)
-- ---------------------------------------------------------------------
INSERT INTO iam.role (code, name, description, db_role_code, is_system)
VALUES
  ('exploration-planner', 'Exploration Planner',
   'Marks the land exploration needs on the GIS map (polygon) and raises land requests. Reads projects, parcel locations and land status. No landowner data, no payments, no approvals.',
   'User', true),
  ('land-request-reviewer', 'Land Request Reviewer',
   'Director Operations / Regional Manager: reviews land requests and their polygons on the map and approves, returns or rejects the tier of the position held.',
   'Approver', true)
ON CONFLICT (code) DO UPDATE
  SET name = EXCLUDED.name, description = EXCLUDED.description,
      db_role_code = EXCLUDED.db_role_code, is_system = true;

INSERT INTO iam.role_permission (role_id, permission_id, scope_level)
SELECT r.id, p.id, 'province'
FROM (VALUES
  ('exploration-planner',   'projects', 'read'),
  ('exploration-planner',   'surveys',  'read'),
  ('exploration-planner',   'gis',      'read'),
  ('exploration-planner',   'requests', 'read'),
  ('exploration-planner',   'requests', 'create'),
  ('land-request-reviewer', 'projects', 'read'),
  ('land-request-reviewer', 'surveys',  'read'),
  ('land-request-reviewer', 'gis',      'read'),
  ('land-request-reviewer', 'requests', 'read'),
  ('land-request-reviewer', 'requests', 'approve')
) AS g(role_code, resource, action)
JOIN iam.role r ON r.code = g.role_code
JOIN iam.permission p ON p.resource = g.resource AND p.action = g.action
ON CONFLICT (role_id, permission_id) DO NOTHING;

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM iam.role_permission rp JOIN iam.role r ON r.id = rp.role_id
   WHERE r.code IN ('exploration-planner', 'land-request-reviewer');
  IF n <> 10 THEN RAISE EXCEPTION '0057: expected 10 grants for the new roles, found %', n; END IF;
END $$;

-- ---------------------------------------------------------------------
-- 2. land_request: hand-over columns
-- ---------------------------------------------------------------------
ALTER TABLE lms.land_request
  ADD COLUMN handed_over_by      uuid REFERENCES lms.app_user(id),
  ADD COLUMN handed_over_at      timestamptz,
  ADD COLUMN handed_over_kind    text CHECK (handed_over_kind IN ('Acquisition', 'Lease', 'Compensation case', 'DBPFC')),
  ADD COLUMN handed_over_comment text,
  ADD COLUMN submitted_at        timestamptz;

-- Rows raised before this migration were submitted when created.
UPDATE lms.land_request SET submitted_at = created_at WHERE submitted_at IS NULL AND stage_code <> 'Draft';

ALTER TABLE lms.land_request ADD CONSTRAINT land_request_stage_ck CHECK (stage_code IN (
  'Draft', 'Submitted', 'Under Review - Ops', 'Under Review - Regional', 'Under Review - Land Affairs',
  'Returned', 'Approved', 'Handed over', 'Rejected', 'Withdrawn'));

-- The hand-over: once, on an approved request, by a Land Officer (Field) in their own name.
CREATE FUNCTION lms.tg_land_request_handover()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE v_actor uuid := util.actor_id();
BEGIN
  IF pg_has_role(session_user, 'lms_owner', 'MEMBER') THEN RETURN NEW; END IF;
  IF OLD.handed_over_by IS NOT NULL THEN
    RAISE EXCEPTION 'this land request has already been handed over' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF OLD.stage_code <> 'Approved' THEN
    RAISE EXCEPTION 'only an approved land request can be handed over' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF NEW.handed_over_by IS DISTINCT FROM v_actor OR v_actor IS NULL
     OR NOT ('Land Officer (Field)' = ANY (lms.actor_groups())) THEN
    RAISE EXCEPTION 'the hand-over is recorded by a Land Officer (Field), in their own name'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION lms.tg_land_request_handover() FROM PUBLIC;
CREATE TRIGGER land_request_handover BEFORE UPDATE OF handed_over_by ON lms.land_request
  FOR EACH ROW WHEN (NEW.handed_over_by IS DISTINCT FROM OLD.handed_over_by)
  EXECUTE FUNCTION lms.tg_land_request_handover();

-- ---------------------------------------------------------------------
-- 3. The polygon, versioned
-- ---------------------------------------------------------------------
CREATE TABLE lms.land_request_area (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  land_request_id  uuid NOT NULL REFERENCES lms.land_request(id) ON DELETE RESTRICT,
  province_code    character(3) NOT NULL REFERENCES lms.province(code),
  version          integer NOT NULL CHECK (version > 0),
  -- A GeoJSON Polygon in WGS84, [longitude, latitude]; one outer ring, closed.
  geometry         jsonb NOT NULL,
  source           text NOT NULL DEFAULT 'draw' CHECK (source IN ('draw', 'coordinates', 'kml')),
  area_sqm         numeric(18,4) NOT NULL CHECK (area_sqm > 0),
  area_acres       numeric(18,4) NOT NULL CHECK (area_acres > 0),
  centroid_lat     numeric(9,6) NOT NULL,
  centroid_lng     numeric(9,6) NOT NULL,
  note             text,
  drawn_by         uuid NOT NULL REFERENCES lms.app_user(id),
  drawn_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (land_request_id, version)
);
CREATE INDEX land_request_area_province_ix ON lms.land_request_area (province_code);
ALTER TABLE lms.land_request_area OWNER TO lms_owner;

-- Shape and ownership rules, whoever writes the row.
CREATE FUNCTION lms.tg_land_request_area_check()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  v_req   record;
  v_ring  jsonb;
  v_n     int;
  v_pt    jsonb;
  v_has   boolean;
BEGIN
  SELECT r.province_code, r.created_by, r.stage_code INTO v_req
    FROM lms.land_request r WHERE r.id = NEW.land_request_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'land request not found' USING ERRCODE = 'no_data_found';
  END IF;
  NEW.province_code := v_req.province_code;

  IF jsonb_typeof(NEW.geometry) <> 'object' OR NEW.geometry->>'type' <> 'Polygon'
     OR jsonb_typeof(NEW.geometry->'coordinates') <> 'array'
     OR jsonb_array_length(NEW.geometry->'coordinates') <> 1 THEN
    RAISE EXCEPTION 'the land area must be one polygon with one outer boundary' USING ERRCODE = 'check_violation';
  END IF;
  v_ring := NEW.geometry->'coordinates'->0;
  v_n := jsonb_array_length(v_ring);
  IF v_n < 4 OR v_n > 501 THEN
    RAISE EXCEPTION 'a land area needs 3 to 500 corners' USING ERRCODE = 'check_violation';
  END IF;
  IF v_ring->0 <> v_ring->(v_n - 1) THEN
    RAISE EXCEPTION 'the polygon boundary must be closed' USING ERRCODE = 'check_violation';
  END IF;
  FOR v_pt IN SELECT * FROM jsonb_array_elements(v_ring) LOOP
    IF jsonb_typeof(v_pt) <> 'array' OR jsonb_array_length(v_pt) <> 2
       OR jsonb_typeof(v_pt->0) <> 'number' OR jsonb_typeof(v_pt->1) <> 'number'
       OR (v_pt->>0)::numeric NOT BETWEEN 60 AND 78           -- longitude, Pakistan and its borders
       OR (v_pt->>1)::numeric NOT BETWEEN 23 AND 38 THEN      -- latitude
      RAISE EXCEPTION 'every corner must be a [longitude, latitude] pair inside Pakistan' USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;

  IF pg_has_role(session_user, 'lms_owner', 'MEMBER') THEN RETURN NEW; END IF;
  -- Only the requester draws, in their own name, while the request may still change.
  IF NEW.drawn_by IS DISTINCT FROM util.actor_id() OR NEW.drawn_by IS DISTINCT FROM v_req.created_by THEN
    RAISE EXCEPTION 'only the person who raised the land request can draw its area' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT EXISTS (SELECT 1 FROM lms.land_request_area a WHERE a.land_request_id = NEW.land_request_id) INTO v_has;
  IF v_has AND v_req.stage_code NOT IN ('Draft', 'Returned') THEN
    RAISE EXCEPTION 'the area can be changed only while the request is a draft or returned' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION lms.tg_land_request_area_check() FROM PUBLIC;
CREATE TRIGGER land_request_area_check BEFORE INSERT ON lms.land_request_area
  FOR EACH ROW EXECUTE FUNCTION lms.tg_land_request_area_check();
CREATE TRIGGER land_request_area_audit AFTER INSERT OR UPDATE OR DELETE ON lms.land_request_area
  FOR EACH ROW EXECUTE FUNCTION audit.tg_audit_row();

ALTER TABLE lms.land_request_area ENABLE ROW LEVEL SECURITY;
CREATE POLICY province_scope ON lms.land_request_area FOR ALL TO lms_readwrite, lms_readonly
  USING      ((SELECT lms.actor_role()) = 'Admin' OR province_code = ANY ((SELECT lms.actor_provinces())::bpchar[]))
  WITH CHECK ((SELECT lms.actor_role()) = 'Admin' OR province_code = ANY ((SELECT lms.actor_provinces())::bpchar[]));

-- Versions are append-only: no UPDATE or DELETE for the application.
GRANT SELECT, INSERT ON lms.land_request_area TO lms_readwrite;
GRANT SELECT ON lms.land_request_area TO lms_readonly;

RESET ROLE;
