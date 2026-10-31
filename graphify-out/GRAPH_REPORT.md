# Graph Report - lms  (2026-10-30)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 3380 nodes · 8576 edges · 228 communities (109 shown, 119 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 59 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `3b06b90f`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Community 0
- Community 1
- Community 2
- Community 3
- Community 4
- Community 5
- Community 6
- Community 7
- Community 8
- Community 9
- Community 10
- Community 11
- Community 12
- Community 13
- Community 14
- Community 15
- Community 16
- Community 17
- Community 18
- Community 19
- Community 20
- Community 21
- Community 22
- Community 23
- Community 25
- Community 26
- Community 27
- Community 28
- Community 29
- Community 30
- Community 31
- Community 32
- Community 33
- Community 34
- Community 35
- Community 36
- Community 37
- Community 38
- Community 39
- Community 40
- Community 41
- Community 42
- Community 43
- Community 44
- Community 45
- Community 46
- Community 47
- Community 48
- Community 49
- Community 50
- Community 51
- Community 52
- Community 53
- Community 54
- Community 55
- Community 57
- Community 58
- Community 59
- Community 60
- Community 61
- Community 63
- Community 64
- Community 65
- Community 66
- Community 67
- Community 68
- Community 69
- Community 71
- Community 73
- Community 75
- Community 76
- Community 77
- Community 78
- Community 79
- Community 80
- Community 81
- Community 82
- Community 83
- Community 84
- Community 85
- Community 86
- Community 87
- Community 88
- Community 89
- Community 90
- Community 91
- Community 92
- Community 93
- Community 94
- Community 95
- Community 96
- Community 97
- Community 98
- Community 99
- Community 100
- Community 101
- Community 102
- Community 103
- Community 104
- Community 105
- Community 107
- Community 108
- Community 109
- Community 110
- Community 111
- Community 112
- Community 113
- Community 114
- Community 115
- Community 116
- Community 117
- Community 118
- Community 119
- Community 120
- Community 121
- Community 122
- Community 123
- Community 124
- Community 125
- Community 128
- Community 129
- Community 130
- Community 131
- Community 132
- Community 133
- Community 134
- Community 135
- Community 136
- Community 137
- Community 138
- Community 139
- Community 140
- Community 141
- Community 142
- Community 143
- Community 144
- Community 145
- Community 146
- Community 147
- Community 148
- Community 149
- Community 150
- Community 151
- Community 155
- Community 156
- Community 157
- Community 159
- Community 160

## God Nodes (most connected - your core abstractions)
1. `HttpError` - 146 edges
2. `json()` - 101 edges
3. `toResponse()` - 84 edges
4. `Table()` - 77 edges
5. `Loading()` - 73 edges
6. `Shell()` - 71 edges
7. `Field()` - 69 edges
8. `Card()` - 69 edges
9. `protect()` - 66 edges
10. `Modal()` - 65 edges

## Surprising Connections (you probably didn't know these)
- `q()` --indirect_call--> `url()`  [INFERRED]
  scripts/iam/permission_matrix.mjs → src/lib/iam/sso/providers.ts
- `Can()` --calls--> `useCan()`  [EXTRACTED]
  src/components/auth/Can.tsx → src/lib/client/permissions.ts
- `Shell()` --indirect_call--> `humanRole()`  [INFERRED]
  src/components/layout/Shell.tsx → src/components/layout/nav.ts
- `GET` --calls--> `toResponse()`  [EXTRACTED]
  src/app/api/calendar/route.ts → src/lib/iam/http.ts
- `POST` --calls--> `toResponse()`  [EXTRACTED]
  src/app/api/cases/[id]/transition/route.ts → src/lib/iam/http.ts

## Import Cycles
- None detected.

## Communities (228 total, 119 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.09
Nodes (65): react, AuditContent(), AuditPage(), AuditTab, MatrixContent(), MatrixPage(), REPORT_CATALOG, REPORT_GROUPS (+57 more)

### Community 1 - "Community 1"
Cohesion: 0.05
Nodes (54): ImportContent(), ImportPage(), parseCsv(), TARGETS, RFC-4180, Can(), homeFor(), NoAccess() (+46 more)

### Community 2 - "Community 2"
Cohesion: 0.10
Nodes (58): directoryLogin(), POST, POST, POST, isLocked(), Outcome, POST, STALE (+50 more)

