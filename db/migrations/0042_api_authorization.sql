-- =====================================================================
-- 0042  Authorization the API relies on, enforced in the database
-- =====================================================================
-- The API checks permissions and record scope (package P1b); the rules
-- below hold whatever path a write takes. Convention throughout: the
-- application connects as lms_app (lms_readwrite). Statements that run as
-- the schema owner (current_user a member of lms_owner, the test 0041 uses
-- too) are the SECURITY DEFINER
-- workflow routines, migrations and maintenance, and they are trusted to
-- have made their own checks. A guard that says "outside owner context"
-- therefore binds every direct application write.
--
--  A. helpers: first stage of a workflow, "are this record's terms
--     approved?", "is this record closed?"
--  B. AUTHZ-02  a workflow record starts at its first stage whatever the
--     client sends, and its stage moves only through the workflow routines
--  C. AUTHZ-01  ownership shares change only through an approved mutation
--     or the first registration of a parcel (api.register_ownership)
--  D. AUTHZ-15  every linked record is in the parent record's province
--  E. AUTHZ-04, AUTHZ-10  approved terms are frozen: mutation heirs and
--     parcels, case owners and valuation, lease / ROW / DBPFC /
--     acquisition financial terms. A change needs the record sent back
--     (api.reopen_workflow), which starts a new approval round. The DBPFC
--     committee rate is recorded by the rate-fixing position; lease
--     renewals go through api.renew_lease with a bounded escalation.
--  F. AUTHZ-05  a court stay is lifted only through api.lift_stay, by an
--     officer who holds the payment-hold authority as well as legal:update
--  G. AUTHZ-11, AUTHZ-12, AUTHZ-21  payment routines and holds check the
--     province of every id they are given and answer "not found" for one
--     out of scope; a held lease holds its own vouchers
--  H. AUTHZ-14  a change to a payee's tax status or bank details is
--     attributed; its author cannot raise that payee's voucher, and a
--     voucher whose payee details changed after it was raised is not
--     verified or released
--  I. AUTHZ-19, AUTHZ-20  documents: archived by someone other than the
--     uploader, never on a closed record, files immutable; access logged
--     only for a document the actor can see
--  J. AUTHZ-23  release follows the approval matrix and separation of
--     duties; a receipt is not recorded by the voucher's raiser or releaser
--  K. AUTHZ-03  the land-request approval tiers are positions
--
-- Not here (0041): challenges, iam.mfa_required_for, iam.has_permission_in
-- (used below), identity writes, settings policy, reconcile authorization,
-- promote_import_batch.
SET ROLE lms_owner;
SELECT set_config('lms.actor_id', '00000000-0000-0000-0000-000000000001', true);

-- ---------------------------------------------------------------------
-- A. Helpers
-- ---------------------------------------------------------------------
CREATE FUNCTION lms.wf_first_stage(p_workflow text)
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT code FROM lms.workflow_stage WHERE workflow_code = p_workflow AND NOT is_terminal ORDER BY seq LIMIT 1;
$function$;

