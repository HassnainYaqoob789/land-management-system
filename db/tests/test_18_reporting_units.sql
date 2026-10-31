-- role: lms_test
-- tx: rollback
-- actor: lofield
--
-- 0040: one source of unit conversion, provincial reporting units, recorded
-- survey areas, and who can see and share report templates.
\set QUIET on

DO $$
DECLARE
  v_lofield uuid; v_mland uuid; v_viewer uuid; v_unit uuid; v_s uuid; v_t uuid; v_u record; v_n integer;
BEGIN
  -- Ids through test.become (row-level security hides other accounts from a user); end as lofield.
  v_mland := test.become('mland'); v_viewer := test.become('viewer'); v_lofield := test.become('lofield');

  -- ---------- conversion ----------
  PERFORM test.eq(lms.uom_convert(1, 'Acre', 'Kanal'), 8::numeric, '1 acre = 8 kanal');
  PERFORM test.eq(lms.uom_convert(40, 'Ghunta', 'Acre'), 1::numeric, '40 ghunta = 1 acre');
  PERFORM test.eq(lms.uom_convert(160, 'marla', 'acre'), 1::numeric, 'aliases and case are accepted');
  PERFORM test.eq(round(lms.uom_convert(1, 'Hectare', 'Acre'), 6), 2.471054::numeric, '1 hectare = 2.471054 acres');
  PERFORM test.ok(lms.uom_convert(1, 'Acre', 'Furlong') IS NULL, 'an unknown unit converts to NULL, never a guess');
  PERFORM test.ok(lms.uom_convert(NULL, 'Acre', 'Kanal') IS NULL, 'a missing value stays missing');
  PERFORM test.eq((SELECT confirmed FROM lms.uom_factor('Bigha')), false, 'the Bigha factor is flagged provisional');
  PERFORM test.eq(lms.convert_area(2, 'bigha', 'acre'), 1.0000::numeric, 'convert_area now knows Bigha (it used to raise)');
  -- convert_area and uom_convert must agree for every unit in the table.
  FOR v_u IN SELECT unit_code FROM lms.unit_conversion WHERE valid_range @> current_date LOOP
    PERFORM test.eq(lms.convert_area(10, v_u.unit_code, 'Acre'), round(lms.uom_convert(10, v_u.unit_code, 'Acre'), 4),
                    'one source of factors: ' || v_u.unit_code);
  END LOOP;
  PERFORM test.throws($q$ SELECT lms.convert_area(1, 'Furlong', 'Acre') $q$, NULL, 'convert_area still refuses an unknown unit');

  -- ---------- provincial reporting units ----------
  PERFORM test.eq(lms.report_unit('PNJ'), 'Kanal', 'Punjab reports in kanals');
  PERFORM test.eq(lms.report_unit('SND', 'Government'), 'Acre', 'no land-class row: the province row applies');
  PERFORM test.eq(lms.report_unit('XYZ'), 'Acre', 'no row at all: the primary unit (acre)');
  PERFORM test.throws($q$ INSERT INTO lms.report_unit_default (province_code, land_class, unit_code) VALUES ('SND', 'Government', 'Hectare') $q$,
                      '42501', 'changing reporting units needs settings:update');

  -- ---------- recorded survey area ----------
  SELECT id INTO v_unit FROM lms.admin_unit WHERE province_code = 'SND' ORDER BY level DESC LIMIT 1;
  INSERT INTO lms.survey (code, province_code, admin_unit_id, survey_no, land_class, total_area, recorded_area, recorded_unit, status_code)
  VALUES ('UOM-TEST-0001', 'SND', v_unit, 'UOM-TEST-1', 'Private', 0.0001, 80, 'Ghunta', 'Proposed')
  RETURNING id INTO v_s;
  PERFORM test.eq((SELECT total_area::numeric FROM lms.survey WHERE id = v_s), 2.0000::numeric, 'total_area is derived from the recorded 80 ghunta');
  PERFORM test.throws($q$ UPDATE lms.survey SET recorded_unit = NULL WHERE survey_no = 'UOM-TEST-1' $q$, '23514',
                      'a recorded area needs its unit');

  -- ---------- templates ----------
  INSERT INTO lms.report_template (name, dataset, config, owner_id)
  VALUES ('My cases', 'cases', '{"columns":["case_code"]}', v_lofield) RETURNING id INTO v_t;
  PERFORM test.throws($q$ INSERT INTO lms.report_template (name, dataset, config, owner_id, visibility)
                         SELECT 'Shared by me', 'cases', '{}'::jsonb, id, 'shared' FROM lms.app_user WHERE username = 'lofield' $q$,
                      '42501', 'sharing a template needs reports:share');
  PERFORM test.throws(format($q$ INSERT INTO lms.report_template (name, dataset, config, owner_id) VALUES ('Not mine', 'cases', '{}', %L) $q$, v_mland),
                      '42501', 'nobody can create a template in someone else''s name');

  PERFORM api.set_actor(v_viewer);
  PERFORM test.eq((SELECT count(*) FROM lms.report_template WHERE id = v_t)::int, 0, 'a private template is invisible to others');

  PERFORM api.set_actor(v_mland);
  INSERT INTO lms.report_template (name, dataset, config, owner_id, visibility)
  VALUES ('Province liabilities', 'cases', '{"columns":["case_code"]}', v_mland, 'shared');
  PERFORM api.set_actor(v_lofield);
  PERFORM test.eq((SELECT count(*) FROM lms.report_template WHERE name = 'Province liabilities')::int, 1,
                  'a shared template is visible to colleagues who can read reports');
  UPDATE lms.report_template SET name = 'hijacked' WHERE name = 'Province liabilities';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM test.eq(v_n, 0, 'and cannot be edited by them');
  PERFORM test.throws(format($q$ UPDATE lms.report_template SET owner_id = %L WHERE id = %L $q$, v_mland, v_t),
                      NULL, 'a template cannot change owner');

  -- ---------- export jobs are private ----------
  INSERT INTO lms.report_export_job (requested_by, dataset, config, format) VALUES (v_lofield, 'cases', '{}', 'csv');
  PERFORM api.set_actor(v_mland);
  PERFORM test.eq((SELECT count(*) FROM lms.report_export_job WHERE requested_by = v_lofield)::int, 0,
                  'an export job is visible only to the person who asked for it');
END $$;
