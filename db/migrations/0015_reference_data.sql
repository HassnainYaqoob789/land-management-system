-- =====================================================================
-- 0015  Reference data
-- =====================================================================
-- This is structural, not sample: the four provinces, their administrative
-- tiers, the measurement factors, the roles, the approval positions and the
-- workflow definitions. The application cannot function without these rows,
-- so they are a migration rather than a seed script. Fictional demo records
-- live in db/seed/ and are never loaded by a migration.
SET ROLE lms_owner;

INSERT INTO lms.province (code, name, revenue_key_label, revenue_key2_label, centre_lat, centre_lng, display_order) VALUES
  ('SND','Sindh',             'Survey No.', 'Block No.', 26.000000, 68.700000, 1),
  ('BAL','Balochistan',       'Khasra No.', NULL,        29.500000, 67.500000, 2),
  ('PNJ','Punjab',            'Khasra No.', NULL,        31.300000, 72.600000, 3),
  ('KPK','Khyber Pakhtunkhwa','Khasra No. (Rural) / Survey No. (Urban)', NULL, 33.600000, 71.600000, 4);

-- The tiers differ per province; this is the table lms.admin_unit.level is
-- checked against, so a five-level Balochistan tree and a three-level Sindh
-- one are both representable and neither can gain a level it does not have.
INSERT INTO lms.province_level (province_code, depth, name) VALUES
  ('SND',0,'District'), ('SND',1,'Taluka'), ('SND',2,'Deh'),
  ('BAL',0,'District'), ('BAL',1,'Sub-Division'), ('BAL',2,'Tehsil'),
  ('BAL',3,'Sub-Tehsil / Qanungo Halka'), ('BAL',4,'Mouza'),
  ('PNJ',0,'District'), ('PNJ',1,'Tehsil'), ('PNJ',2,'Qanungo Halka'), ('PNJ',3,'Mouza'),
  ('KPK',0,'District'), ('KPK',1,'Sub-Division'), ('KPK',2,'Tehsil'), ('KPK',3,'Mouza');

INSERT INTO lms.measurement_unit (code, name, display_order) VALUES
  ('Acre','Acre',1), ('Kanal','Kanal',2), ('Marla','Marla',3), ('Ghunta','Ghunta',4),
  ('Jireb','Jireb',5), ('Rod','Rod',6), ('Pole','Pole',7), ('Bigha','Bigha',8),
  ('Square Feet','Square Feet',9), ('Square Meter','Square Metre',10), ('Hectare','Hectare',11);

-- Square metres per unit, valid from the start of the system's records.
--
-- Every confirmed factor below is exact, not rounded: the international foot
-- is 0.3048 m by definition, so an acre is 4046.8564224 m² exactly, and each
-- Pakistani sub-unit is a whole fraction of an acre.
--
--   1 acre = 4046.8564224 m²        8 kanal  = 1 acre      160 marla = 1 acre
--   40 ghunta = 1 acre              4 rod    = 1 acre      160 pole  = 1 acre
--
-- Jireb and Bigha vary by district in practice and have not been confirmed by
-- the client; they are marked unconfirmed, which makes api.convert_area()
-- refuse them unless the caller opts in and labels the result provisional.
-- That is the same "to confirm" flag the prototype shows in Settings, moved to
-- the one place a conversion can read it.
INSERT INTO lms.unit_conversion (unit_code, sqm_per_unit, valid_from, is_confirmed, source_ref, note) VALUES
  ('Acre',         4046.8564224000, '1900-01-01', true,  'definition', '1 acre = 4046.8564224 m² exactly (66 x 660 international feet)'),
  ('Kanal',         505.8570528000, '1900-01-01', true,  'definition', '8 kanal = 1 acre'),
  ('Marla',          25.2928526400, '1900-01-01', true,  'definition', '160 marla = 1 acre'),
  ('Ghunta',        101.1714105600, '1900-01-01', true,  'definition', '40 ghunta = 1 acre (Sindh)'),
  ('Rod',          1011.7141056000, '1900-01-01', true,  'definition', '4 rod = 1 acre (Balochistan)'),
  ('Pole',           25.2928526400, '1900-01-01', true,  'definition', '160 pole = 1 acre (Balochistan)'),
  ('Square Feet',     0.0929030400, '1900-01-01', true,  'definition', '1 ft = 0.3048 m exactly'),
  ('Square Meter',    1.0000000000, '1900-01-01', true,  'SI',         'the base unit of this table'),
  ('Hectare',     10000.0000000000, '1900-01-01', true,  'SI',         '1 ha = 10,000 m²'),
  ('Jireb',        2023.4282112000, '1900-01-01', false, 'provisional', 'Sindh; 2 jireb = 1 acre assumed. Varies by district — awaiting client confirmation.'),
  ('Bigha',        2023.4282112000, '1900-01-01', false, 'provisional', 'KPK; 2 bigha = 1 acre assumed. Varies by district — awaiting client confirmation.');

