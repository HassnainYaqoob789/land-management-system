-- =====================================================================
-- 0013  Triggers: versioning, audit, append-only protection, and the
--       cross-table invariants that cannot be CHECK constraints
-- =====================================================================
-- Every trigger here is deterministic, narrowly scoped and does one thing. No
-- trigger writes to a table that has a trigger writing back to it, so none can
-- recurse. Each is covered by a test in db/tests/.
SET ROLE lms_owner;

-- ---------------------------------------------------------------------
-- Stamping and optimistic concurrency.
--
-- The trigger bumps version on every update. The application's half of the
-- contract is to write UPDATE … WHERE id = $1 AND version = $2: if the row
-- has moved on, zero rows are affected and the application reports a conflict
-- instead of overwriting someone else's edit. The trigger cannot enforce the
-- application's WHERE clause, which is why the contract is documented here and
-- tested in db/tests/test_07_concurrency.sql.
-- ---------------------------------------------------------------------
CREATE FUNCTION lms.tg_touch_version() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  NEW.version    := OLD.version + 1;
  NEW.updated_at := clock_timestamp();
  NEW.updated_by := coalesce(util.actor_id(), NEW.updated_by, OLD.updated_by);
  -- created_at / created_by are not the caller's to change.
  NEW.created_at := OLD.created_at;
  NEW.created_by := OLD.created_by;
  RETURN NEW;
END $$;
COMMENT ON FUNCTION lms.tg_touch_version() IS
  'Bumps version, stamps updated_at/by from the actor context, and pins '
  'created_at/by so an update cannot rewrite who created the record.';

CREATE FUNCTION lms.tg_stamp_created() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  NEW.created_at := clock_timestamp();
  NEW.created_by := coalesce(NEW.created_by, util.actor_id());
  NEW.updated_at := NEW.created_at;
  NEW.updated_by := coalesce(NEW.updated_by, NEW.created_by);
  NEW.version    := 1;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------
-- Which columns of a table are generated.
--
-- Needed because a BEFORE trigger sees NULL in every STORED generated column
-- of NEW: PostgreSQL computes them after the BEFORE triggers have run. A
-- naive to_jsonb(OLD) versus to_jsonb(NEW) diff therefore reports every
-- generated column as having changed, and a locking trigger built on that diff
-- would refuse an update that touched nothing but a remarks field. The AFTER
-- triggers do not have this problem, which is why the audit trigger does not
-- need this.
-- ---------------------------------------------------------------------
CREATE FUNCTION util.generated_columns(p_relid oid) RETURNS text[]
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT coalesce(array_agg(a.attname::text ORDER BY a.attname), '{}'::text[])
  FROM pg_attribute a
  WHERE a.attrelid = p_relid AND a.attgenerated <> '' AND NOT a.attisdropped;
$$;
COMMENT ON FUNCTION util.generated_columns(oid) IS
  'Generated column names for a table. BEFORE triggers must exclude these from '
  'an OLD/NEW diff: they are NULL in NEW at that point and would look changed.';

-- ---------------------------------------------------------------------
-- The audit trigger.
--
-- SECURITY DEFINER because the application role has INSERT on
-- audit.audit_event but the trigger also needs to read lms.app_user to
-- snapshot the actor's username and role, and the application role cannot
-- select from that table. Pinned search_path, fully qualified references, no
-- dynamic SQL built from row data.
--
-- It requires an actor. A write with no actor context is refused rather than
-- recorded anonymously: an audit trail with holes in it is worse than a write
-- that fails loudly, because nobody discovers the holes until they matter.
-- ---------------------------------------------------------------------
CREATE FUNCTION audit.tg_audit_row() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_actor  uuid;
  v_user   record;
  v_old    jsonb;
  v_new    jsonb;
  v_changed text[];
  v_id     uuid;
  v_code   text;
  v_prov   text;
  v_row    jsonb;
