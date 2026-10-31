-- =====================================================================
-- 0005  Acquisitions, compensation cases, leases and ROW corridors
-- =====================================================================
SET ROLE lms_owner;

-- ---------------------------------------------------------------------
-- Acquisition / lease process: Identification → Negotiation → Approval →
-- Acquisition/Lease → Handover, gated on a title-completeness checklist.
-- ---------------------------------------------------------------------
CREATE TABLE lms.title_check_item (
  code text PRIMARY KEY,
  name text NOT NULL,
  display_order smallint NOT NULL DEFAULT 100,
  -- A mandatory item blocks the Approval stage until it is ticked.
  is_mandatory boolean NOT NULL DEFAULT true
);

CREATE TABLE lms.acquisition (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code           lms.record_code NOT NULL UNIQUE,
  province_code  char(3) NOT NULL REFERENCES lms.province(code) ON DELETE RESTRICT,
  project_id     uuid NOT NULL REFERENCES lms.project(id) ON DELETE RESTRICT,
  mode           text NOT NULL CHECK (mode IN (
                   'Private Lease','Direct Purchase','Government Land (Lease / Allotment)',
                   'LAA 1894 Acquisition','ROW / Easement')),
  area_required  lms.area_acres NOT NULL CHECK (area_required > 0),
  negotiated_rate lms.rate_pkr,
  target_handover_date date,
  negotiator_id  uuid REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  stage_code     text NOT NULL,
  -- A constant generated column, present only so that (workflow_code,
  -- stage_code) can be a real foreign key into lms.workflow_stage. It costs a
  -- few bytes a row and makes a stage name that does not belong to this
  -- workflow unrepresentable, rather than merely discouraged. Every
  -- workflow-bearing table below does the same.
  workflow_code  text NOT NULL GENERATED ALWAYS AS ('acquisitions') STORED,
  remarks        text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  version        integer NOT NULL DEFAULT 1,
  CONSTRAINT acquisition_stage_fk FOREIGN KEY (workflow_code, stage_code)
    REFERENCES lms.workflow_stage(workflow_code, code) ON DELETE RESTRICT
);

CREATE TABLE lms.acquisition_survey (
  acquisition_id uuid NOT NULL REFERENCES lms.acquisition(id) ON DELETE CASCADE,
  survey_id      uuid NOT NULL REFERENCES lms.survey(id) ON DELETE RESTRICT,
  PRIMARY KEY (acquisition_id, survey_id)
);

CREATE TABLE lms.acquisition_title_check (
  acquisition_id uuid NOT NULL REFERENCES lms.acquisition(id) ON DELETE CASCADE,
  item_code      text NOT NULL REFERENCES lms.title_check_item(code) ON DELETE RESTRICT,
  checked_at     timestamptz NOT NULL DEFAULT now(),
  checked_by     uuid REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  PRIMARY KEY (acquisition_id, item_code)
);
COMMENT ON TABLE lms.acquisition_title_check IS
  'Which title-completeness items have been verified. Presence of a row is the '
  'tick; who ticked it and when are kept because the Approval gate depends on it.';