INSERT INTO lms.province_unit (province_code, unit_code, display_order) VALUES
  ('SND','Acre',1), ('SND','Jireb',2), ('SND','Ghunta',3),
  ('BAL','Acre',1), ('BAL','Rod',2),   ('BAL','Pole',3),
  ('PNJ','Acre',1), ('PNJ','Kanal',2), ('PNJ','Marla',3),
  ('KPK','Acre',1), ('KPK','Kanal',2), ('KPK','Bigha',3);

INSERT INTO lms.approval_group (code, name, display_order) VALUES
  ('Land Officer (Field)','Land Officer (Field)',1),
  ('Negotiation Group','Negotiation Group',2),
  ('Legal Advisor','Legal Advisor',3),
  ('Sr. Administrator LMS (Field)','Sr. Administrator LMS (Field)',4),
  ('DM / Team Lead (Field)','DM / Team Lead (Field)',5),
  ('Manager Land (HO)','Manager Land (HO)',6),
  ('Finance Officer','Finance Officer',7),
  ('Internal Audit','Internal Audit',8),
  ('System Administrator','System Administrator',9);

INSERT INTO lms.office (code, name, province_code, is_head_office) VALUES
  ('HO_ISB','Head Office Islamabad', NULL, true),
  ('FO_DHRK','Daharki Field Office', 'SND', false),
  ('OF_KHI','Karachi Office', 'SND', false),
  ('OF_QTA','Quetta Office', 'BAL', false),
  ('OF_REG','Regional Office (other)', NULL, false);

INSERT INTO lms.land_status (code, name, display_order, is_held) VALUES
  ('Proposed','Proposed',1,false),
  ('Under Acquisition','Under Acquisition',2,false),
  ('Acquired','Acquired',3,true),
  ('Leased','Leased',4,true),
  ('Released','Released',5,false),
  ('Disputed','Disputed',6,false);

INSERT INTO lms.project_type (code, name, display_order) VALUES
  ('Well Location','Well Location',1), ('Pipeline','Pipeline',2), ('Access Road','Access Road',3),
  ('Camp / Base','Camp / Base',4), ('Compressor Station','Compressor Station',5),
  ('Processing Facility','Processing Facility',6), ('Seismic Survey','Seismic Survey',7), ('Other','Other',8);

INSERT INTO lms.land_use (code, name, display_order) VALUES
  ('Well Location','Well Location',1), ('Access Road','Access Road',2), ('Pipeline ROW','Pipeline ROW',3),
  ('Flowline','Flowline',4), ('Camp','Camp',5), ('Water Pond','Water Pond',6),
  ('Compressor Station','Compressor Station',7), ('Other','Other',8);

INSERT INTO lms.tree_species (code, name, display_order) VALUES
  ('Babul','Babul (Acacia)',1), ('Neem','Neem',2), ('Sheesham','Sheesham',3), ('Date Palm','Date Palm',4),
  ('Mango','Mango',5), ('Eucalyptus','Eucalyptus',6), ('Kikar','Kikar',7), ('Ber','Ber',8), ('Other','Other',9);

INSERT INTO lms.payment_category (code, name, display_order) VALUES
  ('Lease Rent','Lease Rent',1), ('Crop Compensation','Crop Compensation',2),
  ('Tree Compensation','Tree Compensation',3), ('Land Purchase','Land Purchase',4),
  ('ROW Compensation','ROW Compensation',5), ('Government Lease','Government Lease',6),
  ('Structure / Misc','Structure / Miscellaneous',7), ('Court Deposit','Court Deposit',8);

