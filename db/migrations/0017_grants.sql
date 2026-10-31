-- =====================================================================
-- 0017  Grants: least privilege for the runtime and reporting roles
-- =====================================================================
-- The shape of this file is the access-control design, so it is worth stating
-- before the SQL:
--
--   lms_owner      owns everything, cannot log in. Migrations SET ROLE to it.
--   lms_readwrite  the application runtime. SELECT/INSERT/UPDATE on the
--                  transactional tables, SELECT on reference data, DELETE on
--                  almost nothing, no DDL, no privilege on the ledgers.
--   lms_readonly   reporting. SELECT on views and on base tables with the
--                  sensitive columns withheld.
--
-- Three groups of tables are deliberately NOT writable by the application at
-- all, and that is the main point of the file:
--
--   * the audit tables, so the trail cannot be fabricated or edited;
--   * lms.payment_release, lms.workflow_transition,
--     lms.survey_ownership_history, lms.setting_history,
--     lms.dbpfc_rate_history and lms.idempotency_key, so money, approvals and
--     ownership transfers can only happen through the api routines that record
--     them properly;
--   * every reference table, so a running application cannot redefine a
--     workflow, a conversion factor or a tax rate.
--
-- The routines that write those tables are SECURITY DEFINER and run as
-- lms_owner, which is how the application gets the effect without the
-- privilege. Each one re-checks province access, since definer rights bypass
-- row-level security.
SET ROLE lms_owner;

-- Nothing is granted to PUBLIC. Functions in particular default to
-- EXECUTE for PUBLIC, which would undo the whole arrangement.
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA api, lms, audit, util FROM PUBLIC;
REVOKE ALL ON SCHEMA util FROM PUBLIC;
-- util.actor_id() and util.require_actor() are reached from invoker-rights
-- triggers running as the application role, so that role needs USAGE on the
-- schema. Nothing else in util is granted.
GRANT USAGE ON SCHEMA util TO lms_readwrite, lms_readonly;
REVOKE ALL ON ALL TABLES IN SCHEMA lms, audit, api FROM PUBLIC;

GRANT USAGE ON SCHEMA lms, api, audit, ext, util TO lms_readwrite, lms_readonly;

-- ---------------------------------------------------------------------
-- Reference data: readable, not writable. A workflow definition, a conversion
-- factor or the withholding rate changes through a migration or through
-- api.set_setting(), never through the application's own connection.
-- ---------------------------------------------------------------------
DO $$
DECLARE t text;
  reference text[] := ARRAY[
    'province','province_level','measurement_unit','unit_conversion','province_unit',
    'app_role','approval_group','office','land_status','project_type','land_use',
    'tree_species','payment_category','title_check_item','case_document_item',
    'grievance_category','encroachment_category','document_category',
    'workflow','workflow_stage','workflow_step_group','workflow_matrix_history',
    'code_sequence','integration_endpoint','system_setting','setting_history',
    'migration_reconciliation','data_provenance'];
