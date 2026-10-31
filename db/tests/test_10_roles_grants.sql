-- role: lms_test
-- tx: rollback
-- actor: admin
--
-- Database roles and least privilege, asserted against the catalogue rather
-- than against the migration that was supposed to set them. A grant that was
-- revoked in one migration and quietly restored by a later blanket GRANT would
-- show up here.
\set QUIET on

DO $$
DECLARE v_n integer; t text;
BEGIN
  -- ---------- role attributes ----------
  PERFORM test.eq((SELECT count(*)::integer FROM pg_roles
                   WHERE rolname LIKE 'lms%' AND (rolsuper OR rolcreatedb OR rolcreaterole)), 0,
                  'no LMS role is a superuser or may create databases or roles');
  PERFORM test.eq((SELECT count(*)::integer FROM pg_roles
                   WHERE rolname LIKE 'lms%' AND rolbypassrls), 0,
                  'and none may bypass row-level security');
  PERFORM test.ok(NOT (SELECT rolcanlogin FROM pg_roles WHERE rolname = 'lms_owner'),
                  'the owning role cannot log in, so no session holds owner rights by default');
  PERFORM test.ok((SELECT rolcanlogin FROM pg_roles WHERE rolname = 'lms_app'),
                  'the application role can log in');

  -- ---------- everything is owned by lms_owner, nothing by the app ----------
  PERFORM test.eq((SELECT count(*)::integer FROM pg_class c
                   JOIN pg_namespace n ON n.oid = c.relnamespace
                   JOIN pg_roles r ON r.oid = c.relowner
                   WHERE n.nspname IN ('lms','api','audit','util')
                     AND c.relkind IN ('r','v','m','S')
                     AND r.rolname <> 'lms_owner'), 0,
                  'every table, view and sequence in the schema is owned by lms_owner');

  -- ---------- the application cannot read what it has no business in ----------
  PERFORM test.ok(NOT has_table_privilege('lms_app', 'lms.payment_release', 'INSERT'),
                  'the application cannot insert a payment release');
  PERFORM test.ok(NOT has_table_privilege('lms_app', 'lms.payment_release', 'UPDATE'),
                  'nor update one');
  PERFORM test.ok(NOT has_table_privilege('lms_app', 'lms.payment_release', 'DELETE'),
                  'nor delete one');
  PERFORM test.ok(has_table_privilege('lms_app', 'lms.payment_release', 'SELECT'),
                  'but can read the release ledger');

  PERFORM test.ok(NOT has_table_privilege('lms_app', 'audit.audit_event', 'INSERT'),
                  'the application cannot insert an audit event');
  PERFORM test.ok(NOT has_table_privilege('lms_app', 'audit.audit_event', 'UPDATE'),
                  'nor update one');
  PERFORM test.ok(NOT has_table_privilege('lms_app', 'audit.audit_event', 'DELETE'),
                  'nor delete one');
  PERFORM test.ok(NOT has_table_privilege('lms_app', 'audit.audit_event', 'TRUNCATE'),
                  'nor truncate the table');
  PERFORM test.ok(has_table_privilege('lms_app', 'audit.audit_event', 'SELECT'),
                  'but can read the trail it is accountable to');

  PERFORM test.ok(NOT has_table_privilege('lms_app', 'lms.workflow_transition', 'INSERT'),
                  'the application cannot fabricate a workflow decision');
  PERFORM test.ok(NOT has_table_privilege('lms_app', 'lms.survey_ownership_history', 'INSERT'),
                  'nor write ownership history');
  PERFORM test.ok(NOT has_table_privilege('lms_app', 'lms.idempotency_key', 'UPDATE'),
                  'nor alter an idempotency key');

  -- ---------- reference data is read-only to the application ----------
  FOREACH t IN ARRAY ARRAY['lms.province','lms.unit_conversion','lms.workflow',
                           'lms.workflow_stage','lms.workflow_step_group',
                           'lms.system_setting','lms.app_role','lms.approval_group'] LOOP
    PERFORM test.ok(has_table_privilege('lms_app', t, 'SELECT')
                AND NOT has_table_privilege('lms_app', t, 'INSERT')
                AND NOT has_table_privilege('lms_app', t, 'UPDATE')
                AND NOT has_table_privilege('lms_app', t, 'DELETE'),
                    format('%s is read-only to the application', t));
  END LOOP;

  -- ---------- no DELETE on the core records ----------
  FOREACH t IN ARRAY ARRAY['lms.compensation_case','lms.payment_request','lms.lease',
                           'lms.landowner','lms.survey','lms.project','lms.legal_case',
                           'lms.mutation','lms.budget'] LOOP
    PERFORM test.ok(NOT has_table_privilege('lms_app', t, 'DELETE'),
                    format('the application cannot DELETE from %s — records are cancelled, not erased', t));
  END LOOP;

  -- But it can edit the child rows of a draft, which is what editing means.
  PERFORM test.ok(has_table_privilege('lms_app', 'lms.case_lease_line', 'DELETE'),
                  'it can remove a lease line from a draft case');

  -- ---------- the reporting role ----------
  PERFORM test.ok(has_table_privilege('lms_report', 'api.v_province_summary', 'SELECT'),
                  'the reporting role can read the dashboard view');
  FOREACH t IN ARRAY ARRAY['lms.compensation_case','lms.payment_request','lms.survey'] LOOP
    PERFORM test.ok(NOT has_table_privilege('lms_report', t, 'INSERT')
                AND NOT has_table_privilege('lms_report', t, 'UPDATE')
                AND NOT has_table_privilege('lms_report', t, 'DELETE'),
                    format('the reporting role cannot write to %s', t));
  END LOOP;

  -- Column-level least privilege: the reporting role can read a landowner's
  -- name but not their identity number or bank details.
  PERFORM test.ok(has_column_privilege('lms_report', 'lms.landowner', 'full_name', 'SELECT'),
                  'the reporting role can read a landowner''s name');
  PERFORM test.ok(NOT has_column_privilege('lms_report', 'lms.landowner', 'cnic', 'SELECT'),
                  'but not their CNIC');
  PERFORM test.ok(NOT has_column_privilege('lms_report', 'lms.landowner', 'iban', 'SELECT'),
                  'nor their IBAN');
  PERFORM test.ok(NOT has_column_privilege('lms_report', 'lms.landowner', 'bank_branch', 'SELECT'),
                  'nor their bank');
  PERFORM test.ok(NOT has_column_privilege('lms_report', 'lms.landowner', 'address', 'SELECT'),
                  'nor their address');
  PERFORM test.ok(NOT has_column_privilege('lms_report', 'lms.app_user', 'password_hash', 'SELECT'),
                  'nor any password verifier');
  PERFORM test.ok(NOT has_column_privilege('lms_report', 'lms.login_session', 'token_sha256', 'SELECT'),
                  'nor a session token hash');

  -- The views that expose a CNIC are not granted to the reporting role; the
  -- masked equivalents are.
  PERFORM test.ok(NOT has_table_privilege('lms_report', 'api.v_landowner_summary', 'SELECT'),
                  'the unmasked landowner view is not granted to the reporting role');
  PERFORM test.ok(has_table_privilege('lms_report', 'api.v_landowner_summary_masked', 'SELECT'),
                  'the masked one is');
  PERFORM test.ok(NOT has_table_privilege('lms_report', 'api.v_payment_release', 'SELECT'),
                  'and the unmasked payment view is not granted either');

  -- ---------- PUBLIC holds nothing ----------
  PERFORM test.eq((SELECT count(*)::integer FROM pg_class c
                   JOIN pg_namespace n ON n.oid = c.relnamespace
                   WHERE n.nspname IN ('lms','api','audit','util')
                     AND c.relkind IN ('r','v')
                     AND has_table_privilege('public', c.oid, 'SELECT')), 0,
                  'PUBLIC can read nothing in any LMS schema');
  PERFORM test.ok(NOT has_schema_privilege('public', 'lms', 'USAGE'),
                  'PUBLIC has no USAGE on the data schema');
  PERFORM test.ok(NOT has_schema_privilege('public', 'public', 'CREATE'),
                  'and cannot create anything in the public schema');

  -- No function is executable by PUBLIC. A function left executable by PUBLIC
  -- is the usual way a SECURITY DEFINER routine becomes available to everyone.
  PERFORM test.eq((SELECT count(*)::integer FROM pg_proc p
                   JOIN pg_namespace n ON n.oid = p.pronamespace
                   WHERE n.nspname IN ('api','lms','audit','util')
                     AND has_function_privilege('public', p.oid, 'EXECUTE')), 0,
                  'no routine in any LMS schema is executable by PUBLIC');

  -- ---------- the application cannot reach the cheque sequence ----------
  PERFORM test.ok(NOT has_sequence_privilege('lms_app', 'lms.cheque_no_seq', 'USAGE'),
                  'the application cannot draw a cheque number');
  PERFORM test.ok(has_sequence_privilege('lms_app', 'lms.survey_code_seq', 'USAGE'),
                  'but can draw a parcel code');

  -- ---------- api.apply_mutation is not callable on its own ----------
  PERFORM test.ok(NOT has_function_privilege('lms_app', 'api.apply_mutation(uuid)', 'EXECUTE'),
                  'the application cannot apply a mutation outside its approval');
  PERFORM test.ok(has_function_privilege('lms_app', 'api.advance_workflow(text,uuid,text,text,text)', 'EXECUTE'),
                  'but can advance a workflow, which is what applies one');

  -- ---------- every SECURITY DEFINER routine has a pinned search_path ----------
  -- A definer routine without one can be hijacked by a caller who controls an
  -- earlier schema on the search path.
  PERFORM test.eq((SELECT count(*)::integer FROM pg_proc p
                   JOIN pg_namespace n ON n.oid = p.pronamespace
                   WHERE n.nspname IN ('api','lms','audit','util')
                     AND p.prosecdef
                     AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig,'{}'))
                                     AS cfg WHERE cfg LIKE 'search_path=%')), 0,
                  'every SECURITY DEFINER routine pins its search_path');

  -- And so does every other routine in these schemas, definer or not.
  PERFORM test.eq((SELECT count(*)::integer FROM pg_proc p
                   JOIN pg_namespace n ON n.oid = p.pronamespace
                   WHERE n.nspname IN ('api','lms','audit','util')
                     AND p.prokind = 'f'
                     AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig,'{}'))
                                     AS cfg WHERE cfg LIKE 'search_path=%')), 0,
                  'and so does every other routine in the LMS schemas');

  -- ---------- row-level security is on where it should be ----------
  PERFORM test.eq((SELECT count(*)::integer FROM pg_class c
                   JOIN pg_namespace n ON n.oid = c.relnamespace
                   WHERE n.nspname = 'lms' AND c.relkind = 'r'
                     AND c.relname IN ('survey','landowner','project','compensation_case',
                                       'payment_request','lease','row_corridor','budget',
                                       'grievance','encroachment','legal_case','mutation',
                                       'dbpfc_estimate','acquisition','admin_unit')
                     AND NOT c.relrowsecurity), 0,
                  'row-level security is enabled on every province-bearing table');
  PERFORM test.ok((SELECT count(*) FROM pg_policies WHERE schemaname IN ('lms','audit')) > 40,
                  'and the policies are present');
END $$;
