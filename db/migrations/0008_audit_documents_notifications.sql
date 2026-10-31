-- =====================================================================
-- 0008  Audit events, record versions, documents, notifications, sessions
-- =====================================================================
SET ROLE lms_owner;

-- ---------------------------------------------------------------------
-- Audit events.
--
-- Append-only by three separate means, because any one of them alone is weak:
--   1. the application role is granted INSERT and SELECT only — no UPDATE,
--      no DELETE, no TRUNCATE (migration 0016);
--   2. a BEFORE UPDATE OR DELETE trigger raises (migration 0012), which also
--      catches a privileged session that has the grants;
--   3. REVOKE TRUNCATE, because TRUNCATE fires no row triggers.
--
-- What this is NOT: tamper-proof. The table owner can disable the trigger, and
-- a superuser can do anything at all. Real immutability needs an append-only
-- store outside this database — shipping the log to a WORM target or a
-- centralised SIEM. That gap is recorded as DB-02 in docs/SECURITY_FINDINGS.md
-- and is a dependency on infrastructure that does not exist in this
-- environment, not something SQL can close.
-- ---------------------------------------------------------------------
CREATE TABLE audit.audit_event (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- The application user, from the transaction-local context. NOT NULL: an
  -- unattributed change is not allowed to be recorded as if it were fine.
  actor_id      uuid NOT NULL REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  -- Username and role are snapshotted, not joined. A rename or a role change
  -- afterwards must not rewrite what the trail says about a past action.
  actor_username text NOT NULL,
  actor_role     text NOT NULL,
  -- The database role the change actually arrived as. Distinguishes the
  -- application from a migration or a manual administrative correction.
  db_role       text NOT NULL DEFAULT current_user,
  entity        text NOT NULL,
  record_id     uuid,
  record_code   lms.record_code,
  province_code char(3) REFERENCES lms.province(code) ON DELETE RESTRICT,
  action        text NOT NULL CHECK (action IN ('INSERT','UPDATE','DELETE','TRANSITION','EXECUTE','LOGIN','LOGOUT','DENY')),
  old_data      jsonb,
  new_data      jsonb,
  -- Only the fields that actually changed, so a reviewer reads a diff rather
  -- than two full rows.
  changed_fields text[],
  note          text,
  -- The transaction id groups every row written by one business operation, so
  -- "what else happened when this payment was released" is one query.
  txid          bigint NOT NULL DEFAULT txid_current(),
  statement_ts  timestamptz NOT NULL DEFAULT statement_timestamp()
);
COMMENT ON TABLE audit.audit_event IS
  'Immutable under ordinary application permissions. See the header of '
  'migration 0008 for exactly how far that goes and where it stops.';
COMMENT ON COLUMN audit.audit_event.txid IS
  'txid_current(). Groups the rows of one business transaction; a release '
  'writes the payment update, the release row and the workflow transition '
  'under one txid.';

CREATE INDEX audit_event_record_idx ON audit.audit_event (entity, record_id, occurred_at DESC);
CREATE INDEX audit_event_actor_idx  ON audit.audit_event (actor_id, occurred_at DESC);
CREATE INDEX audit_event_at_idx     ON audit.audit_event (occurred_at DESC);
CREATE INDEX audit_event_txid_idx   ON audit.audit_event (txid);

-- ---------------------------------------------------------------------
-- Record versions. The audit event holds the diff; this holds the whole row as
-- it stood at each version, which is what "show me this case as it was when it
-- was approved" needs. Kept only for the records where that question is asked.
-- ---------------------------------------------------------------------
CREATE TABLE audit.record_version (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity      text NOT NULL,
  record_id   uuid NOT NULL,
  version     integer NOT NULL CHECK (version > 0),
  province_code char(3) REFERENCES lms.province(code) ON DELETE RESTRICT,
  snapshot    jsonb NOT NULL,
  valid_from  timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by  uuid NOT NULL REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  UNIQUE (entity, record_id, version)
);
COMMENT ON TABLE audit.record_version IS
  'Full row snapshots per version. UNIQUE(entity, record_id, version) is also '
  'the optimistic-concurrency witness: two sessions that both think they are '
  'writing version 4 cannot both succeed.';

-- ---------------------------------------------------------------------
-- Authentication and session records. Separate from audit_event because a
-- failed login has no actor_id to attribute it to, and audit_event requires one.
-- ---------------------------------------------------------------------
CREATE TABLE audit.auth_event (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  username_tried ext.citext,
  user_id      uuid REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  outcome      text NOT NULL CHECK (outcome IN
                 ('success','bad_password','unknown_user','suspended','locked_out','mfa_failed','logout','session_expired')),
  -- Source address and agent, for the brute-force and impossible-travel
  -- questions a monitoring process asks. inet, not text, so a range query works.
  source_ip    inet,
  user_agent   text,
  session_id   uuid,
  detail       text
);
COMMENT ON TABLE audit.auth_event IS
  'Every authentication attempt, successful or not. The input to lockout and '
  'to the failed-login alerting SOC 2 CC7.2 expects. Populated by the '
  'application tier, which does not yet exist — see docs/SECURITY_FINDINGS.md APP-01.';
CREATE INDEX auth_event_user_idx ON audit.auth_event (user_id, occurred_at DESC);
CREATE INDEX auth_event_failed_idx ON audit.auth_event (username_tried, occurred_at DESC)
  WHERE outcome <> 'success';

