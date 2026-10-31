-- =====================================================================
-- 0016  Row-level security: province scoping
-- =====================================================================
-- The prototype enforced province scope in the browser (app/assets/js/app/scope.js).
-- That is a usability feature, not a boundary: a crafted request bypasses it.
-- Here the boundary is in the database, below the application, so a query the
-- application forgot to scope still cannot return another province's rows.
--
-- How it works: lms.actor_provinces() reads the access list for the actor set
-- by api.set_actor(), and every policy is written in terms of it. With no
-- actor set the function returns an empty array, so the default is to see
-- nothing rather than everything.
--
-- What bypasses it, deliberately and documented:
--   * lms_owner, because an owner always bypasses its own tables' policies.
--     That is why the application does not run as lms_owner and why
--     lms_owner cannot log in.
--   * SECURITY DEFINER routines, which run as lms_owner. Each one re-checks
--     province access itself; api.advance_workflow(), api.request_payment(),
--     api.release_payment() and api.allocate_payment() all do, and
--     db/tests/test_06_rls_scope.sql tests that they do.
--   * Superusers and any role with BYPASSRLS. None of the LMS roles has it.
SET ROLE lms_owner;

-- ---------------------------------------------------------------------
-- Tables that carry province_code directly.
--
-- Admin sees every province: the role exists to administer all four, and the
-- prototype's Users screen already lets an Admin change anyone's access, so
-- restricting them would be theatre. Every Admin action is audited.
-- ---------------------------------------------------------------------
DO $$
DECLARE t text;
  direct text[] := ARRAY[
    'admin_unit','project','survey','landowner','acquisition','compensation_case',
    'lease','row_corridor','payment_request','payment_release','payment_hold',
    'budget','dbpfc_estimate','grievance','encroachment','legal_case','mutation',
    'workflow_transition','workflow_comment','workflow_escalation','document',
    'reconciliation_run','import_batch'];