### Community 3 - "Community 3"
Cohesion: 0.16
Nodes (64): AcquisitionsContent(), AcquisitionsPage(), EMPTY, BudgetsContent(), BudgetsPage(), EMPTY, thisYear, DbpfcContent() (+56 more)

### Community 4 - "Community 4"
Cohesion: 0.05
Nodes (38): next, GET, normalizeReportingUnit(), GET, GET, KINDS, POST, GET (+30 more)

### Community 5 - "Community 5"
Cohesion: 0.05
Nodes (27): app_user_account_security, app_user_deactivate, group_mapping_guard, iam.actor_covers_role(), iam.authn_lookup(), iam.create_session(), iam.failure_counts(), iam.has_permission() (+19 more)

### Community 6 - "Community 6"
Cohesion: 0.07
Nodes (19): api.v_admin_unit_path, api.v_approval_bottleneck, api.v_audit_trail, api.v_budget_utilisation, api.v_case_status, api.v_dbpfc_summary, api.v_encroachment_status, api.v_grievance_status (+11 more)

### Community 7 - "Community 7"
Cohesion: 0.14
Nodes (43): GET, GET, POST, GET, GET, GET, safeEqual(), ACCOUNT_UNAVAILABLE_MESSAGE (+35 more)

### Community 8 - "Community 8"
Cohesion: 0.12
Nodes (26): otplib, vitest, enrolTotp(), lastIp(), BASE, Client, DB, PW (+18 more)

### Community 9 - "Community 9"
Cohesion: 0.08
Nodes (49): GET, GET, gone, POST, GET, GET, GET, idOf() (+41 more)

### Community 10 - "Community 10"
Cohesion: 0.05
Nodes (34): fs, path, REPORT_FILE, ROOT_DIR, TEST_RESULTS, main(), parseArea(), parseCSV() (+26 more)

### Community 11 - "Community 11"
Cohesion: 0.06
Nodes (14): budget_link_province, document_access_visible, document_guard, land_request_link_province, land_request_tier, legal_case_landowner_link_province, legal_case_survey_link_province, lms.tg_document_access_visible() (+6 more)

### Community 12 - "Community 12"
Cohesion: 0.10
Nodes (26): auth_event_type_idx, challenge_expiry_idx, external_identity_one_per_user_provider, iam.access_review, iam.access_review_item, iam.account_security, iam.auth_provider, iam.challenge (+18 more)

### Community 13 - "Community 13"
Cohesion: 0.05
Nodes (41): description, name, private, version, autoprefixer, bcryptjs, chart.js, clsx (+33 more)

### Community 14 - "Community 14"
Cohesion: 0.11
Nodes (25): GET, POST, POST, cookieSecure, isProd, ISSUER_NAME, OIDC_COOKIE, requireEnv() (+17 more)

### Community 15 - "Community 15"
Cohesion: 0.07
Nodes (64): RFC-4512, POST, connect(), DirectoryAnswer, directoryLookup(), DirectoryPerson, groupNames(), INVALID (+56 more)

### Community 16 - "Community 16"
Cohesion: 0.07
Nodes (9): iam.create_user(), iam.decide_provisioning(), iam.recent_password_hashes(), iam.redeem_token(), iam.set_policy(), iam.tg_provider_lockout(), iam.tg_require_release(), payment_release_requires_permission (+1 more)

### Community 17 - "Community 17"
Cohesion: 0.21
Nodes (30): refusalText(), text(), uuid(), anonymise(), assignRole(), breakGlass(), bulkAssign(), bulkRefused() (+22 more)

### Community 18 - "Community 18"
Cohesion: 0.16
Nodes (17): EMPTY, LandownersPage(), OWNER_TYPE, PII, statementHtml(), EMPTY, surveyRecord(), SurveysContent() (+9 more)

### Community 19 - "Community 19"
Cohesion: 0.08
Nodes (18): ldapjs, oidc-provider, smtp-server, APP, CA, esc(), lds, oidc (+10 more)

### Community 20 - "Community 20"
Cohesion: 0.09
Nodes (14): calculateFBRTax(), calculateTax(), convertArea(), MeasurementUnit, OwnerShareInput, PROVINCES, PROVINCIAL_HIERARCHIES, SQFT_FACTORS (+6 more)

