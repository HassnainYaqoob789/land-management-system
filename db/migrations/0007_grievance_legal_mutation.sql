-- =====================================================================
-- 0007  Grievances, encroachments, litigation and mutations
-- =====================================================================
SET ROLE lms_owner;

CREATE TABLE lms.grievance_category (
  code text PRIMARY KEY, name text NOT NULL, display_order smallint NOT NULL DEFAULT 100);
CREATE TABLE lms.encroachment_category (
  code text PRIMARY KEY, name text NOT NULL, display_order smallint NOT NULL DEFAULT 100);

-- ---------------------------------------------------------------------
-- Grievances and land-related incident reports
-- ---------------------------------------------------------------------
CREATE TABLE lms.grievance (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code           lms.record_code NOT NULL UNIQUE,
  province_code  char(3) NOT NULL REFERENCES lms.province(code) ON DELETE RESTRICT,
  grievance_type text NOT NULL CHECK (grievance_type IN
                   ('Landowner Complaint','Community Complaint','IIR — Land Matter')),
  landowner_id   uuid REFERENCES lms.landowner(id) ON DELETE RESTRICT,
  complainant    text NOT NULL CHECK (btrim(complainant) <> ''),
  complainant_cnic lms.cnic,
  mobile         text,
  project_id     uuid REFERENCES lms.project(id) ON DELETE RESTRICT,
  survey_id      uuid REFERENCES lms.survey(id) ON DELETE RESTRICT,
  category_code  text NOT NULL REFERENCES lms.grievance_category(code) ON DELETE RESTRICT,
  severity       text NOT NULL CHECK (severity IN ('Low','Medium','High','Critical')),
  channel        text,
  received_date  date NOT NULL,
  due_date       date,
  assigned_to    uuid REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  description    text NOT NULL CHECK (btrim(description) <> ''),
  resolution     text,
  resolved_on    date,
  escalation_level smallint NOT NULL DEFAULT 0 CHECK (escalation_level BETWEEN 0 AND 5),
  stage_code     text NOT NULL,
  workflow_code  text NOT NULL GENERATED ALWAYS AS ('grievances') STORED,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  version        integer NOT NULL DEFAULT 1,
  CONSTRAINT grievance_stage_fk FOREIGN KEY (workflow_code, stage_code)
    REFERENCES lms.workflow_stage(workflow_code, code) ON DELETE RESTRICT,
  CONSTRAINT grievance_due_ck CHECK (due_date IS NULL OR due_date >= received_date),
  CONSTRAINT grievance_resolved_ck CHECK (resolved_on IS NULL OR resolved_on >= received_date),
  -- A grievance cannot reach Resolved without a recorded resolution. The
  -- prototype checked this in a guard() callback at transition time; as a
  -- CHECK it also holds against a direct UPDATE that skips the workflow.
  CONSTRAINT grievance_resolution_required_ck
    CHECK (stage_code NOT IN ('Resolved','Closed') OR btrim(coalesce(resolution,'')) <> '')
);
COMMENT ON CONSTRAINT grievance_resolution_required_ck ON lms.grievance IS
  'No resolution, no Resolved stage — enforced for any write path, not only '
  'the workflow routine.';