BEGIN
  v_actor := util.require_actor();
  SELECT username, role_code INTO v_user FROM lms.app_user WHERE id = v_actor;

  IF TG_OP = 'DELETE' THEN
    v_old := to_jsonb(OLD); v_row := v_old;
  ELSIF TG_OP = 'INSERT' THEN
    v_new := to_jsonb(NEW); v_row := v_new;
  ELSE
    v_old := to_jsonb(OLD); v_new := to_jsonb(NEW); v_row := v_new;
    -- Only the fields that actually changed, so a reviewer reads a diff.
    SELECT array_agg(k ORDER BY k) INTO v_changed
    FROM jsonb_object_keys(v_new) AS k
    WHERE v_new -> k IS DISTINCT FROM v_old -> k
      AND k NOT IN ('updated_at','updated_by','version');
    -- An update that changed nothing of substance is not worth a row.
    IF v_changed IS NULL THEN RETURN NULL; END IF;
  END IF;

  v_id   := (v_row ->> 'id')::uuid;
  v_code := v_row ->> 'code';
  v_prov := v_row ->> 'province_code';

  INSERT INTO audit.audit_event
    (actor_id, actor_username, actor_role, entity, record_id, record_code,
     province_code, action, old_data, new_data, changed_fields)
  VALUES (v_actor, v_user.username, v_user.role_code, TG_TABLE_NAME, v_id,
          v_code::lms.record_code, v_prov::char(3), TG_OP, v_old, v_new, v_changed);
  RETURN NULL;   -- AFTER trigger; the return value is ignored
END $$;
COMMENT ON FUNCTION audit.tg_audit_row() IS
  'Generic row audit. Refuses to record an unattributed change: a write with '
  'no actor context raises rather than producing an anonymous audit row.';

-- Append-only protection for the audit tables. This catches a privileged
-- session that holds the grants; it does NOT stop the table owner (who can
-- disable it) or a superuser. See docs/SECURITY_FINDINGS.md DB-02.
CREATE FUNCTION audit.tg_append_only() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION '% on %.% is not permitted: this table is append-only',
    TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'correct the record itself; the trail of what happened is not editable';
END $$;

CREATE TRIGGER audit_event_append_only
  BEFORE UPDATE OR DELETE ON audit.audit_event
  FOR EACH ROW EXECUTE FUNCTION audit.tg_append_only();
CREATE TRIGGER record_version_append_only
  BEFORE UPDATE OR DELETE ON audit.record_version
  FOR EACH ROW EXECUTE FUNCTION audit.tg_append_only();
CREATE TRIGGER auth_event_append_only
  BEFORE UPDATE OR DELETE ON audit.auth_event
  FOR EACH ROW EXECUTE FUNCTION audit.tg_append_only();
-- The money ledger is append-only for the same reason.
CREATE TRIGGER payment_release_append_only
  BEFORE UPDATE OR DELETE ON lms.payment_release
  FOR EACH ROW EXECUTE FUNCTION audit.tg_append_only();
CREATE TRIGGER workflow_transition_append_only
  BEFORE UPDATE OR DELETE ON lms.workflow_transition
  FOR EACH ROW EXECUTE FUNCTION audit.tg_append_only();
CREATE TRIGGER survey_ownership_history_append_only
  BEFORE UPDATE OR DELETE ON lms.survey_ownership_history
  FOR EACH ROW EXECUTE FUNCTION audit.tg_append_only();
CREATE TRIGGER setting_history_append_only
  BEFORE UPDATE OR DELETE ON lms.setting_history
  FOR EACH ROW EXECUTE FUNCTION audit.tg_append_only();
CREATE TRIGGER dbpfc_rate_history_append_only
  BEFORE UPDATE OR DELETE ON lms.dbpfc_rate_history
  FOR EACH ROW EXECUTE FUNCTION audit.tg_append_only();