INSERT INTO lms.title_check_item (code, name, display_order, is_mandatory) VALUES
  ('fard','Fard / Record of Rights (Form VII-B or equivalent)',1,true),
  ('mutation','Latest mutation (Intiqal) verified',2,true),
  ('cnic','CNIC of every owner verified against the revenue record',3,true),
  ('no_encumbrance','No encumbrance or mortgage recorded',4,true),
  ('no_litigation','No pending litigation on the parcel',5,true),
  ('possession','Physical possession confirmed on site',6,true),
  ('boundary','Boundary demarcated and agreed',7,false);

INSERT INTO lms.case_document_item (code, name, display_order, required_when) VALUES
  ('cnic_copies','CNIC copies of all landowners',1,'always'),
  ('fard','Fard / record of rights',2,'always'),
  ('consent','Signed consent / agreement',3,'always'),
  ('bank','Bank details or IBAN certificate',4,'always'),
  ('site_photos','Site photographs',5,'always'),
  ('joint_survey','Joint survey / measurement report',6,'always'),
  ('power_of_attorney','Power of attorney',7,'attorney_present');

INSERT INTO lms.grievance_category (code, name, display_order) VALUES
  ('Compensation Amount','Compensation amount disputed',1),
  ('Payment Delay','Payment delay',2),
  ('Land Damage','Land or crop damage',3),
  ('Access Obstruction','Access obstruction',4),
  ('Ownership Dispute','Ownership dispute',5),
  ('Environmental','Environmental concern',6),
  ('Employment','Local employment',7),
  ('Other','Other',8);

INSERT INTO lms.encroachment_category (code, name, display_order) VALUES
  ('Construction on ROW','Construction on ROW',1),
  ('Cultivation on ROW','Cultivation on ROW',2),
  ('Boundary Encroachment','Boundary encroachment',3),
  ('Unauthorised Access','Unauthorised access',4),
  ('Illegal Tapping','Illegal tapping',5),
  ('Waste Dumping','Waste dumping',6),
  ('Other','Other',7);

INSERT INTO lms.document_category (code, name, display_order, retention_years) VALUES
  ('Title Document','Title document', 1, NULL),
  ('Agreement','Agreement or lease deed', 2, NULL),
  ('CNIC','Identity document', 3, 10),
  ('Bank Detail','Bank detail', 4, 10),
  ('Photograph','Site photograph', 5, 10),
  ('Survey Report','Survey or measurement report', 6, 15),
  ('Court Document','Court document', 7, NULL),
  ('Payment Evidence','Payment evidence', 8, 10),
  ('Correspondence','Correspondence', 9, 7),
  ('Other','Other', 10, 7);
COMMENT ON TABLE lms.document_category IS
  'retention_years NULL = indefinite. Title documents, agreements and court '
  'documents are retained indefinitely because a land title has no expiry; '
  'identity and bank documents are time-limited because holding them longer '
  'than needed is itself a risk.';

INSERT INTO lms.integration_endpoint (code, name, direction, is_enabled, secret_ref, note) VALUES
  ('erp_finance','ERP finance posting','outbound', false, 'lms/erp_finance/credentials',
   'Disabled until the finance system is available. Releases still queue in the outbox.');

-- ---------------------------------------------------------------------
-- Workflows
-- ---------------------------------------------------------------------
INSERT INTO lms.workflow
  (code, entity_table, label, lock_at_stage, allows_cancel, allows_stop,
   edit_only_first_stage, no_delete_after_submit, allows_escalation, sod_mode) VALUES
  ('acquisitions','acquisition','Acquisition / Lease Process','Handover', true, false, false,false,false,'strict'),
  ('cases','compensation_case','Compensation Case','HO Approved',        true, false, true, true, false,'strict'),
  ('leases','lease','Lease / Agreement',NULL,                            false,false, false,false,false,'strict'),
  ('rows','row_corridor','ROW / Pipeline Corridor',NULL,                 false,true,  false,false,false,'strict'),
  ('payments','payment_request','Payment','Released',                    true, true,  true, true, false,'strict'),
  ('dbpfc','dbpfc_estimate','DBPFC Government Land Estimate',NULL,       false,true,  false,false,false,'strict'),
  ('grievances','grievance','Grievance / IIR','Closed',                  false,false, false,false,true, 'strict'),
  ('encroachments','encroachment','Encroachment / ROW Violation','Resolved', false,false,false,false,true,'strict'),
  ('mutations','mutation','Mutation / Succession','Approved & Applied',  true, false, true, true, false,'strict');

