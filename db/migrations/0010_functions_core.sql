-- =====================================================================
-- 0010  Core routines: actor context, authorisation helpers, record codes,
--       unit conversion, case totals
-- =====================================================================
-- Every function here sets its own search_path explicitly. Without that, a
-- caller who can create objects in a schema earlier on their own search_path
-- could shadow a function or operator this body relies on — the classic
-- search_path hijack. The setting is on the function, not on the session, so
-- it holds however the function is reached.
SET ROLE lms_owner;

-- ---------------------------------------------------------------------
-- api.set_actor — the first statement of every application transaction.
--
-- SET LOCAL, not SET: the value is discarded at the end of the transaction, so
-- a pooled connection cannot carry one request's identity into the next. The
-- function also refuses a suspended or unknown account, so a stale user id in
-- an application session cannot keep writing.
-- ---------------------------------------------------------------------
CREATE FUNCTION api.set_actor(p_user_id uuid) RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_status text;
BEGIN
  SELECT status INTO v_status FROM lms.app_user WHERE id = p_user_id;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'unknown application user %', p_user_id
      USING ERRCODE = 'invalid_authorization_specification';
  END IF;
  IF v_status <> 'Active' THEN
    RAISE EXCEPTION 'application user % is %', p_user_id, v_status
      USING ERRCODE = 'invalid_authorization_specification';
  END IF;
  PERFORM set_config('lms.actor_id', p_user_id::text, true);  -- true = transaction-local
END $$;
COMMENT ON FUNCTION api.set_actor(uuid) IS
  'SECURITY DEFINER: it must read lms.app_user, which the application role '
  'cannot select from directly (the account table is not application-readable '
  'outside the api views). search_path is pinned and the only parameter is a '
  'uuid, so there is no injection surface. It grants nothing beyond setting a '
  'transaction-local string and validating that the account exists and is active.';

-- ---------------------------------------------------------------------
-- Authorisation helpers. All three are SECURITY DEFINER for the same reason:
-- a row-level security policy on lms.survey has to ask which provinces the
-- actor may see, and that answer lives in lms.app_user_province, which is
-- itself protected. A SECURITY INVOKER helper would need the application role
-- to be able to read the whole access table, which is exactly what we are
-- trying to avoid; and a policy that queried a protected table directly would
-- recurse.
--
-- Each one takes no parameters, reads its input only from the validated actor
-- context, returns facts about that actor and nothing else, and has a pinned
-- search_path with schema-qualified references. There is no path by which a
-- caller can make one of them answer about a different actor.
-- ---------------------------------------------------------------------
CREATE FUNCTION lms.actor_provinces() RETURNS char(3)[]
  LANGUAGE sql STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT coalesce(array_agg(up.province_code ORDER BY up.province_code), '{}'::char(3)[])
  FROM lms.app_user_province up
  WHERE up.user_id = nullif(current_setting('lms.actor_id', true), '')::uuid;
$$;
COMMENT ON FUNCTION lms.actor_provinces() IS
  'The provinces the current actor may see. Returns an empty array when no '
  'actor is set, which denies everything rather than allowing it.';

CREATE FUNCTION lms.actor_role() RETURNS text
  LANGUAGE sql STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT u.role_code FROM lms.app_user u
  WHERE u.id = nullif(current_setting('lms.actor_id', true), '')::uuid;
$$;

CREATE FUNCTION lms.actor_groups() RETURNS text[]
  LANGUAGE sql STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT coalesce(array_agg(g.group_code ORDER BY g.group_code), '{}'::text[])
  FROM lms.app_user_group g
  WHERE g.user_id = nullif(current_setting('lms.actor_id', true), '')::uuid;
$$;

-- Does the actor have access to this province? The one predicate every
-- province-scoped policy is written in terms of.
CREATE FUNCTION lms.actor_can_see_province(p_province char(3)) RETURNS boolean
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT p_province IS NULL OR p_province = ANY (lms.actor_provinces());
$$;
COMMENT ON FUNCTION lms.actor_can_see_province(char) IS
  'SECURITY INVOKER: it only calls lms.actor_provinces(), which is the '
  'definer-rights function. Keeping the thin predicate invoker-rights limits '
  'how much runs with elevated privilege.';

