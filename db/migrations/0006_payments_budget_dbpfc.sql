-- =====================================================================
-- 0006  Payments, allocations, releases, receipts, holds, reconciliation,
--       budgets and DBPFC government-land estimates
-- =====================================================================
-- This is the part of the schema where a mistake costs money, so the rules
-- that matter are constraints rather than conventions: a payment cannot be
-- released twice, a cheque number cannot repeat, a retried request cannot pay
-- twice, and allocations cannot exceed the approved compensation.
SET ROLE lms_owner;

CREATE TABLE lms.payment_category (
  code text PRIMARY KEY,
  name text NOT NULL,
  display_order smallint NOT NULL DEFAULT 100
);

-- ---------------------------------------------------------------------
-- Idempotency.
--
-- A payment API that is retried — a timeout, a double-clicked button, a
-- message redelivered — must not pay twice. The caller supplies a key; the
-- first call records it with its result, and a retry with the same key gets
-- that result back instead of a second effect.
--
-- The unique constraint is what makes this work under concurrency: two
-- simultaneous retries both try to insert the key, one wins, the other gets a
-- unique violation and reads the winner's result. An application-level
-- "have I seen this key?" check cannot do that.
-- ---------------------------------------------------------------------
CREATE TABLE lms.idempotency_key (
  key           text PRIMARY KEY CHECK (length(key) BETWEEN 16 AND 128),
  operation     text NOT NULL,
  request_hash  text NOT NULL,
  result_id     uuid,
  result        jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid REFERENCES lms.app_user(id) ON DELETE RESTRICT
);
COMMENT ON TABLE lms.idempotency_key IS
  'One row per retry-sensitive operation. request_hash lets a retry with the '
  'same key but a different payload be rejected rather than silently '
  'returning the first result.';
COMMENT ON COLUMN lms.idempotency_key.request_hash IS
  'sha256 of the normalised request. Guards against key reuse with a changed amount.';

-- ---------------------------------------------------------------------
-- Payment requests (vouchers)
-- ---------------------------------------------------------------------
CREATE TABLE lms.payment_request (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code           lms.record_code NOT NULL UNIQUE,
  province_code  char(3) NOT NULL REFERENCES lms.province(code) ON DELETE RESTRICT,
  -- A payee is either a registered landowner or a named external body
  -- (a provincial Board of Revenue, for instance). Exactly one of the two.
  landowner_id   uuid REFERENCES lms.landowner(id) ON DELETE RESTRICT,
  payee_name     text,
  project_id     uuid NOT NULL REFERENCES lms.project(id) ON DELETE RESTRICT,
  case_id        uuid REFERENCES lms.compensation_case(id) ON DELETE RESTRICT,
  lease_id       uuid REFERENCES lms.lease(id) ON DELETE RESTRICT,
  dbpfc_id       uuid,
  category_code  text NOT NULL REFERENCES lms.payment_category(code) ON DELETE RESTRICT,
  pay_type       text NOT NULL CHECK (pay_type IN ('One-time','Yearly Lease','Advance Lease (multi-year)')),
  land_class     text CHECK (land_class IN ('Private','Government')),
  period_from    date NOT NULL,
  period_to      date,
  gross_amount   lms.money_pkr_pos NOT NULL,
  wht_pct        lms.pct NOT NULL DEFAULT 0,
  -- Withholding tax and the net payable are generated, so the figure on the
  -- cheque is arithmetic the database performed, not a number the client sent.
  -- round() on numeric is half-up and exact; the same expression in float
  -- would give a different paisa on some amounts.
  wht_amount     lms.money_pkr_nonneg NOT NULL GENERATED ALWAYS AS
                   (round(gross_amount * wht_pct / 100, 2)) STORED,
  net_amount     lms.money_pkr NOT NULL GENERATED ALWAYS AS
                   (gross_amount - round(gross_amount * wht_pct / 100, 2)) STORED,
  payment_mode   text NOT NULL CHECK (payment_mode IN ('Cross Cheque','Pay Order','Direct Credit (IBFT)')),
  remarks        text,
  stage_code     text NOT NULL,
  workflow_code  text NOT NULL GENERATED ALWAYS AS ('payments') STORED,
  -- The payee's business identity, whichever kind of payee it is. Generated so
  -- that the duplicate-prevention index below keys on exactly the business
  -- rule and an external payee's name cannot differ only by case or spacing.
  payee_key      text NOT NULL GENERATED ALWAYS AS (
                   coalesce(landowner_id::text, 'ext:' || lower(btrim(coalesce(payee_name,''))))
                 ) STORED,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  version        integer NOT NULL DEFAULT 1,
  CONSTRAINT payment_stage_fk FOREIGN KEY (workflow_code, stage_code)
    REFERENCES lms.workflow_stage(workflow_code, code) ON DELETE RESTRICT,
  CONSTRAINT payment_payee_ck CHECK (
    (landowner_id IS NOT NULL AND payee_name IS NULL) OR
    (landowner_id IS NULL AND payee_name IS NOT NULL AND btrim(payee_name) <> '')),
  CONSTRAINT payment_period_ck CHECK (period_to IS NULL OR period_to >= period_from)
);
COMMENT ON TABLE lms.payment_request IS
  'Payment vouchers: Requested → Verified → Released. net_amount is generated '
  'from gross and WHT and cannot be supplied by the client.';
