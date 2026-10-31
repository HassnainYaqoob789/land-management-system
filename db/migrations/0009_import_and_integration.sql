-- =====================================================================
-- 0009  Import batches, validation errors, provenance, migration
--       reconciliation and outbound integrations
-- =====================================================================
-- The client's existing data arrives as spreadsheets (requirments/CSV Datasets.zip).
-- An import is a two-phase operation: rows land in a staging table and are
-- validated there, and only a batch that validates clean is promoted into the
-- live tables. That way a 4,000-row spreadsheet with six bad CNICs produces
-- six exceptions to fix rather than a half-loaded register.
SET ROLE lms_owner;

CREATE TABLE lms.import_batch (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          lms.record_code NOT NULL UNIQUE,
  target_entity text NOT NULL,
  province_code char(3) REFERENCES lms.province(code) ON DELETE RESTRICT,
  source_file   text NOT NULL,
  -- sha256 of the uploaded file. Re-uploading the identical file is detected
  -- rather than loaded twice, which is the commonest way a register ends up
  -- with duplicates.
  source_sha256 bytea NOT NULL CHECK (length(source_sha256) = 32),
  row_count     integer NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  valid_count   integer NOT NULL DEFAULT 0 CHECK (valid_count >= 0),
  error_count   integer NOT NULL DEFAULT 0 CHECK (error_count >= 0),
  promoted_count integer NOT NULL DEFAULT 0 CHECK (promoted_count >= 0),
  status        text NOT NULL DEFAULT 'staged' CHECK (status IN
                  ('staged','validating','validated','rejected','promoting','promoted','failed','rolled_back')),
  uploaded_at   timestamptz NOT NULL DEFAULT now(),
  uploaded_by   uuid NOT NULL REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  validated_at  timestamptz,
  promoted_at   timestamptz,
  promoted_by   uuid REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  note          text,
  CONSTRAINT import_batch_counts_ck CHECK (valid_count + error_count <= row_count),
  CONSTRAINT import_batch_promote_ck CHECK (promoted_count <= valid_count),
  -- Promotion is an approval: it has an author and a time, or it has not happened.
  CONSTRAINT import_batch_promoted_ck CHECK ((promoted_at IS NULL) = (promoted_by IS NULL))
);
COMMENT ON TABLE lms.import_batch IS
  'One row per uploaded file. A batch may only be promoted from status '
  '''validated'', so a file with unresolved errors cannot reach the live tables.';
CREATE UNIQUE INDEX import_batch_source_uq
  ON lms.import_batch (target_entity, source_sha256)
  WHERE status IN ('validated','promoting','promoted');
COMMENT ON INDEX lms.import_batch_source_uq IS
  'The same file cannot be promoted twice into the same entity. Partial, so a '
  'rejected attempt can be corrected and re-uploaded.';

-- Staging. One row per spreadsheet line, held as jsonb because the incoming
-- columns vary by entity and by whoever prepared the file. Typed validation
-- happens in api.validate_import_batch(), which writes the findings below.
CREATE TABLE lms.import_row (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id    uuid NOT NULL REFERENCES lms.import_batch(id) ON DELETE CASCADE,
  source_line integer NOT NULL CHECK (source_line > 0),
  raw         jsonb NOT NULL,
  normalised  jsonb,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN
                ('pending','valid','invalid','duplicate','promoted','skipped')),
  promoted_id uuid,
  UNIQUE (batch_id, source_line)
);
COMMENT ON COLUMN lms.import_row.normalised IS
  'The row after cleaning (CNIC punctuation, area units, trimmed names). Kept '
  'beside raw so a reviewer can see what the import changed about their data.';
CREATE INDEX import_row_batch_status_idx ON lms.import_row (batch_id, status);

CREATE TABLE lms.import_validation_error (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id    uuid NOT NULL REFERENCES lms.import_batch(id) ON DELETE CASCADE,
  row_id      bigint REFERENCES lms.import_row(id) ON DELETE CASCADE,
  source_line integer,
  field       text,
  severity    text NOT NULL CHECK (severity IN ('error','warning')),
  rule        text NOT NULL,
  message     text NOT NULL,
  observed    text,
  detected_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE lms.import_validation_error IS
  'The exception report. rule names the check that failed so the same message '
  'can be counted across batches ("how often do we get a malformed CNIC").';
CREATE INDEX import_validation_error_batch_idx
  ON lms.import_validation_error (batch_id, severity, rule);

-- ---------------------------------------------------------------------
-- Provenance. For a record that came from an import or a legacy system rather
-- than from a person typing it in, this says where it came from. Needed to
-- answer "is this figure from the revenue record or from the old spreadsheet",
-- which is the first question asked of any migrated number.
-- ---------------------------------------------------------------------
CREATE TABLE lms.data_provenance (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity       text NOT NULL,
  record_id    uuid NOT NULL,
  source_kind  text NOT NULL CHECK (source_kind IN
                 ('manual','import','legacy_migration','integration','derived')),
  batch_id     uuid REFERENCES lms.import_batch(id) ON DELETE RESTRICT,
  source_system text,
  source_key   text,
  source_line  integer,
  confidence   text CHECK (confidence IS NULL OR confidence IN ('high','medium','low')),
  recorded_at  timestamptz NOT NULL DEFAULT now()
);
-- A unique INDEX rather than a UNIQUE constraint, because the key has to treat
-- a missing source_key as a value: a table constraint cannot hold an
-- expression, and over a nullable column it would not fire at all.
CREATE UNIQUE INDEX data_provenance_key_uq
  ON lms.data_provenance (entity, record_id, source_kind, coalesce(source_key, ''));
COMMENT ON TABLE lms.data_provenance IS
  'Where each non-manual record came from. confidence ''low'' marks figures '
  'the migration could not reconcile and that a person still has to confirm.';

-- ---------------------------------------------------------------------
-- Migration reconciliation. A one-off load from the legacy system is only
-- finished when the counts and the money agree. These rows are the evidence
-- that they did, per entity, and they are kept.
-- ---------------------------------------------------------------------
CREATE TABLE lms.migration_reconciliation (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_label     text NOT NULL,
  entity        text NOT NULL,
  province_code char(3) REFERENCES lms.province(code) ON DELETE RESTRICT,
  measure       text NOT NULL CHECK (measure IN ('row_count','sum_amount','sum_area','distinct_key')),
  source_value  numeric(20,4) NOT NULL,
  target_value  numeric(20,4) NOT NULL,
  difference    numeric(20,4) NOT NULL GENERATED ALWAYS AS (target_value - source_value) STORED,
  tolerance     numeric(20,4) NOT NULL DEFAULT 0,
  -- Generated, so "did it reconcile" is not a human judgement recorded as a
  -- boolean that might not match the numbers beside it.
  reconciled    boolean NOT NULL GENERATED ALWAYS AS
                  (abs(target_value - source_value) <= tolerance) STORED,
  checked_at    timestamptz NOT NULL DEFAULT now(),
  checked_by    uuid REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  note          text
);
CREATE UNIQUE INDEX migration_reconciliation_key_uq
  ON lms.migration_reconciliation (run_label, entity, coalesce(province_code, '---'), measure);
COMMENT ON TABLE lms.migration_reconciliation IS
  'Source-versus-target counts and totals per migration run. reconciled is '
  'generated from the numbers, so the sign-off cannot contradict the evidence.';

-- ---------------------------------------------------------------------
-- Outbound integrations. The prototype simulates an ERP document number on
-- release ("SIM-5100…"). A real deployment posts the release to finance and
-- has to cope with that call failing, so the intent is recorded in the same
-- transaction as the release and delivered afterwards — a transactional
-- outbox. A release therefore never half-happens because a remote system was
-- down, and a retry cannot pay twice because the release itself is already
-- unique.
-- ---------------------------------------------------------------------
CREATE TABLE lms.integration_endpoint (
  code        text PRIMARY KEY,
  name        text NOT NULL,
  direction   text NOT NULL CHECK (direction IN ('outbound','inbound','both')),
  is_enabled  boolean NOT NULL DEFAULT false,
  -- No URL, no credential, no token. Connection details live in the
  -- deployment's secret store; this table holds only the logical endpoint and
  -- the name of the secret to look up.
  secret_ref  text,
  note        text
);
COMMENT ON COLUMN lms.integration_endpoint.secret_ref IS
  'The NAME of a secret in the deployment secret store, never a secret. '
  'Nothing in this schema stores a credential.';

CREATE TABLE lms.integration_outbox (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  endpoint_code text NOT NULL REFERENCES lms.integration_endpoint(code) ON DELETE RESTRICT,
  event_type    text NOT NULL,
  entity        text NOT NULL,
  record_id     uuid NOT NULL,
  payload       jsonb NOT NULL,
  -- The key the remote system should deduplicate on, so our retry is their
  -- no-op.
  idempotency_key text NOT NULL,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','abandoned')),
  attempts      smallint NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  sent_at       timestamptz,
  external_ref  text,
  UNIQUE (endpoint_code, idempotency_key)
);
COMMENT ON TABLE lms.integration_outbox IS
  'Transactional outbox. Written in the same transaction as the business '
  'change, delivered by a separate worker. UNIQUE(endpoint, idempotency_key) '
  'makes a redelivery harmless.';
CREATE INDEX integration_outbox_due_idx
  ON lms.integration_outbox (next_attempt_at)
  WHERE status IN ('pending','failed');