-- ---------------------------------------------------------------------
-- Record codes. A user-facing code must never repeat, including across a
-- rolled-back transaction, so the counter is a PostgreSQL sequence (which is
-- deliberately non-transactional) rather than a row that would be rolled back
-- or would serialise every insert behind a lock.
--
-- Gaps are therefore expected and are documented as acceptable: AREA-000007
-- may not exist if the transaction that claimed it failed. A reused number
-- would be far worse than a missing one — two parcels with one code.
-- ---------------------------------------------------------------------
CREATE FUNCTION lms.next_code(p_prefix text) RETURNS lms.record_code
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE r record; v bigint;
BEGIN
  SELECT seq_name, pad_to INTO r FROM lms.code_sequence WHERE prefix = p_prefix;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no code sequence registered for prefix %', p_prefix
      USING ERRCODE = 'invalid_parameter_value',
            HINT = 'add a row to lms.code_sequence and create its sequence in a migration';
  END IF;
  -- format('%I') quotes the identifier: the sequence name comes from a table
  -- the application cannot write to, and is still quoted rather than trusted.
  EXECUTE format('SELECT nextval(%L)', 'lms.' || quote_ident(r.seq_name)) INTO v;
  RETURN (p_prefix || lpad(v::text, r.pad_to, '0'))::lms.record_code;
END $$;
COMMENT ON FUNCTION lms.next_code(text) IS
  'Next user-facing code for a prefix. Gaps are expected and acceptable; '
  'repeats are not. See docs/DATABASE_ENGINEERING_REPORT.md "Record codes".';

-- Year-stamped codes (CC-2026-0001, VCH-2026-00001). The year is part of the
-- prefix, so each year has its own sequence and the numbering restarts.
-- SECURITY DEFINER, and this one needs explaining: the first record of a new
-- year creates that year's sequence, which is DDL, and the application role
-- has none. Making the function invoker-rights would mean either granting the
-- application CREATE on the schema — far worse — or having the first case of
-- every January fail until someone ran a migration.
--
-- What keeps it safe: the only parameter that reaches an identifier is
-- p_stem, and it is not trusted. It must match a template already registered
-- in lms.code_sequence (which the application cannot write to), the derived
-- name is built by lowercasing and replacing, and it is still passed through
-- format(%I). A stem that is not registered raises before any DDL is reached.
CREATE FUNCTION lms.next_code_year(p_stem text, p_year integer DEFAULT NULL) RETURNS lms.record_code
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE y integer := coalesce(p_year, extract(year from current_date)::integer);
        pfx text; r record; v bigint; sq text;
BEGIN
  pfx := p_stem || '-' || y::text || '-';
  SELECT seq_name, pad_to INTO r FROM lms.code_sequence WHERE prefix = pfx;
  IF NOT FOUND THEN
    -- The first record of a new year creates that year's sequence. CREATE
    -- SEQUENCE is transactional, so two concurrent first-inserts cannot both
    -- create it: one waits and then finds it.
    SELECT seq_name, pad_to INTO r FROM lms.code_sequence WHERE prefix = p_stem || '-YYYY-';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'no year-code template registered for stem %', p_stem
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    sq := lower(replace(p_stem, '-', '_')) || '_' || y::text || '_seq';
    EXECUTE format('CREATE SEQUENCE IF NOT EXISTS lms.%I START WITH 1', sq);
    -- The runtime roles hold USAGE on the sequences that existed when the
    -- grants were applied; a sequence created later needs its own grant, or
    -- lms.next_code() would fail on it for the application.
    EXECUTE format('GRANT USAGE ON SEQUENCE lms.%I TO lms_readwrite', sq);
    INSERT INTO lms.code_sequence(prefix, seq_name, pad_to, note)
    VALUES (pfx, sq, r.pad_to, 'auto-created for year ' || y)
    ON CONFLICT (prefix) DO NOTHING;
    SELECT seq_name, pad_to INTO r FROM lms.code_sequence WHERE prefix = pfx;
  END IF;
  EXECUTE format('SELECT nextval(%L)', 'lms.' || quote_ident(r.seq_name)) INTO v;
  RETURN (pfx || lpad(v::text, r.pad_to, '0'))::lms.record_code;
END $$;

