-- =====================================================================
-- 0034  Maintaining the approval matrix through one audited routine
-- =====================================================================
-- lms.workflow_step_group says which approval positions may move a record
-- into each workflow stage. The application cannot write it (by design: it is
-- the heart of segregation of duties), and nothing else could change it short
-- of a migration, so the Approval Matrix screen had no way to work.
--
-- api.set_step_groups() is that way, and the only one:
--   - it requires settings:update, checked here, not only by the caller;
--   - the stage must exist and not be a terminal side-exit (Cancelled/Stopped);
--   - a stage may not be left with no approving position, which would make
--     it approvable only by an administrative override;
--   - every group added or removed is written to lms.workflow_matrix_history
--     with who and when, alongside the row-level audit trail.
SET ROLE lms_owner;

CREATE FUNCTION api.set_step_groups(p_workflow text, p_stage text, p_groups text[], p_note text DEFAULT NULL)
RETURNS text[]
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_actor   uuid := util.require_actor();
  v_terminal boolean;
  v_groups  text[] := ARRAY(SELECT DISTINCT g FROM unnest(coalesce(p_groups, '{}')) AS g WHERE btrim(g) <> '' ORDER BY g);
  v_unknown text[];
  v_before  text[];
BEGIN
  PERFORM iam.require('settings', 'update');

  SELECT is_terminal INTO v_terminal FROM lms.workflow_stage WHERE workflow_code = p_workflow AND code = p_stage;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'stage % does not belong to workflow %', p_stage, p_workflow USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_terminal THEN
    RAISE EXCEPTION 'the % stage is a side-exit and has no approving positions', p_stage USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF (SELECT min(seq) FROM lms.workflow_stage WHERE workflow_code = p_workflow) =
     (SELECT seq FROM lms.workflow_stage WHERE workflow_code = p_workflow AND code = p_stage) THEN
    RAISE EXCEPTION 'the first stage is where records are created; it is not approved' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF cardinality(v_groups) = 0 THEN
    RAISE EXCEPTION 'every approval step needs at least one position' USING ERRCODE = 'check_violation';
  END IF;
  SELECT array_agg(g) INTO v_unknown FROM unnest(v_groups) AS g
   WHERE NOT EXISTS (SELECT 1 FROM lms.approval_group a WHERE a.code = g);
  IF v_unknown IS NOT NULL THEN
    RAISE EXCEPTION 'unknown approval position(s): %', array_to_string(v_unknown, ', ') USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT coalesce(array_agg(group_code ORDER BY group_code), '{}') INTO v_before
    FROM lms.workflow_step_group WHERE workflow_code = p_workflow AND to_stage = p_stage;

  INSERT INTO lms.workflow_matrix_history (workflow_code, to_stage, action, group_code, changed_at, changed_by)
  SELECT p_workflow, p_stage, 'removed', g, now(), v_actor FROM unnest(v_before) AS g WHERE NOT (g = ANY (v_groups))
  UNION ALL
  SELECT p_workflow, p_stage, 'added', g, now(), v_actor FROM unnest(v_groups) AS g WHERE NOT (g = ANY (v_before));

  DELETE FROM lms.workflow_step_group
   WHERE workflow_code = p_workflow AND to_stage = p_stage AND NOT (group_code = ANY (v_groups));
  INSERT INTO lms.workflow_step_group (workflow_code, to_stage, group_code)
  SELECT p_workflow, p_stage, g FROM unnest(v_groups) AS g
  ON CONFLICT DO NOTHING;

  RETURN v_groups;
END $$;

COMMENT ON FUNCTION api.set_step_groups(text, text, text[], text) IS
  'Replace the approval positions for one workflow stage; requires settings:update; history in lms.workflow_matrix_history.';

REVOKE ALL ON FUNCTION api.set_step_groups(text, text, text[], text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.set_step_groups(text, text, text[], text) TO lms_readwrite;

RESET ROLE;