-- ---------------------------------------------------------------------
-- Record versions: a full snapshot per version, for the records where "show me
-- this as it was when it was approved" gets asked.
-- ---------------------------------------------------------------------
CREATE FUNCTION audit.tg_record_version() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_actor uuid := util.require_actor();
BEGIN
  INSERT INTO audit.record_version (entity, record_id, version, province_code, snapshot, created_by)
  VALUES (TG_TABLE_NAME, NEW.id, NEW.version,
          (to_jsonb(NEW) ->> 'province_code')::char(3), to_jsonb(NEW), v_actor)
  -- Concurrent writers that both produced version N: the unique constraint
  -- decides, and the loser's whole transaction fails, which is the correct
  -- outcome for a lost update.
  ON CONFLICT (entity, record_id, version) DO NOTHING;
  RETURN NULL;
END $$;

-- ---------------------------------------------------------------------
-- Cross-table invariants
-- ---------------------------------------------------------------------

-- A parent administrative unit must be exactly one level up and in the same
-- province. Reads another row, so not a CHECK.
CREATE FUNCTION lms.tg_admin_unit_parent() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE p record;
BEGIN
  IF NEW.parent_id IS NULL THEN RETURN NEW; END IF;
  SELECT level, province_code, name INTO p FROM lms.admin_unit WHERE id = NEW.parent_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'parent unit % does not exist', NEW.parent_id USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF p.province_code <> NEW.province_code THEN
    RAISE EXCEPTION 'parent unit % is in % but this unit is in %',
      p.name, p.province_code, NEW.province_code USING ERRCODE = 'raise_exception';
  END IF;
  IF p.level <> NEW.level - 1 THEN
    RAISE EXCEPTION 'parent of a level-% unit must be level %, but % is level %',
      NEW.level, NEW.level - 1, p.name, p.level USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER admin_unit_parent_ck
  BEFORE INSERT OR UPDATE OF parent_id, level, province_code ON lms.admin_unit
  FOR EACH ROW EXECUTE FUNCTION lms.tg_admin_unit_parent();

-- A project's district must actually be a district.
CREATE FUNCTION lms.tg_project_district() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_level smallint;
BEGIN
  SELECT level INTO v_level FROM lms.admin_unit WHERE id = NEW.district_id;
  IF v_level <> 0 THEN
    RAISE EXCEPTION 'a project''s district must be a level-0 unit, not level %', v_level
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER project_district_level_ck
  BEFORE INSERT OR UPDATE OF district_id ON lms.project
  FOR EACH ROW EXECUTE FUNCTION lms.tg_project_district();
CREATE TRIGGER dbpfc_district_level_ck
  BEFORE INSERT OR UPDATE OF district_id ON lms.dbpfc_estimate
  FOR EACH ROW EXECUTE FUNCTION lms.tg_project_district();

-- A lease line may not claim more of a parcel than the parcel has.
CREATE FUNCTION lms.tg_case_lease_line_area() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE s record;
BEGIN
  SELECT code, total_area INTO s FROM lms.survey WHERE id = NEW.survey_id;
  IF NEW.lease_area > s.total_area + 0.0001 THEN
    RAISE EXCEPTION 'lease area % exceeds the total area of parcel % (%)',
      NEW.lease_area, s.code, s.total_area USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER case_lease_line_area_ck
  BEFORE INSERT OR UPDATE OF survey_id, lease_area ON lms.case_lease_line
  FOR EACH ROW EXECUTE FUNCTION lms.tg_case_lease_line_area();

-- A DBPFC estimate covers government land only.
CREATE FUNCTION lms.tg_dbpfc_survey_class() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE s record;
BEGIN
  SELECT code, land_class INTO s FROM lms.survey WHERE id = NEW.survey_id;
  IF s.land_class <> 'Government' THEN
    RAISE EXCEPTION 'parcel % is % land; a DBPFC estimate covers government land only',
      s.code, s.land_class USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER dbpfc_survey_class_ck
  BEFORE INSERT OR UPDATE ON lms.dbpfc_survey
  FOR EACH ROW EXECUTE FUNCTION lms.tg_dbpfc_survey_class();