COMMENT ON COLUMN lms.payment_request.payee_key IS
  'GENERATED. The landowner id, or ''ext:'' plus the folded external payee '
  'name. Part of payment_no_duplicate_live_uq.';

-- The duplicate-payment block, as a constraint rather than a pre-insert query.
-- Partial on the live stages: a cancelled or stopped voucher must not block a
-- corrected one being raised for the same period.
-- NIL_UUID stands in for "no case" / "no lease". A plain UNIQUE over nullable
-- columns would not fire at all, because NULL is never equal to NULL: two
-- vouchers for the same payee and period with no case would both be accepted.
CREATE UNIQUE INDEX payment_no_duplicate_live_uq
  ON lms.payment_request (
    payee_key,
    category_code,
    period_from,
    coalesce(case_id,  '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(lease_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE stage_code NOT IN ('Cancelled','Stopped');
COMMENT ON INDEX lms.payment_no_duplicate_live_uq IS
  'One live voucher per payee / category / period / case / lease. The '
  'prototype did this with a JavaScript find() before insert, which two '
  'concurrent requests both pass. This cannot be raced.';

-- ---------------------------------------------------------------------
-- Releases. One row per payment, ever.
--
-- The UNIQUE on payment_id is the single most important constraint in the
-- schema: it is what makes "this payment has already been released" a fact the
-- database enforces rather than a stage value that a lost update could
-- overwrite. The release row, not payment_request.stage_code, is the record of
-- money having left.
-- ---------------------------------------------------------------------
CREATE SEQUENCE lms.cheque_no_seq START WITH 25186401 INCREMENT BY 1 NO CYCLE;
COMMENT ON SEQUENCE lms.cheque_no_seq IS
  'Cheque numbers. A sequence, not a counter column: non-transactional, so a '
  'rolled-back release burns a number instead of reissuing one.';

CREATE TABLE lms.payment_release (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id     uuid NOT NULL UNIQUE REFERENCES lms.payment_request(id) ON DELETE RESTRICT,
  province_code  char(3) NOT NULL REFERENCES lms.province(code) ON DELETE RESTRICT,
  cheque_no      text NOT NULL UNIQUE,
  cheque_date    date NOT NULL DEFAULT current_date,
  released_amount lms.money_pkr_pos NOT NULL,
  external_doc_no text,
  idempotency_key text UNIQUE REFERENCES lms.idempotency_key(key) ON DELETE RESTRICT,
  released_at    timestamptz NOT NULL DEFAULT now(),
  released_by    uuid NOT NULL REFERENCES lms.app_user(id) ON DELETE RESTRICT
);
COMMENT ON TABLE lms.payment_release IS
  'Money out. UNIQUE(payment_id) makes a second release of the same voucher '
  'impossible at the storage layer; UNIQUE(cheque_no) makes a reused cheque '
  'number impossible. Rows are never updated or deleted (see 0012).';
COMMENT ON CONSTRAINT payment_release_payment_id_key ON lms.payment_release IS
  'The no-double-release rule. Holds under concurrency, retries and lost updates.';

CREATE TABLE lms.payment_receipt (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  release_id    uuid NOT NULL REFERENCES lms.payment_release(id) ON DELETE RESTRICT,
  receipt_no    text NOT NULL,
  received_on   date NOT NULL,
  acknowledged_by text NOT NULL,
  acknowledged_cnic lms.cnic,
  note          text,
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  recorded_by   uuid REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  UNIQUE (release_id, receipt_no)
);
COMMENT ON TABLE lms.payment_receipt IS
  'Landowner acknowledgement of a released payment. Separate from the release '
  'because the two happen days apart and the second is not always obtained.';

-- ---------------------------------------------------------------------
-- Allocations: how much of a payment is applied to which compensation case.
-- A payment may be partial and a case may be paid in instalments, so the
-- relationship is many-to-many through amounts, and the sum of allocations is
-- what "how much has this case been paid" means.
-- ---------------------------------------------------------------------
CREATE TABLE lms.payment_allocation (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id  uuid NOT NULL REFERENCES lms.payment_request(id) ON DELETE CASCADE,
  case_id     uuid NOT NULL REFERENCES lms.compensation_case(id) ON DELETE RESTRICT,
  landowner_id uuid REFERENCES lms.landowner(id) ON DELETE RESTRICT,
  amount      lms.money_pkr_pos NOT NULL,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  UNIQUE (payment_id, case_id, landowner_id)
);
COMMENT ON TABLE lms.payment_allocation IS
  'Which case (and optionally which payee within it) a payment settles. '
  '"Allocations may not exceed the case total" and "may not exceed the '
  'payment net" span rows and are enforced by deferred constraint triggers in 0012.';

-- ---------------------------------------------------------------------
-- Holds. A court stay order blocks payment to a landowner or against a parcel.
-- Modelled as its own table rather than a flag on the litigation record so
-- that the block has a start, an end, a reason and an author of its own.
-- ---------------------------------------------------------------------
CREATE TABLE lms.payment_hold (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  province_code char(3) REFERENCES lms.province(code) ON DELETE RESTRICT,
  scope         text NOT NULL CHECK (scope IN ('landowner','survey','case','payment','project')),
  landowner_id  uuid REFERENCES lms.landowner(id) ON DELETE RESTRICT,
  survey_id     uuid REFERENCES lms.survey(id) ON DELETE RESTRICT,
  case_id       uuid REFERENCES lms.compensation_case(id) ON DELETE RESTRICT,
  payment_id    uuid REFERENCES lms.payment_request(id) ON DELETE RESTRICT,
  project_id    uuid REFERENCES lms.project(id) ON DELETE RESTRICT,
  legal_case_id uuid,
  reason        text NOT NULL CHECK (btrim(reason) <> ''),
  placed_at     timestamptz NOT NULL DEFAULT now(),
  placed_by     uuid NOT NULL REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  lifted_at     timestamptz,
  lifted_by     uuid REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  lift_reason   text,
  -- The scope column and the populated target must agree, so a 'landowner'
  -- hold cannot be recorded with no landowner and therefore block nothing.
  CONSTRAINT payment_hold_scope_ck CHECK (
    CASE scope
      WHEN 'landowner' THEN landowner_id IS NOT NULL
      WHEN 'survey'    THEN survey_id    IS NOT NULL
      WHEN 'case'      THEN case_id      IS NOT NULL
      WHEN 'payment'   THEN payment_id   IS NOT NULL
      WHEN 'project'   THEN project_id   IS NOT NULL
    END),
  CONSTRAINT payment_hold_lift_ck CHECK ((lifted_at IS NULL) = (lifted_by IS NULL)),
  CONSTRAINT payment_hold_lift_order_ck CHECK (lifted_at IS NULL OR lifted_at >= placed_at)
);
COMMENT ON TABLE lms.payment_hold IS
  'Active holds block api.verify_payment() and api.release_payment(). Lifting '
  'a hold is a recorded act with a reason, not a deletion.';
CREATE INDEX payment_hold_active_landowner_idx
  ON lms.payment_hold (landowner_id) WHERE lifted_at IS NULL;
CREATE INDEX payment_hold_active_survey_idx
  ON lms.payment_hold (survey_id) WHERE lifted_at IS NULL;

-- ---------------------------------------------------------------------
-- Reconciliation. These tables record what a reconciliation run found. They
-- deliberately hold findings only: no reconciliation routine in this schema
-- adjusts a financial record. A mismatch becomes an exception for a person to
-- decide on, because silently rewriting financial history is how an error
-- becomes unauditable.
-- ---------------------------------------------------------------------
CREATE TABLE lms.reconciliation_run (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope        text NOT NULL CHECK (scope IN ('case','project','province','all')),
  scope_ref    uuid,
  province_code char(3) REFERENCES lms.province(code) ON DELETE RESTRICT,
  as_of        date NOT NULL DEFAULT current_date,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  exception_count integer NOT NULL DEFAULT 0,
  run_by       uuid REFERENCES lms.app_user(id) ON DELETE RESTRICT
);

CREATE TABLE lms.reconciliation_exception (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id        uuid NOT NULL REFERENCES lms.reconciliation_run(id) ON DELETE CASCADE,
  kind          text NOT NULL,
  severity      text NOT NULL CHECK (severity IN ('info','warning','error')),
  entity        text NOT NULL,
  entity_id     uuid,
  entity_code   lms.record_code,
  province_code char(3) REFERENCES lms.province(code) ON DELETE RESTRICT,
  expected      numeric(18,2),
  actual        numeric(18,2),
  difference    numeric(18,2),
  detail        text NOT NULL,
  resolved_at   timestamptz,
  resolved_by   uuid REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  resolution    text
);
COMMENT ON TABLE lms.reconciliation_exception IS
  'Findings, not corrections. Nothing in this schema writes back to a payment '
  'or a case on the strength of one of these rows.';
CREATE INDEX reconciliation_exception_open_idx
  ON lms.reconciliation_exception (kind, severity) WHERE resolved_at IS NULL;

-- ---------------------------------------------------------------------
-- Budgets, per project per year
-- ---------------------------------------------------------------------
CREATE TABLE lms.budget (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          lms.record_code NOT NULL UNIQUE,
  province_code char(3) NOT NULL REFERENCES lms.province(code) ON DELETE RESTRICT,
  project_id    uuid NOT NULL REFERENCES lms.project(id) ON DELETE RESTRICT,
  fiscal_year   smallint NOT NULL CHECK (fiscal_year BETWEEN 2000 AND 2100),
  approved_amount lms.money_pkr_nonneg NOT NULL,
  approval_ref  text,
  remarks       text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  version       integer NOT NULL DEFAULT 1,
  -- One budget per project per year; a revision edits the row and leaves a
  -- trail in the audit log rather than creating a second budget.
  UNIQUE (project_id, fiscal_year)
);

-- ---------------------------------------------------------------------
-- DBPFC: Sindh government land, where the rate is fixed by the District Base
-- Price Fixation Committee. An estimate is recorded first and replaced by the
-- notified rate later; both, and every revision in between, are kept.
-- ---------------------------------------------------------------------
CREATE TABLE lms.dbpfc_estimate (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          lms.record_code NOT NULL UNIQUE,
  province_code char(3) NOT NULL REFERENCES lms.province(code) ON DELETE RESTRICT,
  project_id    uuid NOT NULL REFERENCES lms.project(id) ON DELETE RESTRICT,
  district_id   uuid NOT NULL,
  area_acres    lms.area_acres NOT NULL CHECK (area_acres > 0),
  estimated_rate lms.rate_pkr NOT NULL,
  fixed_rate    lms.rate_pkr,
  committee_ref text,
  meeting_date  date,
  -- The rate actually applied, and the annual liability it implies. Generated,
  -- so no screen can show a different number from the one a payment uses.
  applied_rate  lms.rate_pkr NOT NULL GENERATED ALWAYS AS (coalesce(fixed_rate, estimated_rate)) STORED,
  annual_amount lms.money_pkr_nonneg NOT NULL GENERATED ALWAYS AS
                  (round(coalesce(fixed_rate, estimated_rate) * area_acres, 2)) STORED,
  remarks       text,
  stage_code    text NOT NULL,
  workflow_code text NOT NULL GENERATED ALWAYS AS ('dbpfc') STORED,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  version       integer NOT NULL DEFAULT 1,
  CONSTRAINT dbpfc_stage_fk FOREIGN KEY (workflow_code, stage_code)
    REFERENCES lms.workflow_stage(workflow_code, code) ON DELETE RESTRICT,
  CONSTRAINT dbpfc_district_fk FOREIGN KEY (district_id, province_code)
    REFERENCES lms.admin_unit(id, province_code) ON DELETE RESTRICT,
  -- DBPFC is a Sindh institution; the record has no meaning elsewhere.
  CONSTRAINT dbpfc_sindh_only_ck CHECK (province_code = 'SND')
);
COMMENT ON CONSTRAINT dbpfc_sindh_only_ck ON lms.dbpfc_estimate IS
  'The District Base Price Fixation Committee exists in Sindh only. The '
  'prototype enforced this in a validate() callback; here it is a CHECK.';

CREATE TABLE lms.dbpfc_survey (
  dbpfc_id  uuid NOT NULL REFERENCES lms.dbpfc_estimate(id) ON DELETE CASCADE,
  survey_id uuid NOT NULL REFERENCES lms.survey(id) ON DELETE RESTRICT,
  PRIMARY KEY (dbpfc_id, survey_id)
);
COMMENT ON TABLE lms.dbpfc_survey IS
  'Government parcels under this estimate. "land_class must be Government" '
  'reads lms.survey and is enforced by lms.tg_dbpfc_survey_class().';

CREATE TABLE lms.dbpfc_rate_history (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dbpfc_id       uuid NOT NULL REFERENCES lms.dbpfc_estimate(id) ON DELETE CASCADE,
  estimated_rate lms.rate_pkr,
  fixed_rate     lms.rate_pkr,
  changed_at     timestamptz NOT NULL DEFAULT now(),
  changed_by     uuid REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  note           text
);
COMMENT ON TABLE lms.dbpfc_rate_history IS
  'Every rate revision, append-only. Written by a trigger so a rate cannot be '
  'changed without the change being recorded.';

ALTER TABLE lms.payment_request
  ADD CONSTRAINT payment_dbpfc_fk FOREIGN KEY (dbpfc_id)
    REFERENCES lms.dbpfc_estimate(id) ON DELETE RESTRICT;