### Community 21 - "Community 21"
Cohesion: 0.07
Nodes (13): api.case_liability(), api.case_settlement(), case_adjustment_append_only, case_adjustment_audit, case_adjustment_case_idx, import_row_area_unit_required, import_row_recorded_area, lms.case_adjustment (+5 more)

### Community 22 - "Community 22"
Cohesion: 0.12
Nodes (25): AccountSecurityPage(), Authenticator(), ChangePassword(), Me, post(), RecoveryCodes(), ForgotPasswordPage(), Done (+17 more)

### Community 23 - "Community 23"
Cohesion: 0.09
Nodes (53): GET, PUT, codeOf(), GET, PATCH, POST, actorTier(), fail() (+45 more)

### Community 25 - "Community 25"
Cohesion: 0.18
Nodes (21): lms.acquisition, lms.acquisition_survey, lms.acquisition_title_check, lms.case_crop_line, lms.case_document_check, lms.case_document_item, lms.case_lease_line, lms.case_misc_line (+13 more)

### Community 27 - "Community 27"
Cohesion: 0.09
Nodes (58): GET, POST, PUT, GET, POST, PUT, GET, POST (+50 more)

### Community 28 - "Community 28"
Cohesion: 0.18
Nodes (17): lms.budget, lms.dbpfc_estimate, lms.dbpfc_rate_history, lms.dbpfc_survey, lms.idempotency_key, lms.payment_allocation, lms.payment_category, lms.payment_hold (+9 more)

### Community 29 - "Community 29"
Cohesion: 0.16
Nodes (12): api.v_data_quality_audit, api.v_executive_kpis, api.v_finance_aging, api.v_gis_coverage, api.v_project_portfolio, idx_kml_import_proj, idx_spatial_feat_project, idx_spatial_feat_survey (+4 more)

### Community 30 - "Community 30"
Cohesion: 0.14
Nodes (11): iam.actor_covers_role(), iam.has_permission(), iam.other_working_admin_exists(), iam.passkey_record_use(), iam.provider_runtime(), iam.set_user_status(), iam.signin_methods(), iam.tg_role_permission_guard() (+3 more)

### Community 31 - "Community 31"
Cohesion: 0.09
Nodes (8): api.acre_ghunta(), api.set_actor(), api.validate_ownership_shares(), api.validate_survey_area(), lms.actor_groups(), lms.actor_provinces(), lms.actor_role(), lms.next_code()

### Community 32 - "Community 32"
Cohesion: 0.09
Nodes (10): admin_unit_parent_ck, audit.tg_audit_row(), case_crop_line_locked_ck, case_misc_line_locked_ck, case_tree_line_locked_ck, lms.tg_admin_unit_parent(), lms.tg_setting_history(), project_district_level_ck (+2 more)

### Community 33 - "Community 33"
Cohesion: 0.10
Nodes (35): awardSheetHtml(), CasesContent(), CasesPage(), draftOf(), problem(), s(), signedAmount(), CaseDraft (+27 more)

### Community 34 - "Community 34"
Cohesion: 0.08
Nodes (24): devDependencies, autoprefixer, @axe-core/playwright, eslint, eslint-config-next, @eslint/eslintrc, ldapjs, oidc-provider (+16 more)

### Community 35 - "Community 35"
Cohesion: 0.11
Nodes (33): maplibre-gl, ArchContent(), ArchPage(), LAYERS, RULES, CalendarContent(), CalendarEvent, CalendarPage() (+25 more)

### Community 36 - "Community 36"
Cohesion: 0.19
Nodes (13): nextkey(), nextperiod(), ok(), psql(), race(), go(), scalar(), setup_voucher() (+5 more)

### Community 37 - "Community 37"
Cohesion: 0.09
Nodes (23): dependencies, adm-zip, bcryptjs, chart.js, clsx, ldapts, lucide-react, maplibre-gl (+15 more)

### Community 38 - "Community 38"
Cohesion: 0.07
Nodes (20): @axe-core/playwright, @playwright/test, g, grants, lines, pages, perms, q() (+12 more)

### Community 39 - "Community 39"
Cohesion: 0.19
Nodes (10): api.rpt_acquisition, api.rpt_dbpfc, api.rpt_exec_project, api.rpt_exec_province, api.rpt_lease, api.v_executive_kpis, api.v_gis_coverage, api.v_project_portfolio (+2 more)

