-- role: lms_test
-- tx: rollback
--
-- Row-level security on the base tables, and the fact that the SECURITY
-- DEFINER routines re-check province access themselves. Definer rights bypass
-- the policies, so a routine that forgot to check would be a hole straight
-- through them.
\set QUIET on

DO $$
DECLARE fx record; v_n integer; v_id uuid;
BEGIN
  -- Fixtures have to be read as an administrator; a scoped account cannot see
  -- the ids it is about to be refused.
  PERFORM test.become('admin');
  SELECT * INTO fx FROM test.fixtures;

  -- ---------- no actor means no rows ----------
  PERFORM test.unbecome();
  PERFORM test.eq((SELECT count(*)::integer FROM lms.survey), 0,
                  'with no actor set, no parcel is visible — the default is deny');
  PERFORM test.eq((SELECT count(*)::integer FROM lms.compensation_case), 0,
                  'and no case');
  PERFORM test.eq((SELECT count(*)::integer FROM lms.landowner), 0,
                  'and no landowner');
  PERFORM test.eq(lms.actor_provinces(), '{}'::char(3)[],
                  'and the province list is empty rather than unset');

  -- ---------- base-table scoping ----------
  PERFORM test.become('lofield');
  PERFORM test.eq((SELECT count(*)::integer FROM lms.survey WHERE province_code <> 'SND'), 0,
                  'a Sindh account sees no other province''s parcels');
  PERFORM test.eq((SELECT count(*)::integer FROM lms.landowner WHERE province_code <> 'SND'), 0,
                  'nor landowners');
  PERFORM test.eq((SELECT count(*)::integer FROM lms.payment_request WHERE province_code <> 'SND'), 0,
                  'nor payments');
  PERFORM test.eq((SELECT count(*)::integer FROM lms.project WHERE province_code <> 'SND'), 0,
                  'nor projects');
  PERFORM test.eq((SELECT count(*)::integer FROM lms.admin_unit WHERE province_code <> 'SND'), 0,
                  'nor administrative units');

  -- Child tables are scoped through their parent, so a Balochistan case's
  -- lines are invisible even though the child table has no province column.
  PERFORM test.eq((SELECT count(*)::integer FROM lms.case_owner co
                   JOIN lms.compensation_case c ON c.id = co.case_id
                   WHERE c.province_code <> 'SND'), 0,
                  'case payees are scoped through their case');
  PERFORM test.ok((SELECT count(*) FROM lms.case_lease_line) > 0,
                  'while the account''s own case lines are visible');

  -- Fetching a known out-of-scope id by primary key returns nothing: the
  -- policy is on the rows, not on the query shape.
  PERFORM test.eq((SELECT count(*)::integer FROM lms.compensation_case WHERE id = fx.case_bal), 0,
                  'a direct lookup of a Balochistan case id by a Sindh account finds nothing');
  PERFORM test.eq((SELECT count(*)::integer FROM lms.survey WHERE id = fx.survey_1187), 0,
                  'and of a Balochistan parcel');

  -- ---------- writes are scoped too ----------
  PERFORM test.throws($q$
    INSERT INTO lms.landowner (code, province_code, full_name, father_name, cnic, owner_type, status)
    VALUES ('RLS-1','PNJ','Out of scope','Father','45102-7777777-7','O','Active')
  $q$, '42501', 'a Sindh account cannot create a Punjab landowner');

  PERFORM test.eq((SELECT count(*)::integer FROM lms.survey WHERE id = fx.survey_1187), 0,
                  'and cannot even see the parcel it would need to update');

  -- ---------- definer routines re-check scope ----------
  -- These are the important ones: each runs as lms_owner, which bypasses every
  -- policy, so the check has to be in the routine.
  PERFORM test.throws_like(
    format($q$ SELECT api.advance_workflow('cases', %L, 'Reviewed') $q$, fx.case_bal),
    '%outside your province access%',
    'api.advance_workflow refuses a record outside the actor''s provinces');

  PERFORM test.throws_like(
    format($q$ SELECT api.request_payment('rls-test-key-0001-aaaaaaaa', %L, 'Lease Rent',
             'One-time', current_date, 1000, 'Cross Cheque', %L) $q$,
           fx.proj_sui, fx.lo_shahbaz),
    '%outside your province access%',
    'api.request_payment refuses a project outside the actor''s provinces');

  PERFORM test.become('loquetta');
  PERFORM test.throws_like(
    format($q$ SELECT api.release_payment(%L, 'rls-test-key-0002-aaaaaaaa') $q$, fx.pay_verified),
    '%outside your province access%',
    'api.release_payment refuses a voucher outside the actor''s provinces');

  PERFORM test.throws_like(
    format($q$ SELECT api.allocate_payment(%L, %L, 100) $q$, fx.pay_verified, fx.case_approved),
    '%outside your province access%',
    'api.allocate_payment refuses a voucher outside the actor''s provinces');

  -- ---------- an administrator is not scoped ----------
  PERFORM test.become('admin');
  PERFORM test.ok((SELECT count(DISTINCT province_code) FROM lms.survey) = 4,
                  'an administrator sees parcels in all four provinces');

  -- ---------- a user's own row, and nobody else's ----------
  PERFORM test.become('lofield');
  PERFORM test.eq((SELECT count(*)::integer FROM lms.app_user), 1,
                  'an ordinary account sees only its own user row');
  PERFORM test.eq((SELECT username::text FROM lms.app_user), 'lofield',
                  'and it is its own');
  PERFORM test.throws($q$
    UPDATE lms.app_user SET role_code = 'Admin' WHERE username = 'lofield'
  $q$, '42501', 'and cannot promote itself to Admin');
  PERFORM test.throws($q$
    INSERT INTO lms.app_user_province (user_id, province_code)
    SELECT id, 'PNJ' FROM lms.app_user WHERE username = 'lofield'
  $q$, '42501', 'and cannot grant itself another province');

  -- ---------- notifications are per person ----------
  PERFORM test.become('lofield');
  INSERT INTO lms.notification (user_id, province_code, kind, title)
  VALUES (fx.u_lofield, 'SND', 'approval_pending', 'for the field officer');
  PERFORM test.become('mland');
  INSERT INTO lms.notification (user_id, province_code, kind, title)
  VALUES (fx.u_mland,   'SND', 'approval_pending', 'for the manager');
  PERFORM test.become('admin');
  PERFORM test.eq((SELECT count(*)::integer FROM lms.notification WHERE title IN ('for the field officer','for the manager')), 0,
                  'an administrator does not see other people''s notifications');
  PERFORM test.throws(format($q$ INSERT INTO lms.notification (user_id, province_code, kind, title)
                                VALUES (%L, 'SND', 'approval_pending', 'planted') $q$, fx.u_lofield),
                      '42501', 'nor write into someone else''s');
  PERFORM test.become('lofield');
  PERFORM test.eq((SELECT count(*)::integer FROM lms.notification), 1,
                  'an account sees only its own notifications');
  PERFORM test.eq((SELECT title FROM lms.notification), 'for the field officer',
                  'and it is the right one');

  -- ---------- Internal Audit sees the whole trail ----------
  PERFORM test.become('audit');
  PERFORM test.ok((SELECT count(DISTINCT province_code) FROM audit.audit_event
                   WHERE province_code IS NOT NULL) > 1,
                  'Internal Audit sees audit entries from more than one province');
  PERFORM test.become('lofield');
  PERFORM test.eq((SELECT count(DISTINCT province_code)::integer FROM audit.audit_event
                   WHERE province_code IS NOT NULL), 1,
                  'while a field officer sees one province''s entries');

  -- ---------- no BYPASSRLS anywhere ----------
  PERFORM test.eq((SELECT count(*)::integer FROM pg_roles
                   WHERE rolname LIKE 'lms%' AND rolbypassrls), 0,
                  'no LMS role has BYPASSRLS');
  PERFORM test.eq((SELECT count(*)::integer FROM pg_roles
                   WHERE rolname LIKE 'lms%' AND rolsuper), 0,
                  'and none is a superuser');
  PERFORM test.eq((SELECT count(*)::integer FROM pg_roles
                   WHERE rolname = 'lms_owner' AND rolcanlogin), 0,
                  'and the owning role cannot log in');
END $$;