-- ---------------------------------------------------------------------
-- Encroachments and ROW violations
-- ---------------------------------------------------------------------
CREATE TABLE lms.encroachment (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code           lms.record_code NOT NULL UNIQUE,
  province_code  char(3) NOT NULL REFERENCES lms.province(code) ON DELETE RESTRICT,
  category_code  text NOT NULL REFERENCES lms.encroachment_category(code) ON DELETE RESTRICT,
  project_id     uuid NOT NULL REFERENCES lms.project(id) ON DELETE RESTRICT,
  survey_id      uuid REFERENCES lms.survey(id) ON DELETE RESTRICT,
  row_id         uuid REFERENCES lms.row_corridor(id) ON DELETE RESTRICT,
  lat            lms.latitude  NOT NULL,
  lng            lms.longitude NOT NULL,
  detected_on    date NOT NULL,
  reported_by    uuid REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  encroacher     text,
  area_affected  lms.area_acres,
  risk           text NOT NULL CHECK (risk IN ('Low','Medium','High','Critical')),
  description    text NOT NULL CHECK (btrim(description) <> ''),
  impact         text,
  corrective_action text,
  escalation_level smallint NOT NULL DEFAULT 0 CHECK (escalation_level BETWEEN 0 AND 5),
  stage_code     text NOT NULL,
  workflow_code  text NOT NULL GENERATED ALWAYS AS ('encroachments') STORED,
  resolved_on    date,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  version        integer NOT NULL DEFAULT 1,
  CONSTRAINT encroachment_stage_fk FOREIGN KEY (workflow_code, stage_code)
    REFERENCES lms.workflow_stage(workflow_code, code) ON DELETE RESTRICT,
  -- An incident has to be somewhere: on a parcel, on a corridor, or both.
  CONSTRAINT encroachment_location_ck CHECK (survey_id IS NOT NULL OR row_id IS NOT NULL)
);

-- ---------------------------------------------------------------------
-- Litigation. A stay order here is what creates a payment hold; the two are
-- kept in step by a trigger (0012) so that lifting a stay cannot leave a stale
-- hold blocking payments, and recording one cannot fail to block them.
-- ---------------------------------------------------------------------
CREATE TABLE lms.legal_case (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code           lms.record_code NOT NULL UNIQUE,
  province_code  char(3) NOT NULL REFERENCES lms.province(code) ON DELETE RESTRICT,
  court_case_no  text NOT NULL CHECK (btrim(court_case_no) <> ''),
  court          text NOT NULL,
  case_type      text NOT NULL,
  company_role   text NOT NULL CHECK (company_role IN
                   ('Defendant / Respondent','Plaintiff / Petitioner','Proforma Party')),
  parties        text NOT NULL CHECK (btrim(parties) <> ''),
  project_id     uuid REFERENCES lms.project(id) ON DELETE RESTRICT,
  case_id        uuid REFERENCES lms.compensation_case(id) ON DELETE RESTRICT,
  filing_date    date NOT NULL,
  next_hearing   date,
  counsel        text,
  officer_id     uuid REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  financial_exposure lms.money_pkr_nonneg,
  stay_order     boolean NOT NULL DEFAULT false,
  status         text NOT NULL CHECK (status IN
                   ('Pending','Under Hearing','Reserved for Judgment','Decided — In Favour',
                    'Decided — Against','In Appeal','Settled','Withdrawn')),
  remarks        text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  version        integer NOT NULL DEFAULT 1,
  -- One register entry per court case number per court.
  UNIQUE (court, court_case_no)
);
COMMENT ON COLUMN lms.legal_case.stay_order IS
  'true while a stay is in force. lms.tg_legal_case_stay() places and lifts the '
  'matching rows in lms.payment_hold, so the block cannot drift from the register.';

CREATE TABLE lms.legal_case_landowner (
  legal_case_id uuid NOT NULL REFERENCES lms.legal_case(id) ON DELETE CASCADE,
  landowner_id  uuid NOT NULL REFERENCES lms.landowner(id) ON DELETE RESTRICT,
  PRIMARY KEY (legal_case_id, landowner_id)
);
CREATE TABLE lms.legal_case_survey (
  legal_case_id uuid NOT NULL REFERENCES lms.legal_case(id) ON DELETE CASCADE,
  survey_id     uuid NOT NULL REFERENCES lms.survey(id) ON DELETE RESTRICT,
  PRIMARY KEY (legal_case_id, survey_id)
);

CREATE TABLE lms.legal_hearing (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_case_id uuid NOT NULL REFERENCES lms.legal_case(id) ON DELETE CASCADE,
  hearing_date  date NOT NULL,
  proceedings   text,
  next_date     date,
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  recorded_by   uuid REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  UNIQUE (legal_case_id, hearing_date),
  CONSTRAINT legal_hearing_next_ck CHECK (next_date IS NULL OR next_date > hearing_date)
);