### Community 40 - "Community 40"
Cohesion: 0.21
Nodes (13): applied(), cmd_status(), cmd_up(), cmd_verify(), discover(), _lit(), main(), psql() (+5 more)

### Community 41 - "Community 41"
Cohesion: 0.19
Nodes (11): lms.encroachment, lms.encroachment_category, lms.grievance, lms.grievance_category, lms.legal_case, lms.legal_case_landowner, lms.legal_case_survey, lms.legal_hearing (+3 more)

### Community 42 - "Community 42"
Cohesion: 0.18
Nodes (18): audit.audit_event, audit.auth_event, audit_event_actor_idx, audit_event_at_idx, audit_event_record_idx, audit_event_txid_idx, audit.record_version, auth_event_failed_idx (+10 more)

### Community 43 - "Community 43"
Cohesion: 0.10
Nodes (5): api.advance_workflow(), lms.wf_guard_acquisitions(), lms.wf_guard_cases(), lms.wf_guard_mutations(), lms.wf_guard_payments()

### Community 44 - "Community 44"
Cohesion: 0.12
Nodes (14): case_crop_line_survey_idx, dbpfc_project_idx, document_entity_idx, encroachment_open_idx, encroachment_row_idx, encroachment_survey_idx, payment_receipt_release_idx, payment_request_case_idx (+6 more)

### Community 45 - "Community 45"
Cohesion: 0.12
Nodes (10): access_review_audit, access_review_item_audit, access_review_started_idx, iam.role_history(), iam.tg_role_guard_status(), iam.tg_role_permission_cover(), iam.tg_user_role_log(), role_guard_status (+2 more)

### Community 46 - "Community 46"
Cohesion: 0.18
Nodes (19): blank(), canSeePii(), empty(), EXACT, guardPiiWrite(), isMasked(), keepLast(), Kind (+11 more)

### Community 47 - "Community 47"
Cohesion: 0.10
Nodes (10): audit_event_append_only, audit.tg_append_only(), auth_event_append_only, dbpfc_rate_history_append_only, legal_case_stay_sync, lms.tg_legal_case_stay(), record_version_append_only, setting_history_append_only (+2 more)

### Community 48 - "Community 48"
Cohesion: 0.13
Nodes (5): api.promote_import_batch(), api.report_approval_turnaround(), api.report_landowner_statement(), api.report_payment_register(), api.validate_import_batch()

### Community 49 - "Community 49"
Cohesion: 0.14
Nodes (4): api.v_executive_kpis, api.v_finance_aging, api.v_project_portfolio, pg_temp.grant_perm()

### Community 50 - "Community 50"
Cohesion: 0.11
Nodes (9): lms.report_export_job, lms.report_unit(), lms.report_unit_default, lms.uom_factor(), report_export_job_owner_idx, report_template_audit, report_template_stamp, report_unit_default_audit (+1 more)

### Community 51 - "Community 51"
Cohesion: 0.10
Nodes (14): acquisition_title_check_terms_frozen, case_crop_line_link_province, case_crop_line_terms_frozen, case_misc_line_link_province, case_misc_line_terms_frozen, case_tree_line_link_province, case_tree_line_terms_frozen, dbpfc_survey_link_province (+6 more)

### Community 52 - "Community 52"
Cohesion: 0.19
Nodes (12): api.set_setting(), iam.holds_system_admin(), iam.is_approval_position(), iam.leave_system_context(), iam.mfa_required_for(), iam.sync_db_role(), iam.tg_role_permission_guard(), iam.tg_user_role_guard() (+4 more)

### Community 53 - "Community 53"
Cohesion: 0.24
Nodes (13): api.budget_status(), api.report_landowner_statement(), api.rpt_allocation, api.rpt_case_owner, api.rpt_person, api.rpt_voucher, api.v_finance_aging, lms.case_owner_money (+5 more)

### Community 54 - "Community 54"
Cohesion: 0.25
Nodes (13): actor_and_province(), cmd_build(), cmd_index(), cmd_measure(), cmd_report(), cmd_sizes(), collect(), collect_index() (+5 more)

### Community 55 - "Community 55"
Cohesion: 0.16
Nodes (16): adm-zip, pdfkit, logoBytes(), PdfColumn, PdfTable, renderPdf(), cellXml(), colName() (+8 more)

### Community 57 - "Community 57"
Cohesion: 0.15
Nodes (5): api.apply_mutation(), api.budget_status(), api.case_liability(), api.reconcile(), api.request_payment()