BEGIN
  FOREACH t IN ARRAY direct LOOP
    EXECUTE format('ALTER TABLE lms.%I ENABLE ROW LEVEL SECURITY', t);
    -- One permissive policy for all commands. USING governs which rows are
    -- visible and which may be updated or deleted; WITH CHECK governs which
    -- may be written, so an in-scope account cannot insert a row into another
    -- province or move one out of its own scope.
    EXECUTE format($f$
      CREATE POLICY province_scope ON lms.%I
        FOR ALL TO lms_readwrite, lms_readonly
        USING      (lms.actor_role() = 'Admin' OR province_code = ANY (lms.actor_provinces()))
        WITH CHECK (lms.actor_role() = 'Admin' OR province_code = ANY (lms.actor_provinces()))
    $f$, t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- Child tables, scoped through their parent. Generated from a mapping so the
-- policies cannot drift from one another, and so a child table added later
-- without an entry here has no policy and is therefore invisible rather than
-- accidentally open.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  m text[][] := ARRAY[
    -- child table,                parent table,          child FK column,  parent key
    ['project_survey',            'project',             'project_id',      'id'],
    ['survey_ownership_share',    'survey',              'survey_id',       'id'],
    ['survey_ownership_history',  'survey',              'survey_id',       'id'],
    ['acquisition_survey',        'acquisition',         'acquisition_id',  'id'],
    ['acquisition_title_check',   'acquisition',         'acquisition_id',  'id'],
    ['case_owner',                'compensation_case',   'case_id',         'id'],
    ['case_lease_line',           'compensation_case',   'case_id',         'id'],
    ['case_crop_line',            'compensation_case',   'case_id',         'id'],
    ['case_tree_line',            'compensation_case',   'case_id',         'id'],
    ['case_misc_line',            'compensation_case',   'case_id',         'id'],
    ['case_document_check',       'compensation_case',   'case_id',         'id'],
    ['lease_lessor',              'lease',               'lease_id',        'id'],
    ['lease_survey',              'lease',               'lease_id',        'id'],
    ['lease_renewal',             'lease',               'lease_id',        'id'],
    ['row_survey',                'row_corridor',        'row_id',          'id'],
    ['row_landowner',             'row_corridor',        'row_id',          'id'],
    ['payment_allocation',        'payment_request',     'payment_id',      'id'],
    ['payment_receipt',           'payment_release',     'release_id',      'id'],
    ['dbpfc_survey',              'dbpfc_estimate',      'dbpfc_id',        'id'],
    ['dbpfc_rate_history',        'dbpfc_estimate',      'dbpfc_id',        'id'],
    ['legal_case_landowner',      'legal_case',          'legal_case_id',   'id'],
    ['legal_case_survey',         'legal_case',          'legal_case_id',   'id'],
    ['legal_hearing',             'legal_case',          'legal_case_id',   'id'],
    ['mutation_survey',           'mutation',            'mutation_id',     'id'],
    ['mutation_heir',             'mutation',            'mutation_id',     'id'],
    ['import_row',                'import_batch',        'batch_id',        'id'],
    ['import_validation_error',   'import_batch',        'batch_id',        'id'],
    ['reconciliation_exception',  'reconciliation_run',  'run_id',          'id']
  ];
  i integer;
BEGIN
  FOR i IN 1 .. array_length(m, 1) LOOP
    EXECUTE format('ALTER TABLE lms.%I ENABLE ROW LEVEL SECURITY', m[i][1]);
    EXECUTE format($f$
      CREATE POLICY province_scope_via_parent ON lms.%I
        FOR ALL TO lms_readwrite, lms_readonly
        USING (lms.actor_role() = 'Admin' OR EXISTS (
                 SELECT 1 FROM lms.%I p
                 WHERE p.%I = lms.%I.%I
                   AND p.province_code = ANY (lms.actor_provinces())))
        WITH CHECK (lms.actor_role() = 'Admin' OR EXISTS (
                 SELECT 1 FROM lms.%I p
                 WHERE p.%I = lms.%I.%I
                   AND p.province_code = ANY (lms.actor_provinces())))
    $f$, m[i][1],
         m[i][2], m[i][4], m[i][1], m[i][3],
         m[i][2], m[i][4], m[i][1], m[i][3]);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- Per-user tables. A notification belongs to one person; an account's own
-- row is visible to that account and to an Admin, and to nobody else.
-- ---------------------------------------------------------------------
ALTER TABLE lms.notification ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_notifications ON lms.notification
  FOR ALL TO lms_readwrite, lms_readonly
  USING      (user_id = util.actor_id() OR lms.actor_role() = 'Admin')
  WITH CHECK (user_id = util.actor_id() OR lms.actor_role() = 'Admin');

ALTER TABLE lms.login_session ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_sessions ON lms.login_session
  FOR ALL TO lms_readwrite, lms_readonly
  USING      (user_id = util.actor_id() OR lms.actor_role() = 'Admin')
  WITH CHECK (user_id = util.actor_id() OR lms.actor_role() = 'Admin');

-- An ordinary account sees its own user row; an Admin administers all of them.
ALTER TABLE lms.app_user ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_or_admin ON lms.app_user
  FOR ALL TO lms_readwrite, lms_readonly
  USING      (id = util.actor_id() OR lms.actor_role() = 'Admin')
  WITH CHECK (lms.actor_role() = 'Admin');
COMMENT ON POLICY own_or_admin ON lms.app_user IS
  'WITH CHECK is Admin-only on purpose: an account may read its own row but '
  'not write one, so a user cannot grant themselves a role or an extra province.';

ALTER TABLE lms.app_user_province ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_or_admin ON lms.app_user_province
  FOR ALL TO lms_readwrite, lms_readonly
  USING      (user_id = util.actor_id() OR lms.actor_role() = 'Admin')
  WITH CHECK (lms.actor_role() = 'Admin');

ALTER TABLE lms.app_user_group ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_or_admin ON lms.app_user_group
  FOR ALL TO lms_readwrite, lms_readonly
  USING      (user_id = util.actor_id() OR lms.actor_role() = 'Admin')
  WITH CHECK (lms.actor_role() = 'Admin');

-- ---------------------------------------------------------------------
-- Audit tables. Scoped the same way, with one addition: Internal Audit sees
-- the whole trail regardless of province, because reviewing it is their job
-- and a province-limited trail would make that review incomplete.
-- ---------------------------------------------------------------------
ALTER TABLE audit.audit_event ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_scope ON audit.audit_event
  FOR SELECT TO lms_readwrite, lms_readonly
  USING (lms.actor_role() = 'Admin'
         OR 'Internal Audit' = ANY (lms.actor_groups())
         OR province_code IS NULL
         OR province_code = ANY (lms.actor_provinces()));
-- INSERT is unrestricted on purpose: writing one's own audit trail must never
-- fail for scope reasons, and the trigger that writes it decides the content.
CREATE POLICY audit_insert ON audit.audit_event
  FOR INSERT TO lms_readwrite
  WITH CHECK (true);

ALTER TABLE audit.record_version ENABLE ROW LEVEL SECURITY;
CREATE POLICY version_scope ON audit.record_version
  FOR SELECT TO lms_readwrite, lms_readonly
  USING (lms.actor_role() = 'Admin'
         OR 'Internal Audit' = ANY (lms.actor_groups())
         OR province_code IS NULL
         OR province_code = ANY (lms.actor_provinces()));
CREATE POLICY version_insert ON audit.record_version
  FOR INSERT TO lms_readwrite WITH CHECK (true);

ALTER TABLE audit.auth_event ENABLE ROW LEVEL SECURITY;
CREATE POLICY auth_event_scope ON audit.auth_event
  FOR SELECT TO lms_readwrite, lms_readonly
  USING (lms.actor_role() = 'Admin'
         OR 'Internal Audit' = ANY (lms.actor_groups())
         OR user_id = util.actor_id());
CREATE POLICY auth_event_insert ON audit.auth_event
  FOR INSERT TO lms_readwrite WITH CHECK (true);

ALTER TABLE lms.document_access_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY doc_access_scope ON lms.document_access_log
  FOR SELECT TO lms_readwrite, lms_readonly
  USING (lms.actor_role() = 'Admin'
         OR 'Internal Audit' = ANY (lms.actor_groups())
         OR accessed_by = util.actor_id());
CREATE POLICY doc_access_insert ON lms.document_access_log
  FOR INSERT TO lms_readwrite WITH CHECK (accessed_by = util.actor_id());

-- ---------------------------------------------------------------------
-- Workflow assignment: scoped through whichever entity it points at, which is
-- polymorphic. Rather than a union over nine tables, it is scoped by the
-- province recorded on the record's own transition history, which
-- api.advance_workflow() always writes.
-- ---------------------------------------------------------------------
ALTER TABLE lms.workflow_assignment ENABLE ROW LEVEL SECURITY;
CREATE POLICY assignment_scope ON lms.workflow_assignment
  FOR ALL TO lms_readwrite, lms_readonly
  USING (lms.actor_role() = 'Admin' OR EXISTS (
           SELECT 1 FROM lms.workflow_transition t
           WHERE t.workflow_code = lms.workflow_assignment.workflow_code
             AND t.record_id = lms.workflow_assignment.record_id
             AND t.province_code = ANY (lms.actor_provinces())))
  WITH CHECK (true);
COMMENT ON POLICY assignment_scope ON lms.workflow_assignment IS
  'WITH CHECK is true because api.advance_workflow() writes assignments after '
  'it has already checked the actor''s access to the record; the row it writes '
  'may be for a queue the actor is not in, which is the normal case.';