-- ---------------------------------------------------------------------
-- Unit conversion.
--
-- One routine, reading one versioned table, is the whole conversion story.
-- Nothing else in the schema or the application is allowed to hold a factor,
-- which is what makes a correction to the Jireb factor a single UPDATE rather
-- than a hunt through four provinces' worth of code.
--
-- Unconfirmed factors (Jireb, Bigha) raise unless the caller explicitly opts
-- in. A report that silently used a provisional factor would present a guess
-- as a measurement.
-- ---------------------------------------------------------------------
CREATE FUNCTION api.convert_area(
         p_value            numeric,
         p_from_unit        text,
         p_to_unit          text DEFAULT 'Acre',
         p_as_of            date DEFAULT current_date,
         p_allow_unconfirmed boolean DEFAULT false)
  RETURNS numeric
  LANGUAGE plpgsql STABLE
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE from_sqm numeric; to_sqm numeric; from_ok boolean; to_ok boolean;
BEGIN
  IF p_value IS NULL THEN RETURN NULL; END IF;
  IF p_value < 0 THEN
    RAISE EXCEPTION 'area cannot be negative: %', p_value
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT c.sqm_per_unit, c.is_confirmed INTO from_sqm, from_ok
  FROM lms.unit_conversion c
  WHERE c.unit_code = p_from_unit AND c.valid_range @> p_as_of;
  IF from_sqm IS NULL THEN
    RAISE EXCEPTION 'no conversion factor for unit % on %', p_from_unit, p_as_of
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT c.sqm_per_unit, c.is_confirmed INTO to_sqm, to_ok
  FROM lms.unit_conversion c
  WHERE c.unit_code = p_to_unit AND c.valid_range @> p_as_of;
  IF to_sqm IS NULL THEN
    RAISE EXCEPTION 'no conversion factor for unit % on %', p_to_unit, p_as_of
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF NOT (from_ok AND to_ok) AND NOT p_allow_unconfirmed THEN
    RAISE EXCEPTION 'conversion % -> % uses a factor that the client has not confirmed',
      p_from_unit, p_to_unit
      USING ERRCODE = 'raise_exception',
            HINT = 'pass p_allow_unconfirmed => true and label the result as provisional';
  END IF;

  -- Exact division in numeric, rounded once at the end. 6 decimal places on
  -- the intermediate keeps a chain of conversions stable.
  RETURN round(p_value * from_sqm / to_sqm, 6);
END $$;
COMMENT ON FUNCTION api.convert_area(numeric,text,text,date,boolean) IS
  'Convert between land units using the factor in force on p_as_of. Refuses '
  'an unconfirmed factor (Jireb, Bigha) unless the caller opts in.';

-- Acre-Ghunta, the form every Sindh report prints (40 ghunta = 1 acre).
CREATE FUNCTION api.acre_ghunta(p_acres numeric) RETURNS text
  LANGUAGE plpgsql IMMUTABLE
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE a integer; g numeric;
BEGIN
  IF p_acres IS NULL THEN RETURN NULL; END IF;
  a := floor(p_acres)::integer;
  g := round((p_acres - a) * 40, 2);
  IF g >= 40 THEN a := a + 1; g := g - 40; END IF;
  RETURN a::text || ' - ' || trim(trailing '.' from trim(trailing '0' from g::text));
END $$;
COMMENT ON FUNCTION api.acre_ghunta(numeric) IS
  'Acre-Ghunta display form. IMMUTABLE: 40 ghunta per acre is a definition, '
  'not a configurable factor, so this one does not read lms.unit_conversion.';

-- ---------------------------------------------------------------------
-- Case totals.
--
-- Returns the four component totals and the lease area from the line tables.
-- The rounding order is fixed and documented: each line is rounded to the
-- paisa (the crop and tree line amounts are generated columns that do exactly
-- that), then the lines are summed. Rounding after summing would give a
-- different total, and the application has to use the same order to agree with
-- the database to the paisa.
-- ---------------------------------------------------------------------
CREATE TYPE api.case_total AS (
  lease_area   numeric(14,4),
  lease_amount numeric(18,2),
  crop_amount  numeric(18,2),
  tree_amount  numeric(18,2),
  misc_amount  numeric(18,2),
  total_amount numeric(18,2)
);

CREATE FUNCTION api.case_totals(p_case_id uuid) RETURNS api.case_total
  LANGUAGE plpgsql STABLE
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE r api.case_total; v_rate numeric; v_term smallint; v_area numeric;
BEGIN
  SELECT c.lease_rate, c.lease_term_months INTO v_rate, v_term
  FROM lms.compensation_case c WHERE c.id = p_case_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such compensation case %', p_case_id USING ERRCODE = 'no_data_found';
  END IF;

  -- The area the lease amount is charged on is the subsequent (reduced) area
  -- where one has been recorded, otherwise the original.
  SELECT coalesce(sum(coalesce(l.subsequent_area, l.lease_area)), 0)
  INTO v_area FROM lms.case_lease_line l WHERE l.case_id = p_case_id;

  r.lease_area := round(v_area, 4);
  -- Rent is quoted per acre per year and the term is in months.
  r.lease_amount := round(coalesce(v_rate,0) * v_area * coalesce(v_term,0) / 12.0, 2);

  SELECT coalesce(sum(amount),0) INTO r.crop_amount FROM lms.case_crop_line WHERE case_id = p_case_id;
  SELECT coalesce(sum(amount),0) INTO r.tree_amount FROM lms.case_tree_line WHERE case_id = p_case_id;
  SELECT coalesce(sum(amount),0) INTO r.misc_amount FROM lms.case_misc_line WHERE case_id = p_case_id;

  r.total_amount := r.lease_amount + r.crop_amount + r.tree_amount + r.misc_amount;
  RETURN r;