### Community 58 - "Community 58"
Cohesion: 0.12
Nodes (12): api.v_case_status, api.v_outstanding_liability, case_approved_idx, case_owner_landowner_idx, case_project_stage_idx, case_province_stage_date_idx, landowner_father_trgm_idx, landowner_name_trgm_idx (+4 more)

### Community 59 - "Community 59"
Cohesion: 0.22
Nodes (4): pg, fromEnv, username, { Pool }

### Community 60 - "Community 60"
Cohesion: 0.11
Nodes (18): compilerOptions, allowJs, esModuleInterop, incremental, isolatedModules, jsx, lib, module (+10 more)

### Community 61 - "Community 61"
Cohesion: 0.24
Nodes (16): lms.admin_unit, lms.app_role, lms.app_user, lms.app_user_group, lms.app_user_province, lms.approval_group, lms.code_sequence, lms.measurement_unit (+8 more)

### Community 63 - "Community 63"
Cohesion: 0.12
Nodes (16): Aggregate, CatalogResult, ColumnOut, DatasetInfo, ExportFormat, FieldInfo, FieldType, FilterOp (+8 more)

### Community 64 - "Community 64"
Cohesion: 0.28
Nodes (11): lms.workflow, lms.workflow_assignment, lms.workflow_comment, lms.workflow_escalation, lms.workflow_matrix_history, lms.workflow_stage, lms.workflow_step_group, lms.workflow_transition (+3 more)

### Community 65 - "Community 65"
Cohesion: 0.23
Nodes (13): data_provenance_key_uq, import_batch_source_uq, import_row_batch_status_idx, import_validation_error_batch_idx, integration_outbox_due_idx, lms.data_provenance, lms.import_batch, lms.import_row (+5 more)

### Community 66 - "Community 66"
Cohesion: 0.13
Nodes (7): iam.public_providers(), iam.token_subject(), land_request_sod, lms.tg_land_request_sod(), pg_temp.grant_perm(), project_gis_merge_audit, project_kml_import_audit

### Community 67 - "Community 67"
Cohesion: 0.12
Nodes (12): acquisition_link_province, acquisition_stage_guard, acquisition_terms_frozen, encroachment_link_province, encroachment_stage_guard, grievance_link_province, grievance_stage_guard, lms.tg_workflow_stage_guard() (+4 more)

### Community 68 - "Community 68"
Cohesion: 0.36
Nodes (12): drop_db(), make_db(), migrate(), ok(), psql(), schema_fingerprint(), sh(), status() (+4 more)

### Community 69 - "Community 69"
Cohesion: 0.12
Nodes (16): scripts, build, db:ingest:reference, dev, lint, start, test, test:a11y (+8 more)

### Community 71 - "Community 71"
Cohesion: 0.30
Nodes (10): lms.land_status, lms.landowner, lms.project, lms.project_survey, lms.project_type, lms.survey, lms.survey_ownership_history, lms.survey_ownership_share (+2 more)

### Community 73 - "Community 73"
Cohesion: 0.30
Nodes (13): GET, POST, PUT, cleanFileName(), DOCUMENT_ENTITIES, IntegrityError, MAX_DOCUMENT_BYTES, pathFor() (+5 more)

### Community 75 - "Community 75"
Cohesion: 0.15
Nodes (4): api.v_payment_release, api.v_record_version_history, lms.user_full_name(), lms.user_username()

### Community 76 - "Community 76"
Cohesion: 0.26
Nodes (11): GET, POST, calculatePolygonAreaSqm(), escapeXml(), generateMergedKmlXml(), KmlError, KmlParseResult, parseCoordinateList() (+3 more)

### Community 77 - "Community 77"
Cohesion: 0.24
Nodes (10): sendMail(), ConfigState, deliver(), mailConfigured(), MailFailure, MailMessage, MailResult, SmtpConfig (+2 more)

### Community 78 - "Community 78"
Cohesion: 0.24
Nodes (4): dump_pdf(), convert(), main(), match_brace()

### Community 79 - "Community 79"
Cohesion: 0.19
Nodes (7): api.rpt_exception, api.v_data_quality_audit, case_lease_line_commitment_ck, lms.hold_for(), lms.project_parcel, lms.survey_committed_area(), payment_receipt_audit

