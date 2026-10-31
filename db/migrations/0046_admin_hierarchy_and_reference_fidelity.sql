-- =====================================================================
-- 0046  Administrative hierarchy and reference-data fidelity
-- =====================================================================
-- Closes the master-data gaps of docs/requirements/GAP_LIST.md REQ-01,
-- REQ-27, REQ-28, REQ-29 and the database half of REQ-83..88:
--
-- 1. Division tier (REQ-01, REQ-29). The client's hierarchy (PPSX slides
--    7-8) starts every Pakistani province at Division. lms.admin_unit keeps
--    depth 0 = District, because projects, DBPFC estimates, the path
--    materialized view, the reporting lineage view and the application all
--    read "level 0" as the district. Divisions therefore live in their own
--    master, lms.admin_division, and a district (level 0 only) points at its
--    division through the new, nullable admin_unit.division_id. Nothing that
--    resolves today stops resolving. api.v_province_hierarchy lists every
--    province's tiers in the client's order, Division included.
--
-- 2. Balochistan and Khyber Pakhtunkhwa tier order (REQ-01). The slides give
--    District → Tehsil → Sub-Division; 0015 stored District → Sub-Division →
--    Tehsil. The level labels are swapped and the existing units re-parented
--    so every row keeps its id, code and references: a Tehsil moves up under
--    its district and its former Sub-Division moves under it. A Sub-Division
--    that held several Tehsils is copied once per extra Tehsil (a new row;
--    nothing is deleted). The step refuses — and the migration fails, leaving
--    the database untouched — when a Sub-Division has no Tehsil, when one
--    that must be split is referenced by a survey, or when two Tehsils of a
--    district share a name. Sindh and Punjab already match the slides.
--
-- 3. Province unit sets exactly as the client's reference (REQ-27; slide 3,
--    slide 4 / "Measurement Units.jpg"): Sindh Acre/Ghunta/Sq Ft; Balochistan
--    Acre/Rod/Pole/Sq Ft; Punjab and KPK Acre/Kanal/Marla/Sq Ft. The two
--    prototype extras (Sindh Jireb, KPK Bigha) leave the province sets unless
--    a survey of that province recorded its area in them. Factors stay in
--    lms.unit_conversion, unchanged. Slide 5's "Pole / Marla" row contradicts
--    the rest of its own table (see the note written on those factors); the
--    factor the rest of the table supports is kept and the conflict is
--    flagged for the client rather than resolved by guesswork.
--
-- 4. Acre–Ghunta helpers for Sindh (REQ-28, REQ-30): lms.acre_ghunta_to_acres
--    and lms.format_acre_ghunta ("13 Acre(s) - 22 Ghunta(s)"), both reading
--    the ghunta factor from lms.unit_conversion.
--
-- 5. Legacy CSV staging (REQ-83..88). The historical CSVs are staged through
--    the existing import tables (lms.import_batch / import_row /
--    import_validation_error) under target entities named legacy_*, which
--    the application's own import routines do not promote. The rules live
--    here so they are tested in SQL: lms.legacy_row_check (one row) and
--    lms.stage_legacy_batch (a whole batch, plus in-file duplicates, shared
--    CNICs and incomplete lease groups). A row that lacks a mandatory field
--    is held as an exception — no CNIC, rate, date, area or geometry is
--    invented. A placeholder CNIC (system setting migration.placeholder_cnics)
--    can no longer enter the landowner register at all.
--
-- International jurisdiction (REQ-25) is NOT added here: a fifth province row
-- would change reference data that db/tests/test_16_migration.py pins at four
-- provinces, and every province-keyed rule (withholding tax, approval matrix,
-- DBPFC) would need an International definition first.
SET ROLE lms_owner;
SELECT set_config('lms.actor_id', '00000000-0000-0000-0000-000000000001', true);
SELECT set_config('lms.change_note', '0046: administrative hierarchy per PPSX slides 7-8; unit sets per slide 3', true);

-- ---------------------------------------------------------------------
-- 1. Division tier
-- ---------------------------------------------------------------------
ALTER TABLE lms.province
  ADD COLUMN division_label text CHECK (division_label IS NULL OR btrim(division_label) <> '');