BEGIN
  FOREACH t IN ARRAY reference LOOP
    EXECUTE format('GRANT SELECT ON lms.%I TO lms_readwrite, lms_readonly', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- Transactional tables: read, create and amend. No DELETE: a record is
-- cancelled, withdrawn or soft-deleted so that it stays explicable.
-- ---------------------------------------------------------------------
DO $$
DECLARE t text;
  rw text[] := ARRAY[
    'admin_unit','project','survey','landowner','survey_ownership_share',
    'acquisition','compensation_case','lease','lease_renewal','row_corridor',
    'payment_request','payment_allocation','payment_receipt','payment_hold',
    'budget','dbpfc_estimate','grievance','encroachment','legal_case',
    'legal_hearing','mutation','document','notification','login_session',
    'import_batch','import_row','import_validation_error',
    'reconciliation_run','reconciliation_exception','workflow_comment',
    'workflow_escalation','workflow_assignment','app_user','app_user_group',
    'app_user_province'];
BEGIN
  FOREACH t IN ARRAY rw LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON lms.%I TO lms_readwrite', t);
  END LOOP;
END $$;

-- Child rows that are genuinely part of editing a draft: adding and removing a
-- lease line, a payee, a linked parcel. DELETE here is editing, not erasure;
-- the locking triggers stop it once the parent is approved.
DO $$
DECLARE t text;
  rwd text[] := ARRAY[
    'project_survey','acquisition_survey','acquisition_title_check',
    'case_owner','case_lease_line','case_crop_line','case_tree_line',
    'case_misc_line','case_document_check','lease_lessor','lease_survey',
    'row_survey','row_landowner','dbpfc_survey','legal_case_landowner',
    'legal_case_survey','mutation_survey','mutation_heir','survey_ownership_share',
    -- Staging rows: correcting a file before promotion means removing or
    -- editing the offending lines. Nothing here has reached a live register
    -- yet, and the batch itself keeps the counts and the audit trail.
    'import_row','import_validation_error'];
BEGIN
  FOREACH t IN ARRAY rwd LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON lms.%I TO lms_readwrite', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- The ledgers. SELECT only. There is no INSERT grant, which means the
-- application cannot create a payment release, a workflow decision or an
-- ownership-transfer record even by mistake — only api.release_payment(),
-- api.advance_workflow() and api.apply_mutation() can, and each of those
-- records the surrounding evidence in the same transaction.
-- ---------------------------------------------------------------------
DO $$
DECLARE t text;
  ledger text[] := ARRAY[
    'payment_release','workflow_transition','survey_ownership_history',
    'dbpfc_rate_history','idempotency_key','integration_outbox'];
BEGIN
  FOREACH t IN ARRAY ledger LOOP
    EXECUTE format('GRANT SELECT ON lms.%I TO lms_readwrite, lms_readonly', t);
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON lms.%I FROM lms_readwrite, lms_readonly', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- Audit. SELECT only, and the revokes are explicit rather than merely absent,
-- so a later blanket GRANT does not quietly re-open them. TRUNCATE is revoked
-- separately because it fires no row triggers and so would slip past the
-- append-only trigger entirely.
-- ---------------------------------------------------------------------
GRANT SELECT ON audit.audit_event, audit.record_version, audit.auth_event
  TO lms_readwrite, lms_readonly;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE
  ON audit.audit_event, audit.record_version, audit.auth_event
  FROM lms_readwrite, lms_readonly;
GRANT SELECT ON lms.document_access_log TO lms_readwrite, lms_readonly;
REVOKE UPDATE, DELETE, TRUNCATE ON lms.document_access_log FROM lms_readwrite, lms_readonly;
-- Recording a document read is the one audit write the application makes
-- directly, because it happens on a read path where no definer routine runs.
GRANT INSERT ON lms.document_access_log TO lms_readwrite;

-- ---------------------------------------------------------------------
-- Sequences. The code sequences are used by lms.next_code(), which is
-- invoker-rights, so the application needs USAGE. The cheque sequence is not:
-- only api.release_payment() draws from it, and that runs as the owner.
-- ---------------------------------------------------------------------
GRANT USAGE ON ALL SEQUENCES IN SCHEMA lms TO lms_readwrite;
REVOKE ALL ON SEQUENCE lms.cheque_no_seq FROM lms_readwrite, lms_readonly;
COMMENT ON SEQUENCE lms.cheque_no_seq IS
  'Cheque numbers. The application has no privilege on this sequence: only '
  'api.release_payment() may draw a cheque number, so one cannot be burned or '
  'skipped outside a release.';

-- ---------------------------------------------------------------------
-- Reporting role: base-table access with the sensitive columns withheld.
--
-- This is needed because the api views are security_invoker, which means they
-- read their base tables with the CALLER's privileges. That is what makes
-- row-level security apply to a view (see the header of migration 0014), and
-- the price is that the reporting role must hold SELECT on the base tables.
-- Row visibility is identical either way — the policies decide it — so what is
-- left to control is columns, and that is done here: no CNIC, no IBAN, no bank
-- details, no address, no password hash, no session token.
-- ---------------------------------------------------------------------
GRANT SELECT (id, code, province_code, full_name, father_name, owner_type,
              status, tax_status, created_at, updated_at, version)
  ON lms.landowner TO lms_readonly;
COMMENT ON COLUMN lms.landowner.cnic IS
  'National identity number. Column-level SELECT is NOT granted to lms_readonly: '
  'reporting does not need to identify a person to that degree.';

GRANT SELECT (id, code, username, full_name, role_code, department, position,
              office_code, status, is_service_account, last_login_at, created_at)
  ON lms.app_user TO lms_readonly;

GRANT SELECT (id, user_id, started_at, last_seen_at, expires_at, ended_at,
              end_reason, source_ip)
  ON lms.login_session TO lms_readonly;

GRANT SELECT (id, code, entity, record_id, record_code, province_code, file_name,
              mime_type, size_bytes, category_code, version, uploaded_at,
              uploaded_by, deleted_at)
  ON lms.document TO lms_readonly;

DO $$
DECLARE t text;
  ro text[] := ARRAY[
    'admin_unit','project','survey','survey_ownership_share','survey_ownership_history',
    'project_survey','acquisition','acquisition_survey','acquisition_title_check',
    'compensation_case','case_owner','case_lease_line','case_crop_line','case_tree_line',
    'case_misc_line','case_document_check','lease','lease_lessor','lease_survey',
    'lease_renewal','row_corridor','row_survey','row_landowner','payment_request',
    'payment_allocation','payment_receipt','payment_hold','budget','dbpfc_estimate',
    'dbpfc_survey','grievance','encroachment','legal_case','legal_case_landowner',
    'legal_case_survey','legal_hearing','mutation','mutation_survey','mutation_heir',
    'notification','import_batch','import_row','import_validation_error',
    'reconciliation_run','reconciliation_exception','workflow_comment',
    'workflow_escalation','workflow_assignment','app_user_group','app_user_province'];
BEGIN
  FOREACH t IN ARRAY ro LOOP
    EXECUTE format('GRANT SELECT ON lms.%I TO lms_readonly', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- Views
-- ---------------------------------------------------------------------
GRANT SELECT ON ALL TABLES IN SCHEMA api TO lms_readwrite;

-- The reporting role gets the views that do not expose an identifier.
-- v_landowner_summary and v_payment_release carry CNICs and are withheld;
-- the masked equivalents below replace them.
GRANT SELECT ON
  api.v_admin_unit_path, api.v_survey_ownership, api.v_project_land_status,
  api.v_lease_register, api.v_lease_expiry_alert, api.v_row_renewal_schedule,
  api.v_case_status, api.v_approval_bottleneck, api.v_outstanding_liability,
  api.v_reconciliation_exception, api.v_budget_utilisation, api.v_dbpfc_summary,
  api.v_grievance_status, api.v_encroachment_status, api.v_audit_trail,
  api.v_record_version_history, api.v_province_summary
  TO lms_readonly;

-- ---------------------------------------------------------------------
-- Masked reporting views.
--
-- These two are the one deliberate exception to security_invoker, and the
-- reasoning is worth being explicit about.
--
-- A security_invoker view cannot mask a column, because computing the mask
-- requires reading the column, which requires the caller to hold SELECT on
-- it — at which point the caller can simply read it unmasked. So these views
-- run with owner rights, which does bypass row-level security, and therefore
-- they re-implement the province scope in the view body with exactly the
-- predicate the policies use. That is the "equivalent, explicitly reviewed"
-- design, and it is reviewed here: the predicate is the same function call the
-- policy makes, Internal Audit is not given a wider scope than the policy
-- gives it, and db/tests/test_05_views_rls.sql asserts that these two views
-- return the same row set as their unmasked equivalents for the same actor.
--
-- The risk this accepts: if the predicate below and the policy in 0016 ever
-- drift apart, these views become a way around the policy. The test is what
-- holds them together, and the risk is recorded as DB-05 in
-- docs/SECURITY_FINDINGS.md.
-- ---------------------------------------------------------------------
CREATE FUNCTION api.mask_cnic(p_cnic text) RETURNS text
  LANGUAGE sql IMMUTABLE
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE WHEN p_cnic IS NULL THEN NULL
              ELSE left(p_cnic, 5) || '-*******-' || right(p_cnic, 1) END;
$$;
COMMENT ON FUNCTION api.mask_cnic(text) IS
  'Keeps the district prefix and the check digit, hides the identifying middle. '
  'Enough to match a report line against a record, not enough to identify a '
  'person who is not already known.';

CREATE VIEW api.v_landowner_summary_masked AS
SELECT landowner_id, landowner_code, province_code, full_name, father_name,
       api.mask_cnic(cnic) AS cnic_masked,
       owner_type, status, tax_status,
       holding_count, owned_area_acres, active_lease_count, paid_to_date, is_on_hold
FROM api.v_landowner_summary
WHERE lms.actor_role() = 'Admin'
   OR province_code = ANY (lms.actor_provinces());
COMMENT ON VIEW api.v_landowner_summary_masked IS
  'Owner-rights view (NOT security_invoker) with the province predicate '
  'restated in the body, so the CNIC can be masked. See the header of '
  'migration 0017 for why, and the risk that accepts.';

CREATE VIEW api.v_payment_release_masked AS
SELECT release_id, payment_id, voucher_code, province_code, project_code,
       payee, landowner_code, api.mask_cnic(cnic) AS cnic_masked,
       category_code, pay_type, period_from, period_to,
       gross_amount, wht_amount, net_amount,
       cheque_no, cheque_date, released_amount, released_at, released_by,
       receipt_count, case_code, lease_code
FROM api.v_payment_release
WHERE lms.actor_role() = 'Admin'
   OR province_code = ANY (lms.actor_provinces());

GRANT SELECT ON api.v_landowner_summary_masked, api.v_payment_release_masked
  TO lms_readonly, lms_readwrite;

-- ---------------------------------------------------------------------
-- Routines
-- ---------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION
  api.set_actor(uuid),
  api.convert_area(numeric,text,text,date,boolean),
  api.acre_ghunta(numeric),
  api.case_totals(uuid),
  api.recalculate_case_totals(uuid),
  api.ownership_share_total(uuid),
  api.validate_ownership_shares(uuid),
  api.validate_survey_area(uuid),
  api.budget_status(uuid,integer),
  api.case_liability(uuid),
  api.advance_workflow(text,uuid,text,text,text),
  api.request_payment(text,uuid,text,text,date,numeric,text,uuid,text,uuid,uuid,uuid,date,numeric,text,text),
  api.release_payment(uuid,text,date,text),
  api.allocate_payment(uuid,uuid,numeric,uuid,text),
  api.reconcile(text,uuid,date),
  api.apply_mutation(uuid),
  api.mask_cnic(text),
  lms.next_code(text),
  lms.next_code_year(text,integer),
  lms.actor_provinces(),
  lms.actor_role(),
  lms.actor_groups(),
  lms.actor_can_see_province(char),
  util.actor_id(),
  util.require_actor(),
  -- Reached from the invoker-rights locking triggers.
  util.generated_columns(oid)
  TO lms_readwrite;

GRANT EXECUTE ON FUNCTION
  api.convert_area(numeric,text,text,date,boolean),
  api.acre_ghunta(numeric),
  api.case_totals(uuid),
  api.budget_status(uuid,integer),
  api.case_liability(uuid),
  api.ownership_share_total(uuid),
  api.validate_ownership_shares(uuid),
  api.validate_survey_area(uuid),
  api.mask_cnic(text),
  api.set_actor(uuid),
  lms.actor_provinces(),
  lms.actor_role(),
  lms.actor_groups(),
  lms.actor_can_see_province(char),
  util.actor_id()
  TO lms_readonly;

-- api.apply_mutation is called by api.advance_workflow and should not be
-- callable on its own: applying a mutation outside its approval would move
-- ownership with no approval behind it.
REVOKE EXECUTE ON FUNCTION api.apply_mutation(uuid) FROM lms_readwrite;
COMMENT ON FUNCTION api.apply_mutation(uuid) IS
  'Called only by api.advance_workflow() on final approval. EXECUTE is '
  'deliberately NOT granted to the application: moving ownership is a '
  'consequence of an approval, never an operation of its own.';

-- ---------------------------------------------------------------------
-- Settings are changed through a routine that checks the actor is an Admin,
-- not by granting UPDATE on the table. The role system cannot tell one
-- application user from another; the actor context can.
-- ---------------------------------------------------------------------
CREATE FUNCTION api.set_setting(p_key text, p_value jsonb, p_note text DEFAULT NULL)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_actor uuid := util.require_actor(); v_old jsonb;
BEGIN
  IF lms.actor_role() <> 'Admin' THEN
    RAISE EXCEPTION 'only an Admin may change configuration' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT value INTO v_old FROM lms.system_setting WHERE key = p_key FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown setting %', p_key USING ERRCODE = 'invalid_parameter_value',
      HINT = 'settings are defined by migration; a new one is not created at runtime';
  END IF;
  -- The note is handed to the history trigger through a transaction-local
  -- parameter rather than written afterwards: lms.setting_history is
  -- append-only, so there is no afterwards.
  PERFORM set_config('lms.change_note', coalesce(p_note, ''), true);
  UPDATE lms.system_setting
     SET value = p_value, updated_at = clock_timestamp(), updated_by = v_actor,
         version = version + 1
   WHERE key = p_key;
  RETURN v_old;
END $$;
COMMENT ON FUNCTION api.set_setting(text,jsonb,text) IS
  'The only way the application changes configuration. SECURITY DEFINER '
  'because the application has no UPDATE on lms.system_setting; it checks the '
  'actor''s role itself, which a table grant cannot. The change is recorded in '
  'lms.setting_history by trigger.';
GRANT EXECUTE ON FUNCTION api.set_setting(text,jsonb,text) TO lms_readwrite;

-- ---------------------------------------------------------------------
-- A final sweep. Migration 0001 sets the default privileges so that a new
-- routine cannot arrive world-executable, and this catches anything created
-- by a role other than lms_owner, or before that default was in place.
-- db/tests/test_10_roles_grants.sql asserts the result rather than trusting it.
-- ---------------------------------------------------------------------
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA lms, api, audit, util FROM PUBLIC;