### Community 80 - "Community 80"
Cohesion: 0.33
Nodes (10): admin_id(), ok(), psql(), test_application_login(), test_holder_separation_of_duties(), test_provisioning_context(), test_reporting_login(), test_tier_follows_expiry() (+2 more)

### Community 81 - "Community 81"
Cohesion: 0.17
Nodes (10): C, failed, GETS, N, payees, pct(), PW, results (+2 more)

### Community 83 - "Community 83"
Cohesion: 0.17
Nodes (8): compensation_case_link_province, compensation_case_stage_guard, compensation_case_terms_frozen, landowner_pay_details, lms.tg_landowner_pay_details(), lms.tg_payment_hold_scope(), project_link_province, survey_link_province

### Community 84 - "Community 84"
Cohesion: 0.31
Nodes (8): bodyOf(), forgot(), forRecipient(), linkFor(), mailbox(), redeem(), requestLink(), sleep()

### Community 85 - "Community 85"
Cohesion: 0.17
Nodes (6): validate-agents.sh script, validate-all.sh script, validate-encoding.sh script, validate-skills.sh script, validate-templates.sh script, validate-workflows.sh script

### Community 86 - "Community 86"
Cohesion: 0.20
Nodes (7): case_lease_line_area_ck, case_lease_line_locked_ck, dbpfc_survey_class_ck, lms.tg_case_lease_line_area(), lms.tg_dbpfc_survey_class(), lms.tg_ownership_share_total(), ownership_share_total_ck

### Community 87 - "Community 87"
Cohesion: 0.18
Nodes (7): admin_unit_marks_path_stale, admin_unit_parent_idx, api.v_project_land_status, lms.tg_mark_derived_stale(), project_survey_survey_idx, survey_admin_unit_idx, survey_province_status_idx

### Community 88 - "Community 88"
Cohesion: 0.25
Nodes (6): api.allocate_payment(), api.rpt_case, api.v_approval_bottleneck, api.v_case_status, api.v_outstanding_liability, lms.record_province()

### Community 90 - "Community 90"
Cohesion: 0.20
Nodes (7): case_lease_line_link_province, case_lease_line_terms_frozen, lease_link_province, lease_stage_guard, lease_terms_frozen, lms.wf_guard_payments(), payment_hold_scope

### Community 91 - "Community 91"
Cohesion: 0.25
Nodes (4): audit.tg_audit_row(), iam.tg_secret_audit(), pg_temp.grant_perm(), secret_audit

### Community 92 - "Community 92"
Cohesion: 0.28
Nodes (3): api.v_case_status, api.v_outstanding_liability, lms.case_settlement_totals

### Community 93 - "Community 93"
Cohesion: 0.22
Nodes (7): app_user_group_protect, app_user_group_sod, app_user_province_protect, iam.tg_position_sod(), lms.actor_groups(), lms.actor_provinces(), lms.tg_membership_protect()

### Community 94 - "Community 94"
Cohesion: 0.22
Nodes (5): legal_case_link_province, legal_case_stay_authority, lms.record_closed(), lms.wf_first_stage(), lms.wf_terms_frozen()

### Community 96 - "Community 96"
Cohesion: 0.36
Nodes (6): GET, NF, NF2, csvCell(), csvRow(), RFC-4180

### Community 98 - "Community 98"
Cohesion: 0.25
Nodes (6): api.lift_stay(), case_owner_link_province, case_owner_terms_frozen, payment_request_link_province, payment_request_payee_snapshot, payment_request_payee_unchanged

### Community 99 - "Community 99"
Cohesion: 0.25
Nodes (7): pf_approved, pf_case, pf_dist, pf_lo, pf_mouza, pf_proj, pf_surv

### Community 100 - "Community 100"
Cohesion: 0.50
Nodes (3): https, nextConfig, security

### Community 101 - "Community 101"
Cohesion: 0.29
Nodes (5): case_locked_ck, case_owner_locked_ck, case_owner_share_total_ck, lms.tg_case_locked(), lms.tg_case_owner_share_total()

### Community 102 - "Community 102"
Cohesion: 0.29
Nodes (4): lms.tg_allocation_limits(), lms.tg_mutation_heir_share_total(), mutation_heir_not_transferor_ck, mutation_heir_share_total_ck