ALTER TABLE lms.payment_hold
  ADD CONSTRAINT payment_hold_legal_case_fk FOREIGN KEY (legal_case_id)
    REFERENCES lms.legal_case(id) ON DELETE RESTRICT;

-- ---------------------------------------------------------------------
-- Mutations: inheritance, sale, gift and partition. On final approval the
-- shares move, which is the one place in the schema where approving a record
-- changes somebody's ownership — so it runs in api.apply_mutation() inside a
-- single transaction, writes the ownership history, and is not something the
-- application can do with an UPDATE.
-- ---------------------------------------------------------------------
CREATE TABLE lms.mutation (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code           lms.record_code NOT NULL UNIQUE,
  province_code  char(3) NOT NULL REFERENCES lms.province(code) ON DELETE RESTRICT,
  mutation_type  text NOT NULL CHECK (mutation_type IN
                   ('Inheritance (Virasat)','Sale / Transfer','Gift (Hiba)','Partition')),
  transferor_id  uuid NOT NULL REFERENCES lms.landowner(id) ON DELETE RESTRICT,
  death_date     date,
  revenue_mutation_no text,
  mutation_date  date,
  revenue_office text,
  certificate_no text,
  remarks        text,
  stage_code     text NOT NULL,
  workflow_code  text NOT NULL GENERATED ALWAYS AS ('mutations') STORED,
  applied_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid REFERENCES lms.app_user(id) ON DELETE RESTRICT,
  version        integer NOT NULL DEFAULT 1,
  CONSTRAINT mutation_stage_fk FOREIGN KEY (workflow_code, stage_code)
    REFERENCES lms.workflow_stage(workflow_code, code) ON DELETE RESTRICT,
  -- An inheritance needs a succession certificate before legal clearance, and
  -- a verified mutation needs its revenue number. Both are stage-dependent, so
  -- they are CHECKs over (stage, field) rather than transition-time guards only.
  CONSTRAINT mutation_revenue_no_ck CHECK (
    stage_code IN ('Initiated','Cancelled') OR btrim(coalesce(revenue_mutation_no,'')) <> ''),
  CONSTRAINT mutation_certificate_ck CHECK (
    mutation_type <> 'Inheritance (Virasat)'
    OR stage_code IN ('Initiated','Revenue Verified','Cancelled')
    OR btrim(coalesce(certificate_no,'')) <> ''),
  CONSTRAINT mutation_applied_ck CHECK ((stage_code = 'Approved & Applied') = (applied_at IS NOT NULL))
);

CREATE TABLE lms.mutation_survey (
  mutation_id uuid NOT NULL REFERENCES lms.mutation(id) ON DELETE CASCADE,
  survey_id   uuid NOT NULL REFERENCES lms.survey(id) ON DELETE RESTRICT,
  PRIMARY KEY (mutation_id, survey_id)
);

CREATE TABLE lms.mutation_heir (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mutation_id  uuid NOT NULL REFERENCES lms.mutation(id) ON DELETE CASCADE,
  landowner_id uuid NOT NULL REFERENCES lms.landowner(id) ON DELETE RESTRICT,
  relation     text NOT NULL,
  -- Percent of the transferor's holding, not of the parcel. Must total 100.
  share_pct    lms.share_pct NOT NULL,
  UNIQUE (mutation_id, landowner_id)
);
COMMENT ON COLUMN lms.mutation_heir.share_pct IS
  'Percent of the TRANSFEROR''s share, not of the parcel. Heir shares must '
  'total exactly 100%, enforced at COMMIT by lms.tg_mutation_heir_share_total().';

ALTER TABLE lms.survey_ownership_history
  ADD CONSTRAINT survey_ownership_history_mutation_fk FOREIGN KEY (mutation_id)
    REFERENCES lms.mutation(id) ON DELETE RESTRICT;
