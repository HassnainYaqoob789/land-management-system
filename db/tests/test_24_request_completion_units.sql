-- role: lms_test
-- tx: rollback
--
-- 0060 as the application sees it: a land request handed over for acquisition
-- follows its acquisition (work_stage), and completes when the acquisition
-- reaches Handover (parcels Acquired / Leased); a non-acquisition hand-over is
-- completed by a Land Officer (Field) only; Completed is final. Province unit
-- sizes override the national factor for new parcels only, through the API
-- routines, and need settings:update.
\set QUIET on

DO $$
DECLARE
  fx record; v_req uuid; v_req2 uuid; v_acq uuid; v_lease_acq uuid; v_req3 uuid; v_sv uuid; v_sv2 uuid; v_s uuid; v_old numeric;
BEGIN
  SELECT * INTO fx FROM test.fixtures;

  -- ---------- 1. acquisition request: follows its acquisition ----------
  PERFORM test.become('lofield');
  INSERT INTO lms.land_request (code, province_code, project_id, purpose, area_acres, required_date, justification,
                                stage_code, pending_approver_role, created_by, updated_by)
  VALUES ('T24-REQ-1', 'SND', fx.proj_dhrk1, 'Well Location', 5, current_date + 30, 't24 well pad',
          'Approved', 'Land Officer (Field)', fx.u_lofield, fx.u_lofield) RETURNING id INTO v_req;
  PERFORM test.throws_like(format($q$ UPDATE lms.land_request SET stage_code = 'Completed', completed_by = %L WHERE id = %L $q$, fx.u_lofield, v_req),
    '%handed-over%', 'an approved request cannot jump to Completed');
  UPDATE lms.land_request SET stage_code = 'Handed over', handed_over_by = fx.u_lofield, handed_over_at = now(),
         handed_over_kind = 'Acquisition', handed_over_comment = 't24' WHERE id = v_req;

  SELECT id INTO v_sv FROM lms.survey WHERE code = 'AREA-000012';   -- survey 207, Proposed
  INSERT INTO lms.acquisition (code, province_code, project_id, mode, area_required, negotiator_id, stage_code,
                               created_by, updated_by, land_request_id)
  VALUES ('T24-ACQ-1', 'SND', fx.proj_dhrk1, 'Direct Purchase', 5, fx.u_lofield, 'Identification',
          fx.u_lofield, fx.u_lofield, v_req) RETURNING id INTO v_acq;
  INSERT INTO lms.acquisition_survey (acquisition_id, survey_id) VALUES (v_acq, v_sv);
  INSERT INTO lms.acquisition_title_check (acquisition_id, item_code, checked_by) SELECT v_acq, code, fx.u_lofield FROM lms.title_check_item;
  PERFORM test.eq((SELECT work_stage FROM lms.land_request WHERE id = v_req), 'Identification',
    'creating the acquisition copies its stage to the request');
  PERFORM test.throws_like(format($q$ UPDATE lms.land_request SET stage_code = 'Completed', completed_by = %L WHERE id = %L $q$, fx.u_lofield, v_req),
    '%completes when its acquisition reaches Handover%', 'an acquisition request is not completed by hand');

  PERFORM test.become('nego');
  PERFORM api.advance_workflow('acquisitions', v_acq, 'Negotiation', 't24 negotiate');
  PERFORM test.become('lofield');
  PERFORM test.eq((SELECT work_stage FROM lms.land_request WHERE id = v_req), 'Negotiation', 'each stage change reaches the request');
  PERFORM test.become('dmfield');
  PERFORM api.advance_workflow('acquisitions', v_acq, 'Approval', 't24 approve');
  PERFORM test.become('mland');
  PERFORM api.advance_workflow('acquisitions', v_acq, 'Acquisition / Lease', 't24 acquire');
  PERFORM test.eq((SELECT stage_code FROM lms.land_request WHERE id = v_req), 'Handed over', 'still open before Handover');
  PERFORM test.become('sradmin');
  PERFORM api.advance_workflow('acquisitions', v_acq, 'Handover', 't24 handover');

  PERFORM test.become('lofield');
  PERFORM test.eq((SELECT stage_code FROM lms.land_request WHERE id = v_req), 'Completed', 'Handover completes the request');
  PERFORM test.eq((SELECT work_stage FROM lms.land_request WHERE id = v_req), 'Handover', 'and its work stage is Handover');
  PERFORM test.eq((SELECT completed_by FROM lms.land_request WHERE id = v_req), fx.u_sradmin, 'completed in the name of who handed the land over');
  PERFORM test.ok((SELECT completed_comment FROM lms.land_request WHERE id = v_req) LIKE '%T24-ACQ-1%', 'the comment names the acquisition');
  PERFORM test.eq((SELECT status_code FROM lms.survey WHERE id = v_sv), 'Acquired', 'a purchase marks its parcels Acquired');
  PERFORM test.throws_like(format($q$ UPDATE lms.land_request SET stage_code = 'Handed over' WHERE id = %L $q$, v_req),
    '%closed%', 'Completed is final');

  -- ---------- 2. a lease acquisition marks parcels Leased; a Disputed parcel is left alone ----------
  SELECT id INTO v_sv2 FROM lms.survey WHERE code = 'AREA-000011';   -- Disputed
  INSERT INTO lms.acquisition (code, province_code, project_id, mode, area_required, negotiator_id, stage_code, created_by, updated_by)
  VALUES ('T24-ACQ-2', 'SND', fx.proj_dhrk1, 'Private Lease', 2, fx.u_lofield, 'Identification', fx.u_lofield, fx.u_lofield)
  RETURNING id INTO v_lease_acq;
  UPDATE lms.survey SET status_code = 'Proposed' WHERE code = 'AREA-000008' RETURNING id INTO v_s;
  INSERT INTO lms.acquisition_survey (acquisition_id, survey_id) VALUES (v_lease_acq, v_s), (v_lease_acq, v_sv2);
  INSERT INTO lms.acquisition_title_check (acquisition_id, item_code, checked_by) SELECT v_lease_acq, code, fx.u_lofield FROM lms.title_check_item;
  PERFORM test.become('nego');     PERFORM api.advance_workflow('acquisitions', v_lease_acq, 'Negotiation', 't24');
  PERFORM test.become('dmfield');  PERFORM api.advance_workflow('acquisitions', v_lease_acq, 'Approval', 't24');
  PERFORM test.become('mland');    PERFORM api.advance_workflow('acquisitions', v_lease_acq, 'Acquisition / Lease', 't24');
  PERFORM test.become('sradmin');  PERFORM api.advance_workflow('acquisitions', v_lease_acq, 'Handover', 't24');
  PERFORM test.eq((SELECT status_code FROM lms.survey WHERE id = v_s), 'Leased', 'a lease marks its parcels Leased');
  PERFORM test.eq((SELECT status_code FROM lms.survey WHERE id = v_sv2), 'Disputed', 'a disputed parcel is not changed');

  -- ---------- 3. a lease hand-over: only a Land Officer (Field) completes it ----------
  PERFORM test.become('lofield');
  INSERT INTO lms.land_request (code, province_code, project_id, purpose, area_acres, required_date, justification,
                                stage_code, pending_approver_role, created_by, updated_by)
  VALUES ('T24-REQ-2', 'SND', fx.proj_dhrk1, 'Camp', 2, current_date + 30, 't24 camp', 'Approved', 'Land Officer (Field)',
          fx.u_lofield, fx.u_lofield) RETURNING id INTO v_req2;
  UPDATE lms.land_request SET stage_code = 'Handed over', handed_over_by = fx.u_lofield, handed_over_at = now(),
         handed_over_kind = 'Lease', handed_over_comment = 't24' WHERE id = v_req2;
  PERFORM test.become('sradmin');
  PERFORM test.throws_like(format($q$ UPDATE lms.land_request SET stage_code = 'Completed', completed_by = %L WHERE id = %L $q$, fx.u_sradmin, v_req2),
    '%Land Officer (Field)%', 'someone without the Land Officer position cannot complete it');
  PERFORM test.become('lofield');
  PERFORM test.throws_like(format($q$ UPDATE lms.land_request SET stage_code = 'Completed', completed_by = %L WHERE id = %L $q$, fx.u_sradmin, v_req2),
    '%own name%', 'nor in somebody else''s name');
  UPDATE lms.land_request SET stage_code = 'Completed', completed_by = fx.u_lofield, completed_at = now(), completed_comment = 'lease signed'
   WHERE id = v_req2;
  PERFORM test.eq((SELECT stage_code FROM lms.land_request WHERE id = v_req2), 'Completed', 'the Land Officer completes a lease hand-over');

  -- ---------- 4. province unit sizes ----------
  PERFORM test.become('lofield');
  PERFORM test.throws_like($q$ SELECT api.set_province_unit_factor('SND', 'Jireb', 2.5, false, 'x') $q$,
    '%settings:update%', 'changing a unit size needs settings:update');
  PERFORM test.throws_like($q$ INSERT INTO lms.province_unit_factor (province_code, unit_code, sqm_per_unit) VALUES ('SND','Jireb',1) $q$,
    '%permission denied%', 'and the table is written only through the routine');

  -- A parcel recorded before the change keeps its area.
  INSERT INTO lms.survey (code, province_code, admin_unit_id, survey_no, khasra_type, land_class, status_code, recorded_area, recorded_unit, total_area)
  SELECT 'T24-S-OLD', 'SND', admin_unit_id, 'T24-OLD', 'Rural', 'Private', 'Proposed', 10, 'Jireb', 1
    FROM lms.survey WHERE id = v_sv RETURNING total_area::numeric INTO v_old;
  PERFORM test.eq(v_old, 5.0000::numeric, '10 jireb = 5 acres at the national factor (2 per acre)');

  PERFORM test.become('admin');
  PERFORM api.set_province_unit_factor('SND', 'Jireb', 2.5, true, 'Sindh: 2.5 jireb per acre (t24)');
  PERFORM test.throws_like($q$ SELECT api.set_province_unit_factor('SND', 'Acre', 2, true, 'x') $q$,
    '%fixed unit%', 'a definitional unit cannot be resized');
  PERFORM test.eq(round((SELECT value FROM lms.uom_convert_detail_in(10, 'Jireb', 'Acre', current_date, 'SND')), 4), 4.0000::numeric,
    'Sindh converts with its own size');
  PERFORM test.eq(round((SELECT value FROM lms.uom_convert_detail_in(10, 'Jireb', 'Acre', current_date, 'PNJ')), 4), 5.0000::numeric,
    'other provinces keep the national size');
  PERFORM api.set_province_unit_factor('SND', 'Jireb', 2.5, true, 'same day, again');
  PERFORM test.eq((SELECT count(*)::int FROM lms.province_unit_factor WHERE province_code = 'SND' AND unit_code = 'Jireb'), 1,
    'a second change the same day replaces the day''s row');

  PERFORM test.become('lofield');
  INSERT INTO lms.survey (code, province_code, admin_unit_id, survey_no, khasra_type, land_class, status_code, recorded_area, recorded_unit, total_area)
  SELECT 'T24-S-NEW', 'SND', admin_unit_id, 'T24-NEW', 'Rural', 'Private', 'Proposed', 10, 'Jireb', 1
    FROM lms.survey WHERE id = v_sv;
  PERFORM test.eq((SELECT total_area::numeric FROM lms.survey WHERE code = 'T24-S-NEW'), 4.0000::numeric, 'a new Sindh parcel uses the Sindh size');
  UPDATE lms.survey SET remarks = 't24 edit' WHERE code = 'T24-S-OLD';
  UPDATE lms.survey SET recorded_area = 10 WHERE code = 'T24-S-OLD';
  PERFORM test.eq((SELECT total_area::numeric FROM lms.survey WHERE code = 'T24-S-OLD'), 5.0000::numeric,
    'an old parcel keeps the factor it was recorded with when the area is not changed');

  PERFORM test.become('admin');
  PERFORM test.ok(api.clear_province_unit_factor('SND', 'Jireb'), 'the province size can be removed again');
  PERFORM test.eq(round((SELECT value FROM lms.uom_convert_detail_in(10, 'Jireb', 'Acre', current_date, 'SND')), 4), 5.0000::numeric,
    'and Sindh is back on the national size');

  -- ---------- 5. the new purposes ----------
  PERFORM test.eq((SELECT count(*)::int FROM lms.land_use WHERE code IN ('Gathering Station', 'Processing Facility',
    'Borrow Area (Green Area)', 'Extra Land', 'Seismic / Exploration')), 5, 'the five prototype purposes exist');
END $$;