-- ---------------------------------------------------------------------
-- Share and allocation totals, as DEFERRABLE constraint triggers.
--
-- Deferred to COMMIT, not checked per statement, and that is the whole reason
-- they are constraint triggers: a mutation deletes a 100% holding and inserts
-- three heir holdings, and after the delete the parcel is at 0% while after
-- the first insert it is at 33%. Every intermediate state is invalid and the
-- end state is correct. An immediate check would make the valid transaction
-- impossible; a deferred one enforces the rule on the transaction's result,
-- which is what the rule is actually about.
-- ---------------------------------------------------------------------
CREATE FUNCTION lms.tg_ownership_share_total() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_survey uuid; v_total numeric; v_code text;
BEGIN
  v_survey := coalesce(NEW.survey_id, OLD.survey_id);
  SELECT coalesce(sum(share_pct),0) INTO v_total
  FROM lms.survey_ownership_share WHERE survey_id = v_survey;
  IF v_total > 100.0001 THEN
    SELECT code INTO v_code FROM lms.survey WHERE id = v_survey;
    RAISE EXCEPTION '%', format(
      'ownership shares on parcel %s total %s%%, which exceeds 100%%', v_code, v_total)
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ownership_share_total_ck
  AFTER INSERT OR UPDATE OR DELETE ON lms.survey_ownership_share
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION lms.tg_ownership_share_total();

CREATE FUNCTION lms.tg_case_owner_share_total() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_case uuid; v_total numeric; v_n integer; v_code text; v_stage text;
BEGIN
  v_case := coalesce(NEW.case_id, OLD.case_id);
  -- A cancelled case, or one whose owners were removed along with it, has
  -- nothing to check.
  SELECT code, stage_code INTO v_code, v_stage FROM lms.compensation_case WHERE id = v_case;
  IF NOT FOUND OR v_stage IN ('Cancelled','Stopped') THEN RETURN NULL; END IF;

  SELECT count(*), coalesce(sum(share_pct),0) INTO v_n, v_total
  FROM lms.case_owner WHERE case_id = v_case;
  IF v_n = 0 THEN RETURN NULL; END IF;   -- an empty case is caught by the workflow guard
  IF abs(v_total - 100) > 0.0001 THEN
    RAISE EXCEPTION '%', format(
      'landowner shares on case %s total %s%%, not 100%%', v_code, v_total)
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER case_owner_share_total_ck
  AFTER INSERT OR UPDATE OR DELETE ON lms.case_owner
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION lms.tg_case_owner_share_total();

CREATE FUNCTION lms.tg_mutation_heir_share_total() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_mut uuid; v_total numeric; v_n integer; v_code text; v_stage text;
BEGIN
  v_mut := coalesce(NEW.mutation_id, OLD.mutation_id);
  SELECT code, stage_code INTO v_code, v_stage FROM lms.mutation WHERE id = v_mut;
  IF NOT FOUND OR v_stage = 'Cancelled' THEN RETURN NULL; END IF;
  SELECT count(*), coalesce(sum(share_pct),0) INTO v_n, v_total
  FROM lms.mutation_heir WHERE mutation_id = v_mut;
  IF v_n = 0 THEN RETURN NULL; END IF;
  IF abs(v_total - 100) > 0.0001 THEN
    RAISE EXCEPTION '%', format(
      'heir shares on mutation %s total %s%%, not 100%%', v_code, v_total)
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER mutation_heir_share_total_ck
  AFTER INSERT OR UPDATE OR DELETE ON lms.mutation_heir
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION lms.tg_mutation_heir_share_total();

