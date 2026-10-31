-- role: lms_owner
-- tx: rollback
-- actor: lofield
--
-- Trigger behaviour: audit capture, version stamping, append-only protection,
-- record locking, derived-data synchronisation, and rollback.
\set QUIET on

DO $$
DECLARE fx record; v_before bigint; v_after bigint; v_ver integer; v_id uuid;
        v_ev record; v_hold integer; v_range daterange;
BEGIN
  SELECT * INTO fx FROM test.fixtures;

  -- ---------- audit capture ----------
  SELECT count(*) INTO v_before FROM audit.audit_event;
  UPDATE lms.landowner SET phone = '+92 300 0000001' WHERE id = fx.lo_mukhtiar;
  SELECT count(*) INTO v_after FROM audit.audit_event;
  PERFORM test.eq((v_after - v_before)::integer, 1, 'an update writes exactly one audit event');

  SELECT * INTO v_ev FROM audit.audit_event ORDER BY id DESC LIMIT 1;
  PERFORM test.eq(v_ev.entity, 'landowner', 'the audit event names the table');
  PERFORM test.eq(v_ev.action, 'UPDATE', 'the audit event names the operation');
  PERFORM test.eq(v_ev.actor_username, 'lofield', 'the audit event records the actor');
  PERFORM test.eq(v_ev.actor_role, 'User', 'and the actor''s role at the time');
  PERFORM test.eq(v_ev.record_id, fx.lo_mukhtiar, 'and the record');
  PERFORM test.eq(v_ev.province_code, 'SND'::char(3), 'and the province');
  PERFORM test.eq(v_ev.changed_fields, ARRAY['phone'],
                  'only the field that changed is listed');
  PERFORM test.eq(v_ev.old_data ->> 'phone', '+92 300 1110012', 'the before value is kept');
  PERFORM test.eq(v_ev.new_data ->> 'phone', '+92 300 0000001', 'the after value is kept');
  PERFORM test.ok(v_ev.db_role IS NOT NULL, 'the database role is recorded as well as the actor');

  -- An update that changes nothing writes nothing: the trail is a record of
  -- changes, not of statements.
  SELECT count(*) INTO v_before FROM audit.audit_event;
  UPDATE lms.landowner SET phone = '+92 300 0000001' WHERE id = fx.lo_mukhtiar;
  SELECT count(*) INTO v_after FROM audit.audit_event;
  PERFORM test.eq((v_after - v_before)::integer, 0,
                  'an update that changes nothing writes no audit event');

  -- ---------- version stamping ----------
  SELECT version INTO v_ver FROM lms.landowner WHERE id = fx.lo_mukhtiar;
  UPDATE lms.landowner SET address = 'New address' WHERE id = fx.lo_mukhtiar;
  PERFORM test.eq((SELECT version FROM lms.landowner WHERE id = fx.lo_mukhtiar),
                  v_ver + 1, 'an update bumps the version');
  PERFORM test.eq((SELECT updated_by FROM lms.landowner WHERE id = fx.lo_mukhtiar),
                  fx.u_lofield, 'and stamps the actor as updated_by');

  -- created_by cannot be rewritten by an update, however hard the caller tries.
  UPDATE lms.landowner SET created_by = fx.u_admin WHERE id = fx.lo_mukhtiar;
  PERFORM test.ok((SELECT created_by FROM lms.landowner WHERE id = fx.lo_mukhtiar)
                  IS DISTINCT FROM fx.u_admin,
                  'an update cannot rewrite created_by');

  -- A version snapshot is kept for the snapshotted tables.
  PERFORM test.ok((SELECT count(*) FROM audit.record_version
                   WHERE entity = 'landowner' AND record_id = fx.lo_mukhtiar) >= 2,
                  'each version of a landowner is snapshotted');

  -- ---------- append-only protection ----------
  PERFORM test.throws($q$ UPDATE audit.audit_event SET note = 'tampered' WHERE id =
    (SELECT max(id) FROM audit.audit_event) $q$, '42501',
    'an audit event cannot be updated, even by the schema owner');
  PERFORM test.throws($q$ DELETE FROM audit.audit_event WHERE id =
    (SELECT max(id) FROM audit.audit_event) $q$, '42501',
    'an audit event cannot be deleted');
  PERFORM test.throws($q$ UPDATE lms.payment_release SET released_amount = 1 $q$, '42501',
    'a payment release cannot be updated');
  PERFORM test.throws($q$ DELETE FROM lms.payment_release $q$, '42501',
    'a payment release cannot be deleted');
  PERFORM test.throws($q$ UPDATE lms.workflow_transition SET note = 'rewritten' WHERE id =
    (SELECT max(id) FROM lms.workflow_transition) $q$, '42501',
    'a workflow decision cannot be rewritten');
  -- A row-level trigger does not fire on a statement that matches no rows, so
  -- the table needs a row before the protection can be demonstrated.
  INSERT INTO lms.survey_ownership_history
    (survey_id, landowner_id, share_pct, valid_from, change_reason, recorded_by)
  VALUES (fx.survey_112, fx.lo_mukhtiar, 10.0, current_date, 'test fixture', fx.u_admin);
  PERFORM test.throws($q$ DELETE FROM lms.survey_ownership_history $q$, '42501',
    'ownership history cannot be deleted');
  PERFORM test.throws($q$ UPDATE lms.survey_ownership_history SET share_pct = 1 $q$, '42501',
    'ownership history cannot be rewritten');
  PERFORM test.throws($q$ UPDATE lms.setting_history SET new_value = '1' WHERE id =
    (SELECT max(id) FROM lms.setting_history) $q$, '42501',
    'configuration history cannot be rewritten');

  -- ---------- record locking ----------
  PERFORM test.throws_like(
    format($q$ UPDATE lms.compensation_case SET lease_rate = 1 WHERE id = %L $q$, fx.case_approved),
    '%is locked%', 'an approved case cannot be edited');
  PERFORM test.throws_like(
    format($q$ DELETE FROM lms.compensation_case WHERE id = %L $q$, fx.case_approved),
    '%cannot be deleted%', 'an approved case cannot be deleted');
  PERFORM test.throws_like(
    format($q$ INSERT INTO lms.case_crop_line (case_id, survey_id, crop_type, rate_per_acre, damage_area)
               VALUES (%L, %L, 'Added later', 1000, 1) $q$, fx.case_approved, fx.survey_112),
    '%cannot be changed%', 'a line cannot be added to an approved case');
  PERFORM test.throws_like(
    format($q$ DELETE FROM lms.case_tree_line WHERE case_id = %L $q$, fx.case_approved),
    '%cannot be changed%', 'a line cannot be removed from an approved case');

  -- A released voucher's money is fixed, but its remarks can still be annotated.
  PERFORM test.throws_like(
    format($q$ UPDATE lms.payment_request SET gross_amount = 1 WHERE id = %L $q$, fx.pay_released),
    '%has been released%', 'a released voucher''s amount cannot be changed');
  UPDATE lms.payment_request SET remarks = 'annotated after release' WHERE id = fx.pay_released;
  PERFORM test.ok(true, 'a released voucher''s remarks can still be annotated');
  PERFORM test.throws_like(
    format($q$ DELETE FROM lms.payment_request WHERE id = %L $q$, fx.pay_released),
    '%cannot be deleted%', 'a released voucher cannot be deleted');

  -- A draft case is editable, which is the control group for all of the above.
  UPDATE lms.compensation_case SET lease_rate = 160000 WHERE id = fx.case_draft;
  PERFORM test.ok(true, 'a case that is not yet approved can still be edited');

  -- ---------- administrative hierarchy ----------
  PERFORM test.throws_like($q$
    INSERT INTO lms.admin_unit (code, province_code, level, parent_id, name)
    SELECT 'TG-1','SND', 2, au.id, 'Wrong level parent'
    FROM lms.admin_unit au WHERE au.province_code='SND' AND au.level=0 LIMIT 1
  $q$, '%must be level 1%', 'a unit cannot hang off a grandparent');

  PERFORM test.throws_like($q$
    INSERT INTO lms.admin_unit (code, province_code, level, parent_id, name)
    SELECT 'TG-2','PNJ', 1, au.id, 'Cross province parent'
    FROM lms.admin_unit au WHERE au.province_code='SND' AND au.level=0 LIMIT 1
  $q$, '%is in SND but this unit is in PNJ%', 'a unit cannot hang off another province''s tree');

  PERFORM test.throws_like($q$
    INSERT INTO lms.project (code, name, type_code, block, province_code, district_id, status)
    SELECT 'TG-3','Bad district','Well Location','Blk','SND', au.id, 'Active'
    FROM lms.admin_unit au WHERE au.province_code='SND' AND au.level=2 LIMIT 1
  $q$, '%must be a level-0 unit%', 'a project''s district must be a district');

  -- ---------- lease term propagation ----------
  SELECT term_range INTO v_range FROM lms.lease_survey
   WHERE lease_id = fx.lease_snd LIMIT 1;
  PERFORM test.ok(v_range IS NOT NULL, 'a lease parcel has a term range');
  UPDATE lms.lease SET term_years = 7 WHERE id = fx.lease_snd;
  PERFORM test.ok((SELECT term_range FROM lms.lease_survey WHERE lease_id = fx.lease_snd LIMIT 1)
                  <> v_range,
                  'changing the lease term moves the parcel term range with it');

  -- Terminating the lease stops it blocking the parcel.
  UPDATE lms.lease SET terminated_on = current_date WHERE id = fx.lease_snd;
  PERFORM test.eq((SELECT bool_or(is_blocking) FROM lms.lease_survey WHERE lease_id = fx.lease_snd),
                  false, 'a terminated lease stops blocking its parcels');

  -- ---------- DBPFC rate history ----------
  SELECT count(*) INTO v_before FROM lms.dbpfc_rate_history;
  UPDATE lms.dbpfc_estimate SET fixed_rate = 81000 WHERE code LIKE 'DBP-%';
  SELECT count(*) INTO v_after FROM lms.dbpfc_rate_history;
  PERFORM test.eq((v_after - v_before)::integer, 1, 'a rate revision is recorded in the history');
  PERFORM test.eq((SELECT fixed_rate::numeric FROM lms.dbpfc_rate_history
                   ORDER BY id DESC LIMIT 1), 81000::numeric,
                  'and records the new rate');
  -- The applied rate and annual liability are generated, so they follow at once.
  PERFORM test.eq((SELECT applied_rate::numeric FROM lms.dbpfc_estimate WHERE code LIKE 'DBP-%'),
                  81000::numeric, 'the applied rate becomes the fixed rate');

  -- ---------- stay order synchronisation ----------
  SELECT count(*) INTO v_hold FROM lms.payment_hold
   WHERE legal_case_id = fx.legal1 AND lifted_at IS NULL;
  PERFORM test.ok(v_hold >= 2, 'an in-force stay order holds the landowner and the parcel');

  UPDATE lms.legal_case SET stay_order = false, status = 'Decided — In Favour'
   WHERE id = fx.legal1;
  PERFORM test.eq((SELECT count(*)::integer FROM lms.payment_hold
                   WHERE legal_case_id = fx.legal1 AND lifted_at IS NULL), 0,
                  'deciding the case lifts the holds it placed');
  PERFORM test.ok((SELECT bool_and(lift_reason IS NOT NULL) FROM lms.payment_hold
                   WHERE legal_case_id = fx.legal1),
                  'and records why each hold was lifted');

  -- ---------- configuration history ----------
  SELECT count(*) INTO v_before FROM lms.setting_history;
  UPDATE lms.system_setting SET value = '12'::jsonb WHERE key = 'finance.wht_pct';
  SELECT count(*) INTO v_after FROM lms.setting_history;
  PERFORM test.eq((v_after - v_before)::integer, 1, 'a configuration change is recorded');
  PERFORM test.eq((SELECT old_value FROM lms.setting_history
                   WHERE key='finance.wht_pct' ORDER BY id DESC LIMIT 1), '10'::jsonb,
                  'with the value it had before');
END $$;

-- ---------- rollback ----------
-- Everything above happened in this transaction, which the runner rolls back.
-- The next block proves a trigger failure takes the whole transaction with it
-- rather than leaving half of a business operation behind.
DO $$
DECLARE fx record; v_before bigint; v_phone text;
BEGIN
  SELECT * INTO fx FROM test.fixtures;
  SELECT phone INTO v_phone FROM lms.landowner WHERE id = fx.lo_mukhtiar;
  SELECT count(*) INTO v_before FROM audit.audit_event;

  -- A plpgsql BEGIN/EXCEPTION block is a subtransaction, so the failure of the
  -- second statement discards the first as well.
  BEGIN
    UPDATE lms.landowner SET phone = '+92 300 9999999' WHERE id = fx.lo_mukhtiar;
    UPDATE lms.compensation_case SET lease_rate = 999 WHERE id = fx.case_approved;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  PERFORM test.eq((SELECT count(*)::integer FROM audit.audit_event), v_before::integer,
                  'a trigger failure rolls back the audit row written earlier in the same transaction');
  PERFORM test.eq((SELECT phone FROM lms.landowner WHERE id = fx.lo_mukhtiar), v_phone,
                  'and rolls back the earlier statement itself');
END $$;
