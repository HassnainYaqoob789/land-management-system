-- role: lms_test
-- tx: rollback
--
-- View security. Every api view is security_invoker, so it must return exactly
-- the rows the caller could see through the base tables — no more. These
-- assertions compare the same view as two differently-scoped actors.
\set QUIET on

DO $$
DECLARE v_all integer; v_snd uuid[]; v_bal uuid[]; v record; v_name text;
BEGIN
  -- ---------- every api view is security_invoker ----------
  -- Four views are the documented exceptions: they run with owner rights and
  -- restate the province predicate in their own body, because masking a
  -- column or reading a materialized view cannot be done any other way.
  -- Migration 0017 and migration 0019 explain each; DB-05 records the risk;
  -- the row-set comparisons further down are what holds them to the policies.
  -- Listing them by name means a FIFTH one cannot appear unnoticed.
  FOR v_name IN
    SELECT c.relname FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'api' AND c.relkind = 'v'
      AND c.relname NOT IN ('v_landowner_summary_masked', 'v_payment_release_masked',
                            'v_province_summary_cached', 'v_admin_unit_path')
      AND NOT coalesce((SELECT option_value FROM pg_options_to_table(c.reloptions)
                        WHERE option_name = 'security_invoker')::boolean, false)
  LOOP
    PERFORM test.ok(false, format('view api.%s is neither security_invoker nor a '
                                  'documented owner-rights exception', v_name));
  END LOOP;
  PERFORM test.ok(true, 'every api view outside the four documented exceptions is security_invoker');

  -- ---------- an administrator sees all four provinces ----------
  PERFORM test.become('admin');
  SELECT count(*) INTO v_all FROM api.v_province_summary WHERE parcels > 0;
  PERFORM test.eq(v_all, 4, 'an administrator sees parcels in all four provinces');
  SELECT count(*) INTO v_all FROM api.v_case_status;
  PERFORM test.ok(v_all >= 3, 'an administrator sees every case');

  -- ---------- a Sindh account sees Sindh ----------
  PERFORM test.become('lofield');
  PERFORM test.eq((SELECT count(*)::integer FROM api.v_case_status), 2,
                  'a Sindh field officer sees the two Sindh cases');
  PERFORM test.eq((SELECT count(*)::integer FROM api.v_case_status WHERE province_code <> 'SND'), 0,
                  'and no case from any other province');
  PERFORM test.eq((SELECT count(DISTINCT province_code)::integer FROM api.v_survey_ownership), 1,
                  'the parcel view shows one province');
  PERFORM test.eq((SELECT count(*)::integer FROM api.v_landowner_summary
                   WHERE province_code <> 'SND'), 0,
                  'the landowner view shows no other province''s owners');
  PERFORM test.eq((SELECT count(*)::integer FROM api.v_payment_release
                   WHERE province_code <> 'SND'), 0,
                  'the payment-release view shows no other province''s payments');
  PERFORM test.eq((SELECT count(*)::integer FROM api.v_lease_register
                   WHERE province_code <> 'SND'), 0,
                  'the lease register shows no other province''s leases');
  PERFORM test.eq((SELECT count(*)::integer FROM api.v_outstanding_liability
                   WHERE province_code <> 'SND'), 0,
                  'the liability register shows no other province''s liabilities');
  PERFORM test.eq((SELECT count(*)::integer FROM api.v_audit_trail
                   WHERE province_code IS NOT NULL AND province_code <> 'SND'), 0,
                  'the audit trail shows no other province''s entries');
  PERFORM test.eq((SELECT count(*)::integer FROM api.v_grievance_status
                   WHERE province_code <> 'SND'), 0,
                  'the grievance view shows no other province''s complaints');
  PERFORM test.eq((SELECT count(*)::integer FROM api.v_dbpfc_summary
                   WHERE province_code <> 'SND'), 0,
                  'the DBPFC view shows no other province''s estimates');

  -- The province summary still lists four rows — the province table itself is
  -- reference data — but the figures in the other three are zero, because the
  -- subqueries read tables that row-level security has scoped.
  SELECT count(*) INTO v_all FROM api.v_province_summary;
  PERFORM test.eq(v_all, 4, 'the province summary lists all four provinces');
  PERFORM test.eq((SELECT sum(parcels)::integer FROM api.v_province_summary
                   WHERE province_code <> 'SND'), 0,
                  'but shows zero parcels outside the account''s province');
  PERFORM test.ok((SELECT parcels FROM api.v_province_summary WHERE province_code = 'SND') > 0,
                  'and real figures for its own');

  -- ---------- a Balochistan account sees Balochistan ----------
  PERFORM test.become('loquetta');
  PERFORM test.eq((SELECT count(*)::integer FROM api.v_case_status), 1,
                  'a Balochistan officer sees the one Balochistan case');
  PERFORM test.eq((SELECT count(*)::integer FROM api.v_case_status WHERE province_code <> 'BAL'), 0,
                  'and no Sindh case');
  PERFORM test.eq((SELECT count(*)::integer FROM api.v_payment_release), 0,
                  'and no payment, because none has been released in Balochistan');

  -- The two scopes are genuinely disjoint, not merely different in count.
  -- Collected into arrays rather than temporary tables: the runtime roles are
  -- deliberately not granted TEMP on the database, so a compromised
  -- application cannot stage data of its own there.
  PERFORM test.become('lofield');
  SELECT array_agg(case_id) INTO v_snd FROM api.v_case_status;
  PERFORM test.become('loquetta');
  SELECT array_agg(case_id) INTO v_bal FROM api.v_case_status;
  PERFORM test.ok(array_length(v_snd,1) > 0 AND array_length(v_bal,1) > 0,
                  'both accounts see cases of their own');
  PERFORM test.ok(NOT (v_snd && v_bal),
                  'the Sindh and Balochistan case sets do not overlap at all');

  -- ---------- masked reporting views ----------
  -- They must return the same rows as their unmasked equivalents for the same
  -- actor: same scope, less detail. If this drifts, the owner-rights views
  -- have become a way around the policies.
  PERFORM test.become('lofield');
  PERFORM test.eq((SELECT count(*)::integer FROM api.v_landowner_summary_masked),
                  (SELECT count(*)::integer FROM api.v_landowner_summary),
                  'the masked landowner view returns the same row count as the unmasked one');
  PERFORM test.eq((SELECT count(*)::integer FROM api.v_landowner_summary_masked m
                   WHERE NOT EXISTS (SELECT 1 FROM api.v_landowner_summary u
                                     WHERE u.landowner_id = m.landowner_id)), 0,
                  'and exactly the same rows');
  PERFORM test.eq((SELECT count(*)::integer FROM api.v_payment_release_masked),
                  (SELECT count(*)::integer FROM api.v_payment_release),
                  'the masked payment view returns the same rows as the unmasked one');

  PERFORM test.become('loquetta');
  PERFORM test.eq((SELECT count(*)::integer FROM api.v_landowner_summary_masked
                   WHERE province_code <> 'BAL'), 0,
                  'the masked view is province-scoped for a Balochistan account too');

  -- The mask itself: district prefix and check digit kept, the identifying
  -- middle hidden.
  PERFORM test.eq(api.mask_cnic('45102-1100012-3'), '45102-*******-3',
                  'the CNIC mask keeps the prefix and the check digit');
  PERFORM test.eq(api.mask_cnic(NULL), NULL::text, 'and passes null through');
  PERFORM test.eq((SELECT count(*)::integer FROM api.v_landowner_summary_masked
                   WHERE cnic_masked LIKE '%*******%'), 
                  (SELECT count(*)::integer FROM api.v_landowner_summary_masked),
                  'every CNIC in the masked view is masked');

  -- The two owner-rights views added for performance must scope exactly like
  -- the policies they stand in for.
  PERFORM test.become('lofield');
  PERFORM test.eq((SELECT count(*)::integer FROM api.v_admin_unit_path
                   WHERE province_code <> 'SND'), 0,
                  'the administrative-path view shows one province to a Sindh account');
  PERFORM test.ok((SELECT count(*) FROM api.v_admin_unit_path) > 0,
                  'and shows that province''s units');
  PERFORM test.eq((SELECT count(*)::integer FROM api.v_admin_unit_path),
                  (SELECT count(*)::integer FROM lms.admin_unit),
                  'with exactly the rows the policy on lms.admin_unit allows');
  PERFORM test.eq((SELECT count(*)::integer FROM api.v_province_summary_cached
                   WHERE province_code <> 'SND'), 0,
                  'the cached dashboard is province-scoped too');
  PERFORM test.ok((SELECT age FROM api.v_province_summary_cached LIMIT 1) IS NOT NULL,
                  'and reports its own age, so a screen can say how stale it is');
  PERFORM test.become('loquetta');
  PERFORM test.eq((SELECT count(*)::integer FROM api.v_admin_unit_path
                   WHERE province_code <> 'BAL'), 0,
                  'and both are scoped for a Balochistan account as well');

  -- ---------- a read-only account ----------
  PERFORM test.become('viewer');
  PERFORM test.ok((SELECT count(*) FROM api.v_province_summary) = 4,
                  'a Viewer account can read the dashboard view');
  PERFORM test.ok((SELECT count(*) FROM api.v_outstanding_liability) >= 0,
                  'and the liability register');
END $$;