INSERT INTO lms.workflow_stage (workflow_code, code, seq, label, step_note, is_terminal) VALUES
  ('acquisitions','Identification',0,'Identification',NULL,false),
  ('acquisitions','Negotiation',1,'Negotiation',NULL,false),
  ('acquisitions','Approval',2,'Approval',NULL,false),
  ('acquisitions','Acquisition / Lease',3,'Acquisition / Lease',NULL,false),
  ('acquisitions','Handover',4,'Handover',NULL,false),
  ('acquisitions','Cancelled',90,'Cancelled',NULL,true),

  ('cases','Prepared',0,'Prepared',NULL,false),
  ('cases','Checked',1,'Checked','Checked by Negotiation Group',false),
  ('cases','Reviewed',2,'Reviewed','Reviewed by Legal Advisor',false),
  ('cases','Verified',3,'Verified','Verified by Sr. Administrator LMS (Field)',false),
  ('cases','Field Approved',4,'Field Approved','Approval 1 — Field (DM / TL)',false),
  ('cases','HO Approved',5,'Kharat Approved (HO / RMS)','Approval 2 — Kharat (HO / RMS)',false),
  ('cases','Cancelled',90,'Cancelled',NULL,true),

  ('leases','Draft',0,'Draft',NULL,false),
  ('leases','Under Review',1,'Under Review',NULL,false),
  ('leases','Approved',2,'Approved',NULL,false),

  ('rows','Draft',0,'Draft',NULL,false),
  ('rows','Under Review',1,'Under Review',NULL,false),
  ('rows','Approved',2,'Approved',NULL,false),
  ('rows','Stopped',91,'Stopped',NULL,true),

  ('payments','Requested',0,'Requested','Payment request initiated',false),
  ('payments','Verified',1,'Verified','Verified by Finance',false),
  ('payments','Released',2,'Released','Released — cheque generated',false),
  ('payments','Cancelled',90,'Cancelled',NULL,true),
  ('payments','Stopped',91,'Stopped',NULL,true),

  ('dbpfc','Estimated',0,'Estimated',NULL,false),
  ('dbpfc','Referred to DBPFC',1,'Referred to DBPFC',NULL,false),
  ('dbpfc','Rate Fixed',2,'Rate Fixed',NULL,false),
  ('dbpfc','Stopped',91,'Stopped',NULL,true),

  ('grievances','Registered',0,'Registered',NULL,false),
  ('grievances','Assigned',1,'Assigned',NULL,false),
  ('grievances','In Progress',2,'In Progress',NULL,false),
  ('grievances','Resolved',3,'Resolved',NULL,false),
  ('grievances','Closed',4,'Closed',NULL,false),

  ('encroachments','Reported',0,'Reported',NULL,false),
  ('encroachments','Assessed',1,'Assessed',NULL,false),
  ('encroachments','Action Approved',2,'Action Approved',NULL,false),
  ('encroachments','Legal Follow-up',3,'Legal Follow-up',NULL,false),
  ('encroachments','Resolved',4,'Resolved',NULL,false),

  ('mutations','Initiated',0,'Initiated',NULL,false),
  ('mutations','Revenue Verified',1,'Revenue Verified','Mutation verified against revenue record',false),
  ('mutations','Legal Cleared',2,'Legal Cleared','Legal heirs / succession cleared',false),
  ('mutations','Approved & Applied',3,'Approved & Applied','Approved — shares transferred',false),
  ('mutations','Cancelled',90,'Cancelled',NULL,true);