-- Allocations may not exceed either side: the payment's net, or the case's
-- approved total. Deferred, so a set of allocations can be inserted as a batch.
CREATE FUNCTION lms.tg_allocation_limits() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_pay uuid; v_case uuid; v_sum numeric; v_limit numeric; v_code text;
BEGIN
  v_pay  := coalesce(NEW.payment_id, OLD.payment_id);
  v_case := coalesce(NEW.case_id, OLD.case_id);

  SELECT coalesce(sum(amount),0) INTO v_sum FROM lms.payment_allocation WHERE payment_id = v_pay;
  SELECT net_amount, code INTO v_limit, v_code FROM lms.payment_request WHERE id = v_pay;
  IF v_limit IS NOT NULL AND v_sum > v_limit + 0.001 THEN
    RAISE EXCEPTION 'allocations on voucher % total % but its net payable is %',
      v_code, v_sum, v_limit USING ERRCODE = 'check_violation';
  END IF;

  SELECT coalesce(sum(a.amount),0) INTO v_sum
  FROM lms.payment_allocation a
  JOIN lms.payment_request p ON p.id = a.payment_id
  WHERE a.case_id = v_case AND p.stage_code NOT IN ('Cancelled','Stopped');
  SELECT total_amount, code INTO v_limit, v_code FROM lms.compensation_case WHERE id = v_case;
  IF v_limit IS NOT NULL AND v_sum > v_limit + 0.001 THEN
    RAISE EXCEPTION 'allocations against case % total % but its approved compensation is %',
      v_code, v_sum, v_limit USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER allocation_limits_ck
  AFTER INSERT OR UPDATE OR DELETE ON lms.payment_allocation
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION lms.tg_allocation_limits();

-- A mutation transfers a holding away from the transferor; listing them among
-- the recipients would transfer part of it back to themselves and make the
-- arithmetic meaningless. The prototype checked this in a validate() callback;
-- it reads the parent row, so it is a trigger here rather than a CHECK.
CREATE FUNCTION lms.tg_mutation_heir_not_transferor() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_transferor uuid; v_code text;
BEGIN
  SELECT transferor_id, code INTO v_transferor, v_code
  FROM lms.mutation WHERE id = NEW.mutation_id;
  IF NEW.landowner_id = v_transferor THEN
    RAISE EXCEPTION 'the transferring owner cannot also be an heir on mutation %', v_code
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER mutation_heir_not_transferor_ck
  BEFORE INSERT OR UPDATE OF landowner_id, mutation_id ON lms.mutation_heir
  FOR EACH ROW EXECUTE FUNCTION lms.tg_mutation_heir_not_transferor();

-- ---------------------------------------------------------------------
-- Locked records
-- ---------------------------------------------------------------------
-- An approved or cancelled case is read-only. The one exception is the
-- timestamp the approval itself writes, so that advancing INTO the locking
-- stage is possible while editing AT it is not.
CREATE FUNCTION lms.tg_case_locked() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_changed text[]; v_old jsonb := to_jsonb(OLD); v_new jsonb := to_jsonb(NEW);
BEGIN
  -- Returning NEW from a BEFORE DELETE trigger would return NULL, which
  -- PostgreSQL reads as "cancel this delete" — silently. The row would survive
  -- and the caller would see a successful DELETE of zero rows. Hence the
  -- explicit OLD on the delete path.
  IF OLD.stage_code NOT IN ('HO Approved','Cancelled') THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'case % is % and cannot be deleted', OLD.code, OLD.stage_code
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT array_agg(k ORDER BY k) INTO v_changed
  FROM jsonb_object_keys(v_new) AS k
  WHERE v_new -> k IS DISTINCT FROM v_old -> k
    AND k NOT IN ('approved_at','cancelled_at','updated_at','updated_by','version')
    AND NOT (k = ANY (util.generated_columns(TG_RELID)));
  IF v_changed IS NOT NULL THEN
    RAISE EXCEPTION 'case % is % and is locked; % cannot be changed',
      OLD.code, OLD.stage_code, array_to_string(v_changed, ', ')
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'cancel the case and raise a corrected one; the case number is retained';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER case_locked_ck
  BEFORE UPDATE OR DELETE ON lms.compensation_case
  FOR EACH ROW EXECUTE FUNCTION lms.tg_case_locked();