### Community 103 - "Community 103"
Cohesion: 0.33
Nodes (4): api.case_settlement(), api.report_compensation_summary(), payment_allocation_case_idx, payment_release_cheque_date_idx

### Community 105 - "Community 105"
Cohesion: 0.33
Nodes (3): pg_temp.t21_case(), pg_temp.t21_release(), pg_temp.t21_voucher()

### Community 108 - "Community 108"
Cohesion: 0.33
Nodes (4): lease_propagate_to_surveys, lease_survey_range_sync, lms.tg_lease_propagate(), lms.tg_lease_survey_range()

### Community 109 - "Community 109"
Cohesion: 0.33
Nodes (5): api.set_actor(), app_user_protect, lms.tg_app_user_protect(), lms.user_full_name(), lms.user_username()

### Community 110 - "Community 110"
Cohesion: 0.33
Nodes (5): dbpfc_estimate_link_province, dbpfc_estimate_stage_guard, dbpfc_estimate_terms_frozen, dbpfc_rate_authority, lms.tg_dbpfc_rate_authority()

### Community 111 - "Community 111"
Cohesion: 0.40
Nodes (3): api.rpt_ownership, api.rpt_parcel, lms.admin_unit_lineage

### Community 112 - "Community 112"
Cohesion: 0.53
Nodes (5): config(), main(), OutboxRow, post(), processOutboxQueue()

### Community 113 - "Community 113"
Cohesion: 0.53
Nodes (4): GET, LOOKUPS, parseEnumCheck(), Reference

### Community 115 - "Community 115"
Cohesion: 0.40
Nodes (3): lms.tg_payment_locked(), payment_locked_ck, payment_release_append_only

### Community 116 - "Community 116"
Cohesion: 0.70
Nodes (4): check_fd(), check_ripgrep(), setup_search.sh script, suggest_install()

### Community 117 - "Community 117"
Cohesion: 0.50
Nodes (3): dbpfc_district_level_ck, dbpfc_rate_history_write, lms.tg_dbpfc_rate_history()

### Community 118 - "Community 118"
Cohesion: 0.50
Nodes (3): admin_unit_path_pk, admin_unit_path_province_idx, api.v_admin_unit_path

### Community 119 - "Community 119"
Cohesion: 0.50
Nodes (3): grievance_landowner_idx, grievance_open_idx, grievance_project_idx

### Community 120 - "Community 120"
Cohesion: 0.50
Nodes (3): lease_case_idx, lease_expiry_idx, lease_project_idx

### Community 121 - "Community 121"
Cohesion: 0.50
Nodes (3): lms.tg_ownership_share_guard(), ownership_share_guard, survey_ownership_share_link_province

### Community 122 - "Community 122"
Cohesion: 0.50
Nodes (3): mutation_link_province, mutation_stage_guard, mutation_terms_frozen

### Community 125 - "Community 125"
Cohesion: 0.67
Nodes (3): BASE_URL, run_all_checks.sh script, step()

## Knowledge Gaps
- **26 isolated node(s):** `RFC-4180`, `BASE_URL`, `autoprefixer`, `clsx`, `eslint` (+21 more)
  These have ≤1 connection - possible missing edges. (Counts symbols only; 1270 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **119 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `next` connect `Community 4` to `Community 96`, `Community 1`, `Community 2`, `Community 35`, `Community 100`, `Community 0`, `Community 38`, `Community 7`, `Community 73`, `Community 76`, `Community 13`, `Community 15`, `Community 82`, `Community 22`, `Community 27`?**
  _High betweenness centrality (0.051) - this node is a cross-community bridge._
- **What connects `RFC-4180`, `BASE_URL`, `autoprefixer` to the rest of the system?**
  _26 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.09093646492020475 - nodes in this community are weakly interconnected._
- **Why does `react` connect `Community 0` to `Community 33`, `Community 1`, `Community 35`, `Community 3`, `Community 13`, `Community 18`, `Community 22`, `Community 23`?**
  _High betweenness centrality (0.017) - this node is a cross-community bridge._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.053208137715179966 - nodes in this community are weakly interconnected._
- **Why does `HttpError` connect `Community 17` to `Community 96`, `Community 2`, `Community 4`, `Community 73`, `Community 9`, `Community 46`, `Community 15`, `Community 23`, `Community 27`?**
  _High betweenness centrality (0.014) - this node is a cross-community bridge._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.09855403348554033 - nodes in this community are weakly interconnected._