-- =====================================================================
-- 0004  Workflow definitions, stages, the approval matrix, assignments,
--       decisions, comments and escalations
-- =====================================================================
-- The prototype hard-codes its workflows in JavaScript (WF and MATRIX_DEFAULT
-- in app/assets/js/core/engine.js). Here they are data, so the client can
-- reassign an approval step to a different position without a release, and so
-- the database can refuse a transition the matrix does not allow.
SET ROLE lms_owner;

-- One row per workflow-bearing entity. The code matches the application's
-- collection name ('cases', 'payments', …) so the two sides agree on a name.
CREATE TABLE lms.workflow (
  code                    text PRIMARY KEY,
  entity_table            text NOT NULL,
  label                   text NOT NULL,
  -- The stage at which the record becomes read-only. NULL = never locks.
  lock_at_stage           text,
  allows_cancel           boolean NOT NULL DEFAULT false,
  allows_stop             boolean NOT NULL DEFAULT false,
  -- true = the record may only be edited while it is still at the first stage
  -- (SoR Sc14: once a compensation case is submitted it can only be cancelled).
  edit_only_first_stage   boolean NOT NULL DEFAULT false,
  no_delete_after_submit  boolean NOT NULL DEFAULT false,
  allows_escalation       boolean NOT NULL DEFAULT false,
  -- 'strict' = segregation of duties: whoever created the record, and whoever
  -- approved an earlier step, may not approve a later one.
  sod_mode                text NOT NULL DEFAULT 'strict' CHECK (sod_mode IN ('strict','relaxed','off'))
);
COMMENT ON TABLE lms.workflow IS
  'Workflow definitions, one per entity. entity_table names the lms table the '
  'workflow applies to; api.advance_workflow() uses it to find the record.';

CREATE TABLE lms.workflow_stage (
  workflow_code text NOT NULL REFERENCES lms.workflow(code) ON DELETE CASCADE,
  code          text NOT NULL,
  seq           smallint NOT NULL CHECK (seq >= 0),
  label         text NOT NULL,
  step_note     text,
  -- Cancelled / Stopped: reachable from anywhere, and the end of the road.
  is_terminal   boolean NOT NULL DEFAULT false,
  PRIMARY KEY (workflow_code, code),
  UNIQUE (workflow_code, seq)
);
COMMENT ON TABLE lms.workflow_stage IS
  'Ordered stages per workflow. seq drives "the next stage"; terminal stages '
  'sit outside the ordered path and are reachable from any non-locked stage.';

-- Deferrable, because lms.workflow and lms.workflow_stage reference each other:
-- a workflow names its locking stage and a stage names its workflow. One load
-- cannot satisfy both orders statement by statement, so the check happens at
-- COMMIT, by which point both sides are present.
ALTER TABLE lms.workflow
  ADD CONSTRAINT workflow_lock_stage_fk FOREIGN KEY (code, lock_at_stage)
    REFERENCES lms.workflow_stage(workflow_code, code) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED;

-- The approval matrix: which positions may move a record INTO a given stage.
-- Configurable, which is why it is a table and not a CHECK.
CREATE TABLE lms.workflow_step_group (
  workflow_code text NOT NULL,
  to_stage      text NOT NULL,
  group_code    text NOT NULL REFERENCES lms.approval_group(code) ON DELETE RESTRICT,
  PRIMARY KEY (workflow_code, to_stage, group_code),
  FOREIGN KEY (workflow_code, to_stage)
    REFERENCES lms.workflow_stage(workflow_code, code) ON DELETE CASCADE
);
COMMENT ON TABLE lms.workflow_step_group IS
  'The configurable approval matrix. A transition into to_stage requires the '
  'actor to hold at least one of these approval groups.';

-- Changes to the matrix are themselves a controlled change: who re-pointed the
-- HO approval step, and when.
CREATE TABLE lms.workflow_matrix_history (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workflow_code text NOT NULL,
  to_stage      text NOT NULL,
  action        text NOT NULL CHECK (action IN ('added','removed')),
  group_code    text NOT NULL,
  changed_at    timestamptz NOT NULL DEFAULT now(),
  changed_by    uuid REFERENCES lms.app_user(id) ON DELETE RESTRICT
);
COMMENT ON TABLE lms.workflow_matrix_history IS
  'Append-only history of approval-matrix changes. Evidence for SOC 2 CC6.3 '
  '(authorisation changes are recorded) and ISO 27001 A.5.18.';