-- ---------------------------------------------------------------------
-- Compensation case. The financial heart of the system: lease, crop, tree and
-- miscellaneous lines add up to a total that a payment is later released
-- against.
--
-- The totals are stored, not computed on read. Three reasons: every list
-- screen and dashboard needs them (recomputing from four child tables per row
-- is what made the prototype's list screens slow), a released payment must
-- reconcile against the amount that was actually approved rather than against
-- whatever the lines say today, and an approved case is locked so the stored
-- value cannot drift from the lines. api.recalculate_case_totals() is the only
-- writer and a trigger keeps it honest while the case is still editable.
-- ---------------------------------------------------------------------
CREATE TABLE lms.land_use (
  code text PRIMARY KEY,
  name text NOT NULL,
  display_order smallint NOT NULL DEFAULT 100
);

CREATE TABLE lms.compensation_case (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code           lms.record_code NOT NULL UNIQUE,
  lease_no       lms.record_code UNIQUE,
  province_code  char(3) NOT NULL REFERENCES lms.province(code) ON DELETE RESTRICT,
  project_id     uuid NOT NULL REFERENCES lms.project(id) ON DELETE RESTRICT,
  land_use_code  text NOT NULL REFERENCES lms.land_use(code) ON DELETE RESTRICT,
  business_unit  text,
  block_code     text,
  case_date      date NOT NULL DEFAULT current_date,
  lease_rate     lms.rate_pkr,
  lease_term_months smallint CHECK (lease_term_months IS NULL OR lease_term_months > 0),
  effective_date date,
  case_remarks   text,
  lease_remarks  text,
  crop_remarks   text,
  tree_remarks   text,
  misc_remarks   text,
  -- Stored totals, in rupees exact to the paisa.
  total_lease_area   lms.area_acres       NOT NULL DEFAULT 0,
  total_lease_amount lms.money_pkr_nonneg NOT NULL DEFAULT 0,
  total_crop_amount  lms.money_pkr_nonneg NOT NULL DEFAULT 0,
  total_tree_amount  lms.money_pkr_nonneg NOT NULL DEFAULT 0,
  total_misc_amount  lms.money_pkr_nonneg NOT NULL DEFAULT 0,
  -- The one figure a payment is allowed to be released against. A stored
  -- generated column, so it is arithmetically impossible for the total to
  -- disagree with its four parts — no trigger, no routine, no drift.
  total_amount   lms.money_pkr_nonneg NOT NULL GENERATED ALWAYS AS
                   (total_lease_amount + total_crop_amount + total_tree_amount + total_misc_amount) STORED,
  stage_code     text NOT NULL,
  workflow_code  text NOT NULL GENERATED ALWAYS AS ('cases') STORED,
  approved_at    timestamptz,
  cancelled_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  version        integer NOT NULL DEFAULT 1,
  CONSTRAINT case_stage_fk FOREIGN KEY (workflow_code, stage_code)
    REFERENCES lms.workflow_stage(workflow_code, code) ON DELETE RESTRICT,
  -- A case may only be approved once, and only with a timestamp.
  CONSTRAINT case_approved_ck CHECK ((stage_code = 'HO Approved') = (approved_at IS NOT NULL)),
  CONSTRAINT case_cancelled_ck CHECK ((stage_code = 'Cancelled') = (cancelled_at IS NOT NULL))
);
COMMENT ON TABLE lms.compensation_case IS
  'Compensation case: Prepared → Checked → Reviewed → Verified → Field Approved '
  '→ HO Approved, locked on approval. total_amount is a generated column and is '
  'the only figure payments may be released against.';
COMMENT ON COLUMN lms.compensation_case.total_amount IS
  'GENERATED: the sum of the four component totals. Cannot be set directly, so '
  'it cannot disagree with its parts.';

-- Landowners in the case, with the share of the compensation each receives.
-- Must total 100% — a deferred constraint trigger, so the rows can be built up
-- one insert at a time.
CREATE TABLE lms.case_owner (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id      uuid NOT NULL REFERENCES lms.compensation_case(id) ON DELETE CASCADE,
  landowner_id uuid NOT NULL REFERENCES lms.landowner(id) ON DELETE RESTRICT,
  owner_status char(1) NOT NULL CHECK (owner_status IN ('O','B','A')),
  share_pct    lms.share_pct NOT NULL,
  -- The same landowner cannot appear twice in one case.
  UNIQUE (case_id, landowner_id)
);
COMMENT ON TABLE lms.case_owner IS
  'Case payees and their shares. Shares must total exactly 100%, enforced at '
  'COMMIT by lms.tg_case_owner_share_total().';

CREATE TABLE lms.case_lease_line (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id          uuid NOT NULL REFERENCES lms.compensation_case(id) ON DELETE CASCADE,
  survey_id        uuid NOT NULL REFERENCES lms.survey(id) ON DELETE RESTRICT,
  survey_share_pct lms.pct,
  lease_area       lms.area_acres NOT NULL CHECK (lease_area > 0),
  subsequent_area  lms.area_acres,
  line_no          smallint NOT NULL DEFAULT 1,
  UNIQUE (case_id, survey_id, line_no),
  -- A reduced (subsequent) area can only be smaller than the original.
  CONSTRAINT case_lease_line_subsequent_ck
    CHECK (subsequent_area IS NULL OR subsequent_area <= lease_area)
);
COMMENT ON TABLE lms.case_lease_line IS
  'Leased area per parcel in this case. "lease_area may not exceed the parcel''s '
  'total_area" reads another table and is enforced by lms.tg_case_lease_line_area().';

CREATE TABLE lms.case_crop_line (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id     uuid NOT NULL REFERENCES lms.compensation_case(id) ON DELETE CASCADE,
  survey_id   uuid REFERENCES lms.survey(id) ON DELETE RESTRICT,
  crop_type   text NOT NULL CHECK (btrim(crop_type) <> ''),
  rate_per_acre lms.rate_pkr NOT NULL,
  damage_area lms.area_acres NOT NULL CHECK (damage_area > 0),
  -- Line amount as a generated column: the rate × area multiplication happens
  -- once, in exact numeric arithmetic, and never differs between the screen,
  -- the report and the payment.
  amount      lms.money_pkr_nonneg NOT NULL GENERATED ALWAYS AS
                (round(rate_per_acre * damage_area, 2)) STORED
);
COMMENT ON COLUMN lms.case_crop_line.amount IS
  'GENERATED round(rate * area, 2). Rounding is half-up at the line, then lines '
  'are summed — the order documented in docs/DATABASE_ENGINEERING_REPORT.md so '
  'the application and the database agree to the paisa.';

CREATE TABLE lms.tree_species (
  code text PRIMARY KEY,
  name text NOT NULL,
  display_order smallint NOT NULL DEFAULT 100
);

CREATE TABLE lms.case_tree_line (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id     uuid NOT NULL REFERENCES lms.compensation_case(id) ON DELETE CASCADE,
  survey_id   uuid REFERENCES lms.survey(id) ON DELETE RESTRICT,
  species_code text NOT NULL REFERENCES lms.tree_species(code) ON DELETE RESTRICT,
  size        text NOT NULL CHECK (size IN ('Small','Medium','Large')),
  rate        lms.rate_pkr NOT NULL,
  qty         integer NOT NULL CHECK (qty > 0),
  amount      lms.money_pkr_nonneg NOT NULL GENERATED ALWAYS AS (round(rate * qty, 2)) STORED
);

CREATE TABLE lms.case_misc_line (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id      uuid NOT NULL REFERENCES lms.compensation_case(id) ON DELETE CASCADE,
  survey_id    uuid REFERENCES lms.survey(id) ON DELETE RESTRICT,
  payment_type text NOT NULL CHECK (btrim(payment_type) <> ''),
  amount       lms.money_pkr_pos NOT NULL
);

CREATE TABLE lms.case_document_item (
  code text PRIMARY KEY,
  name text NOT NULL,
  display_order smallint NOT NULL DEFAULT 100,
  -- Power-of-attorney documents are only required when an attorney is a payee.
  required_when text NOT NULL DEFAULT 'always'
    CHECK (required_when IN ('always','attorney_present'))
);

CREATE TABLE lms.case_document_check (
  case_id    uuid NOT NULL REFERENCES lms.compensation_case(id) ON DELETE CASCADE,
  item_code  text NOT NULL REFERENCES lms.case_document_item(code) ON DELETE RESTRICT,
  checked_at timestamptz NOT NULL DEFAULT now(),
  checked_by uuid REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  PRIMARY KEY (case_id, item_code)
);

-- ---------------------------------------------------------------------
-- Leases and agreements
-- ---------------------------------------------------------------------
CREATE TABLE lms.lease (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code            lms.record_code NOT NULL UNIQUE,
  province_code   char(3) NOT NULL REFERENCES lms.province(code) ON DELETE RESTRICT,
  project_id      uuid NOT NULL REFERENCES lms.project(id) ON DELETE RESTRICT,
  case_id         uuid REFERENCES lms.compensation_case(id) ON DELETE RESTRICT,
  kind            text NOT NULL CHECK (kind IN ('Private Land','Government Land','ROW / Easement')),
  registration_no text,
  initial_area    lms.area_acres NOT NULL CHECK (initial_area > 0),
  subsequent_area lms.area_acres,
  start_date      date NOT NULL,
  term_years      smallint NOT NULL CHECK (term_years BETWEEN 1 AND 99),
  -- Expiry as a generated column so no query has to repeat the interval
  -- arithmetic, and so it can be indexed for the expiry-alert view.
  end_date        date NOT NULL GENERATED ALWAYS AS
                    ((start_date + make_interval(years => term_years::int))::date) STORED,
  rate_per_acre   lms.rate_pkr NOT NULL,
  escalation_pct  lms.pct,
  auto_extend     boolean NOT NULL DEFAULT false,
  renewal_clause  text,
  obligations     text,
  stage_code      text NOT NULL,
  workflow_code   text NOT NULL GENERATED ALWAYS AS ('leases') STORED,
  terminated_on   date,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  version         integer NOT NULL DEFAULT 1,
  CONSTRAINT lease_stage_fk FOREIGN KEY (workflow_code, stage_code)
    REFERENCES lms.workflow_stage(workflow_code, code) ON DELETE RESTRICT,
  CONSTRAINT lease_subsequent_ck CHECK (subsequent_area IS NULL OR subsequent_area <= initial_area),
  CONSTRAINT lease_terminated_ck CHECK (terminated_on IS NULL OR terminated_on >= start_date)
);
COMMENT ON COLUMN lms.lease.end_date IS
  'GENERATED start_date + term_years. make_interval keeps leap years correct, '
  'which "+ 365 * n days" does not.';

CREATE TABLE lms.lease_lessor (
  lease_id     uuid NOT NULL REFERENCES lms.lease(id) ON DELETE CASCADE,
  landowner_id uuid NOT NULL REFERENCES lms.landowner(id) ON DELETE RESTRICT,
  PRIMARY KEY (lease_id, landowner_id)
);

-- The parcels a lease covers, and the period each is covered for.
--
-- term_range duplicates the parent lease's dates. That is deliberate: an
-- exclusion constraint can only see columns on its own table, and the
-- invariant worth having is "one parcel is not leased twice over the same
-- period". A trigger (0012) keeps term_range in step with the parent lease, so
-- the duplication cannot drift.
CREATE TABLE lms.lease_survey (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id   uuid NOT NULL REFERENCES lms.lease(id) ON DELETE CASCADE,
  survey_id  uuid NOT NULL REFERENCES lms.survey(id) ON DELETE RESTRICT,
  term_range daterange NOT NULL,
  -- Only an approved, unterminated lease blocks the parcel. A draft or a
  -- cancelled lease must not stop the real one being recorded.
  is_blocking boolean NOT NULL DEFAULT false,
  UNIQUE (lease_id, survey_id),
  CONSTRAINT lease_survey_no_double_lease
    EXCLUDE USING gist (survey_id WITH =, term_range WITH &&) WHERE (is_blocking)
);
COMMENT ON CONSTRAINT lease_survey_no_double_lease ON lms.lease_survey IS
  'A parcel may not be under two approved leases at once. Partial on '
  'is_blocking so drafts and terminated leases do not block. This is the '
  'invariant an application check cannot hold under concurrency.';

CREATE TABLE lms.lease_renewal (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id       uuid NOT NULL REFERENCES lms.lease(id) ON DELETE CASCADE,
  renewal_no     smallint NOT NULL CHECK (renewal_no > 0),
  renewed_on     date NOT NULL,
  new_end_date   date NOT NULL,
  old_rate       lms.rate_pkr NOT NULL,
  new_rate       lms.rate_pkr NOT NULL,
  escalation_pct lms.pct,
  note           text,
  recorded_at    timestamptz NOT NULL DEFAULT now(),
  recorded_by    uuid REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  UNIQUE (lease_id, renewal_no)
);
COMMENT ON TABLE lms.lease_renewal IS
  'Renewal history with the rate before and after escalation, so a rent figure '
  'in an old payment can be explained.';

-- ---------------------------------------------------------------------
-- ROW / pipeline corridors
-- ---------------------------------------------------------------------
CREATE TABLE lms.row_corridor (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code           lms.record_code NOT NULL UNIQUE,
  province_code  char(3) NOT NULL REFERENCES lms.province(code) ON DELETE RESTRICT,
  project_id     uuid NOT NULL REFERENCES lms.project(id) ON DELETE RESTRICT,
  name           text NOT NULL CHECK (btrim(name) <> ''),
  row_type       text NOT NULL CHECK (row_type IN (
                   'Pipeline ROW','Flowline ROW','Access Road','Junction / Valve Station','Power Line')),
  from_point     text,
  to_point       text,
  length_m       numeric(12,2) NOT NULL CHECK (length_m > 0),
  width_m        numeric(8,2)  NOT NULL CHECK (width_m > 0),
  -- Corridor area in acres, generated from length × width. 1 acre = 4046.8564224 m².
  area_acres     lms.area_acres NOT NULL GENERATED ALWAYS AS
                   (round(length_m * width_m / 4046.8564224, 4)) STORED,
  agreement_date date NOT NULL,
  tenure_years   smallint NOT NULL CHECK (tenure_years BETWEEN 1 AND 99),
  annual_rent    lms.money_pkr_nonneg,
  path_wkt       text,
  obligations    text,
  stage_code     text NOT NULL,
  workflow_code  text NOT NULL GENERATED ALWAYS AS ('rows') STORED,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  version        integer NOT NULL DEFAULT 1,
  CONSTRAINT row_stage_fk FOREIGN KEY (workflow_code, stage_code)
    REFERENCES lms.workflow_stage(workflow_code, code) ON DELETE RESTRICT
);
COMMENT ON COLUMN lms.row_corridor.area_acres IS
  'GENERATED length × width / 4046.8564224 m² per acre, rounded to 4 dp. The '
  'exact SI definition, not an approximation.';

CREATE TABLE lms.row_survey (
  row_id    uuid NOT NULL REFERENCES lms.row_corridor(id) ON DELETE CASCADE,
  survey_id uuid NOT NULL REFERENCES lms.survey(id) ON DELETE RESTRICT,
  PRIMARY KEY (row_id, survey_id)
);

CREATE TABLE lms.row_landowner (
  row_id       uuid NOT NULL REFERENCES lms.row_corridor(id) ON DELETE CASCADE,
  landowner_id uuid NOT NULL REFERENCES lms.landowner(id) ON DELETE RESTRICT,
  PRIMARY KEY (row_id, landowner_id)
);