COMMENT ON COLUMN lms.province.division_label IS
  'Name of the tier above District (lms.admin_division), NULL when the jurisdiction has none. PPSX slides 7-8.';
UPDATE lms.province SET division_label = 'Division' WHERE code IN ('SND','BAL','PNJ','KPK');

CREATE TABLE lms.admin_division (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          lms.record_code NOT NULL UNIQUE,
  province_code char(3) NOT NULL REFERENCES lms.province(code) ON DELETE RESTRICT,
  name          text NOT NULL CHECK (btrim(name) <> ''),
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  version       integer NOT NULL DEFAULT 1,
  CONSTRAINT admin_division_id_province_uq UNIQUE (id, province_code),
  CONSTRAINT admin_division_name_uq UNIQUE (province_code, name)
);
COMMENT ON TABLE lms.admin_division IS
  'Divisions: the tier above District (PPSX slides 7-8). Kept apart from lms.admin_unit so that '
  'admin_unit level 0 stays the district every existing rule and screen relies on.';

ALTER TABLE lms.admin_division ENABLE ROW LEVEL SECURITY;
CREATE POLICY province_scope ON lms.admin_division TO lms_readwrite, lms_readonly
  USING (((SELECT lms.actor_role()) = 'Admin') OR (province_code = ANY ((SELECT lms.actor_provinces())::bpchar[])))
  WITH CHECK (((SELECT lms.actor_role()) = 'Admin') OR (province_code = ANY ((SELECT lms.actor_provinces())::bpchar[])));
REVOKE ALL ON lms.admin_division FROM PUBLIC;
GRANT SELECT ON lms.admin_division TO lms_readwrite, lms_readonly;
GRANT INSERT, UPDATE ON lms.admin_division TO lms_readwrite;
CREATE TRIGGER admin_division_audit AFTER INSERT OR UPDATE OR DELETE ON lms.admin_division
  FOR EACH ROW EXECUTE FUNCTION audit.tg_audit_row();
CREATE TRIGGER admin_division_stamp_created BEFORE INSERT ON lms.admin_division
  FOR EACH ROW EXECUTE FUNCTION lms.tg_stamp_created();
CREATE TRIGGER admin_division_touch_version BEFORE UPDATE ON lms.admin_division
  FOR EACH ROW EXECUTE FUNCTION lms.tg_touch_version();

ALTER TABLE lms.admin_unit
  ADD COLUMN division_id uuid,
  ADD CONSTRAINT admin_unit_division_fk FOREIGN KEY (division_id, province_code)
    REFERENCES lms.admin_division(id, province_code) ON DELETE RESTRICT,
  ADD CONSTRAINT admin_unit_division_district_ck CHECK (division_id IS NULL OR level = 0);
CREATE INDEX admin_unit_division_idx ON lms.admin_unit (division_id) WHERE division_id IS NOT NULL;
COMMENT ON COLUMN lms.admin_unit.division_id IS
  'The division of a district (level 0 only), same province. NULL until Land Affairs assigns it; '
  'the source CSVs carry no division, so none is guessed.';

-- The client's tiers per province, in the client's order (slides 7-8).
CREATE VIEW api.v_province_hierarchy WITH (security_invoker = true) AS
SELECT p.code AS province_code, p.name AS province_name, 1::smallint AS ordinal,
       p.division_label AS tier_name, NULL::smallint AS depth, 'admin_division'::text AS stored_in
FROM lms.province p
WHERE p.division_label IS NOT NULL
UNION ALL
SELECT l.province_code, p.name,
       (l.depth + CASE WHEN p.division_label IS NULL THEN 1 ELSE 2 END)::smallint,
       l.name, l.depth, 'admin_unit'
FROM lms.province_level l
JOIN lms.province p ON p.code = l.province_code;
COMMENT ON VIEW api.v_province_hierarchy IS
  'Administrative tiers per province in the client''s order (PPSX slides 7-8). depth is '
  'lms.admin_unit.level for the tiers stored there; the Division tier is lms.admin_division.';
REVOKE ALL ON api.v_province_hierarchy FROM PUBLIC;
GRANT SELECT ON api.v_province_hierarchy TO lms_readwrite, lms_readonly;