-- The approval matrix. Configurable at runtime; these are the defaults the
-- client's workflow documents specify.
INSERT INTO lms.workflow_step_group (workflow_code, to_stage, group_code) VALUES
  ('cases','Checked','Negotiation Group'),
  ('cases','Reviewed','Legal Advisor'),
  ('cases','Verified','Sr. Administrator LMS (Field)'),
  ('cases','Field Approved','DM / Team Lead (Field)'),
  ('cases','HO Approved','Manager Land (HO)'),

  ('payments','Verified','Finance Officer'),
  ('payments','Released','Manager Land (HO)'),

  ('acquisitions','Negotiation','Negotiation Group'),
  ('acquisitions','Negotiation','Land Officer (Field)'),
  ('acquisitions','Approval','DM / Team Lead (Field)'),
  ('acquisitions','Acquisition / Lease','Manager Land (HO)'),
  ('acquisitions','Handover','Sr. Administrator LMS (Field)'),
  ('acquisitions','Handover','Land Officer (Field)'),

  ('leases','Under Review','Sr. Administrator LMS (Field)'),
  ('leases','Under Review','Land Officer (Field)'),
  ('leases','Approved','Manager Land (HO)'),

  ('rows','Under Review','Sr. Administrator LMS (Field)'),
  ('rows','Under Review','Land Officer (Field)'),
  ('rows','Approved','Manager Land (HO)'),

  ('dbpfc','Referred to DBPFC','Sr. Administrator LMS (Field)'),
  ('dbpfc','Referred to DBPFC','Land Officer (Field)'),
  ('dbpfc','Rate Fixed','Manager Land (HO)'),

  ('grievances','Assigned','DM / Team Lead (Field)'),
  ('grievances','Assigned','Manager Land (HO)'),
  ('grievances','In Progress','Land Officer (Field)'),
  ('grievances','In Progress','Sr. Administrator LMS (Field)'),
  ('grievances','In Progress','Legal Advisor'),
  ('grievances','In Progress','Negotiation Group'),
  ('grievances','Resolved','DM / Team Lead (Field)'),
  ('grievances','Resolved','Legal Advisor'),
  ('grievances','Resolved','Sr. Administrator LMS (Field)'),
  ('grievances','Closed','Manager Land (HO)'),

  ('encroachments','Assessed','Sr. Administrator LMS (Field)'),
  ('encroachments','Assessed','Land Officer (Field)'),
  ('encroachments','Action Approved','DM / Team Lead (Field)'),
  ('encroachments','Legal Follow-up','Legal Advisor'),
  ('encroachments','Resolved','Manager Land (HO)'),
  ('encroachments','Resolved','DM / Team Lead (Field)'),

  ('mutations','Revenue Verified','Sr. Administrator LMS (Field)'),
  ('mutations','Revenue Verified','Land Officer (Field)'),
  ('mutations','Legal Cleared','Legal Advisor'),
  ('mutations','Approved & Applied','Manager Land (HO)');

-- ---------------------------------------------------------------------
-- Record code sequences
-- ---------------------------------------------------------------------
DO $$
DECLARE
  spec text[][] := ARRAY[
    ['AREA-','survey_code_seq','6','Survey / parcel'],
    ['USR-','user_code_seq','3','Application user'],
    ['DOC-','document_code_seq','5','Document'],
    ['LSE-','lease_code_seq','5','Lease'],
    ['LN-','lease_no_seq','5','Lease number on a compensation case'],
    ['ROW-','row_code_seq','4','ROW corridor'],
    ['BGT-','budget_code_seq','4','Budget'],
    ['DBP-','dbpfc_code_seq','4','DBPFC estimate'],
    ['LIT-','legal_code_seq','4','Court case'],
    ['MUT-','mutation_code_seq','4','Mutation'],
    ['IMP-','import_code_seq','5','Import batch'],
    ['SND-','landowner_snd_seq','6','Landowner (Sindh)'],
    ['BAL-','landowner_bal_seq','6','Landowner (Balochistan)'],
    ['PNJ-','landowner_pnj_seq','6','Landowner (Punjab)'],
    ['KPK-','landowner_kpk_seq','6','Landowner (Khyber Pakhtunkhwa)'],
    -- Year-stamped templates. lms.next_code_year() creates each year's own
    -- sequence from these the first time that year is used.
    ['CC-YYYY-','case_code_template','4','Compensation case (per year)'],
    ['VCH-YYYY-','voucher_code_template','5','Payment voucher (per year)'],
    ['ACQ-YYYY-','acquisition_code_template','4','Acquisition (per year)'],
    ['GRV-YYYY-','grievance_code_template','4','Grievance (per year)'],
    ['ENC-YYYY-','encroachment_code_template','4','Encroachment (per year)']
  ];
  i integer;