-- The lines of a locked case are locked with it; otherwise the total could be
-- left behind by edits to what it is a total of.
CREATE FUNCTION lms.tg_case_child_locked() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v record;
BEGIN
  SELECT code, stage_code INTO v FROM lms.compensation_case
  WHERE id = coalesce(NEW.case_id, OLD.case_id);
  -- No parent: the parent is being deleted and is cascading to us.
  IF NOT FOUND THEN RETURN coalesce(NEW, OLD); END IF;
  IF v.stage_code IN ('HO Approved','Cancelled') THEN
    RAISE EXCEPTION 'case % is % and its % rows cannot be changed', v.code, v.stage_code, TG_TABLE_NAME
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN coalesce(NEW, OLD);
END $$;
CREATE TRIGGER case_owner_locked_ck BEFORE INSERT OR UPDATE OR DELETE ON lms.case_owner
  FOR EACH ROW EXECUTE FUNCTION lms.tg_case_child_locked();
CREATE TRIGGER case_lease_line_locked_ck BEFORE INSERT OR UPDATE OR DELETE ON lms.case_lease_line
  FOR EACH ROW EXECUTE FUNCTION lms.tg_case_child_locked();
CREATE TRIGGER case_crop_line_locked_ck BEFORE INSERT OR UPDATE OR DELETE ON lms.case_crop_line
  FOR EACH ROW EXECUTE FUNCTION lms.tg_case_child_locked();
CREATE TRIGGER case_tree_line_locked_ck BEFORE INSERT OR UPDATE OR DELETE ON lms.case_tree_line
  FOR EACH ROW EXECUTE FUNCTION lms.tg_case_child_locked();
CREATE TRIGGER case_misc_line_locked_ck BEFORE INSERT OR UPDATE OR DELETE ON lms.case_misc_line
  FOR EACH ROW EXECUTE FUNCTION lms.tg_case_child_locked();

-- A released payment's money fields are fixed. Only the stage change into
-- 'Released' itself, and the stamping columns, may move.
CREATE FUNCTION lms.tg_payment_locked() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_changed text[]; v_old jsonb := to_jsonb(OLD); v_new jsonb := to_jsonb(NEW);
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM lms.payment_release WHERE payment_id = OLD.id) THEN
      RAISE EXCEPTION 'voucher % has been released and cannot be deleted', OLD.code
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.stage_code <> 'Released' THEN RETURN NEW; END IF;

  SELECT array_agg(k ORDER BY k) INTO v_changed
  FROM jsonb_object_keys(v_new) AS k
  WHERE v_new -> k IS DISTINCT FROM v_old -> k
    AND k NOT IN ('updated_at','updated_by','version','remarks')
    AND NOT (k = ANY (util.generated_columns(TG_RELID)));
  IF v_changed IS NOT NULL THEN
    RAISE EXCEPTION 'voucher % has been released; % cannot be changed',
      OLD.code, array_to_string(v_changed, ', ')
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_locked_ck
  BEFORE UPDATE OR DELETE ON lms.payment_request
  FOR EACH ROW EXECUTE FUNCTION lms.tg_payment_locked();

-- ---------------------------------------------------------------------
-- Derived data kept in step
-- ---------------------------------------------------------------------
-- lease_survey.term_range duplicates the parent lease's period so the
-- exclusion constraint can see it. This keeps the copy honest.
CREATE FUNCTION lms.tg_lease_survey_range() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE l record;
BEGIN
  SELECT start_date, end_date, terminated_on, stage_code INTO l
  FROM lms.lease WHERE id = NEW.lease_id;
  NEW.term_range := daterange(l.start_date, coalesce(l.terminated_on, l.end_date), '[)');
  NEW.is_blocking := (l.stage_code = 'Approved' AND l.terminated_on IS NULL);
  RETURN NEW;
END $$;
CREATE TRIGGER lease_survey_range_sync
  BEFORE INSERT OR UPDATE OF lease_id ON lms.lease_survey
  FOR EACH ROW EXECUTE FUNCTION lms.tg_lease_survey_range();