-- ---------------------------------------------------------------------
-- 2. Balochistan / KPK: District → Tehsil → Sub-Division (slides 7-8)
-- ---------------------------------------------------------------------
-- 2a. Labels. admin_unit references (province_code, depth), not the name,
--     so relabelling cannot orphan a row.
CREATE TEMP TABLE _au_relabel ON COMMIT DROP AS
SELECT l1.province_code
FROM lms.province_level l1
JOIN lms.province_level l2 ON l2.province_code = l1.province_code AND l2.depth = 2
WHERE l1.province_code IN ('BAL','KPK') AND l1.depth = 1
  AND l1.name = 'Sub-Division' AND l2.name = 'Tehsil';

UPDATE lms.province_level SET name = '~0046~' WHERE depth = 1 AND province_code IN (SELECT province_code FROM _au_relabel);
UPDATE lms.province_level SET name = 'Sub-Division' WHERE depth = 2 AND province_code IN (SELECT province_code FROM _au_relabel);
UPDATE lms.province_level SET name = 'Tehsil' WHERE depth = 1 AND province_code IN (SELECT province_code FROM _au_relabel);

-- 2b. Code prefixes for every tier of the four provinces (and their
--     divisions), as 0015 builds them. A sequence starts past any code that
--     already uses its prefix, so a generated code cannot collide.
DO $$
DECLARE l record; pfx text; sq text; v_max bigint;
BEGIN
  FOR l IN
    SELECT province_code, depth, name FROM lms.province_level WHERE province_code IN ('SND','BAL','PNJ','KPK')
    UNION ALL
    SELECT code, NULL, 'Division' FROM lms.province WHERE code IN ('SND','BAL','PNJ','KPK')
    ORDER BY 1, 2 NULLS FIRST
  LOOP
    pfx := l.province_code || '-' || upper(substr(regexp_replace(l.name, '[^A-Za-z]', '', 'g'), 1, 3))
           || coalesce(l.depth::text, '') || '-';
    sq  := lower(replace(pfx, '-', '_')) || 'seq';
    EXECUTE format('CREATE SEQUENCE IF NOT EXISTS lms.%I START WITH 1', sq);
    EXECUTE format('GRANT USAGE ON SEQUENCE lms.%I TO lms_readwrite', sq);
    INSERT INTO lms.code_sequence (prefix, seq_name, pad_to, note)
    VALUES (pfx, sq, 3, l.province_code || ' ' || l.name)
    ON CONFLICT (prefix) DO NOTHING;
    SELECT max(substr(c.code::text, length(pfx) + 1)::bigint) INTO v_max
    FROM (SELECT code FROM lms.admin_unit UNION ALL SELECT code FROM lms.admin_division) c
    WHERE c.code::text LIKE pfx || '%' AND substr(c.code::text, length(pfx) + 1) ~ '^[0-9]{1,15}$';
    IF v_max > 0 THEN
      PERFORM setval(format('lms.%I', sq)::regclass, v_max, true);
    END IF;
  END LOOP;
END $$;

