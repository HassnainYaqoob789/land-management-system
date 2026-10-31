-- role: lms_owner
-- tx: rollback
--
-- How migrations, maintenance tasks and authorised administrative corrections
-- interact with the triggers.
--
-- The rule is that nothing writes to an audited table without an actor, and
-- the system itself has an account for that purpose. This file is the place
-- that rule is stated as a test, as the schema owner — the role a migration
-- and a maintenance job actually run as, and the role that row-level security
-- does not apply to.
\set QUIET on

DO $$
DECLARE v_sys uuid := '00000000-0000-0000-0000-000000000001'; v_ev record; v_n integer;
BEGIN
  -- ---------- the audit trigger's own refusal ----------
  -- As the owner, row-level security does not apply, so this reaches the
  -- trigger and shows what the trigger itself does about a missing actor.
  PERFORM test.unbecome();
  PERFORM test.throws($q$
    INSERT INTO lms.landowner (code, province_code, full_name, father_name, cnic, owner_type, status)
    VALUES ('SYS-NOACTOR','SND','No Actor','Father','45102-5555555-5','O','Active')
  $q$, '28000', 'the audit trigger refuses an unattributed write even for the schema owner');

  -- ---------- the system service account ----------
  PERFORM test.ok(EXISTS (SELECT 1 FROM lms.app_user WHERE id = v_sys),
                  'the system service account exists at a fixed, documented id');
  PERFORM test.ok((SELECT is_service_account FROM lms.app_user WHERE id = v_sys),
                  'and is marked as a service account');
  PERFORM test.eq((SELECT password_hash FROM lms.app_user WHERE id = v_sys), NULL::text,
                  'and has no password, so nothing can sign in as it');
  PERFORM test.throws($q$
    UPDATE lms.app_user SET password_hash = '$2b$12$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    WHERE id = '00000000-0000-0000-0000-000000000001'
  $q$, '23514', 'and cannot be given one');

  -- A maintenance task sets the actor to it, and the resulting trail entry is
  -- recognisable as a system action rather than a user action.
  PERFORM set_config('lms.actor_id', v_sys::text, true);
  UPDATE lms.landowner SET phone = '+92 300 0000099'
   WHERE cnic = '45102-1100012-3';
  SELECT * INTO v_ev FROM audit.audit_event ORDER BY id DESC LIMIT 1;
  PERFORM test.eq(v_ev.actor_username, 'system',
                  'a maintenance change is attributed to the system account');
  PERFORM test.eq(v_ev.db_role, 'lms_owner',
                  'and records the database role, so it is distinguishable from an application change');

  -- The reference data loaded by migration 0015 carries the same attribution,
  -- which is how a configuration value can be traced to the migration that
  -- introduced it.
  PERFORM test.ok(EXISTS (SELECT 1 FROM audit.audit_event
                          WHERE actor_id = v_sys AND entity = 'system_setting'
                            AND action = 'INSERT'),
                  'the settings loaded by migration are attributed to the system account');

  -- ---------- an authorised administrative correction ----------
  -- A locked record cannot be edited through the application, and that is the
  -- point. Correcting one is a privileged, deliberate act: the owner disables
  -- the specific trigger, makes the change, and re-enables it. It is still
  -- audited, because the audit trigger is a different trigger and stays on.
  DECLARE v_case uuid; v_before bigint; v_after bigint;
  BEGIN
    SELECT id INTO v_case FROM lms.compensation_case WHERE stage_code = 'HO Approved' LIMIT 1;
    PERFORM test.throws_like(
      format($q$ UPDATE lms.compensation_case SET case_remarks = 'x' WHERE id = %L $q$, v_case),
      '%is locked%', 'even the owner is refused by the locking trigger while it is enabled');

    SELECT count(*) INTO v_before FROM audit.audit_event;
    ALTER TABLE lms.compensation_case DISABLE TRIGGER case_locked_ck;
    UPDATE lms.compensation_case
       SET case_remarks = 'Corrected under change request CR-2026-0042'
     WHERE id = v_case;
    ALTER TABLE lms.compensation_case ENABLE TRIGGER case_locked_ck;
    SELECT count(*) INTO v_after FROM audit.audit_event;

    PERFORM test.eq((v_after - v_before)::integer, 1,
                    'an administrative correction is still audited');
    PERFORM test.eq((SELECT changed_fields FROM audit.audit_event ORDER BY id DESC LIMIT 1),
                    ARRAY['case_remarks'],
                    'and the trail names exactly what was corrected');

    PERFORM test.throws_like(
      format($q$ UPDATE lms.compensation_case SET case_remarks = 'y' WHERE id = %L $q$, v_case),
      '%is locked%', 'and the lock is back in force afterwards');
  END;

  -- ---------- what a privileged session can still do ----------
  -- Stated as a test rather than left implicit, because the honest limit of
  -- the append-only design is that the owner can suspend it. This is DB-02 in
  -- docs/SECURITY_FINDINGS.md and needs an append-only store outside this
  -- database to close.
  SELECT count(*) INTO v_n FROM audit.audit_event;
  ALTER TABLE audit.audit_event DISABLE TRIGGER audit_event_append_only;
  DELETE FROM audit.audit_event WHERE id = (SELECT max(id) FROM audit.audit_event);
  ALTER TABLE audit.audit_event ENABLE TRIGGER audit_event_append_only;
  PERFORM test.eq((SELECT count(*)::integer FROM audit.audit_event), (v_n - 1)::integer,
                  'the schema owner CAN remove an audit row by suspending the trigger — the append-only guarantee holds against the application, not against the owner');
  PERFORM test.throws($q$ DELETE FROM audit.audit_event WHERE id =
    (SELECT max(id) FROM audit.audit_event) $q$, '42501',
    'and the protection is in force again as soon as the trigger is re-enabled');
END $$;