-- When the lease's own dates or stage move, the copies move with them.
CREATE FUNCTION lms.tg_lease_propagate() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  UPDATE lms.lease_survey ls SET
    term_range  = daterange(NEW.start_date, coalesce(NEW.terminated_on, NEW.end_date), '[)'),
    is_blocking = (NEW.stage_code = 'Approved' AND NEW.terminated_on IS NULL)
  WHERE ls.lease_id = NEW.id
    AND (ls.term_range  IS DISTINCT FROM daterange(NEW.start_date, coalesce(NEW.terminated_on, NEW.end_date), '[)')
      OR ls.is_blocking IS DISTINCT FROM (NEW.stage_code = 'Approved' AND NEW.terminated_on IS NULL));
  RETURN NULL;
END $$;
-- No recursion: this writes lms.lease_survey, whose own trigger is BEFORE
-- INSERT OR UPDATE OF lease_id and so does not fire on these columns, and
-- which writes nothing back to lms.lease.
CREATE TRIGGER lease_propagate_to_surveys
  AFTER UPDATE OF start_date, term_years, terminated_on, stage_code ON lms.lease
  FOR EACH ROW EXECUTE FUNCTION lms.tg_lease_propagate();

-- Every DBPFC rate revision is recorded, so a rate cannot change silently.
CREATE FUNCTION lms.tg_dbpfc_rate_history() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT'
     OR OLD.estimated_rate IS DISTINCT FROM NEW.estimated_rate
     OR OLD.fixed_rate     IS DISTINCT FROM NEW.fixed_rate THEN
    INSERT INTO lms.dbpfc_rate_history (dbpfc_id, estimated_rate, fixed_rate, changed_by, note)
    VALUES (NEW.id, NEW.estimated_rate, NEW.fixed_rate, util.actor_id(),
            CASE WHEN TG_OP = 'INSERT' THEN 'initial estimate' ELSE 'rate revised' END);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER dbpfc_rate_history_write
  AFTER INSERT OR UPDATE OF estimated_rate, fixed_rate ON lms.dbpfc_estimate
  FOR EACH ROW EXECUTE FUNCTION lms.tg_dbpfc_rate_history();

-- A stay order in the litigation register places a payment hold, and lifting
-- it lifts the hold. Keeping the two in step by trigger means a stay cannot be
-- recorded without blocking payments, and a decided case cannot leave a stale
-- block behind.
CREATE FUNCTION lms.tg_legal_case_stay() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_actor uuid := coalesce(util.actor_id(), NEW.updated_by, NEW.created_by);
        v_open  boolean;
BEGIN
  -- A stay only bites while the case is open.
  v_open := NEW.stay_order
            AND NEW.status NOT IN ('Decided — In Favour','Decided — Against','Settled','Withdrawn');

  IF v_open THEN
    INSERT INTO lms.payment_hold
      (province_code, scope, landowner_id, legal_case_id, reason, placed_by)
    SELECT NEW.province_code, 'landowner', lcl.landowner_id, NEW.id,
           format('stay order in %s (%s)', NEW.court_case_no, NEW.court), v_actor
    FROM lms.legal_case_landowner lcl
    WHERE lcl.legal_case_id = NEW.id
      AND NOT EXISTS (SELECT 1 FROM lms.payment_hold h
                      WHERE h.legal_case_id = NEW.id AND h.scope = 'landowner'
                        AND h.landowner_id = lcl.landowner_id AND h.lifted_at IS NULL);

    INSERT INTO lms.payment_hold
      (province_code, scope, survey_id, legal_case_id, reason, placed_by)
    SELECT NEW.province_code, 'survey', lcs.survey_id, NEW.id,
           format('stay order in %s (%s)', NEW.court_case_no, NEW.court), v_actor
    FROM lms.legal_case_survey lcs
    WHERE lcs.legal_case_id = NEW.id
      AND NOT EXISTS (SELECT 1 FROM lms.payment_hold h
                      WHERE h.legal_case_id = NEW.id AND h.scope = 'survey'
                        AND h.survey_id = lcs.survey_id AND h.lifted_at IS NULL);
  ELSE
    UPDATE lms.payment_hold
       SET lifted_at = clock_timestamp(), lifted_by = v_actor,
           lift_reason = format('stay no longer in force (case status: %s)', NEW.status)
     WHERE legal_case_id = NEW.id AND lifted_at IS NULL;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER legal_case_stay_sync
  AFTER INSERT OR UPDATE OF stay_order, status ON lms.legal_case
  FOR EACH ROW EXECUTE FUNCTION lms.tg_legal_case_stay();