-- 2c. Re-parent the units that already exist.
DO $$
DECLARE v_bad text; v_moved integer; v_row record; v_new_id uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM _au_relabel) THEN RETURN; END IF;

  SELECT string_agg(s.code::text || ' "' || s.name || '"', ', ' ORDER BY s.code) INTO v_bad
  FROM lms.admin_unit s
  WHERE s.province_code IN (SELECT province_code FROM _au_relabel) AND s.level = 1
    AND NOT EXISTS (SELECT 1 FROM lms.admin_unit t WHERE t.parent_id = s.id);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'cannot reorder the hierarchy: Sub-Division(s) % hold no Tehsil, so there is no Tehsil to place them under', v_bad
      USING ERRCODE = 'object_not_in_prerequisite_state',
            HINT = 'Add the Tehsil each belongs to (as a level-2 unit under it) and run the migration again.';
  END IF;

  SELECT string_agg(s.code::text || ' "' || s.name || '"', ', ' ORDER BY s.code) INTO v_bad
  FROM lms.admin_unit s
  WHERE s.province_code IN (SELECT province_code FROM _au_relabel) AND s.level = 1
    AND (SELECT count(*) FROM lms.admin_unit t WHERE t.parent_id = s.id) > 1
    AND EXISTS (SELECT 1 FROM lms.survey sv WHERE sv.admin_unit_id = s.id);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'cannot reorder the hierarchy: Sub-Division(s) % span several Tehsils and are referenced by surveys directly', v_bad
      USING ERRCODE = 'object_not_in_prerequisite_state',
            HINT = 'Move those surveys to their Mouza first; a split Sub-Division cannot tell which copy they belong to.';
  END IF;

  SELECT string_agg(x, '; ') INTO v_bad FROM (
    SELECT d.code::text || ' "' || t.name || '"' AS x
    FROM lms.admin_unit t
    JOIN lms.admin_unit s ON s.id = t.parent_id
    JOIN lms.admin_unit d ON d.id = s.parent_id
    WHERE t.province_code IN (SELECT province_code FROM _au_relabel) AND t.level = 2
    GROUP BY d.code, t.name HAVING count(*) > 1) z;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'cannot reorder the hierarchy: district/Tehsil name pairs % occur under more than one Sub-Division', v_bad
      USING ERRCODE = 'object_not_in_prerequisite_state',
            HINT = 'Merge or rename the duplicate Tehsils first.';
  END IF;

  CREATE TEMP TABLE _au_swap ON COMMIT DROP AS
  SELECT t.province_code, t.id AS tehsil_id, s.id AS subdiv_id, s.parent_id AS district_id, s.name AS subdiv_name,
         row_number() OVER (PARTITION BY s.id ORDER BY t.code) AS rn, s.id AS target_id
  FROM lms.admin_unit t JOIN lms.admin_unit s ON s.id = t.parent_id
  WHERE t.province_code IN (SELECT province_code FROM _au_relabel) AND t.level = 2;
  GET DIAGNOSTICS v_moved = ROW_COUNT;
  IF v_moved = 0 THEN RETURN; END IF;

  -- The parent rule (one level up, same province) cannot hold half-way
  -- through a swap of two levels; it is re-checked for every row below.
  ALTER TABLE lms.admin_unit DISABLE TRIGGER admin_unit_parent_ck;

  -- A Sub-Division over several Tehsils: one copy per extra Tehsil.
  -- (INSERT cannot appear inside a LATERAL subquery, so this is done row by row.)
  FOR v_row IN SELECT * FROM _au_swap WHERE rn > 1 LOOP
    INSERT INTO lms.admin_unit (code, province_code, level, parent_id, name)
    VALUES (lms.next_code(v_row.province_code || '-SUB2-'), v_row.province_code, 2, v_row.tehsil_id, v_row.subdiv_name)
    RETURNING id INTO v_new_id;
    UPDATE _au_swap SET target_id = v_new_id WHERE tehsil_id = v_row.tehsil_id;
  END LOOP;

  UPDATE lms.admin_unit s SET level = 2, parent_id = x.tehsil_id
  FROM _au_swap x WHERE x.rn = 1 AND s.id = x.subdiv_id;
  UPDATE lms.admin_unit t SET level = 1, parent_id = x.district_id
  FROM _au_swap x WHERE t.id = x.tehsil_id;
  UPDATE lms.admin_unit c SET parent_id = x.target_id
  FROM _au_swap x WHERE c.parent_id = x.tehsil_id AND c.level = 3;

  ALTER TABLE lms.admin_unit ENABLE TRIGGER admin_unit_parent_ck;

  SELECT string_agg(c.code::text, ', ') INTO v_bad
  FROM lms.admin_unit c JOIN lms.admin_unit p ON p.id = c.parent_id
  WHERE p.level <> c.level - 1 OR p.province_code <> c.province_code;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'hierarchy check failed after the reorder for %', v_bad;
  END IF;

  REFRESH MATERIALIZED VIEW lms.admin_unit_path;
  RAISE NOTICE '0046: % Tehsil(s) re-parented under their district in %', v_moved,
    (SELECT string_agg(province_code, ', ') FROM _au_relabel);
END $$;
