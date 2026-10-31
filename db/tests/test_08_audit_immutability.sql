-- role: lms_test
-- tx: rollback
-- actor: lofield
--
-- Audit immutability under ordinary application permissions.
--
-- This is what the claim "the audit trail is append-only" actually means here:
-- the application role cannot write, rewrite or remove an audit row by any
-- route available to it. It does NOT mean the trail is tamper-proof against
-- the schema owner or a superuser; test_14 deliberately disables a trigger to
-- show that a privileged session can, and docs/SECURITY_FINDINGS.md records
-- that gap as DB-02.
\set QUIET on

DO $$
DECLARE fx record; v_id bigint;
BEGIN
  SELECT * INTO fx FROM test.fixtures;

  PERFORM test.ok((SELECT count(*) FROM audit.audit_event) > 0,
                  'the trail has entries to try to tamper with');
  SELECT max(id) INTO v_id FROM audit.audit_event;

  -- ---------- the application cannot write the trail directly ----------
  PERFORM test.throws($q$
    INSERT INTO audit.audit_event (actor_id, actor_username, actor_role, entity, action)
    SELECT u_lofield, 'lofield', 'User', 'landowner', 'UPDATE' FROM test.fixtures
  $q$, '42501', 'the application cannot insert a fabricated audit event');

  PERFORM test.throws(format($q$
    UPDATE audit.audit_event SET note = 'tampered' WHERE id = %s $q$, v_id), '42501',
    'the application cannot update an audit event');

  PERFORM test.throws(format($q$
    DELETE FROM audit.audit_event WHERE id = %s $q$, v_id), '42501',
    'the application cannot delete an audit event');

  PERFORM test.throws($q$ TRUNCATE audit.audit_event $q$, '42501',
    'the application cannot truncate the audit table — TRUNCATE fires no row triggers, so the privilege is revoked as well');

  PERFORM test.throws($q$ DELETE FROM audit.record_version $q$, '42501',
    'the application cannot delete a version snapshot');
  PERFORM test.throws($q$ UPDATE audit.record_version SET snapshot = '{}'::jsonb $q$, '42501',
    'nor rewrite one');
  PERFORM test.throws($q$ DELETE FROM audit.auth_event $q$, '42501',
    'nor delete an authentication event');

  -- ---------- nor the ledgers ----------
  PERFORM test.throws($q$ UPDATE lms.payment_release SET released_amount = 0 $q$, '42501',
    'the application cannot alter a payment release');
  PERFORM test.throws($q$ DELETE FROM lms.payment_release $q$, '42501',
    'nor delete one');
  PERFORM test.throws($q$
    INSERT INTO lms.payment_release (payment_id, province_code, cheque_no, released_amount, released_by)
    SELECT pay_verified, 'SND', 'CHQ-FAKE', 1, u_mland FROM test.fixtures
  $q$, '42501', 'nor create one outside api.release_payment()');

  PERFORM test.throws($q$
    INSERT INTO lms.workflow_transition
      (workflow_code, record_id, record_code, to_stage, action, acted_by)
    SELECT 'cases', case_draft, 'CC-2026-0002', 'HO Approved', 'Advanced', u_mland
    FROM test.fixtures
  $q$, '42501', 'nor fabricate an approval decision');

  PERFORM test.throws($q$ DELETE FROM lms.workflow_transition $q$, '42501',
    'nor erase one');

  PERFORM test.throws($q$
    INSERT INTO lms.survey_ownership_history
      (survey_id, landowner_id, share_pct, valid_from, change_reason, recorded_by)
    SELECT survey_112, lo_mukhtiar, 100, current_date, 'forged', u_lofield FROM test.fixtures
  $q$, '42501', 'nor write ownership history outside api.apply_mutation()');

  PERFORM test.throws($q$ UPDATE lms.idempotency_key SET result_id = NULL $q$, '42501',
    'nor clear an idempotency key to make a retry pay twice');

  PERFORM test.throws($q$ UPDATE lms.dbpfc_rate_history SET fixed_rate = 1 $q$, '42501',
    'nor rewrite a rate history');

  -- ---------- nor reference data ----------
  PERFORM test.throws($q$
    UPDATE lms.unit_conversion SET sqm_per_unit = 1 WHERE unit_code = 'Acre'
  $q$, '42501', 'the application cannot change a conversion factor');
  PERFORM test.throws($q$
    UPDATE lms.system_setting SET value = '0' WHERE key = 'finance.wht_pct'
  $q$, '42501', 'nor the withholding rate directly');
  PERFORM test.throws($q$
    INSERT INTO lms.workflow_step_group (workflow_code, to_stage, group_code)
    VALUES ('cases','HO Approved','Land Officer (Field)')
  $q$, '42501', 'nor reassign an approval step');
  PERFORM test.throws($q$
    DELETE FROM lms.workflow_stage WHERE workflow_code = 'cases'
  $q$, '42501', 'nor remove a workflow stage');

  -- Settings change through the routine, which checks settings:update.
  PERFORM test.throws_like($q$
    SELECT api.set_setting('finance.wht_pct', '0'::jsonb)
  $q$, '%settings:update%', 'a non-Admin cannot change configuration through the routine either');
  PERFORM test.become('admin');
  PERFORM test.eq(api.set_setting('finance.wht_pct', '11'::jsonb, 'FBR notification'), '10'::jsonb,
                  'an Admin can change configuration and gets the old value back');
  PERFORM test.eq((SELECT new_value FROM lms.setting_history
                   WHERE key='finance.wht_pct' ORDER BY id DESC LIMIT 1), '11'::jsonb,
                  'and the change is recorded in the history');
  PERFORM test.eq((SELECT note FROM lms.setting_history
                   WHERE key='finance.wht_pct' ORDER BY id DESC LIMIT 1), 'FBR notification',
                  'with the reason given');
  PERFORM test.throws_like($q$ SELECT api.set_setting('no.such.setting', '1'::jsonb) $q$,
    '%unknown setting%', 'a setting cannot be invented at runtime');

  -- ---------- no DDL ----------
  PERFORM test.become('lofield');
  PERFORM test.throws($q$ CREATE TABLE lms.sneaky (id int) $q$, '42501',
    'the application cannot create a table');
  PERFORM test.throws($q$ ALTER TABLE lms.landowner ADD COLUMN sneaky text $q$, '42501',
    'nor alter one');
  PERFORM test.throws($q$ DROP TABLE lms.payment_release $q$, '42501',
    'nor drop one');
  PERFORM test.throws($q$ ALTER TABLE audit.audit_event DISABLE TRIGGER ALL $q$, '42501',
    'nor disable the append-only triggers');
  PERFORM test.throws($q$ CREATE SCHEMA mine $q$, '42501',
    'nor create a schema');
  PERFORM test.throws($q$ CREATE TABLE public.sneaky (id int) $q$, '42501',
    'nor create anything in public');

  -- ---------- but it can read the trail it is accountable to ----------
  PERFORM test.ok((SELECT count(*) FROM api.v_audit_trail) > 0,
                  'the application can read its own audit trail');
  PERFORM test.ok((SELECT count(*) FROM api.v_record_version_history) > 0,
                  'and the version history');
END $$;