BEGIN
  FOR i IN 1 .. array_length(spec, 1) LOOP
    -- The YYYY rows are templates and carry no sequence of their own.
    IF spec[i][1] NOT LIKE '%YYYY%' THEN
      EXECUTE format('CREATE SEQUENCE lms.%I START WITH 1', spec[i][2]);
    END IF;
    INSERT INTO lms.code_sequence (prefix, seq_name, pad_to, note)
    VALUES (spec[i][1], spec[i][2], spec[i][3]::smallint, spec[i][4]);
  END LOOP;
END $$;

-- Administrative unit codes are province- and tier-specific (SND-DIS-001,
-- BAL-MOU-014), so each province/tier pair gets its own sequence.
DO $$
DECLARE l record; sq text; pfx text;
BEGIN
  FOR l IN SELECT province_code, depth, name FROM lms.province_level ORDER BY 1,2 LOOP
    -- The depth is part of the abbreviation because two tiers can abbreviate
    -- the same: Balochistan has both 'Sub-Division' and 'Sub-Tehsil /
    -- Qanungo Halka', and both start "SUB".
    pfx := l.province_code || '-'
           || upper(substr(regexp_replace(l.name, '[^A-Za-z]', '', 'g'), 1, 3))
           || l.depth::text || '-';
    sq  := lower(replace(replace(pfx, '-', '_'), ' ', '')) || 'seq';
    EXECUTE format('CREATE SEQUENCE IF NOT EXISTS lms.%I START WITH 1', sq);
    INSERT INTO lms.code_sequence (prefix, seq_name, pad_to, note)
    VALUES (pfx, sq, 3, l.province_code || ' ' || l.name)
    ON CONFLICT (prefix) DO NOTHING;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- System settings
-- ---------------------------------------------------------------------
INSERT INTO lms.system_setting (key, value, value_type, description) VALUES
  ('company.name',  '"Mari Energies Limited"'::jsonb, 'string', 'Company name on generated documents'),
  ('company.head_office', '"Islamabad"'::jsonb, 'string', 'Head office location'),
  ('finance.wht_pct', '10'::jsonb, 'number',
   'Default withholding-tax percentage applied to payment vouchers'),
  ('finance.currency', '"PKR"'::jsonb, 'string', 'Reporting currency. All amounts are stored in this currency only.'),
  ('workflow.sod_mode', '"strict"'::jsonb, 'string',
   'strict = the preparer and earlier approvers cannot approve a later step'),
  ('workflow.admin_override', 'false'::jsonb, 'boolean',
   'When true an Admin may approve a step their position does not cover. Every override is recorded in lms.workflow_transition.'),
  ('alerts.lease_expiry_days', '[180, 90, 60, 30]'::jsonb, 'array',
   'Days before lease expiry at which alerts are raised'),
  ('alerts.row_renewal_days', '[60, 30]'::jsonb, 'array',
   'Days before a ROW yearly renewal at which alerts are raised'),
  ('grievance.target_days', '15'::jsonb, 'number', 'Target resolution time for a grievance'),
  ('security.session_minutes', '60'::jsonb, 'number', 'Idle session lifetime in minutes'),
  ('security.max_failed_logins', '5'::jsonb, 'number', 'Failed attempts before an account is locked out'),
  ('security.password_min_length', '12'::jsonb, 'number', 'Minimum password length enforced by the application tier'),
  ('retention.audit_years', '10'::jsonb, 'number',
   'Years audit events are retained before archival. See docs/DATABASE_ENGINEERING_REPORT.md.');