END $$;
COMMENT ON FUNCTION api.case_totals(uuid) IS
  'The case totals computed from its line tables. Read-only; '
  'api.recalculate_case_totals() is what persists them.';

-- Persist the computed totals. Refuses to touch a case that is locked, because
-- the figure a payment was released against must not move afterwards.
CREATE FUNCTION api.recalculate_case_totals(p_case_id uuid) RETURNS api.case_total
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE t api.case_total; v_stage text; v_locked text;
BEGIN
  PERFORM util.require_actor();
  -- FOR UPDATE: two concurrent line edits must not both compute totals from
  -- their own view of the lines and then both write.
  SELECT c.stage_code, w.lock_at_stage INTO v_stage, v_locked
  FROM lms.compensation_case c
  JOIN lms.workflow w ON w.code = 'cases'
  WHERE c.id = p_case_id
  FOR UPDATE OF c;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such compensation case %', p_case_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_stage = v_locked OR v_stage IN ('Cancelled','Stopped') THEN
    RAISE EXCEPTION 'compensation case % is % and its totals are fixed', p_case_id, v_stage
      USING ERRCODE = 'raise_exception';
  END IF;

  t := api.case_totals(p_case_id);
  UPDATE lms.compensation_case SET
    total_lease_area   = t.lease_area,
    total_lease_amount = t.lease_amount,
    total_crop_amount  = t.crop_amount,
    total_tree_amount  = t.tree_amount,
    total_misc_amount  = t.misc_amount
  WHERE id = p_case_id;
  RETURN t;
END $$;

-- ---------------------------------------------------------------------
-- Ownership-share validation, as a callable check rather than only a trigger,
-- so a screen can warn before a save instead of only failing at COMMIT.
-- ---------------------------------------------------------------------
CREATE FUNCTION api.ownership_share_total(p_survey_id uuid) RETURNS numeric
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT coalesce(sum(s.share_pct), 0)::numeric(9,4)
  FROM lms.survey_ownership_share s WHERE s.survey_id = p_survey_id;
$$;

CREATE FUNCTION api.validate_ownership_shares(p_survey_id uuid)
  RETURNS TABLE (survey_code lms.record_code, share_total numeric, is_valid boolean, detail text)
  LANGUAGE plpgsql STABLE
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_total numeric; v_code lms.record_code;
BEGIN
  SELECT s.code INTO v_code FROM lms.survey s WHERE s.id = p_survey_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such survey %', p_survey_id USING ERRCODE = 'no_data_found';
  END IF;
  v_total := api.ownership_share_total(p_survey_id);
  RETURN QUERY SELECT v_code, v_total::numeric, v_total <= 100,
    CASE WHEN v_total > 100 THEN format('shares total %s%%, which exceeds 100%%', v_total)
         WHEN v_total = 100 THEN 'fully apportioned'
         WHEN v_total = 0   THEN 'no ownership recorded'
         ELSE format('%s%% apportioned, %s%% unrecorded', v_total, 100 - v_total)
    END;
END $$;
COMMENT ON FUNCTION api.validate_ownership_shares(uuid) IS
  'Reports the share position of a parcel. A total under 100% is a warning, '
  'not an error: revenue records are often incomplete. Over 100% is an error '
  'and is also refused at COMMIT by the constraint trigger.';

-- Area validation: the leased area on a parcel across all live cases may not
-- exceed the parcel itself.
CREATE FUNCTION api.validate_survey_area(p_survey_id uuid)
  RETURNS TABLE (survey_code lms.record_code, total_area numeric, committed_area numeric,
                 is_valid boolean, detail text)
  LANGUAGE plpgsql STABLE
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v record; v_committed numeric;
BEGIN
  SELECT s.code, s.total_area INTO v FROM lms.survey s WHERE s.id = p_survey_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such survey %', p_survey_id USING ERRCODE = 'no_data_found';
  END IF;
  SELECT coalesce(sum(coalesce(l.subsequent_area, l.lease_area)), 0)
  INTO v_committed
  FROM lms.case_lease_line l
  JOIN lms.compensation_case c ON c.id = l.case_id
  WHERE l.survey_id = p_survey_id AND c.stage_code NOT IN ('Cancelled','Stopped');

  -- The explicit cast matters: v.total_area is the lms.area_acres domain and
  -- the declared return column is a bare numeric, which RETURN QUERY will not
  -- coerce for you.
  RETURN QUERY SELECT v.code, v.total_area::numeric, round(v_committed,4),
    v_committed <= v.total_area + 0.0001,
    CASE WHEN v_committed > v.total_area + 0.0001
         THEN format('%s acres committed across live cases on a %s acre parcel', v_committed, v.total_area)
         ELSE format('%s of %s acres committed', v_committed, v.total_area) END;
END $$;
