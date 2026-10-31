-- role: lms_test
-- tx: rollback
--
-- The actor context: it is required for every write, it is transaction-local
-- so a connection pool cannot leak it between requests, and it cannot be set
-- to an account that is not allowed to act.
\set QUIET on

DO $$
DECLARE fx record;
BEGIN
  PERFORM test.become('admin');
  SELECT * INTO fx FROM test.fixtures;

  -- ---------- a write with no actor is refused ----------
  PERFORM test.unbecome();
  PERFORM test.eq(util.actor_id(), NULL::uuid, 'with no actor set, util.actor_id() is null');
  PERFORM test.throws($q$ SELECT util.require_actor() $q$, '28000',
    'util.require_actor() refuses to proceed without one');

  -- A write with no actor fails. For the application role it fails at the
  -- row-level policy first, because with no actor the province list is empty
  -- and the WITH CHECK can be satisfied by nothing — so the audit trigger is
  -- never reached. Both refusals exist; this is which one comes first.
  -- test_15 exercises the trigger's own refusal, as a role that policies do
  -- not apply to.
  PERFORM test.become('admin');
  PERFORM test.unbecome();
  PERFORM test.throws($q$
    INSERT INTO lms.landowner (code, province_code, full_name, father_name, cnic, owner_type, status)
    VALUES ('NOACTOR-1','SND','No Actor','Father','45102-6666666-6','O','Active')
  $q$, '42501', 'an insert with no actor context is refused by the row-level policy');

  -- ---------- an unknown or suspended account cannot act ----------
  PERFORM test.throws($q$
    SELECT api.set_actor('00000000-0000-0000-0000-0000000000ff')
  $q$, '28000', 'an unknown user id cannot be set as the actor');

  PERFORM test.become('admin');
  PERFORM test.throws(format($q$ UPDATE lms.app_user SET status = 'Suspended' WHERE id = %L $q$, fx.u_lofield), '42501',
    'account status cannot be written directly, even by an administrator');
  PERFORM iam.set_user_status(fx.u_lofield, 'Suspended', 'identity context test');
  PERFORM test.throws(format($q$ SELECT api.set_actor(%L) $q$, fx.u_lofield), '28000',
    'a suspended account cannot be set as the actor');
  PERFORM iam.set_user_status(fx.u_lofield, 'Active', 'identity context test');
  PERFORM api.set_actor(fx.u_lofield);
  PERFORM test.eq(util.actor_id(), fx.u_lofield, 'and can act again once reinstated');

  -- ---------- the Viewer role is read-only through the routines ----------
  PERFORM test.become('viewer');
  PERFORM test.throws_like(
    format($q$ SELECT api.advance_workflow('cases', %L, 'Reviewed') $q$, fx.case_draft),
    '%read-only%', 'a Viewer cannot advance a workflow');
  PERFORM test.throws_like($q$
    SELECT api.request_payment('viewer-key-0001-aaaaaaaaaa',
      (SELECT proj_dhrk1 FROM test.fixtures), 'Lease Rent','One-time',
      current_date, 1000, 'Cross Cheque',
      (SELECT lo_mukhtiar FROM test.fixtures))
  $q$, '%read-only%', 'nor raise a payment');
END $$;

-- ---------- transaction-local, not session-local ----------
-- SET LOCAL is what makes a pooled connection safe: the value is discarded
-- when the transaction ends, so the next request on the same connection starts
-- with no actor rather than inheriting the previous one. Proving that needs
-- more than one transaction, so this part runs outside the runner's wrapper.
\echo '-- committed-transaction part'
BEGIN;
  SELECT test.become('lofield');
  SELECT test.ok(util.actor_id() IS NOT NULL, 'the actor is set inside the transaction');
COMMIT;

-- A new transaction on the same connection. If api.set_actor() used a
-- session-level SET, the actor would still be here — which on a pooled
-- connection would mean one user's identity attached to another user's request.
BEGIN;
  SELECT test.ok(util.actor_id() IS NULL,
                 'the actor does not survive into the next transaction on the same connection');
  SELECT test.ok(lms.actor_provinces() = '{}'::char(3)[],
                 'and neither does the province scope');
  SELECT test.eq((SELECT count(*)::integer FROM lms.survey), 0,
                 'so the next request on a pooled connection starts with no visibility');
ROLLBACK;

-- Same again after a rollback rather than a commit.
BEGIN;
  SELECT test.become('loquetta');
  SELECT test.ok(lms.actor_provinces() = ARRAY['BAL']::char(3)[], 'a second actor is set');
ROLLBACK;
BEGIN;
  SELECT test.ok(util.actor_id() IS NULL, 'and does not survive a rolled-back transaction either');
ROLLBACK;
