-- role: lms_test
-- tx: rollback
--
-- 0042: the authorization the API relies on, held by the database whatever
-- path a write takes. Runs as the application role (lms_test is a member of
-- lms_readwrite), because owner sessions are the trusted context these rules
-- exempt (definer routines, migrations).
\set QUIET on

-- ---------- AUTHZ-01: ownership moves only through a mutation ----------
DO $$
DECLARE fx record; v_survey uuid; v_unit uuid; v_a uuid; v_b uuid;
BEGIN
  SELECT * INTO fx FROM test.fixtures;
  -- Row-level security shows nothing without an actor, so become the officer first.
  PERFORM test.become('lofield');
  -- Two living Sindh landowners (fixture owners may have been moved by other tests' mutations).
  SELECT id INTO v_a FROM lms.landowner WHERE province_code = 'SND' AND status = 'Active' ORDER BY code LIMIT 1;
  SELECT id INTO v_b FROM lms.landowner WHERE province_code = 'SND' AND status = 'Active' AND id <> v_a ORDER BY code LIMIT 1;
  PERFORM test.throws(format($q$ INSERT INTO lms.survey_ownership_share (survey_id, landowner_id, share_pct)
                                 VALUES (%L, %L, 1) $q$, fx.survey_112, fx.lo_rasool), '42501',
                      'the application cannot write ownership shares directly');
  PERFORM test.throws(format($q$ UPDATE lms.survey_ownership_share SET share_pct = share_pct WHERE survey_id = %L $q$, fx.survey_112),
                      '42501', 'nor change them');
  PERFORM test.throws(format($q$ DELETE FROM lms.survey_ownership_share WHERE survey_id = %L $q$, fx.survey_112),
                      '42501', 'nor remove them');
  PERFORM test.throws(format($q$ SELECT api.register_ownership(%L, '[{"landowner_id":"%s","share_pct":100}]') $q$,
                             fx.survey_112, fx.lo_rasool), '55000',
                      'a parcel that has owners is re-registered only by a mutation');

  SELECT admin_unit_id INTO v_unit FROM lms.survey WHERE id = fx.survey_112;
  INSERT INTO lms.survey (code, province_code, admin_unit_id, survey_no, total_area, land_class, status_code)
  VALUES (lms.next_code('AREA-'), 'SND', v_unit, 'T20-1', 4.0, 'Private', 'Proposed') RETURNING id INTO v_survey;
  PERFORM test.eq(api.register_ownership(v_survey, jsonb_build_array(
                    jsonb_build_object('landowner_id', v_a, 'share_pct', 60),
                    jsonb_build_object('landowner_id', v_b, 'share_pct', 40))), 2,
                  'a new parcel gets its first owners through api.register_ownership');
  PERFORM test.eq((SELECT count(*)::int FROM lms.survey_ownership_history WHERE survey_id = v_survey AND change_reason = 'Initial registration'), 2,
                  'and the registration is in the ownership history');
  PERFORM test.throws(format($q$ SELECT api.register_ownership(%L, '[{"landowner_id":"%s","share_pct":100}]') $q$, v_survey, v_a),
                      '55000', 'a second registration is refused');

  INSERT INTO lms.survey (code, province_code, admin_unit_id, survey_no, total_area, land_class, status_code)
  VALUES (lms.next_code('AREA-'), 'SND', v_unit, 'T20-2', 1.0, 'Private', 'Proposed') RETURNING id INTO v_survey;
  PERFORM test.throws(format($q$ SELECT api.register_ownership(%L, '[{"landowner_id":"%s","share_pct":100}]') $q$, v_survey, fx.lo_shahbaz),
                      'P0002', 'an owner from another province reads as not found');
  PERFORM test.throws(format($q$ SELECT api.register_ownership(%L, '[{"landowner_id":"%s","share_pct":50}]') $q$, v_survey, v_a),
                      '23514', 'first owners total 100%');
END $$;

-- ---------- AUTHZ-02: workflow stages ----------
DO $$
DECLARE fx record; v_stage text; v_lease uuid;
BEGIN
  SELECT * INTO fx FROM test.fixtures;
  PERFORM test.become('lofield');
  INSERT INTO lms.lease (code, province_code, project_id, kind, initial_area, start_date, term_years, rate_per_acre, stage_code)
  VALUES (lms.next_code('LSE-'), 'SND', fx.proj_dhrk1, 'Private Land', 1, current_date, 1, 1000, 'Approved')
  RETURNING id, stage_code INTO v_lease, v_stage;
  PERFORM test.eq(v_stage, 'Draft', 'a lease starts at the first stage whatever the client sends');
  INSERT INTO lms.lease_survey (lease_id, survey_id) VALUES (v_lease, fx.survey_207);
  PERFORM test.eq((SELECT is_blocking FROM lms.lease_survey WHERE lease_id = v_lease), false,
                  'and blocks no parcel until it is approved');
  PERFORM test.throws(format($q$ UPDATE lms.lease SET stage_code = 'Approved' WHERE id = %L $q$, v_lease), '42501',
                      'a stage cannot be set directly');
  PERFORM test.become('admin');
  PERFORM test.throws(format($q$ UPDATE lms.compensation_case SET stage_code = 'HO Approved' WHERE id = %L $q$, fx.case_draft), '42501',
                      'not even by an administrator');
  PERFORM test.throws(format($q$ INSERT INTO lms.payment_request (code, province_code, project_id, category_code, pay_type, period_from,
                                   gross_amount, wht_pct, payment_mode, land_class, payee_name, stage_code)
                                 VALUES ('VCH-T20-1', 'SND', %L, 'Lease Rent', 'One-time', current_date, 1, 0, 'Cross Cheque', 'Private', 'X', 'Released') $q$,
                             fx.proj_dhrk1), '42501', 'a voucher is raised only through api.request_payment');
END $$;

-- ---------- AUTHZ-15: links stay inside the record's province ----------
DO $$
DECLARE fx record;
BEGIN
  SELECT * INTO fx FROM test.fixtures;
  PERFORM test.become('admin');   -- sees every province: the rule is "same province", not just "visible"
  PERFORM test.throws(format($q$ INSERT INTO lms.project_survey (project_id, survey_id) VALUES (%L, %L) $q$, fx.proj_dhrk1, fx.survey_1187),
                      'P0002', 'a Sindh project cannot take a Balochistan parcel');
  PERFORM test.throws(format($q$ INSERT INTO lms.case_owner (case_id, landowner_id, share_pct, owner_status) VALUES (%L, %L, 1, 'O') $q$,
                             fx.case_draft, fx.lo_shahbaz), 'P0002', 'nor a Sindh case a Balochistan owner');
  PERFORM test.become('lofield');
  PERFORM test.throws_like(format($q$ INSERT INTO lms.lease_lessor (lease_id, landowner_id) VALUES (%L, %L) $q$, fx.lease_snd, fx.lo_shahbaz),
                           '%not found%', 'and a record the actor cannot see reads as not found');
END $$;

-- ---------- AUTHZ-04: mutation terms freeze on verification; a send-back starts a new round ----------
DO $$
DECLARE fx record; v_mut uuid;
BEGIN
  SELECT * INTO fx FROM test.fixtures;
  PERFORM test.become('admin');
  INSERT INTO lms.mutation (code, province_code, mutation_type, transferor_id, revenue_mutation_no, mutation_date, certificate_no, stage_code)
  VALUES (lms.next_code('MUT-'), 'SND', 'Sale / Transfer', fx.lo_mukhtiar, 'T20-REV-1', current_date, 'T20-C', 'Initiated')
  RETURNING id INTO v_mut;
  INSERT INTO lms.mutation_survey (mutation_id, survey_id) VALUES (v_mut, fx.survey_113);
  PERFORM test.become('sradmin');
  PERFORM api.advance_workflow('mutations', v_mut, 'Revenue Verified');

  PERFORM test.become('lofield');
  PERFORM test.throws(format($q$ INSERT INTO lms.mutation_heir (mutation_id, landowner_id, relation, share_pct) VALUES (%L, %L, 'Buyer', 100) $q$,
                             v_mut, fx.lo_zubaida), '55000', 'heirs cannot be added once Revenue has verified the mutation');
  PERFORM test.throws(format($q$ DELETE FROM lms.mutation_survey WHERE mutation_id = %L $q$, v_mut), '55000', 'nor parcels removed');
  PERFORM test.throws(format($q$ UPDATE lms.mutation SET certificate_no = 'changed' WHERE id = %L $q$, v_mut), '55000',
                      'nor the verified revenue record edited');
  PERFORM test.throws(format($q$ SELECT api.reopen_workflow('mutations', %L, 'short') $q$, v_mut), '22023', 'a send-back needs a reason');
  PERFORM test.eq(api.reopen_workflow('mutations', v_mut, 'Revenue record corrected by the field office'), 'Initiated',
                  'the mutation is sent back to its first stage');
  INSERT INTO lms.mutation_heir (mutation_id, landowner_id, relation, share_pct) VALUES (v_mut, fx.lo_zubaida, 'Buyer', 100);
  PERFORM test.ok(true, 'and can be changed again');
  PERFORM test.throws_like(format($q$ SELECT api.advance_workflow('mutations', %L, 'Revenue Verified') $q$, v_mut),
                           '%sent % back for changes%', 'whoever sent it back does not approve the new round');
  PERFORM test.become('sradmin');
  PERFORM test.eq(api.advance_workflow('mutations', v_mut, 'Revenue Verified'), 'Revenue Verified',
                  'an earlier approver approves the new round (their first approval no longer counts)');
END $$;

-- ---------- AUTHZ-10: valuations, rents and rates ----------
DO $$
DECLARE fx record; v_lease uuid; v_old numeric; v_r jsonb; v_dbpfc uuid;
BEGIN
  SELECT * INTO fx FROM test.fixtures;
  PERFORM test.become('lofield');
  PERFORM test.throws(format($q$ INSERT INTO lms.case_misc_line (case_id, payment_type, amount) VALUES (%L, 'T20 extra', 1) $q$, fx.case_draft),
                      '55000', 'a checked case''s valuation cannot change in place');
  PERFORM test.throws(format($q$ UPDATE lms.compensation_case SET lease_rate = lease_rate + 1 WHERE id = %L $q$, fx.case_draft),
                      '55000', 'nor its lease rate');
  PERFORM test.eq(api.reopen_workflow('cases', fx.case_draft, 'Owners'' share corrected after negotiation'), 'Prepared',
                  'the case is sent back for re-approval');
  INSERT INTO lms.case_misc_line (case_id, payment_type, amount) VALUES (fx.case_draft, 'T20 extra', 1);
  PERFORM test.ok(true, 'and its valuation can then change');
  PERFORM test.throws(format($q$ SELECT api.reopen_workflow('cases', %L, 'reopening an approved case') $q$, fx.case_approved),
                      '55000', 'an approved case is never sent back');
  PERFORM test.throws(format($q$ SELECT api.reopen_workflow('payments', %L, 'reopening a voucher') $q$, fx.pay_verified),
                      '22023', 'a voucher is cancelled and raised again, not sent back');

  SELECT id, rate_per_acre INTO v_lease, v_old FROM lms.lease
   WHERE stage_code = 'Approved' AND NOT is_on_hold AND terminated_on IS NULL ORDER BY code LIMIT 1;
  PERFORM test.become('mland');
  PERFORM test.throws(format($q$ UPDATE lms.lease SET rate_per_acre = rate_per_acre + 1 WHERE id = %L $q$, v_lease), '55000',
                      'an approved lease''s rent does not change in place');
  PERFORM test.throws(format($q$ SELECT api.reopen_workflow('leases', %L, 'reopening an approved lease') $q$, v_lease), '55000',
                      'nor is an approved lease sent back');
  PERFORM test.throws(format($q$ SELECT api.renew_lease(%L, 1, 200) $q$, v_lease), '22023', 'a renewal''s escalation is bounded by policy');
  v_r := api.renew_lease(v_lease, 1, 5);
  PERFORM test.eq((v_r ->> 'new_rate')::numeric, round(v_old * 1.05, 2), 'a renewal escalates the agreed rate');
  PERFORM test.become('lofield');
  -- Since 0048 a land officer holds leases:update (for the leases review step), so the
  -- renewal is refused by its position, Manager Land (HO), rather than by permission.
  PERFORM test.throws(format($q$ SELECT api.renew_lease(%L, 1, 5) $q$, v_lease), '42501', 'and is the Manager Land (HO) position''s to make');

  SELECT id INTO v_dbpfc FROM lms.dbpfc_estimate WHERE stage_code = 'Referred to DBPFC' ORDER BY code LIMIT 1;
  PERFORM test.throws(format($q$ UPDATE lms.dbpfc_estimate SET fixed_rate = 1 WHERE id = %L $q$, v_dbpfc), '42501',
                      'the committee rate is not recorded by a field user');
  PERFORM test.throws(format($q$ UPDATE lms.dbpfc_estimate SET area_acres = area_acres + 1 WHERE id = %L $q$, v_dbpfc), '55000',
                      'and the referred estimate is frozen');
  PERFORM test.become('mland');
  UPDATE lms.dbpfc_estimate SET fixed_rate = 76000 WHERE id = v_dbpfc;
  PERFORM test.eq((SELECT fixed_rate::numeric FROM lms.dbpfc_estimate WHERE id = v_dbpfc), 76000::numeric,
                  'the rate-fixing position records it');
END $$;

-- ---------- AUTHZ-05: a court stay is lifted only with the hold authority ----------
DO $$
DECLARE fx record; v_n integer;
BEGIN
  SELECT * INTO fx FROM test.fixtures;
  PERFORM test.become('finance');
  PERFORM test.throws(format($q$ UPDATE lms.payment_hold SET lifted_at = clock_timestamp(), lifted_by = %L, lift_reason = 'x'
                                 WHERE legal_case_id = %L AND lifted_at IS NULL $q$, fx.u_finance, fx.legal1), '42501',
                      'a court-stay hold is not lifted from the payments side');
  PERFORM test.throws(format($q$ SELECT api.lift_stay(%L, 'Court order of 1 Nov vacating the stay') $q$, fx.legal1), 'P0002',
                      'and finance without legal:update cannot record the court''s order');
  PERFORM test.become('legal');
  PERFORM test.throws(format($q$ UPDATE lms.legal_case SET stay_order = false WHERE id = %L $q$, fx.legal1), '42501',
                      'a stay is not lifted by a plain edit of the legal case');
  PERFORM test.throws(format($q$ SELECT api.lift_stay(%L, 'Court order of 1 Nov vacating the stay') $q$, fx.legal1), '42501',
                      'nor by legal:update alone, without the payment-hold authority');
  PERFORM test.become('mland');
  PERFORM test.throws(format($q$ SELECT api.lift_stay(%L, 'too short') $q$, fx.legal1), '22023', 'the court''s order is recorded');
  v_n := api.lift_stay(fx.legal1, 'Court order of 1 Nov vacating the stay');
  PERFORM test.ok(v_n >= 1, 'the officer with both authorities lifts the stay');
  PERFORM test.eq((SELECT count(*)::int FROM lms.payment_hold WHERE legal_case_id = fx.legal1 AND lifted_at IS NULL), 0,
                  'which lifts every hold it placed');
  PERFORM test.ok((SELECT bool_and(lift_reason LIKE '%Court order of 1 Nov%') FROM lms.payment_hold
                   WHERE legal_case_id = fx.legal1 AND lifted_by = fx.u_mland),
                  'and records the court''s order on each');
END $$;

-- ---------- AUTHZ-11, AUTHZ-12: payment routines and holds check every id's province ----------
DO $$
DECLARE fx record; v_prov text;
BEGIN
  SELECT * INTO fx FROM test.fixtures;
  PERFORM test.become('lofield');
  PERFORM test.throws(format($q$ SELECT api.request_payment('t20-key-0001-aaaaaaaaaaaa', %L, 'Crop Compensation', 'One-time',
                                   current_date + 700, 1000, 'Cross Cheque', %L) $q$, fx.proj_dhrk1, fx.lo_shahbaz),
                      'P0002', 'a voucher cannot name a payee from another province');
  PERFORM test.throws(format($q$ SELECT api.request_payment('t20-key-0002-aaaaaaaaaaaa', %L, 'Crop Compensation', 'One-time',
                                   current_date + 701, 1000, 'Cross Cheque', NULL, 'Someone', %L) $q$, fx.proj_dhrk1, fx.case_bal),
                      'P0002', 'nor a case from another province, and says nothing about it');
  PERFORM test.throws(format($q$ SELECT api.request_payment('t20-key-0003-aaaaaaaaaaaa', %L, 'Crop Compensation', 'One-time',
                                   current_date + 702, 1000, 'Cross Cheque', %L, NULL, %L) $q$, fx.proj_dhrk1, fx.lo_rasool, fx.case_approved),
                      '22023', 'a landowner payee on a case must be one of its owners');
  PERFORM test.become('finance');
  PERFORM test.throws(format($q$ SELECT api.allocate_payment(%L, %L, 1) $q$, fx.pay_verified, fx.case_bal), 'P0002',
                      'an allocation cannot reach another province''s case');
  INSERT INTO lms.payment_hold (province_code, scope, landowner_id, reason, placed_by)
  VALUES ('SND', 'landowner', fx.lo_shahbaz, 'T20 dispute', fx.u_finance) RETURNING province_code INTO v_prov;
  PERFORM test.eq(v_prov, 'BAL', 'a hold takes its province from its target, not from the request');
  PERFORM test.become('lofield');
  PERFORM test.throws(format($q$ INSERT INTO lms.payment_hold (province_code, scope, landowner_id, reason, placed_by)
                                 VALUES ('SND', 'landowner', %L, 'x', %L) $q$, fx.lo_shahbaz, fx.u_lofield),
                      'P0002', 'and a target the actor cannot see reads as not found');
END $$;

-- ---------- AUTHZ-14: payee tax status and bank details ----------
DO $$
DECLARE fx record; v_payee uuid; v_pay uuid;
BEGIN
  SELECT * INTO fx FROM test.fixtures;
  SELECT lo.id INTO v_payee FROM lms.landowner lo
   WHERE lo.province_code = 'SND' AND lo.status = 'Active'
     AND NOT EXISTS (SELECT 1 FROM lms.payment_hold h WHERE h.landowner_id = lo.id AND h.lifted_at IS NULL)
   ORDER BY lo.code LIMIT 1;
  PERFORM test.become('lofield');
  UPDATE lms.landowner SET tax_status = CASE WHEN tax_status = 'Filer' THEN 'Non-Filer' ELSE 'Filer' END WHERE id = v_payee;
  PERFORM test.eq((SELECT pay_details_changed_by FROM lms.landowner WHERE id = v_payee), fx.u_lofield,
                  'a change of tax status is attributed by the database');
  PERFORM test.throws(format($q$ SELECT api.request_payment('t20-key-0004-aaaaaaaaaaaa', %L, 'Crop Compensation', 'One-time',
                                   current_date + 703, 100, 'Cross Cheque', %L) $q$, fx.proj_dhrk1, v_payee),
                      '42501', 'whoever changed it does not raise that payee''s voucher');
  PERFORM test.become('nego');
  v_pay := api.request_payment('t20-key-0005-aaaaaaaaaaaa', fx.proj_dhrk1, 'Crop Compensation', 'One-time',
                               current_date + 704, 100, 'Cross Cheque', v_payee);
  PERFORM test.ok((SELECT payee_tax_status IS NOT NULL FROM lms.payment_request WHERE id = v_pay),
                  'another person raises it, and the payee''s tax status is kept on the voucher');
  PERFORM test.become('lofield');
  UPDATE lms.landowner SET tax_status = CASE WHEN tax_status = 'Filer' THEN 'Non-Filer' ELSE 'Filer' END WHERE id = v_payee;
  PERFORM test.become('finance');
  PERFORM test.throws(format($q$ SELECT api.advance_workflow('payments', %L, 'Verified') $q$, v_pay), '55000',
                      'a voucher whose payee changed after it was raised is not verified');
END $$;

-- ---------- AUTHZ-19, AUTHZ-20: documents ----------
DO $$
DECLARE fx record; v_cat text; v_doc uuid; v_closed uuid; v_bal uuid;
BEGIN
  SELECT * INTO fx FROM test.fixtures;
  SELECT code INTO v_cat FROM lms.document_category ORDER BY display_order LIMIT 1;
  PERFORM test.become('lofield');
  INSERT INTO lms.document (code, entity, record_id, record_code, province_code, file_name, mime_type, size_bytes,
                            category_code, storage_ref, content_sha256, uploaded_by)
  VALUES (lms.next_code('DOC-'), 'project', fx.proj_dhrk1, 'DHRK-001', 'SND', 't20.pdf', 'application/pdf', 10,
          v_cat, 'sha256:' || repeat('ab', 32), decode(repeat('ab', 32), 'hex'), fx.u_lofield) RETURNING id INTO v_doc;
  INSERT INTO lms.document (code, entity, record_id, record_code, province_code, file_name, mime_type, size_bytes,
                            category_code, storage_ref, content_sha256, uploaded_by)
  VALUES (lms.next_code('DOC-'), 'compensation_case', fx.case_approved, 'CC-2026-0001', 'SND', 't20-deed.pdf', 'application/pdf', 10,
          v_cat, 'sha256:' || repeat('cd', 32), decode(repeat('cd', 32), 'hex'), fx.u_lofield) RETURNING id INTO v_closed;
  PERFORM test.throws(format($q$ UPDATE lms.document SET deleted_at = now(), deleted_by = %L, delete_reason = 'wrong file' WHERE id = %L $q$,
                             fx.u_lofield, v_doc), '42501', 'the uploader does not archive their own document');
  PERFORM test.become('nego');
  PERFORM test.throws(format($q$ UPDATE lms.document SET file_name = 'renamed.pdf' WHERE id = %L $q$, v_doc), '42501',
                      'a document''s file and attribution are immutable');
  PERFORM test.throws(format($q$ UPDATE lms.document SET deleted_at = now(), deleted_by = %L, delete_reason = 'superseded' WHERE id = %L $q$,
                             fx.u_nego, v_closed), '55000', 'a document of an approved case is kept');
  UPDATE lms.document SET deleted_at = now(), deleted_by = fx.u_lofield, delete_reason = 'uploaded to the wrong record' WHERE id = v_doc;
  PERFORM test.eq((SELECT deleted_by FROM lms.document WHERE id = v_doc), fx.u_nego,
                  'someone else archives it, attributed to themselves');

  PERFORM test.become('admin');
  INSERT INTO lms.document (code, entity, record_id, record_code, province_code, file_name, mime_type, size_bytes,
                            category_code, storage_ref, content_sha256, uploaded_by)
  VALUES (lms.next_code('DOC-'), 'project', fx.proj_sui, 'SUI-004', 'BAL', 't20-bal.pdf', 'application/pdf', 10,
          v_cat, 'sha256:' || repeat('ef', 32), decode(repeat('ef', 32), 'hex'), fx.u_admin) RETURNING id INTO v_bal;
  PERFORM test.become('lofield');
  PERFORM test.throws(format($q$ INSERT INTO lms.document_access_log (document_id, accessed_by, action) VALUES (%L, %L, 'view') $q$,
                             v_bal, fx.u_lofield), 'P0002', 'an access is not logged against a document the actor cannot see');
END $$;

-- ---------- AUTHZ-23: proof of payment is not self-attested ----------
DO $$
DECLARE fx record; v_rel uuid;
BEGIN
  SELECT * INTO fx FROM test.fixtures;
  SELECT id INTO v_rel FROM lms.payment_release WHERE payment_id = fx.pay_released;
  PERFORM test.become('lofield');
  PERFORM test.throws(format($q$ INSERT INTO lms.payment_receipt (release_id, receipt_no, received_on, acknowledged_by, recorded_by)
                                 VALUES (%L, 'T20-RC-1', current_date, 'Payee', %L) $q$, v_rel, fx.u_lofield),
                      '42501', 'the voucher''s raiser does not record its receipt');
  PERFORM test.become('mland');
  PERFORM test.throws(format($q$ INSERT INTO lms.payment_receipt (release_id, receipt_no, received_on, acknowledged_by, recorded_by)
                                 VALUES (%L, 'T20-RC-2', current_date, 'Payee', %L) $q$, v_rel, fx.u_mland),
                      '42501', 'nor does its releaser');
  PERFORM test.become('finance');
  INSERT INTO lms.payment_receipt (release_id, receipt_no, received_on, acknowledged_by, recorded_by)
  VALUES (v_rel, 'T20-RC-3', current_date, 'Payee', fx.u_lofield);
  PERFORM test.eq((SELECT recorded_by FROM lms.payment_receipt WHERE receipt_no = 'T20-RC-3'), fx.u_finance,
                  'finance records it, attributed to the person who did');
END $$;

-- ---------- AUTHZ-03: land-request tiers are positions ----------
DO $$
DECLARE fx record; v_req uuid;
BEGIN
  SELECT * INTO fx FROM test.fixtures;
  PERFORM test.ok(EXISTS (SELECT 1 FROM lms.approval_group WHERE code = 'Director Operations'), 'the tiers are approval positions');
  PERFORM test.become('lofield');
  INSERT INTO lms.land_request (code, province_code, project_id, purpose, area_acres, required_date, justification, created_by, updated_by)
  VALUES ('REQ-T20-1', 'SND', fx.proj_dhrk1, 'T20 well pad', 2, current_date + 30, 'T20 test', fx.u_lofield, fx.u_lofield)
  RETURNING id INTO v_req;
  PERFORM test.become('nego');
  PERFORM test.throws(format($q$ UPDATE lms.land_request SET director_ops_id = %L WHERE id = %L $q$, fx.u_nego, v_req), '42501',
                      'a tier is decided only by a holder of its position');
  PERFORM test.become('admin');
  PERFORM test.throws(format($q$ UPDATE lms.land_request SET director_ops_id = %L WHERE id = %L $q$, fx.u_admin, v_req), '42501',
                      'and never by a system administrator');
END $$;