CREATE TABLE lms.login_session (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  started_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  ended_at     timestamptz,
  end_reason   text CHECK (end_reason IN ('logout','expired','revoked','superseded')),
  source_ip    inet,
  user_agent   text,
  -- The session token is never stored, only a hash of it, so a database dump
  -- does not hand over live sessions.
  token_sha256 bytea UNIQUE,
  CONSTRAINT login_session_expiry_ck CHECK (expires_at > started_at),
  CONSTRAINT login_session_end_ck CHECK ((ended_at IS NULL) = (end_reason IS NULL))
);
COMMENT ON COLUMN lms.login_session.token_sha256 IS
  'sha256 of the session token. The token itself is never stored: a dump of '
  'this table cannot be replayed as a live session.';
CREATE INDEX login_session_active_idx ON lms.login_session (user_id, expires_at)
  WHERE ended_at IS NULL;

-- ---------------------------------------------------------------------
-- Documents.
--
-- The bytes are NOT in the database. The prototype kept base64 in
-- localStorage, capped at 450 KB; the production design keeps the file in an
-- object store and the metadata plus a SHA-256 here. Reasons: the database
-- stays small enough to restore quickly, the object store does its own
-- encryption at rest and lifecycle expiry, and the checksum here is what
-- proves the stored object is still the one that was approved.
-- ---------------------------------------------------------------------
CREATE TABLE lms.document_category (
  code text PRIMARY KEY, name text NOT NULL, display_order smallint NOT NULL DEFAULT 100,
  retention_years smallint CHECK (retention_years IS NULL OR retention_years > 0));
COMMENT ON COLUMN lms.document_category.retention_years IS
  'Retention period per category, from docs/DATABASE_ENGINEERING_REPORT.md '
  '"Retention and archival". NULL = retain indefinitely (land title records).';

CREATE TABLE lms.document (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          lms.record_code NOT NULL UNIQUE,
  entity        text NOT NULL,
  record_id     uuid NOT NULL,
  record_code   lms.record_code,
  province_code char(3) REFERENCES lms.province(code) ON DELETE RESTRICT,
  file_name     text NOT NULL CHECK (btrim(file_name) <> ''),
  -- An allowlist, not a denylist: the only file types the system accepts.
  -- Checked here as well as in the application, because a mis-typed upload is
  -- how a stored-XSS payload gets served back to a reviewer later.
  mime_type     text NOT NULL CHECK (mime_type IN
                  ('application/pdf','image/jpeg','image/png','image/tiff',
                   'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                   'application/vnd.openxmlformats-officedocument.wordprocessingml.document')),
  size_bytes    bigint NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 52428800),
  category_code text NOT NULL REFERENCES lms.document_category(code) ON DELETE RESTRICT,
  version       integer NOT NULL DEFAULT 1 CHECK (version > 0),
  storage_ref   text NOT NULL,
  content_sha256 bytea NOT NULL CHECK (length(content_sha256) = 32),
  uploaded_at   timestamptz NOT NULL DEFAULT now(),
  uploaded_by   uuid NOT NULL REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  -- Soft delete: a document cited by an approval is withdrawn, not erased.
  deleted_at    timestamptz,
  deleted_by    uuid REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  delete_reason text,
  CONSTRAINT document_delete_ck CHECK ((deleted_at IS NULL) = (deleted_by IS NULL)),
  UNIQUE (entity, record_id, file_name, version)
);
COMMENT ON COLUMN lms.document.size_bytes IS
  'Capped at 50 MiB. An upload limit belongs in the schema as well as the '
  'application: it is the backstop if a client-side check is bypassed.';
COMMENT ON COLUMN lms.document.content_sha256 IS
  'SHA-256 of the stored object. Detects silent corruption or substitution in '
  'the object store, and is what a restore is verified against.';
CREATE INDEX document_record_idx ON lms.document (entity, record_id) WHERE deleted_at IS NULL;

CREATE TABLE lms.document_access_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES lms.document(id) ON DELETE RESTRICT,
  accessed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  accessed_by uuid NOT NULL REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  action      text NOT NULL CHECK (action IN ('view','download','print')),
  source_ip   inet
);
COMMENT ON TABLE lms.document_access_log IS
  'Who read which document. Land records contain CNICs and bank details, so '
  'read access to them is itself auditable (ISO 27001 A.8.15).';

-- ---------------------------------------------------------------------
-- Notifications. Scoped by province like everything else, so a notification
-- about a Sindh case never reaches an account that cannot open it — the gap
-- the prototype's scope.js had to close after the fact.
-- ---------------------------------------------------------------------
CREATE TABLE lms.notification (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES lms.app_user(id) ON DELETE CASCADE,
  province_code char(3) REFERENCES lms.province(code) ON DELETE RESTRICT,
  entity        text,
  record_id     uuid,
  record_code   lms.record_code,
  kind          text NOT NULL CHECK (kind IN
                  ('approval_pending','assigned','escalated','lease_expiring','row_renewal',
                   'payment_released','grievance_due','stay_order','import_failed','budget_exceeded')),
  title         text NOT NULL,
  body          text,
  urgency       text NOT NULL DEFAULT 'normal' CHECK (urgency IN ('low','normal','high','urgent')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  read_at       timestamptz,
  -- Deduplication: the nightly lease-expiry job must not add a second
  -- "expiring in 90 days" notice every time it runs.
  dedupe_tag    text,
  CONSTRAINT notification_read_ck CHECK (read_at IS NULL OR read_at >= created_at)
);
CREATE UNIQUE INDEX notification_dedupe_uq
  ON lms.notification (user_id, dedupe_tag) WHERE dedupe_tag IS NOT NULL;
CREATE INDEX notification_unread_idx
  ON lms.notification (user_id, created_at DESC) WHERE read_at IS NULL;
COMMENT ON INDEX lms.notification_dedupe_uq IS
  'Makes the alert jobs idempotent: re-running one cannot duplicate a notice.';