-- ---------------------------------------------------------------------
-- Per-record workflow state is held on each entity table (stage_code), because
-- every query that filters by stage filters the entity. What lives here is the
-- cross-entity history: the decisions, who made them and when.
--
-- (workflow_code, record_id) is a polymorphic reference and therefore cannot
-- carry a foreign key. That is a real limitation and it is mitigated, not
-- ignored: the application role has no INSERT privilege on this table, and the
-- only writer is api.advance_workflow(), which resolves the record in its own
-- entity table first and fails if it is not there. A privileged role can still
-- insert an orphan row; see docs/DATABASE_SECURITY_REVIEW.md, "Polymorphic
-- references".
-- ---------------------------------------------------------------------
CREATE TABLE lms.workflow_transition (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workflow_code text NOT NULL REFERENCES lms.workflow(code) ON DELETE RESTRICT,
  record_id     uuid NOT NULL,
  record_code   lms.record_code NOT NULL,
  province_code char(3) REFERENCES lms.province(code) ON DELETE RESTRICT,
  from_stage    text,
  to_stage      text NOT NULL,
  action        text NOT NULL CHECK (action IN ('Created','Advanced','Cancelled','Stopped','Escalated','Reopened')),
  acted_by      uuid NOT NULL REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  acted_as_group text REFERENCES lms.approval_group(code) ON DELETE RESTRICT,
  acted_at      timestamptz NOT NULL DEFAULT now(),
  note          text,
  FOREIGN KEY (workflow_code, to_stage)
    REFERENCES lms.workflow_stage(workflow_code, code) ON DELETE RESTRICT
);
COMMENT ON TABLE lms.workflow_transition IS
  'Every workflow decision, append-only. acted_as_group records which position '
  'the approval was given in, which is what segregation of duties is checked against.';

CREATE INDEX workflow_transition_record_idx
  ON lms.workflow_transition (workflow_code, record_id, acted_at);

-- Who a record is currently waiting on. One open assignment per record at a
-- time; closed ones stay for the turnaround-time reports.
CREATE TABLE lms.workflow_assignment (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workflow_code  text NOT NULL REFERENCES lms.workflow(code) ON DELETE RESTRICT,
  record_id      uuid NOT NULL,
  stage_code     text NOT NULL,
  assigned_group text REFERENCES lms.approval_group(code) ON DELETE RESTRICT,
  assigned_user  uuid REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  assigned_at    timestamptz NOT NULL DEFAULT now(),
  due_at         timestamptz,
  closed_at      timestamptz,
  CONSTRAINT workflow_assignment_target_ck
    CHECK (assigned_group IS NOT NULL OR assigned_user IS NOT NULL),
  CONSTRAINT workflow_assignment_closed_ck
    CHECK (closed_at IS NULL OR closed_at >= assigned_at)
);
-- Partial unique index: at most one open assignment per record. Partial
-- because closed assignments are history and may repeat.
CREATE UNIQUE INDEX workflow_assignment_one_open_uq
  ON lms.workflow_assignment (workflow_code, record_id)
  WHERE closed_at IS NULL;
COMMENT ON INDEX lms.workflow_assignment_one_open_uq IS
  'A record waits on one queue at a time. Partial so that the closed history '
  'is unconstrained.';

CREATE TABLE lms.workflow_comment (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workflow_code text NOT NULL REFERENCES lms.workflow(code) ON DELETE RESTRICT,
  record_id     uuid NOT NULL,
  province_code char(3) REFERENCES lms.province(code) ON DELETE RESTRICT,
  body          text NOT NULL CHECK (btrim(body) <> ''),
  commented_by  uuid NOT NULL REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  commented_at  timestamptz NOT NULL DEFAULT now(),
  -- A comment is retracted rather than deleted, so a conversation cannot be
  -- rewritten after an approval cites it.
  retracted_at  timestamptz,
  retracted_by  uuid REFERENCES lms.app_user(id) ON DELETE RESTRICT
);
CREATE INDEX workflow_comment_record_idx
  ON lms.workflow_comment (workflow_code, record_id, commented_at DESC);

CREATE TABLE lms.workflow_escalation (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workflow_code    text NOT NULL REFERENCES lms.workflow(code) ON DELETE RESTRICT,
  record_id        uuid NOT NULL,
  province_code    char(3) REFERENCES lms.province(code) ON DELETE RESTRICT,
  level            smallint NOT NULL CHECK (level BETWEEN 1 AND 5),
  reason           text NOT NULL,
  escalated_to_group text REFERENCES lms.approval_group(code) ON DELETE RESTRICT,
  escalated_at     timestamptz NOT NULL DEFAULT now(),
  escalated_by     uuid REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  resolved_at      timestamptz,
  UNIQUE (workflow_code, record_id, level)
);
COMMENT ON TABLE lms.workflow_escalation IS
  'Grievance and encroachment escalations. UNIQUE on (record, level) stops the '
  'same level being raised twice by a retried request.';
