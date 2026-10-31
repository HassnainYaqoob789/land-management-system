-- role: lms_test
-- tx: rollback
--
-- Import validation, duplicate detection, the exception report, and promotion.
--
-- The rule being tested is that a file with unresolved errors cannot reach the
-- live registers, and that the errors it produces name the line and the reason
-- rather than failing the whole load with one message.
\set QUIET on

DO $$
DECLARE
  fx record; v_batch uuid; r api.import_result; v_n integer; v_id uuid;
BEGIN
  PERFORM test.become('sradmin');  -- 0047: the administrator holds no business permission
  SELECT * INTO fx FROM test.fixtures;

  -- ---------- a landowner file with a representative set of problems ----------
  INSERT INTO lms.import_batch (code, target_entity, province_code, source_file,
                                source_sha256, uploaded_by)
  VALUES (lms.next_code('IMP-'), 'landowner', 'SND', 'landowners_ghotki.csv',
          sha256('landowners_ghotki.csv v1'::bytea), fx.u_admin)
  RETURNING id INTO v_batch;

  INSERT INTO lms.import_row (batch_id, source_line, raw) VALUES
   -- clean, but with the CNIC punctuation the client's spreadsheets omit
   (v_batch, 1, '{"full_name":"Ghulam Rasool Jarwar","father_name":"Hakim Ali",
                  "cnic":"4510233333331","phone":"+92 300 3333331",
                  "iban":"PK24HABB0000033000330031","owner_type":"o"}'::jsonb),
   -- clean, CNIC already punctuated and padded with spaces
   (v_batch, 2, '{"full_name":"  Sakina Bibi  ","father_name":"Ghulam Rasool",
                  "cnic":" 45102-3333334-4 ","iban":"PK24HABB0000033000330034"}'::jsonb),
   -- missing name
   (v_batch, 3, '{"full_name":"","father_name":"Someone","cnic":"45102-3333335-7"}'::jsonb),
   -- malformed CNIC
   (v_batch, 4, '{"full_name":"Bad Cnic","father_name":"Someone","cnic":"123-45"}'::jsonb),
   -- a CNIC that is already in the register
   (v_batch, 5, '{"full_name":"Impostor","father_name":"Someone",
                  "cnic":"45102-1100012-3"}'::jsonb),
   -- the same CNIC twice within the file
   (v_batch, 6, '{"full_name":"Twin A","father_name":"Someone","cnic":"45102-3333338-5"}'::jsonb),
   (v_batch, 7, '{"full_name":"Twin B","father_name":"Someone","cnic":"45102-3333338-5"}'::jsonb),
   -- an unknown province
   (v_batch, 8, '{"full_name":"Wrong Province","father_name":"Someone",
                  "cnic":"45102-3333339-8","province_code":"XYZ"}'::jsonb),
   -- clean except for a missing IBAN, which is a warning not an error
   (v_batch, 9, '{"full_name":"No Bank Yet","father_name":"Someone",
                  "cnic":"45102-3333340-1"}'::jsonb);

  r := api.validate_import_batch(v_batch);
  PERFORM test.eq(r.row_count, 9, 'the batch has nine rows');
  PERFORM test.eq(r.status, 'rejected', 'and is rejected, because some rows have errors');
  PERFORM test.eq(r.error_count, 6, 'six rows are in error');
  PERFORM test.eq(r.valid_count, 3, 'and three are clean');

  -- ---------- normalisation ----------
  PERFORM test.eq((SELECT normalised ->> 'cnic' FROM lms.import_row
                   WHERE batch_id = v_batch AND source_line = 1),
                  '45102-3333333-1', 'an unpunctuated CNIC is normalised');
  PERFORM test.eq((SELECT normalised ->> 'cnic' FROM lms.import_row
                   WHERE batch_id = v_batch AND source_line = 2),
                  '45102-3333334-4', 'and a padded one is trimmed');
  PERFORM test.eq((SELECT normalised ->> 'full_name' FROM lms.import_row
                   WHERE batch_id = v_batch AND source_line = 2),
                  'Sakina Bibi', 'surrounding spaces are stripped from the name');
  PERFORM test.eq((SELECT normalised ->> 'owner_type' FROM lms.import_row
                   WHERE batch_id = v_batch AND source_line = 1),
                  'O', 'a lower-case owner type is upper-cased');
  PERFORM test.eq((SELECT normalised ->> 'owner_type' FROM lms.import_row
                   WHERE batch_id = v_batch AND source_line = 2),
                  'O', 'and a missing one defaults');
  -- The raw row is kept beside the normalised one, so a reviewer can see what
  -- the import changed about their data.
  PERFORM test.eq((SELECT raw ->> 'cnic' FROM lms.import_row
                   WHERE batch_id = v_batch AND source_line = 1),
                  '4510233333331', 'and the original value is kept as it arrived');

  -- ---------- the exception report ----------
  PERFORM test.ok(EXISTS (SELECT 1 FROM lms.import_validation_error
                          WHERE batch_id = v_batch AND source_line = 3
                            AND rule = 'required' AND field = 'full_name'),
                  'the missing name is reported against line 3');
  PERFORM test.ok(EXISTS (SELECT 1 FROM lms.import_validation_error
                          WHERE batch_id = v_batch AND source_line = 4
                            AND rule = 'cnic_format'),
                  'the malformed CNIC is reported against line 4');
  PERFORM test.ok(EXISTS (SELECT 1 FROM lms.import_validation_error
                          WHERE batch_id = v_batch AND source_line = 5
                            AND rule = 'duplicate_existing'
                            AND message LIKE '%already registered as%'),
                  'the CNIC that already exists is reported, naming the existing record');
  PERFORM test.eq((SELECT count(*)::integer FROM lms.import_validation_error
                   WHERE batch_id = v_batch AND rule = 'duplicate_in_file'), 2,
                  'both halves of the in-file duplicate are reported');
  PERFORM test.ok(EXISTS (SELECT 1 FROM lms.import_validation_error
                          WHERE batch_id = v_batch AND source_line = 8
                            AND rule = 'unknown_province'),
                  'the unknown province is reported');
  PERFORM test.ok(EXISTS (SELECT 1 FROM lms.import_validation_error
                          WHERE batch_id = v_batch AND source_line = 9
                            AND rule = 'iban_format' AND severity = 'warning'),
                  'the missing IBAN is a warning, not an error');
  PERFORM test.eq((SELECT status FROM lms.import_row
                   WHERE batch_id = v_batch AND source_line = 9), 'valid',
                  'so that row is still loadable');

  -- ---------- a rejected batch cannot be promoted ----------
  PERFORM test.throws_like(
    format($q$ SELECT api.promote_import_batch(%L) $q$, v_batch),
    '%only a validated batch may be promoted%',
    'a batch with errors cannot reach the live register');

  -- ---------- fix the file and re-validate ----------
  DELETE FROM lms.import_row WHERE batch_id = v_batch AND source_line IN (3,4,5,7,8);
  r := api.validate_import_batch(v_batch);
  PERFORM test.eq(r.status, 'validated', 'once the bad rows are removed the batch validates');
  PERFORM test.eq(r.error_count, 0, 'with no errors left');
  PERFORM test.eq(r.valid_count, 4, 'and four rows to load');
  PERFORM test.eq((SELECT count(*)::integer FROM lms.import_validation_error
                   WHERE batch_id = v_batch AND severity = 'error'), 0,
                  're-validation clears the errors it previously reported');
  PERFORM test.ok(EXISTS (SELECT 1 FROM lms.import_validation_error
                          WHERE batch_id = v_batch AND severity = 'warning'),
                  'while the warnings remain');

  -- ---------- promotion ----------
  SELECT count(*) INTO v_n FROM lms.landowner;
  PERFORM test.eq(api.promote_import_batch(v_batch), 4, 'four rows are promoted');
  PERFORM test.eq((SELECT count(*)::integer FROM lms.landowner), v_n + 4,
                  'and four landowners appear in the register');
  PERFORM test.eq((SELECT status FROM lms.import_batch WHERE id = v_batch), 'promoted',
                  'the batch is marked promoted');
  PERFORM test.ok((SELECT promoted_by FROM lms.import_batch WHERE id = v_batch) IS NOT NULL,
                  'with who promoted it');

  -- The promoted records are real, normalised, and carry their provenance.
  SELECT id INTO v_id FROM lms.landowner WHERE cnic = '45102-3333333-1';
  PERFORM test.ok(v_id IS NOT NULL, 'the normalised CNIC is what landed in the register');
  PERFORM test.eq((SELECT full_name FROM lms.landowner WHERE id = v_id),
                  'Ghulam Rasool Jarwar', 'with the cleaned name');
  PERFORM test.ok(EXISTS (SELECT 1 FROM lms.data_provenance
                          WHERE entity = 'landowner' AND record_id = v_id
                            AND source_kind = 'import' AND batch_id = v_batch
                            AND source_line = 1),
                  'and a provenance row naming the file and the line it came from');

  -- ---------- promoting twice is refused ----------
  PERFORM test.throws_like(
    format($q$ SELECT api.promote_import_batch(%L) $q$, v_batch),
    '%is promoted%', 'a promoted batch cannot be promoted again');

  -- ---------- the same file cannot be loaded twice ----------
  PERFORM test.throws($q$
    INSERT INTO lms.import_batch (code, target_entity, province_code, source_file,
                                  source_sha256, uploaded_by, status, validated_at)
    SELECT lms.next_code('IMP-'), 'landowner', 'SND', 'landowners_ghotki_copy.csv',
           sha256('landowners_ghotki.csv v1'::bytea), u_admin, 'validated', now()
    FROM test.fixtures
  $q$, '23505', 'a second validated batch of the same file content is refused');

  -- ---------- an unsupported entity is reported, not silently passed ----------
  INSERT INTO lms.import_batch (code, target_entity, province_code, source_file,
                                source_sha256, uploaded_by)
  VALUES (lms.next_code('IMP-'), 'legal_case', 'SND', 'courtcases.csv',
          sha256('courtcases.csv'::bytea), fx.u_admin)
  RETURNING id INTO v_batch;
  INSERT INTO lms.import_row (batch_id, source_line, raw)
  VALUES (v_batch, 1, '{"anything":"here"}'::jsonb);
  r := api.validate_import_batch(v_batch);
  PERFORM test.eq(r.status, 'rejected', 'an unsupported entity rejects the batch');
  PERFORM test.ok(EXISTS (SELECT 1 FROM lms.import_validation_error
                          WHERE batch_id = v_batch AND rule = 'unsupported_entity'),
                  'and says so, rather than reporting a clean validation');