-- True when the record is closed (terminal or locking stage) or has, in its
-- current approval round, been approved into p_from or any later stage. A
-- round starts at creation and again at every 'Reopened' transition.
CREATE FUNCTION lms.wf_terms_frozen(p_workflow text, p_record uuid, p_stage text, p_from text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT coalesce(s.is_terminal, false)
      OR p_stage IS NOT DISTINCT FROM w.lock_at_stage
      OR EXISTS (
           SELECT 1
           FROM lms.workflow_transition t
           JOIN lms.workflow_stage ts ON ts.workflow_code = t.workflow_code AND ts.code = t.to_stage
           WHERE t.workflow_code = p_workflow AND t.record_id = p_record AND t.action = 'Advanced'
             AND ts.seq >= (SELECT f.seq FROM lms.workflow_stage f WHERE f.workflow_code = p_workflow AND f.code = p_from)
             AND t.id > coalesce((SELECT max(r.id) FROM lms.workflow_transition r
                                  WHERE r.workflow_code = p_workflow AND r.record_id = p_record
                                    AND r.action = 'Reopened'), 0))
  FROM lms.workflow w
  LEFT JOIN lms.workflow_stage s ON s.workflow_code = w.code AND s.code = p_stage
  WHERE w.code = p_workflow;
$function$;

-- Is the record a document belongs to approved or closed? Registers without
-- a workflow (landowner, survey, project) never close.
CREATE FUNCTION lms.record_closed(p_table text, p_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE w record; v_stage text; v_status text;
BEGIN
  IF p_table = 'legal_case' THEN
    SELECT status INTO v_status FROM lms.legal_case WHERE id = p_id;
    RETURN coalesce(v_status IN ('Decided — In Favour','Decided — Against','Settled','Withdrawn'), false);
  END IF;
  SELECT * INTO w FROM lms.workflow WHERE entity_table = p_table;
  IF NOT FOUND THEN RETURN false; END IF;
  -- The table name comes from lms.workflow, which no application role can write.
  EXECUTE format('SELECT stage_code FROM lms.%I WHERE id = $1', w.entity_table) INTO v_stage USING p_id;
  IF v_stage IS NULL THEN RETURN false; END IF;
  RETURN EXISTS (
    SELECT 1 FROM lms.workflow_stage s
    WHERE s.workflow_code = w.code AND s.code = v_stage
      AND (s.is_terminal OR s.code = w.lock_at_stage
           OR s.seq = (SELECT max(x.seq) FROM lms.workflow_stage x WHERE x.workflow_code = w.code AND NOT x.is_terminal)));
END $function$;

REVOKE ALL ON FUNCTION lms.wf_first_stage(text), lms.wf_terms_frozen(text, uuid, text, text),
                       lms.record_closed(text, uuid) FROM PUBLIC;
-- Called from triggers that run as the application role.
GRANT EXECUTE ON FUNCTION lms.wf_first_stage(text), lms.wf_terms_frozen(text, uuid, text, text),
                          lms.record_closed(text, uuid) TO lms_readwrite;

-- ---------------------------------------------------------------------
-- B. Stages move only through the workflow (AUTHZ-02)
-- ---------------------------------------------------------------------
-- TG_ARGV[0] = workflow code; TG_ARGV[1] = 'routine' when rows of the table
-- are created only by a definer routine (vouchers: api.request_payment).
CREATE FUNCTION lms.tg_workflow_stage_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  IF pg_has_role(current_user, 'lms_owner', 'MEMBER') THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    IF TG_NARGS > 1 AND TG_ARGV[1] = 'routine' THEN
      RAISE EXCEPTION '% records are created through their routine, not inserted directly', TG_ARGV[0]
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.stage_code := lms.wf_first_stage(TG_ARGV[0]);
  ELSIF NEW.stage_code IS DISTINCT FROM OLD.stage_code THEN
    RAISE EXCEPTION 'the stage of a % record moves only through its approval workflow', TG_ARGV[0]
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION lms.tg_workflow_stage_guard() FROM PUBLIC;

CREATE TRIGGER lease_stage_guard BEFORE INSERT OR UPDATE OF stage_code ON lms.lease
  FOR EACH ROW EXECUTE FUNCTION lms.tg_workflow_stage_guard('leases');
CREATE TRIGGER compensation_case_stage_guard BEFORE INSERT OR UPDATE OF stage_code ON lms.compensation_case
  FOR EACH ROW EXECUTE FUNCTION lms.tg_workflow_stage_guard('cases');
CREATE TRIGGER acquisition_stage_guard BEFORE INSERT OR UPDATE OF stage_code ON lms.acquisition
  FOR EACH ROW EXECUTE FUNCTION lms.tg_workflow_stage_guard('acquisitions');
CREATE TRIGGER row_corridor_stage_guard BEFORE INSERT OR UPDATE OF stage_code ON lms.row_corridor
  FOR EACH ROW EXECUTE FUNCTION lms.tg_workflow_stage_guard('rows');
CREATE TRIGGER dbpfc_estimate_stage_guard BEFORE INSERT OR UPDATE OF stage_code ON lms.dbpfc_estimate
  FOR EACH ROW EXECUTE FUNCTION lms.tg_workflow_stage_guard('dbpfc');
CREATE TRIGGER encroachment_stage_guard BEFORE INSERT OR UPDATE OF stage_code ON lms.encroachment
  FOR EACH ROW EXECUTE FUNCTION lms.tg_workflow_stage_guard('encroachments');
CREATE TRIGGER grievance_stage_guard BEFORE INSERT OR UPDATE OF stage_code ON lms.grievance
  FOR EACH ROW EXECUTE FUNCTION lms.tg_workflow_stage_guard('grievances');
CREATE TRIGGER payment_request_stage_guard BEFORE INSERT OR UPDATE OF stage_code ON lms.payment_request
  FOR EACH ROW EXECUTE FUNCTION lms.tg_workflow_stage_guard('payments', 'routine');
-- A mutation may be staged at any stage by a data-migration load; its heirs
-- and parcels are frozen by section E once it has been approved.
CREATE TRIGGER mutation_stage_guard BEFORE UPDATE OF stage_code ON lms.mutation
  FOR EACH ROW EXECUTE FUNCTION lms.tg_workflow_stage_guard('mutations');

-- ---------------------------------------------------------------------
-- C. Ownership moves only through a mutation (AUTHZ-01)
-- ---------------------------------------------------------------------
REVOKE INSERT, UPDATE, DELETE ON lms.survey_ownership_share FROM lms_readwrite;

CREATE FUNCTION lms.tg_ownership_share_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  -- api.apply_mutation, api.register_ownership and data loads run as the owner.
  IF NOT pg_has_role(current_user, 'lms_owner', 'MEMBER') THEN
    RAISE EXCEPTION 'ownership shares change only through an approved mutation, or when a parcel is first registered'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN coalesce(NEW, OLD);
END $function$;
REVOKE ALL ON FUNCTION lms.tg_ownership_share_guard() FROM PUBLIC;
CREATE TRIGGER ownership_share_guard BEFORE INSERT OR UPDATE OR DELETE ON lms.survey_ownership_share
  FOR EACH ROW EXECUTE FUNCTION lms.tg_ownership_share_guard();

-- The first owners of a parcel that has none. Every later change is a mutation.
CREATE FUNCTION api.register_ownership(p_survey uuid, p_shares jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := util.require_actor();
  v_prov  char(3); v_code text;
  s jsonb; v_lo uuid; v_pct numeric; v_lo_prov char(3); v_lo_status text; v_name text;
  v_total numeric := 0; v_n integer := 0;
BEGIN
  IF lms.actor_role() = 'Viewer' THEN
    RAISE EXCEPTION 'the Viewer role is read-only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT province_code, code INTO v_prov, v_code FROM lms.survey WHERE id = p_survey FOR UPDATE;
  IF v_prov IS NULL OR (lms.actor_role() <> 'Admin' AND NOT lms.actor_can_see_province(v_prov))
     OR NOT (iam.has_permission_in('surveys', 'create', v_prov) OR iam.has_permission_in('surveys', 'update', v_prov)) THEN
    RAISE EXCEPTION 'the parcel was not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF EXISTS (SELECT 1 FROM lms.survey_ownership_share WHERE survey_id = p_survey) THEN
    RAISE EXCEPTION 'parcel % already has registered owners; a change of ownership is recorded as a mutation', v_code
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF jsonb_typeof(p_shares) IS DISTINCT FROM 'array' OR jsonb_array_length(p_shares) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'give between 1 and 200 owners with their shares' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  FOR s IN SELECT value FROM jsonb_array_elements(p_shares) LOOP
    BEGIN
      v_lo := (s ->> 'landowner_id')::uuid;
      v_pct := (s ->> 'share_pct')::numeric;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'each owner needs a landowner and a share' USING ERRCODE = 'invalid_parameter_value';
    END;
    IF v_lo IS NULL OR v_pct IS NULL OR v_pct <= 0 OR v_pct > 100 THEN
      RAISE EXCEPTION 'each owner needs a landowner and a share above 0 and up to 100' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    SELECT province_code, status, full_name INTO v_lo_prov, v_lo_status, v_name FROM lms.landowner WHERE id = v_lo;
    IF v_lo_prov IS DISTINCT FROM v_prov THEN
      RAISE EXCEPTION 'a landowner was not found in the parcel''s province' USING ERRCODE = 'no_data_found';
    END IF;
    IF v_lo_status = 'Deceased' THEN
      RAISE EXCEPTION 'cannot assign shares to deceased landowner %; an inheritance mutation is required', v_name
        USING ERRCODE = 'raise_exception';
    END IF;
    INSERT INTO lms.survey_ownership_share
      (survey_id, landowner_id, share_pct, revenue_doc_ref, effective_from, created_by, updated_by)
    VALUES (p_survey, v_lo, round(v_pct, 4), nullif(btrim(coalesce(s ->> 'revenue_doc_ref', '')), ''),
            current_date, v_actor, v_actor);
    INSERT INTO lms.survey_ownership_history
      (survey_id, landowner_id, share_pct, valid_from, change_reason, recorded_by)
    VALUES (p_survey, v_lo, round(v_pct, 4), current_date, 'Initial registration', v_actor);
    v_total := v_total + round(v_pct, 4);
    v_n := v_n + 1;
  END LOOP;
  IF abs(v_total - 100) > 0.0001 THEN
    RAISE EXCEPTION 'co-ownership shares must total 100%% (they total %)', v_total USING ERRCODE = 'check_violation';
  END IF;
  RETURN v_n;
END $function$;
REVOKE ALL ON FUNCTION api.register_ownership(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.register_ownership(uuid, jsonb) TO lms_readwrite;

-- ---------------------------------------------------------------------
-- D. Linked records are in the parent record's province (AUTHZ-15)
-- ---------------------------------------------------------------------
-- Row-level security on a link table checks only its parent, and a foreign
-- key ignores row-level security, so a parcel or landowner id from another
-- province could be attached. This trigger runs as the caller: a record the
-- caller cannot see reads as missing, and either way the answer is the same.
--   TG_ARGV[0] = '-'  the row carries province_code itself; pairs follow from [1]
--   TG_ARGV[0] = parent table, [1] = parent id column; pairs follow from [2]
--   a pair is (column, referenced table)
CREATE FUNCTION lms.tg_link_same_province()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  v_new  jsonb := to_jsonb(NEW);
  v_old  jsonb := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) END;
  v_self boolean := TG_ARGV[0] = '-';
  v_prov text; v_ref text; v_id text; i integer; v_all boolean;
BEGIN
  IF v_self THEN
    v_prov := v_new ->> 'province_code';
    i := 1;
    v_all := v_old IS NULL OR v_old ->> 'province_code' IS DISTINCT FROM v_prov;
  ELSE
    EXECUTE format('SELECT province_code::text FROM lms.%I WHERE id = $1', TG_ARGV[0])
      INTO v_prov USING (v_new ->> TG_ARGV[1])::uuid;
    -- No visible parent: its own policy (or foreign key) refuses the row.
    IF v_prov IS NULL THEN RETURN NEW; END IF;
    i := 2;
    v_all := v_old IS NULL OR v_old ->> TG_ARGV[1] IS DISTINCT FROM v_new ->> TG_ARGV[1];
  END IF;
  WHILE i + 1 < TG_NARGS LOOP
    v_id := v_new ->> TG_ARGV[i];
    IF v_id IS NOT NULL AND (v_all OR v_old ->> TG_ARGV[i] IS DISTINCT FROM v_id) THEN
      EXECUTE format('SELECT province_code::text FROM lms.%I WHERE id = $1', TG_ARGV[i + 1])
        INTO v_ref USING v_id::uuid;
      IF v_ref IS DISTINCT FROM v_prov THEN
        RAISE EXCEPTION 'the linked % was not found in this record''s province', replace(TG_ARGV[i + 1], '_', ' ')
          USING ERRCODE = 'no_data_found';
      END IF;
    END IF;
    i := i + 2;
  END LOOP;
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION lms.tg_link_same_province() FROM PUBLIC;

-- Link tables (province from the parent).
CREATE TRIGGER acquisition_survey_link_province BEFORE INSERT OR UPDATE OF acquisition_id, survey_id ON lms.acquisition_survey
  FOR EACH ROW EXECUTE FUNCTION lms.tg_link_same_province('acquisition', 'acquisition_id', 'survey_id', 'survey');
CREATE TRIGGER lease_survey_link_province BEFORE INSERT OR UPDATE OF lease_id, survey_id ON lms.lease_survey
  FOR EACH ROW EXECUTE FUNCTION lms.tg_link_same_province('lease', 'lease_id', 'survey_id', 'survey');
CREATE TRIGGER lease_lessor_link_province BEFORE INSERT OR UPDATE OF lease_id, landowner_id ON lms.lease_lessor
  FOR EACH ROW EXECUTE FUNCTION lms.tg_link_same_province('lease', 'lease_id', 'landowner_id', 'landowner');
CREATE TRIGGER case_owner_link_province BEFORE INSERT OR UPDATE OF case_id, landowner_id ON lms.case_owner
  FOR EACH ROW EXECUTE FUNCTION lms.tg_link_same_province('compensation_case', 'case_id', 'landowner_id', 'landowner');
CREATE TRIGGER case_lease_line_link_province BEFORE INSERT OR UPDATE OF case_id, survey_id ON lms.case_lease_line
  FOR EACH ROW EXECUTE FUNCTION lms.tg_link_same_province('compensation_case', 'case_id', 'survey_id', 'survey');
CREATE TRIGGER case_crop_line_link_province BEFORE INSERT OR UPDATE OF case_id, survey_id ON lms.case_crop_line
  FOR EACH ROW EXECUTE FUNCTION lms.tg_link_same_province('compensation_case', 'case_id', 'survey_id', 'survey');
CREATE TRIGGER case_tree_line_link_province BEFORE INSERT OR UPDATE OF case_id, survey_id ON lms.case_tree_line
  FOR EACH ROW EXECUTE FUNCTION lms.tg_link_same_province('compensation_case', 'case_id', 'survey_id', 'survey');
CREATE TRIGGER case_misc_line_link_province BEFORE INSERT OR UPDATE OF case_id, survey_id ON lms.case_misc_line
  FOR EACH ROW EXECUTE FUNCTION lms.tg_link_same_province('compensation_case', 'case_id', 'survey_id', 'survey');
CREATE TRIGGER project_survey_link_province BEFORE INSERT OR UPDATE OF project_id, survey_id ON lms.project_survey
  FOR EACH ROW EXECUTE FUNCTION lms.tg_link_same_province('project', 'project_id', 'survey_id', 'survey');
CREATE TRIGGER row_survey_link_province BEFORE INSERT OR UPDATE OF row_id, survey_id ON lms.row_survey
  FOR EACH ROW EXECUTE FUNCTION lms.tg_link_same_province('row_corridor', 'row_id', 'survey_id', 'survey');
CREATE TRIGGER row_landowner_link_province BEFORE INSERT OR UPDATE OF row_id, landowner_id ON lms.row_landowner
  FOR EACH ROW EXECUTE FUNCTION lms.tg_link_same_province('row_corridor', 'row_id', 'landowner_id', 'landowner');
CREATE TRIGGER legal_case_survey_link_province BEFORE INSERT OR UPDATE OF legal_case_id, survey_id ON lms.legal_case_survey
  FOR EACH ROW EXECUTE FUNCTION lms.tg_link_same_province('legal_case', 'legal_case_id', 'survey_id', 'survey');
CREATE TRIGGER legal_case_landowner_link_province BEFORE INSERT OR UPDATE OF legal_case_id, landowner_id ON lms.legal_case_landowner
  FOR EACH ROW EXECUTE FUNCTION lms.tg_link_same_province('legal_case', 'legal_case_id', 'landowner_id', 'landowner');
CREATE TRIGGER dbpfc_survey_link_province BEFORE INSERT OR UPDATE OF dbpfc_id, survey_id ON lms.dbpfc_survey
  FOR EACH ROW EXECUTE FUNCTION lms.tg_link_same_province('dbpfc_estimate', 'dbpfc_id', 'survey_id', 'survey');
CREATE TRIGGER mutation_survey_link_province BEFORE INSERT OR UPDATE OF mutation_id, survey_id ON lms.mutation_survey
  FOR EACH ROW EXECUTE FUNCTION lms.tg_link_same_province('mutation', 'mutation_id', 'survey_id', 'survey');
CREATE TRIGGER mutation_heir_link_province BEFORE INSERT OR UPDATE OF mutation_id, landowner_id ON lms.mutation_heir
  FOR EACH ROW EXECUTE FUNCTION lms.tg_link_same_province('mutation', 'mutation_id', 'landowner_id', 'landowner');
CREATE TRIGGER survey_ownership_share_link_province BEFORE INSERT OR UPDATE OF survey_id, landowner_id ON lms.survey_ownership_share
  FOR EACH ROW EXECUTE FUNCTION lms.tg_link_same_province('survey', 'survey_id', 'landowner_id', 'landowner');
CREATE TRIGGER payment_allocation_link_province BEFORE INSERT OR UPDATE OF payment_id, case_id, landowner_id ON lms.payment_allocation
  FOR EACH ROW EXECUTE FUNCTION lms.tg_link_same_province('payment_request', 'payment_id', 'case_id', 'compensation_case', 'landowner_id', 'landowner');
CREATE TRIGGER project_spatial_feature_link_province BEFORE INSERT OR UPDATE OF project_id, survey_id ON lms.project_spatial_feature
  FOR EACH ROW EXECUTE FUNCTION lms.tg_link_same_province('project', 'project_id', 'survey_id', 'survey');

-- Records that carry their own province.
CREATE TRIGGER survey_link_province BEFORE INSERT OR UPDATE OF province_code, admin_unit_id ON lms.survey
  FOR EACH ROW EXECUTE FUNCTION lms.tg_link_same_province('-', 'admin_unit_id', 'admin_unit');
CREATE TRIGGER project_link_province BEFORE INSERT OR UPDATE OF province_code, district_id ON lms.project
  FOR EACH ROW EXECUTE FUNCTION lms.tg_link_same_province('-', 'district_id', 'admin_unit');
CREATE TRIGGER compensation_case_link_province BEFORE INSERT OR UPDATE OF province_code, project_id ON lms.compensation_case
  FOR EACH ROW EXECUTE FUNCTION lms.tg_link_same_province('-', 'project_id', 'project');
CREATE TRIGGER lease_link_province BEFORE INSERT OR UPDATE OF province_code, project_id, case_id ON lms.lease
  FOR EACH ROW EXECUTE FUNCTION lms.tg_link_same_province('-', 'project_id', 'project', 'case_id', 'compensation_case');
CREATE TRIGGER acquisition_link_province BEFORE INSERT OR UPDATE OF province_code, project_id ON lms.acquisition
  FOR EACH ROW EXECUTE FUNCTION lms.tg_link_same_province('-', 'project_id', 'project');
CREATE TRIGGER row_corridor_link_province BEFORE INSERT OR UPDATE OF province_code, project_id ON lms.row_corridor
  FOR EACH ROW EXECUTE FUNCTION lms.tg_link_same_province('-', 'project_id', 'project');
CREATE TRIGGER dbpfc_estimate_link_province BEFORE INSERT OR UPDATE OF province_code, project_id, district_id ON lms.dbpfc_estimate
  FOR EACH ROW EXECUTE FUNCTION lms.tg_link_same_province('-', 'project_id', 'project', 'district_id', 'admin_unit');
CREATE TRIGGER encroachment_link_province BEFORE INSERT OR UPDATE OF province_code, project_id, survey_id, row_id ON lms.encroachment
  FOR EACH ROW EXECUTE FUNCTION lms.tg_link_same_province('-', 'project_id', 'project', 'survey_id', 'survey', 'row_id', 'row_corridor');
CREATE TRIGGER grievance_link_province BEFORE INSERT OR UPDATE OF province_code, project_id, survey_id, landowner_id ON lms.grievance
  FOR EACH ROW EXECUTE FUNCTION lms.tg_link_same_province('-', 'project_id', 'project', 'survey_id', 'survey', 'landowner_id', 'landowner');
CREATE TRIGGER legal_case_link_province BEFORE INSERT OR UPDATE OF province_code, project_id, case_id ON lms.legal_case
  FOR EACH ROW EXECUTE FUNCTION lms.tg_link_same_province('-', 'project_id', 'project', 'case_id', 'compensation_case');
CREATE TRIGGER land_request_link_province BEFORE INSERT OR UPDATE OF province_code, project_id, allocated_survey_id, allocated_lease_id ON lms.land_request
  FOR EACH ROW EXECUTE FUNCTION lms.tg_link_same_province('-', 'project_id', 'project', 'allocated_survey_id', 'survey', 'allocated_lease_id', 'lease');
CREATE TRIGGER mutation_link_province BEFORE INSERT OR UPDATE OF province_code, transferor_id ON lms.mutation
  FOR EACH ROW EXECUTE FUNCTION lms.tg_link_same_province('-', 'transferor_id', 'landowner');
CREATE TRIGGER payment_request_link_province BEFORE INSERT OR UPDATE OF province_code, project_id, landowner_id, case_id, lease_id, dbpfc_id ON lms.payment_request
  FOR EACH ROW EXECUTE FUNCTION lms.tg_link_same_province('-', 'project_id', 'project', 'landowner_id', 'landowner',
                                                         'case_id', 'compensation_case', 'lease_id', 'lease', 'dbpfc_id', 'dbpfc_estimate');
CREATE TRIGGER budget_link_province BEFORE INSERT OR UPDATE OF province_code, project_id ON lms.budget
  FOR EACH ROW EXECUTE FUNCTION lms.tg_link_same_province('-', 'project_id', 'project');

-- ---------------------------------------------------------------------
-- E. Approved terms are frozen (AUTHZ-04, AUTHZ-10)
-- ---------------------------------------------------------------------
-- TG_ARGV[0] = workflow, [1] = the stage whose approval fixes the terms.
-- Parent mode: [2] = '-', [3..] = the columns that are terms (UPDATE only).
-- Child mode:  [2] = parent table, [3] = parent id column.
CREATE FUNCTION lms.tg_terms_frozen()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  v_row jsonb := to_jsonb(coalesce(NEW, OLD));
  v_old jsonb; v_new jsonb;
  v_id uuid; v_stage text; v_code text; v_what text; v_changed text[]; i integer;
BEGIN
  IF pg_has_role(current_user, 'lms_owner', 'MEMBER') THEN RETURN coalesce(NEW, OLD); END IF;
  IF TG_ARGV[2] = '-' THEN
    v_old := to_jsonb(OLD); v_new := to_jsonb(NEW);
    FOR i IN 3 .. TG_NARGS - 1 LOOP
      IF v_new -> TG_ARGV[i] IS DISTINCT FROM v_old -> TG_ARGV[i] THEN
        v_changed := array_append(v_changed, replace(TG_ARGV[i], '_', ' '));
      END IF;
    END LOOP;
    IF v_changed IS NULL THEN RETURN NEW; END IF;
    v_id := (v_old ->> 'id')::uuid; v_stage := v_old ->> 'stage_code'; v_code := v_old ->> 'code';
    v_what := array_to_string(v_changed, ', ');
  ELSE
    v_id := (v_row ->> TG_ARGV[3])::uuid;
    EXECUTE format('SELECT stage_code, code::text FROM lms.%I WHERE id = $1', TG_ARGV[2]) INTO v_stage, v_code USING v_id;
    -- No parent row: it is being deleted (cascade) or is not visible (its policy refuses).
    IF v_stage IS NULL THEN RETURN coalesce(NEW, OLD); END IF;
    v_what := 'its ' || replace(TG_TABLE_NAME, '_', ' ') || ' rows';
  END IF;
  IF lms.wf_terms_frozen(TG_ARGV[0], v_id, v_stage, TG_ARGV[1]) THEN
    RAISE EXCEPTION '% has been approved or is closed; % cannot change until it is sent back for changes', v_code, v_what
      USING ERRCODE = 'object_not_in_prerequisite_state',
            HINT = 'Send the record back with a reason (it then needs approval again), or cancel it and raise a new one.';
  END IF;
  RETURN coalesce(NEW, OLD);
END $function$;
REVOKE ALL ON FUNCTION lms.tg_terms_frozen() FROM PUBLIC;

-- Parents: the terms each approval fixes.
CREATE TRIGGER compensation_case_terms_frozen BEFORE UPDATE ON lms.compensation_case
  FOR EACH ROW EXECUTE FUNCTION lms.tg_terms_frozen('cases', 'Checked', '-',
    'lease_rate', 'lease_term_months', 'land_use_code', 'project_id');
CREATE TRIGGER lease_terms_frozen BEFORE UPDATE ON lms.lease
  FOR EACH ROW EXECUTE FUNCTION lms.tg_terms_frozen('leases', 'Under Review', '-',
    'initial_area', 'subsequent_area', 'rate_per_acre', 'escalation_pct', 'start_date', 'term_years', 'kind', 'project_id', 'case_id');
CREATE TRIGGER row_corridor_terms_frozen BEFORE UPDATE ON lms.row_corridor
  FOR EACH ROW EXECUTE FUNCTION lms.tg_terms_frozen('rows', 'Under Review', '-',
    'annual_rent', 'tenure_years', 'agreement_date', 'length_m', 'width_m', 'row_type', 'project_id');
CREATE TRIGGER dbpfc_estimate_terms_frozen BEFORE UPDATE ON lms.dbpfc_estimate
  FOR EACH ROW EXECUTE FUNCTION lms.tg_terms_frozen('dbpfc', 'Referred to DBPFC', '-',
    'area_acres', 'estimated_rate', 'project_id', 'district_id');
CREATE TRIGGER acquisition_terms_frozen BEFORE UPDATE ON lms.acquisition
  FOR EACH ROW EXECUTE FUNCTION lms.tg_terms_frozen('acquisitions', 'Approval', '-',
    'negotiated_rate', 'area_required', 'mode', 'project_id');
CREATE TRIGGER mutation_terms_frozen BEFORE UPDATE ON lms.mutation
  FOR EACH ROW EXECUTE FUNCTION lms.tg_terms_frozen('mutations', 'Revenue Verified', '-',
    'transferor_id', 'mutation_type', 'death_date', 'revenue_mutation_no', 'mutation_date', 'revenue_office', 'certificate_no');

-- Children.
CREATE TRIGGER case_owner_terms_frozen BEFORE INSERT OR UPDATE OR DELETE ON lms.case_owner
  FOR EACH ROW EXECUTE FUNCTION lms.tg_terms_frozen('cases', 'Checked', 'compensation_case', 'case_id');
CREATE TRIGGER case_lease_line_terms_frozen BEFORE INSERT OR UPDATE OR DELETE ON lms.case_lease_line
  FOR EACH ROW EXECUTE FUNCTION lms.tg_terms_frozen('cases', 'Checked', 'compensation_case', 'case_id');
CREATE TRIGGER case_crop_line_terms_frozen BEFORE INSERT OR UPDATE OR DELETE ON lms.case_crop_line
  FOR EACH ROW EXECUTE FUNCTION lms.tg_terms_frozen('cases', 'Checked', 'compensation_case', 'case_id');
CREATE TRIGGER case_tree_line_terms_frozen BEFORE INSERT OR UPDATE OR DELETE ON lms.case_tree_line
  FOR EACH ROW EXECUTE FUNCTION lms.tg_terms_frozen('cases', 'Checked', 'compensation_case', 'case_id');
CREATE TRIGGER case_misc_line_terms_frozen BEFORE INSERT OR UPDATE OR DELETE ON lms.case_misc_line
  FOR EACH ROW EXECUTE FUNCTION lms.tg_terms_frozen('cases', 'Checked', 'compensation_case', 'case_id');
CREATE TRIGGER lease_lessor_terms_frozen BEFORE INSERT OR UPDATE OR DELETE ON lms.lease_lessor
  FOR EACH ROW EXECUTE FUNCTION lms.tg_terms_frozen('leases', 'Under Review', 'lease', 'lease_id');
-- term_range / is_blocking are kept in step with the lease by its own triggers; only the parcel is a term.
CREATE TRIGGER lease_survey_terms_frozen BEFORE INSERT OR DELETE OR UPDATE OF lease_id, survey_id ON lms.lease_survey
  FOR EACH ROW EXECUTE FUNCTION lms.tg_terms_frozen('leases', 'Under Review', 'lease', 'lease_id');
CREATE TRIGGER row_survey_terms_frozen BEFORE INSERT OR UPDATE OR DELETE ON lms.row_survey
  FOR EACH ROW EXECUTE FUNCTION lms.tg_terms_frozen('rows', 'Under Review', 'row_corridor', 'row_id');
CREATE TRIGGER row_landowner_terms_frozen BEFORE INSERT OR UPDATE OR DELETE ON lms.row_landowner
  FOR EACH ROW EXECUTE FUNCTION lms.tg_terms_frozen('rows', 'Under Review', 'row_corridor', 'row_id');
CREATE TRIGGER dbpfc_survey_terms_frozen BEFORE INSERT OR UPDATE OR DELETE ON lms.dbpfc_survey
  FOR EACH ROW EXECUTE FUNCTION lms.tg_terms_frozen('dbpfc', 'Referred to DBPFC', 'dbpfc_estimate', 'dbpfc_id');
CREATE TRIGGER acquisition_survey_terms_frozen BEFORE INSERT OR UPDATE OR DELETE ON lms.acquisition_survey
  FOR EACH ROW EXECUTE FUNCTION lms.tg_terms_frozen('acquisitions', 'Approval', 'acquisition', 'acquisition_id');
-- Title checks are ticked through the approval steps; they freeze at handover.
CREATE TRIGGER acquisition_title_check_terms_frozen BEFORE INSERT OR UPDATE OR DELETE ON lms.acquisition_title_check
  FOR EACH ROW EXECUTE FUNCTION lms.tg_terms_frozen('acquisitions', 'Handover', 'acquisition', 'acquisition_id');
CREATE TRIGGER mutation_heir_terms_frozen BEFORE INSERT OR UPDATE OR DELETE ON lms.mutation_heir
  FOR EACH ROW EXECUTE FUNCTION lms.tg_terms_frozen('mutations', 'Revenue Verified', 'mutation', 'mutation_id');
CREATE TRIGGER mutation_survey_terms_frozen BEFORE INSERT OR UPDATE OR DELETE ON lms.mutation_survey
  FOR EACH ROW EXECUTE FUNCTION lms.tg_terms_frozen('mutations', 'Revenue Verified', 'mutation', 'mutation_id');

-- The DBPFC committee rate is the decision of the position that fixes it
-- (the approval matrix's 'Rate Fixed' step), not of whoever edits the estimate.
CREATE FUNCTION lms.tg_dbpfc_rate_authority()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE v_groups text[]; v_terminal boolean;
BEGIN
  IF pg_has_role(current_user, 'lms_owner', 'MEMBER') THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.fixed_rate IS NULL THEN RETURN NEW; END IF;
  ELSE
    IF NEW.fixed_rate IS NOT DISTINCT FROM OLD.fixed_rate AND NEW.committee_ref IS NOT DISTINCT FROM OLD.committee_ref
       AND NEW.meeting_date IS NOT DISTINCT FROM OLD.meeting_date THEN
      RETURN NEW;
    END IF;
    SELECT is_terminal INTO v_terminal FROM lms.workflow_stage WHERE workflow_code = 'dbpfc' AND code = OLD.stage_code;
    IF v_terminal THEN
      RAISE EXCEPTION 'DBPFC estimate % is % and its rate cannot change', OLD.code, OLD.stage_code
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
  END IF;
  SELECT array_agg(group_code ORDER BY group_code) INTO v_groups
  FROM lms.workflow_step_group WHERE workflow_code = 'dbpfc' AND to_stage = 'Rate Fixed';
  IF v_groups IS NULL OR NOT (v_groups && lms.actor_groups()) THEN
    RAISE EXCEPTION 'the committee rate is recorded by the % position', coalesce(array_to_string(v_groups, ' or '), 'rate-fixing')
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION lms.tg_dbpfc_rate_authority() FROM PUBLIC;
CREATE TRIGGER dbpfc_rate_authority BEFORE INSERT OR UPDATE OF fixed_rate, committee_ref, meeting_date ON lms.dbpfc_estimate
  FOR EACH ROW EXECUTE FUNCTION lms.tg_dbpfc_rate_authority();

-- Send a record back to its first stage for changes. Earlier approvals stop
-- counting: the record needs every approval again (a new round), and the
-- person who sent it back may not approve it in that round.
CREATE FUNCTION api.reopen_workflow(p_workflow text, p_record_id uuid, p_reason text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := util.require_actor();
  w record; v_res text; v_row jsonb; v_code text; v_prov text; v_stage text; v_first text; v_first_seq smallint;
  st record;
BEGIN
  IF lms.actor_role() = 'Viewer' THEN
    RAISE EXCEPTION 'the Viewer role is read-only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Vouchers, grievances and encroachments are not reopened: a voucher is
  -- cancelled and raised again, and the others carry no approved terms.
  v_res := CASE p_workflow WHEN 'cases' THEN 'cases' WHEN 'leases' THEN 'leases' WHEN 'rows' THEN 'rows'
                           WHEN 'dbpfc' THEN 'dbpfc' WHEN 'acquisitions' THEN 'acquisitions'
                           WHEN 'mutations' THEN 'mutations' END;
  IF v_res IS NULL THEN
    RAISE EXCEPTION '% records are not sent back; cancel and raise a new one', coalesce(p_workflow, 'these')
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO w FROM lms.workflow WHERE code = p_workflow;
  EXECUTE format('SELECT to_jsonb(t) FROM lms.%I t WHERE t.id = $1 FOR UPDATE', w.entity_table) INTO v_row USING p_record_id;
  v_code := v_row ->> 'code'; v_prov := v_row ->> 'province_code'; v_stage := v_row ->> 'stage_code';
  IF v_row IS NULL OR (lms.actor_role() <> 'Admin' AND NOT lms.actor_can_see_province(v_prov::char(3)))
     OR NOT iam.has_permission_in(v_res, 'update', v_prov, (v_row ->> 'project_id')::uuid) THEN
    RAISE EXCEPTION 'the record was not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF length(btrim(coalesce(p_reason, ''))) < 10 THEN
    RAISE EXCEPTION 'say why the record is sent back (at least 10 characters)' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT s.is_terminal, s.seq INTO st FROM lms.workflow_stage s WHERE s.workflow_code = p_workflow AND s.code = v_stage;
  -- Closed, locked or fully approved (the last stage) records are not sent back:
  -- they are cancelled or stopped and raised again (a lease is renewed).
  IF st.is_terminal OR v_stage IS NOT DISTINCT FROM w.lock_at_stage
     OR st.seq = (SELECT max(x.seq) FROM lms.workflow_stage x WHERE x.workflow_code = p_workflow AND NOT x.is_terminal) THEN
    RAISE EXCEPTION 'record % is % and cannot be sent back', v_code, v_stage USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  SELECT code, seq INTO v_first, v_first_seq FROM lms.workflow_stage
  WHERE workflow_code = p_workflow AND NOT is_terminal ORDER BY seq LIMIT 1;
  IF v_stage = v_first AND NOT lms.wf_terms_frozen(p_workflow, p_record_id, v_stage, v_first) THEN
    RETURN v_first;   -- nothing approved yet; nothing to send back
  END IF;

  EXECUTE format('UPDATE lms.%I SET stage_code = $1 WHERE id = $2', w.entity_table) USING v_first, p_record_id;
  INSERT INTO lms.workflow_transition
    (workflow_code, record_id, record_code, province_code, from_stage, to_stage, action, acted_by, note)
  VALUES (p_workflow, p_record_id, v_code, v_prov, v_stage, v_first, 'Reopened', v_actor, left(btrim(p_reason), 500));
  UPDATE lms.workflow_assignment SET closed_at = clock_timestamp()
  WHERE workflow_code = p_workflow AND record_id = p_record_id AND closed_at IS NULL;
  INSERT INTO lms.workflow_assignment (workflow_code, record_id, stage_code, assigned_group)
  SELECT p_workflow, p_record_id, ns.code, sg.group_code
  FROM lms.workflow_stage ns
  JOIN lms.workflow_step_group sg ON sg.workflow_code = p_workflow AND sg.to_stage = ns.code
  WHERE ns.workflow_code = p_workflow AND NOT ns.is_terminal AND ns.seq = v_first_seq + 1
  ORDER BY sg.group_code LIMIT 1;
  INSERT INTO audit.audit_event
    (actor_id, actor_username, actor_role, entity, record_id, record_code, province_code,
     action, old_data, new_data, changed_fields, note)
  SELECT v_actor, u.username, u.role_code, w.entity_table, p_record_id, v_code, v_prov,
         'TRANSITION', jsonb_build_object('stage_code', v_stage), jsonb_build_object('stage_code', v_first, 'action', 'Reopened'),
         ARRAY['stage_code'], left(btrim(p_reason), 500)
  FROM lms.app_user u WHERE u.id = v_actor;
  RETURN v_first;
END $function$;
REVOKE ALL ON FUNCTION api.reopen_workflow(text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.reopen_workflow(text, uuid, text) TO lms_readwrite;

-- Separation of duties counts approvals per round. Patched in place so that
-- any other change made to api.advance_workflow (e.g. by 0041) is kept; a
-- body that no longer contains the expected block stops the migration
-- rather than being overwritten.
DO $do$
DECLARE v_def text; v_new text;
BEGIN
  v_def := pg_get_functiondef('api.advance_workflow(text,uuid,text,text,text)'::regprocedure);
  v_new := replace(v_def,
$old$    IF EXISTS (SELECT 1 FROM lms.workflow_transition t
               WHERE t.workflow_code = p_workflow AND t.record_id = p_record_id
                 AND t.acted_by = v_actor AND t.action = 'Advanced') THEN
      RAISE EXCEPTION 'segregation of duties: you already approved an earlier step of %', v_code
        USING ERRCODE = 'insufficient_privilege';
    END IF;$old$,
$new$    -- 0042: approvals count within the current round; a record sent back
    -- (api.reopen_workflow) starts a new round, and whoever sent it back is
    -- its preparer for that round.
    IF EXISTS (SELECT 1 FROM lms.workflow_transition t
               WHERE t.workflow_code = p_workflow AND t.record_id = p_record_id
                 AND t.acted_by = v_actor AND t.action = 'Advanced'
                 AND t.id > coalesce((SELECT max(r.id) FROM lms.workflow_transition r
                                      WHERE r.workflow_code = p_workflow AND r.record_id = p_record_id
                                        AND r.action = 'Reopened'), 0)) THEN
      RAISE EXCEPTION 'segregation of duties: you already approved an earlier step of %', v_code
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF EXISTS (SELECT 1 FROM lms.workflow_transition t
               WHERE t.workflow_code = p_workflow AND t.record_id = p_record_id AND t.action = 'Reopened'
                 AND t.acted_by = v_actor
                 AND t.id = (SELECT max(r.id) FROM lms.workflow_transition r
                             WHERE r.workflow_code = p_workflow AND r.record_id = p_record_id
                               AND r.action = 'Reopened')) THEN
      RAISE EXCEPTION 'segregation of duties: you sent % back for changes and cannot also approve it', v_code
        USING ERRCODE = 'insufficient_privilege';
    END IF;$new$);
  IF v_new = v_def THEN
    RAISE EXCEPTION '0042: the separation-of-duties block of api.advance_workflow is not the expected one; merge the per-round rule by hand';
  END IF;
  EXECUTE v_new;
END $do$;

-- Renewing a lease escalates the agreed rent: the lease must be approved and
-- not held, the escalation is bounded by policy, and the renewal is made by
-- the position that approves leases.
INSERT INTO lms.system_setting (key, value, value_type, description)
VALUES ('leases.max_renewal_escalation_pct', '25'::jsonb, 'number',
        'Largest escalation (percent) a lease renewal may apply; a larger change needs a new lease approval')
ON CONFLICT (key) DO NOTHING;

CREATE FUNCTION api.renew_lease(p_lease_id uuid, p_years integer, p_escalation_pct numeric, p_note text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := util.require_actor();
  l record; v_max numeric; v_groups text[]; v_no smallint; v_rate numeric; v_term integer; v_end date;
BEGIN
  IF lms.actor_role() = 'Viewer' THEN
    RAISE EXCEPTION 'the Viewer role is read-only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO l FROM lms.lease WHERE id = p_lease_id FOR UPDATE;
  IF NOT FOUND OR (lms.actor_role() <> 'Admin' AND NOT lms.actor_can_see_province(l.province_code))
     OR NOT iam.has_permission_in('leases', 'update', l.province_code, l.project_id) THEN
    RAISE EXCEPTION 'the lease was not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF l.is_on_hold THEN
    RAISE EXCEPTION 'lease % is on hold (%); release the hold before renewing it', l.code, coalesce(l.hold_reason, 'administrative hold')
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF l.terminated_on IS NOT NULL THEN
    RAISE EXCEPTION 'lease % was terminated and cannot be renewed', l.code USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF l.stage_code <> 'Approved' THEN
    RAISE EXCEPTION 'only an approved lease is renewed; lease % is %', l.code, l.stage_code
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  SELECT array_agg(group_code ORDER BY group_code) INTO v_groups
  FROM lms.workflow_step_group WHERE workflow_code = 'leases' AND to_stage = 'Approved';
  IF v_groups IS NOT NULL AND NOT (v_groups && lms.actor_groups()) THEN
    RAISE EXCEPTION 'a renewal changes the agreed rent and is made by the % position', array_to_string(v_groups, ' or ')
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_years IS NULL OR p_years NOT BETWEEN 1 AND 25 THEN
    RAISE EXCEPTION 'a renewal adds between 1 and 25 years' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT (value #>> '{}')::numeric INTO v_max FROM lms.system_setting WHERE key = 'leases.max_renewal_escalation_pct';
  v_max := coalesce(v_max, 25);
  IF p_escalation_pct IS NULL OR p_escalation_pct < 0 OR p_escalation_pct > v_max THEN
    RAISE EXCEPTION 'the escalation must be between 0 and % percent', v_max USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_term := l.term_years + p_years;
  IF v_term > 99 THEN
    RAISE EXCEPTION 'the cumulative lease term cannot exceed 99 years' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_rate := round(l.rate_per_acre * (1 + p_escalation_pct / 100), 2);
  v_end := (l.start_date + make_interval(years => v_term))::date;
  SELECT coalesce(max(renewal_no), 0) + 1 INTO v_no FROM lms.lease_renewal WHERE lease_id = p_lease_id;
  INSERT INTO lms.lease_renewal (lease_id, renewal_no, renewed_on, new_end_date, old_rate, new_rate, escalation_pct, note, recorded_by)
  VALUES (p_lease_id, v_no, current_date, v_end, l.rate_per_acre, v_rate, p_escalation_pct,
          nullif(left(btrim(coalesce(p_note, '')), 500), ''), v_actor);
  UPDATE lms.lease SET term_years = v_term, rate_per_acre = v_rate, escalation_pct = p_escalation_pct, updated_by = v_actor
  WHERE id = p_lease_id;
  RETURN jsonb_build_object('renewal_no', v_no, 'old_rate', l.rate_per_acre, 'new_rate', v_rate, 'escalation_pct', p_escalation_pct,
                            'term_years', v_term, 'new_end_date', v_end,
                            'annual_rent', round(v_rate * coalesce(l.subsequent_area, l.initial_area), 2));
END $function$;
REVOKE ALL ON FUNCTION api.renew_lease(uuid, integer, numeric, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.renew_lease(uuid, integer, numeric, text) TO lms_readwrite;

-- ---------------------------------------------------------------------
-- F. Lifting a court stay (AUTHZ-05)
-- ---------------------------------------------------------------------
-- A stay freezes payments to the case's landowners and parcels; lifting it
-- releases them. It is therefore done only through api.lift_stay, by an
-- officer who may edit the legal case and who also holds the payment-hold
-- authority (payments:verify or payments:release), with the court's order
-- recorded as the reason.
CREATE FUNCTION lms.tg_legal_stay_authority()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE c_closed CONSTANT text[] := ARRAY['Decided — In Favour','Decided — Against','Settled','Withdrawn'];
BEGIN
  IF pg_has_role(current_user, 'lms_owner', 'MEMBER') THEN RETURN NEW; END IF;
  IF OLD.stay_order AND NOT (OLD.status = ANY (c_closed))
     AND NOT (NEW.stay_order AND NOT (NEW.status = ANY (c_closed))) THEN
    RAISE EXCEPTION 'a court stay is lifted by recording the court''s order (api.lift_stay), by an officer who may also lift payment holds'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION lms.tg_legal_stay_authority() FROM PUBLIC;
CREATE TRIGGER legal_case_stay_authority BEFORE UPDATE OF stay_order, status ON lms.legal_case
  FOR EACH ROW EXECUTE FUNCTION lms.tg_legal_stay_authority();

CREATE FUNCTION api.lift_stay(p_legal_case_id uuid, p_reason text, p_status text DEFAULT NULL)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE v_actor uuid := util.require_actor(); c record; v_n integer; v_t timestamptz := clock_timestamp();
BEGIN
  IF lms.actor_role() = 'Viewer' THEN
    RAISE EXCEPTION 'the Viewer role is read-only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO c FROM lms.legal_case WHERE id = p_legal_case_id FOR UPDATE;
  IF NOT FOUND OR (lms.actor_role() <> 'Admin' AND NOT lms.actor_can_see_province(c.province_code))
     OR NOT iam.has_permission_in('legal', 'update', c.province_code, c.project_id) THEN
    RAISE EXCEPTION 'the legal case was not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT (iam.has_permission_in('payments', 'verify', c.province_code, c.project_id)
          OR iam.has_permission_in('payments', 'release', c.province_code, c.project_id)) THEN
    RAISE EXCEPTION 'lifting a court stay releases held payments, so it needs the authority that places and lifts payment holds'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF length(btrim(coalesce(p_reason, ''))) < 10 THEN
    RAISE EXCEPTION 'record the court''s order that lifts the stay (at least 10 characters)' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT c.stay_order THEN
    RAISE EXCEPTION 'there is no stay order in force on legal case %', c.code USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  UPDATE lms.legal_case SET stay_order = false, status = coalesce(p_status, status), updated_by = v_actor
  WHERE id = p_legal_case_id;
  -- lms.tg_legal_case_stay has lifted the holds; record the court's order on each.
  UPDATE lms.payment_hold SET lift_reason = left(coalesce(lift_reason, '') || ' — ' || btrim(p_reason), 500)
  WHERE legal_case_id = p_legal_case_id AND lifted_at >= v_t AND lifted_by = v_actor;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $function$;
REVOKE ALL ON FUNCTION api.lift_stay(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.lift_stay(uuid, text, text) TO lms_readwrite;

-- ---------------------------------------------------------------------
-- G. Payments: scope of every id, holds, lease holds (AUTHZ-11/12/21)
-- ---------------------------------------------------------------------
-- As 0037, plus: the case, lease, DBPFC estimate and landowner a voucher
-- names must be in the voucher's province (an out-of-scope id is answered
-- exactly like a missing one), belong to its project, and a landowner payee
-- on a case must be one of the case's owners.
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
  v_ref      record;
  v_wht      numeric;
  v_tax      text;
  v_lo_prov  char(3);
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

  -- A payment may only be raised against an approved case of this project.
  IF p_case_id IS NOT NULL THEN
    SELECT c.stage_code, c.code, c.total_amount, c.province_code, c.project_id INTO v_case
    FROM lms.compensation_case c WHERE c.id = p_case_id;
    IF NOT FOUND OR v_case.province_code <> v_province THEN
      RAISE EXCEPTION 'the compensation case was not found in this project''s province' USING ERRCODE = 'no_data_found';
    END IF;
    IF v_case.stage_code <> 'HO Approved' THEN
      RAISE EXCEPTION 'case % is % — a payment may only be raised against an approved case',
        v_case.code, v_case.stage_code USING ERRCODE = 'raise_exception';
    END IF;
    IF v_case.project_id <> p_project_id THEN
      RAISE EXCEPTION 'case % belongs to a different project', v_case.code USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF p_landowner_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM lms.case_owner co WHERE co.case_id = p_case_id AND co.landowner_id = p_landowner_id) THEN
      RAISE EXCEPTION 'the payee is not an owner on case %', v_case.code USING ERRCODE = 'invalid_parameter_value';
    END IF;
  END IF;
  IF p_lease_id IS NOT NULL THEN
    SELECT l.province_code, l.project_id, l.code INTO v_ref FROM lms.lease l WHERE l.id = p_lease_id;
    IF NOT FOUND OR v_ref.province_code <> v_province THEN
      RAISE EXCEPTION 'the lease was not found in this project''s province' USING ERRCODE = 'no_data_found';
    END IF;
    IF v_ref.project_id <> p_project_id THEN
      RAISE EXCEPTION 'lease % belongs to a different project', v_ref.code USING ERRCODE = 'invalid_parameter_value';
    END IF;
  END IF;
  IF p_dbpfc_id IS NOT NULL THEN
    SELECT d.province_code, d.project_id, d.code INTO v_ref FROM lms.dbpfc_estimate d WHERE d.id = p_dbpfc_id;
    IF NOT FOUND OR v_ref.province_code <> v_province THEN
      RAISE EXCEPTION 'the DBPFC estimate was not found in this project''s province' USING ERRCODE = 'no_data_found';
    END IF;
    IF v_ref.project_id <> p_project_id THEN
      RAISE EXCEPTION 'DBPFC estimate % belongs to a different project', v_ref.code USING ERRCODE = 'invalid_parameter_value';
    END IF;
  END IF;

  -- Withholding tax (reference: "Default WHT % (filer; non-filer = 2x)"):
  --  * a landowner payee pays finance.wht_pct, times finance.wht_nonfiler_multiplier
  --    if a non-filer. This is policy: a different rate in the request is refused.
  --  * any other payee (e.g. Government of Sindh for government land) defaults
  --    to 0%, as in the reference; the requester may state a rate (0–100), which
  --    is recorded on the voucher and checked at verification.
  IF p_landowner_id IS NOT NULL THEN
    SELECT (value #>> '{}')::numeric INTO v_wht FROM lms.system_setting WHERE key = 'finance.wht_pct';
    IF v_wht IS NULL THEN
      RAISE EXCEPTION 'finance.wht_pct is not configured' USING ERRCODE = 'raise_exception';
    END IF;
    SELECT lo.tax_status, lo.province_code INTO v_tax, v_lo_prov FROM lms.landowner lo WHERE lo.id = p_landowner_id;
    IF NOT FOUND OR v_lo_prov <> v_province THEN
      RAISE EXCEPTION 'the landowner was not found in this project''s province' USING ERRCODE = 'no_data_found';
    END IF;
    IF v_tax = 'Non-Filer' THEN
      SELECT (value #>> '{}')::numeric INTO v_mult FROM lms.system_setting WHERE key = 'finance.wht_nonfiler_multiplier';
      IF v_mult IS NULL THEN
        RAISE EXCEPTION 'finance.wht_nonfiler_multiplier is not configured' USING ERRCODE = 'raise_exception';
      END IF;
      v_wht := v_wht * v_mult;
    END IF;
    IF p_wht_pct IS NOT NULL AND p_wht_pct <> v_wht THEN
      RAISE EXCEPTION 'withholding tax for a landowner is set by policy (% %%), not by the request', v_wht
        USING ERRCODE = 'raise_exception';
    END IF;
  ELSE
    v_wht := coalesce(p_wht_pct, 0);
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

-- As 0012, plus: the case is in the voucher's province and project, a named
-- landowner is an owner on it, and no code or amount of a record outside the
-- actor's scope is ever put in a message.
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
  v_liab  api.case_liability;
  v_allocated numeric;
  v_id    uuid;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'allocation amount must be positive' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT pr.id, pr.code, pr.net_amount, pr.province_code, pr.stage_code, pr.project_id
  INTO v_pay FROM lms.payment_request pr WHERE pr.id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such payment %', p_payment_id USING ERRCODE = 'no_data_found';
  END IF;
  IF lms.actor_role() <> 'Admin' AND NOT lms.actor_can_see_province(v_pay.province_code) THEN
    RAISE EXCEPTION 'payment is outside your province access' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_pay.stage_code IN ('Cancelled','Stopped') THEN
    RAISE EXCEPTION 'payment % is % and cannot be allocated', v_pay.code, v_pay.stage_code
      USING ERRCODE = 'raise_exception';
  END IF;

  SELECT c.province_code, c.project_id, c.code INTO v_case FROM lms.compensation_case c WHERE c.id = p_case_id;
  IF NOT FOUND OR v_case.province_code <> v_pay.province_code THEN
    RAISE EXCEPTION 'the compensation case was not found in this voucher''s province' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_case.project_id <> v_pay.project_id THEN
    RAISE EXCEPTION 'case % belongs to a different project than voucher %', v_case.code, v_pay.code
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_landowner_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM lms.case_owner co WHERE co.case_id = p_case_id AND co.landowner_id = p_landowner_id) THEN
    RAISE EXCEPTION 'the landowner is not an owner on case %', v_case.code USING ERRCODE = 'invalid_parameter_value';
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
END $function$;

-- A hold's province is its target's, whatever the client sent; a target the
-- caller cannot see reads as missing. A court-stay hold is lifted only
-- through the legal case (section F).
CREATE FUNCTION lms.tg_payment_hold_scope()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE v_prov text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.legal_case_id IS NOT NULL AND OLD.lifted_at IS NULL AND NEW.lifted_at IS NOT NULL
       AND NOT pg_has_role(current_user, 'lms_owner', 'MEMBER') THEN
      RAISE EXCEPTION 'a court-stay hold is lifted by recording the court''s order on the legal case'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF (NEW.scope, NEW.landowner_id, NEW.survey_id, NEW.case_id, NEW.payment_id, NEW.project_id, NEW.legal_case_id, NEW.province_code)
       IS NOT DISTINCT FROM
       (OLD.scope, OLD.landowner_id, OLD.survey_id, OLD.case_id, OLD.payment_id, OLD.project_id, OLD.legal_case_id, OLD.province_code) THEN
      RETURN NEW;
    END IF;
  END IF;
  v_prov := CASE NEW.scope
    WHEN 'landowner' THEN (SELECT province_code::text FROM lms.landowner WHERE id = NEW.landowner_id)
    WHEN 'survey'    THEN (SELECT province_code::text FROM lms.survey WHERE id = NEW.survey_id)
    WHEN 'case'      THEN (SELECT province_code::text FROM lms.compensation_case WHERE id = NEW.case_id)
    WHEN 'payment'   THEN (SELECT province_code::text FROM lms.payment_request WHERE id = NEW.payment_id)
    WHEN 'project'   THEN (SELECT province_code::text FROM lms.project WHERE id = NEW.project_id)
  END;
  IF v_prov IS NULL
     OR (NEW.legal_case_id IS NOT NULL
         AND (SELECT province_code::text FROM lms.legal_case WHERE id = NEW.legal_case_id) IS DISTINCT FROM v_prov) THEN
    RAISE EXCEPTION 'the record to hold was not found' USING ERRCODE = 'no_data_found';
  END IF;
  NEW.province_code := v_prov;
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION lms.tg_payment_hold_scope() FROM PUBLIC;
CREATE TRIGGER payment_hold_scope BEFORE INSERT OR UPDATE ON lms.payment_hold
  FOR EACH ROW EXECUTE FUNCTION lms.tg_payment_hold_scope();

-- As 0012/0031, plus: a voucher against a lease that is on hold is held. The
-- lease hold no longer freezes every payment of the project (a finance hold
-- does that, under payments:verify or payments:release).
CREATE OR REPLACE FUNCTION lms.wf_guard_payments(p_id uuid, p_to text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE p record; h record; b record; l record;
BEGIN
  SELECT pr.id, pr.landowner_id, pr.case_id, pr.project_id, pr.lease_id, pr.net_amount, pr.period_from
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

  IF p.lease_id IS NOT NULL THEN
    SELECT ls.code, ls.hold_reason INTO l FROM lms.lease ls WHERE ls.id = p.lease_id AND ls.is_on_hold;
    IF FOUND THEN
      RETURN format('Payment is on hold: lease %s is on hold (%s)', l.code, coalesce(l.hold_reason, 'administrative hold'));
    END IF;
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
END $function$;

-- ---------------------------------------------------------------------
-- H. Payee tax status and bank details (AUTHZ-14)
-- ---------------------------------------------------------------------
ALTER TABLE lms.landowner
  ADD COLUMN pay_details_changed_at    timestamptz,
  ADD COLUMN pay_details_changed_by    uuid REFERENCES lms.app_user(id),
  ADD COLUMN pay_details_change_reason text CHECK (pay_details_change_reason IS NULL OR length(pay_details_change_reason) <= 500);
COMMENT ON COLUMN lms.landowner.pay_details_changed_by IS
  'Who last changed tax status, IBAN, bank branch, CNIC or status (set by trigger). That person may not raise this payee''s voucher.';

ALTER TABLE lms.payment_request
  ADD COLUMN payee_tax_status text,
  ADD COLUMN payee_iban       text;
COMMENT ON COLUMN lms.payment_request.payee_tax_status IS
  'The landowner payee''s tax status when the voucher was raised; verification and release refuse a voucher whose payee changed since.';

-- Open vouchers get their snapshot now, before the rules below apply.
UPDATE lms.payment_request pr SET payee_tax_status = lo.tax_status, payee_iban = lo.iban
FROM lms.landowner lo
WHERE lo.id = pr.landowner_id AND pr.stage_code IN ('Requested','Verified');

CREATE FUNCTION lms.tg_landowner_pay_details()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.pay_details_changed_at := NULL; NEW.pay_details_changed_by := NULL;
    RETURN NEW;
  END IF;
  IF (NEW.tax_status, NEW.iban, NEW.bank_branch, NEW.cnic, NEW.status)
     IS DISTINCT FROM (OLD.tax_status, OLD.iban, OLD.bank_branch, OLD.cnic, OLD.status) THEN
    NEW.pay_details_changed_at := clock_timestamp();
    NEW.pay_details_changed_by := util.actor_id();
    IF NEW.pay_details_change_reason IS NOT DISTINCT FROM OLD.pay_details_change_reason THEN
      NEW.pay_details_change_reason := NULL;   -- a reason belongs to the change it came with
    END IF;
  ELSE
    -- Attribution is the trigger's, not the client's.
    NEW.pay_details_changed_at := OLD.pay_details_changed_at;
    NEW.pay_details_changed_by := OLD.pay_details_changed_by;
    NEW.pay_details_change_reason := OLD.pay_details_change_reason;
  END IF;
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION lms.tg_landowner_pay_details() FROM PUBLIC;
CREATE TRIGGER landowner_pay_details BEFORE INSERT OR UPDATE ON lms.landowner
  FOR EACH ROW EXECUTE FUNCTION lms.tg_landowner_pay_details();

-- At request: snapshot the payee's tax status and IBAN, and refuse a
-- requester who changed them (the change and the voucher are two people).
CREATE FUNCTION lms.tg_payment_payee_snapshot()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE lo record;
BEGIN
  IF NEW.landowner_id IS NULL THEN RETURN NEW; END IF;
  SELECT tax_status, iban, pay_details_changed_by INTO lo FROM lms.landowner WHERE id = NEW.landowner_id;
  NEW.payee_tax_status := lo.tax_status;
  NEW.payee_iban := lo.iban;
  IF lo.pay_details_changed_by IS NOT NULL AND lo.pay_details_changed_by = util.actor_id() THEN
    -- Vouchers are raised by api.request_payment (owner context); the signed
    -- system context (seed, maintenance) is the only exemption.
    IF pg_has_role(current_user, 'lms_owner', 'MEMBER') THEN
      IF iam.is_system_actor() THEN RETURN NEW; END IF;
    END IF;
    RAISE EXCEPTION 'segregation of duties: you changed this payee''s tax status or bank details, so another person must raise the voucher'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION lms.tg_payment_payee_snapshot() FROM PUBLIC;
CREATE TRIGGER payment_request_payee_snapshot BEFORE INSERT ON lms.payment_request
  FOR EACH ROW EXECUTE FUNCTION lms.tg_payment_payee_snapshot();

-- At verification and release: the payee is still who the voucher was raised for.
CREATE FUNCTION lms.tg_payment_payee_unchanged()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE lo record;
BEGIN
  IF NEW.stage_code IS NOT DISTINCT FROM OLD.stage_code OR NEW.stage_code NOT IN ('Verified','Released')
     OR NEW.landowner_id IS NULL OR OLD.payee_tax_status IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT tax_status, iban INTO lo FROM lms.landowner WHERE id = NEW.landowner_id;
  IF lo.tax_status IS DISTINCT FROM OLD.payee_tax_status OR lo.iban IS DISTINCT FROM OLD.payee_iban THEN
    RAISE EXCEPTION 'the payee''s tax status or bank account changed after voucher % was raised; cancel it and raise a new one', OLD.code
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION lms.tg_payment_payee_unchanged() FROM PUBLIC;
CREATE TRIGGER payment_request_payee_unchanged BEFORE UPDATE OF stage_code ON lms.payment_request
  FOR EACH ROW EXECUTE FUNCTION lms.tg_payment_payee_unchanged();

-- ---------------------------------------------------------------------
-- I. Documents (AUTHZ-19, AUTHZ-20)
-- ---------------------------------------------------------------------
-- A document's file and attribution never change (a correction is a new
-- version). Archiving is the only change the application may make, by
-- someone other than the uploader, with a reason, and never while the
-- record it belongs to is approved or closed: that record's evidence is
-- kept. Rows and bytes are never deleted (the application has no DELETE),
-- so category retention is preserved.
CREATE FUNCTION lms.tg_document_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  IF pg_has_role(current_user, 'lms_owner', 'MEMBER') THEN RETURN NEW; END IF;
  IF OLD.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'document % is archived and cannot be changed', OLD.code USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF (NEW.code, NEW.entity, NEW.record_id, NEW.record_code, NEW.province_code, NEW.file_name, NEW.mime_type, NEW.size_bytes,
      NEW.category_code, NEW.version, NEW.storage_ref, NEW.content_sha256, NEW.uploaded_at, NEW.uploaded_by)
     IS DISTINCT FROM
     (OLD.code, OLD.entity, OLD.record_id, OLD.record_code, OLD.province_code, OLD.file_name, OLD.mime_type, OLD.size_bytes,
      OLD.category_code, OLD.version, OLD.storage_ref, OLD.content_sha256, OLD.uploaded_at, OLD.uploaded_by) THEN
    RAISE EXCEPTION 'a document''s file and attribution cannot be changed; upload a new version instead'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.deleted_at IS NULL THEN RETURN NEW; END IF;
  IF util.actor_id() = OLD.uploaded_by THEN
    RAISE EXCEPTION 'segregation of duties: a document is archived by someone other than the person who uploaded it'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF length(btrim(coalesce(NEW.delete_reason, ''))) < 5 THEN
    RAISE EXCEPTION 'give a reason for archiving (at least 5 characters)' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF lms.record_closed(OLD.entity, OLD.record_id) THEN
    RAISE EXCEPTION 'the record document % belongs to is approved or closed, so its documents are kept', OLD.code
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  NEW.deleted_by := util.actor_id();
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION lms.tg_document_guard() FROM PUBLIC;
CREATE TRIGGER document_guard BEFORE UPDATE ON lms.document
  FOR EACH ROW EXECUTE FUNCTION lms.tg_document_guard();

-- An access is logged only for a document the actor can see.
CREATE FUNCTION lms.tg_document_access_visible()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  IF pg_has_role(current_user, 'lms_owner', 'MEMBER') THEN RETURN NEW; END IF;
  PERFORM 1 FROM lms.document WHERE id = NEW.document_id AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the document was not found' USING ERRCODE = 'no_data_found';
  END IF;
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION lms.tg_document_access_visible() FROM PUBLIC;
CREATE TRIGGER document_access_visible BEFORE INSERT ON lms.document_access_log
  FOR EACH ROW EXECUTE FUNCTION lms.tg_document_access_visible();

-- ---------------------------------------------------------------------
-- J. Release and receipt (AUTHZ-23)
-- ---------------------------------------------------------------------
-- api.release_payment moves a voucher to Released without api.advance_workflow,
-- so the approval matrix and separation of duties are applied here, on the
-- release row it writes (the application cannot insert one). It fires inside
-- the definer routine, so owner context is not an exemption; only the signed
-- system context (seed, maintenance) is.
CREATE FUNCTION lms.tg_release_matrix()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE v_required text[]; v_sod text; p record;
BEGIN
  IF iam.is_system_actor() THEN RETURN NEW; END IF;
  SELECT array_agg(group_code ORDER BY group_code) INTO v_required
  FROM lms.workflow_step_group WHERE workflow_code = 'payments' AND to_stage = 'Released';
  IF v_required IS NOT NULL AND NOT (v_required && lms.actor_groups()) THEN
    RAISE EXCEPTION 'the Released step is for: %', array_to_string(v_required, ', ')
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT sod_mode INTO v_sod FROM lms.workflow WHERE code = 'payments';
  IF v_sod = 'strict' THEN
    SELECT created_by, code INTO p FROM lms.payment_request WHERE id = NEW.payment_id;
    IF p.created_by = NEW.released_by
       OR EXISTS (SELECT 1 FROM lms.workflow_transition t
                  WHERE t.workflow_code = 'payments' AND t.record_id = NEW.payment_id
                    AND t.action = 'Advanced' AND t.acted_by = NEW.released_by) THEN
      RAISE EXCEPTION 'segregation of duties: the person who raised or verified voucher % cannot also release it', p.code
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION lms.tg_release_matrix() FROM PUBLIC;
CREATE TRIGGER payment_release_matrix BEFORE INSERT ON lms.payment_release
  FOR EACH ROW EXECUTE FUNCTION lms.tg_release_matrix();

-- Proof of payment is not self-attested: neither the voucher's raiser nor its
-- releaser records the payee's acknowledgment.
CREATE FUNCTION lms.tg_receipt_sod()
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
  NEW.recorded_by := util.actor_id();
  IF NEW.recorded_by = r.created_by OR NEW.recorded_by = r.released_by THEN
    RAISE EXCEPTION 'segregation of duties: the person who raised or released voucher % cannot also record its receipt', r.code
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION lms.tg_receipt_sod() FROM PUBLIC;
CREATE TRIGGER payment_receipt_sod BEFORE INSERT ON lms.payment_receipt
  FOR EACH ROW EXECUTE FUNCTION lms.tg_receipt_sod();

-- ---------------------------------------------------------------------
-- K. Land-request approval tiers are positions (AUTHZ-03)
-- ---------------------------------------------------------------------
-- The tiers were names on the request, compared with nobody. They are now
-- approval positions an administrator assigns (users:assign), and the
-- person recorded against a tier must hold it.
INSERT INTO lms.approval_group (code, name, display_order) VALUES
  ('Director Operations', 'Director Operations (land requests, tier 2)', 110),
  ('Regional Manager', 'Regional Manager (land requests, tier 3)', 120),
  ('DM / TL Land Affairs', 'DM / TL Land Affairs (land requests, tier 4)', 130)
ON CONFLICT (code) DO NOTHING;

-- Definer, to ask iam.holds_system_admin; only migration and seed sessions
-- (owner members) are exempt. No routine writes these columns.
CREATE FUNCTION lms.tg_land_request_tier()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE v_groups text[]; v_actor uuid := util.actor_id();
BEGIN
  IF pg_has_role(session_user, 'lms_owner', 'MEMBER') THEN RETURN NEW; END IF;
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
REVOKE ALL ON FUNCTION lms.tg_land_request_tier() FROM PUBLIC;
CREATE TRIGGER land_request_tier BEFORE UPDATE OF director_ops_id, regional_mgr_id, land_affairs_id ON lms.land_request
  FOR EACH ROW EXECUTE FUNCTION lms.tg_land_request_tier();

RESET ROLE;