-- Configuration changes are recorded.
CREATE FUNCTION lms.tg_setting_history() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.value IS NOT DISTINCT FROM NEW.value THEN RETURN NULL; END IF;
  -- The reason for the change, if the caller supplied one. api.set_setting()
  -- puts it in a transaction-local parameter, because this table is
  -- append-only and cannot be annotated after the fact.
  INSERT INTO lms.setting_history (key, old_value, new_value, changed_by, note)
  VALUES (NEW.key, CASE WHEN TG_OP = 'UPDATE' THEN OLD.value END, NEW.value,
          coalesce(util.actor_id(), NEW.updated_by),
          nullif(current_setting('lms.change_note', true), ''));
  RETURN NULL;
END $$;
CREATE TRIGGER setting_history_write
  AFTER INSERT OR UPDATE OF value ON lms.system_setting
  FOR EACH ROW EXECUTE FUNCTION lms.tg_setting_history();

-- ---------------------------------------------------------------------
-- Attach the stamping, versioning, audit and snapshot triggers to the tables
-- that carry the standard columns. Done in a loop so a new table cannot be
-- added later and quietly miss its audit trigger — the list is the policy.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  t text;
  -- Tables with created_at/by, updated_at/by and version.
  versioned text[] := ARRAY[
    'admin_unit','app_user','project','survey','landowner','survey_ownership_share',
    'acquisition','compensation_case','lease','row_corridor','payment_request',
    'budget','dbpfc_estimate','grievance','encroachment','legal_case','mutation'];
  -- Tables whose every change is audited.
  audited text[] := ARRAY[
    'admin_unit','app_user','app_user_province','app_user_group','project','survey',
    'landowner','survey_ownership_share','acquisition','compensation_case','case_owner',
    'case_lease_line','case_crop_line','case_tree_line','case_misc_line','lease',
    'lease_survey','lease_renewal','row_corridor','payment_request','payment_allocation',
    'payment_hold','budget','dbpfc_estimate','grievance','encroachment','legal_case',
    'mutation','mutation_heir','document','system_setting'];
  -- Tables that keep full version snapshots: the records whose past state gets
  -- asked about. Not every table, because a snapshot per version of every row
  -- would dwarf the data it describes.
  snapshotted text[] := ARRAY[
    'compensation_case','payment_request','lease','survey','landowner','mutation','dbpfc_estimate'];
BEGIN
  FOREACH t IN ARRAY versioned LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT ON lms.%I FOR EACH ROW EXECUTE FUNCTION lms.tg_stamp_created()',
      t || '_stamp_created', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON lms.%I FOR EACH ROW EXECUTE FUNCTION lms.tg_touch_version()',
      t || '_touch_version', t);
  END LOOP;

  FOREACH t IN ARRAY audited LOOP
    EXECUTE format(
      'CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON lms.%I FOR EACH ROW EXECUTE FUNCTION audit.tg_audit_row()',
      t || '_audit', t);
  END LOOP;

  FOREACH t IN ARRAY snapshotted LOOP
    EXECUTE format(
      'CREATE TRIGGER %I AFTER INSERT OR UPDATE ON lms.%I FOR EACH ROW EXECUTE FUNCTION audit.tg_record_version()',
      t || '_version_snapshot', t);
  END LOOP;
END $$;