END $$;

-- ---------- a survey file, including the unit conversion ----------
DO $$
DECLARE fx record; v_batch uuid; r api.import_result; v_id uuid;
BEGIN
  PERFORM test.become('mland');    -- PNJ batch: needs head-office scope
  SELECT * INTO fx FROM test.fixtures;

  INSERT INTO lms.import_batch (code, target_entity, province_code, source_file,
                                source_sha256, uploaded_by)
  VALUES (lms.next_code('IMP-'), 'survey', 'PNJ', 'khasra_jampur.csv',
          sha256('khasra_jampur.csv'::bytea), fx.u_admin)
  RETURNING id INTO v_batch;

  INSERT INTO lms.import_row (batch_id, source_line, raw) VALUES
   -- 16 kanal is exactly 2 acres
   (v_batch, 1, '{"survey_no":"771","unit_name":"Chak Dajal","area_value":"16",
                  "area_unit":"Kanal","land_class":"Private"}'::jsonb),
   -- already in acres
   (v_batch, 2, '{"survey_no":"772","unit_name":"Chak Dajal","area_value":"5.25",
                  "area_unit":"Acre"}'::jsonb),
   -- an unknown unit
   (v_batch, 3, '{"survey_no":"773","unit_name":"Chak Dajal","area_value":"3",
                  "area_unit":"Furlong"}'::jsonb),
   -- a non-numeric area
   (v_batch, 4, '{"survey_no":"774","unit_name":"Chak Dajal","area_value":"about three",
                  "area_unit":"Acre"}'::jsonb),
   -- a unit name that is not in this province
   (v_batch, 5, '{"survey_no":"775","unit_name":"Jarwar","area_value":"2",
                  "area_unit":"Acre"}'::jsonb),
   -- a provisional conversion factor: loadable, but flagged
   (v_batch, 6, '{"survey_no":"776","unit_name":"Chak Dajal","area_value":"2",
                  "area_unit":"Bigha"}'::jsonb);

  r := api.validate_import_batch(v_batch);
  PERFORM test.eq(r.error_count, 3, 'three survey rows are in error');
  PERFORM test.ok(EXISTS (SELECT 1 FROM lms.import_validation_error
                          WHERE batch_id = v_batch AND source_line = 3
                            AND rule = 'unknown_unit'),
                  'the unknown area unit is reported');
  PERFORM test.ok(EXISTS (SELECT 1 FROM lms.import_validation_error
                          WHERE batch_id = v_batch AND source_line = 4
                            AND rule = 'numeric'),
                  'the non-numeric area is reported');
  PERFORM test.ok(EXISTS (SELECT 1 FROM lms.import_validation_error
                          WHERE batch_id = v_batch AND source_line = 5
                            AND rule = 'unknown_unit_name'),
                  'a unit name from the wrong province is reported');
  PERFORM test.ok(EXISTS (SELECT 1 FROM lms.import_validation_error
                          WHERE batch_id = v_batch AND source_line = 6
                            AND rule = 'unconfirmed_unit' AND severity = 'warning'),
                  'a provisional conversion factor is a warning, so the figure can be labelled');

  DELETE FROM lms.import_row WHERE batch_id = v_batch AND source_line IN (3,4,5);
  r := api.validate_import_batch(v_batch);
  PERFORM test.eq(r.status, 'validated', 'the corrected survey batch validates');
  PERFORM test.eq(api.promote_import_batch(v_batch), 3, 'and promotes three parcels');

  -- The conversion happened through api.convert_area(), so an imported area is
  -- the same number the application would have computed.
  PERFORM test.eq((SELECT total_area::numeric FROM lms.survey WHERE survey_no = '771'),
                  2.0000::numeric, '16 kanal was converted to exactly 2 acres');
  PERFORM test.eq((SELECT total_area::numeric FROM lms.survey WHERE survey_no = '772'),
                  5.2500::numeric, 'an area already in acres is unchanged');
  PERFORM test.eq((SELECT total_area::numeric FROM lms.survey WHERE survey_no = '776'),
                  1.0000::numeric, '2 bigha was converted using the provisional factor');
  PERFORM test.eq((SELECT status_code FROM lms.survey WHERE survey_no = '771'), 'Proposed',
                  'an imported parcel starts as Proposed, not as held');
END $$;

-- ---------- promotion is an approval ----------
DO $$
DECLARE fx record; v_batch uuid;
BEGIN
  PERFORM test.become('sradmin');
  SELECT * INTO fx FROM test.fixtures;
  INSERT INTO lms.import_batch (code, target_entity, province_code, source_file,
                                source_sha256, uploaded_by, status)
  VALUES (lms.next_code('IMP-'), 'landowner', 'SND', 'tiny.csv',
          sha256('tiny.csv'::bytea), fx.u_admin, 'staged')
  RETURNING id INTO v_batch;
  INSERT INTO lms.import_row (batch_id, source_line, raw)
  VALUES (v_batch, 1, '{"full_name":"Only Row","father_name":"Someone",
                        "cnic":"45102-4444444-4","iban":"PK24HABB0000044000440044"}'::jsonb);
  PERFORM api.validate_import_batch(v_batch);

  PERFORM test.become('lofield');
  PERFORM test.throws_like(
    format($q$ SELECT api.promote_import_batch(%L) $q$, v_batch),
    '%import:update%',
    'a data-entry account cannot promote an import into the live register');

  PERFORM test.become('mland');
  PERFORM test.eq(api.promote_import_batch(v_batch), 1,
                  'an Approver can');
END $$;
