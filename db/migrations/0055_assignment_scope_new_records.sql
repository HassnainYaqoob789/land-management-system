-- =====================================================================
-- 0055  Approval queue: a new record is visible to its province at once
-- =====================================================================
-- RECOVERED FILE. This migration was applied to lms_dev and lms_test on
-- 2026-10-30 17:54 (+05) by lms_migrator, but its file was never kept in the
-- repository. On 2026-10-31 it was rebuilt from the live policy in lms_dev
-- (pg_policies) and compared with lms_iam_test, which does not have it: this
-- policy is the only database object that differs. The recorded checksum was
-- updated to this file's (original checksum
-- 8b98a03841765181d54e4891a1b21799cdacc958235ef1073bd917e59c4ce960).
--
-- Why: the policy scoped an approval-queue entry by the province of the
-- record's earlier transitions. A record just created (e.g. a compensation
-- case at Prepared, queued for its first approval by queueFirstStep) has no
-- transition yet, so the officers of its province could not see the entry in
-- their inbox. The record's own province (lms.record_province) now also
-- grants visibility.

SET ROLE lms_owner;

DROP POLICY IF EXISTS assignment_scope ON lms.workflow_assignment;
CREATE POLICY assignment_scope ON lms.workflow_assignment
  AS PERMISSIVE FOR ALL TO lms_readwrite, lms_readonly
  USING (
    ((SELECT lms.actor_role()) = 'Admin')
    OR EXISTS (SELECT 1 FROM lms.workflow_transition t
                WHERE t.workflow_code = workflow_assignment.workflow_code
                  AND t.record_id = workflow_assignment.record_id
                  AND t.province_code = ANY ((SELECT lms.actor_provinces())::bpchar[]))
    OR lms.record_province(workflow_code, record_id) = ANY ((SELECT lms.actor_provinces())::bpchar[])
  )
  WITH CHECK (true);

RESET ROLE;
