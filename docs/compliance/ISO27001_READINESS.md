# ISO/IEC 27001 readiness

## What this document is and is not

ISO/IEC 27001 certifies an **information security management system** — a set
of organisational processes, with assigned responsibilities, documented risk
decisions, internal audits and management review. It does not certify
software, and no amount of code produces it.

This document is a readiness assessment of the **technical evidence** that an
ISO 27001-aligned ISMS would draw on, as it stands after the database phase. It
maps what exists to the relevant Annex A controls of **ISO/IEC 27001:2022**,
and it is explicit about the far larger set of clauses and controls that
require organisational work nobody has started.

**Nothing here constitutes certification, an audit, or a statement that the
organisation is certifiable.** No certification body has been engaged, no
internal audit has been performed, and no management review has taken place.

Assessed 2026-10-27, against the repository as it stands.

## The overall position in one paragraph

The database layer provides genuine, tested technical evidence for a subset of
Annex A — principally access control (A.5.15–A.5.18, A.8.2–A.8.4), logging
(A.8.15), secure development (A.8.25–A.8.32) and data integrity. It provides
nothing for the management-system clauses (4 through 10), which are where
certification is actually decided, and nothing for the controls that depend on
infrastructure and people. A fair summary: **useful evidence for perhaps a
fifth of Annex A, and none of the ISMS itself.**

---

## Clauses 4–10: the management system

These are the clauses a certification audit spends most of its time on, and
**none of them is addressed by this work**. They are listed so the gap is not
mistaken for an oversight.

| Clause | What it requires | State |
| --- | --- | --- |
| 4 | Context, interested parties, ISMS scope | Not started |
| 5 | Leadership, policy, assigned roles | Not started — no information security policy, no appointed owner |
| 6 | Risk assessment and treatment, Statement of Applicability, objectives | Partial: [SECURITY_FINDINGS.md](../SECURITY_FINDINGS.md) is a risk register input with severities and owners-by-role, but there is no methodology, no risk acceptance criteria, no SoA, and no named person has accepted any risk |
| 7 | Competence, awareness, training, documented information | Not started |
| 8 | Operational planning and control | Partial: change control over the schema is real and tested; nothing else |
| 9 | Monitoring, measurement, internal audit, management review | Not started |
| 10 | Nonconformity, corrective action, continual improvement | Not started |

---

## Annex A: control-by-control

Status values: **Technical evidence** — implemented and tested, and an auditor
could be shown it. **Partial** — some evidence, with a stated gap.
**Not met** — nothing. **Organisational** — cannot be satisfied by code.

### A.5 Organisational controls

| Control | Status | Evidence / gap |
| --- | --- | --- |
| A.5.1 Policies for information security | Not met | No policy document |
| A.5.2 Roles and responsibilities | Partial | Role definitions exist technically (`lms.app_role`, `lms.approval_group`, the four database roles); no organisational assignment |
| A.5.3 Segregation of duties | **Technical evidence** | Enforced, not just described: `api.advance_workflow` refuses an approval from the record's preparer or from anyone who approved an earlier step; the approval matrix (`lms.workflow_step_group`) decides which position may approve which step. The demo seed walks a compensation case through six different people because it cannot be done with fewer. `db/tests/test_04_financial.sql` |
| A.5.7 Threat intelligence | Not met | — |
| A.5.9 Inventory of information and assets | Partial | Data classification in [SECURITY_ARCHITECTURE.md](../security/SECURITY_ARCHITECTURE.md); schema inventory in [DATABASE_ENGINEERING_REPORT.md](../DATABASE_ENGINEERING_REPORT.md). No organisational asset register |
| A.5.10 Acceptable use | Organisational | — |
| A.5.12 Classification of information | **Technical evidence** | Seven classes, each with the controls applied to it; column-level grants and masked views implement the distinction |
| A.5.13 Labelling | Partial | `lms.document_category` carries a retention period per class; `lms.unit_conversion.is_confirmed` labels provisional data; `api.v_province_summary_cached` labels its own staleness. No general labelling scheme |
| A.5.15 Access control | **Technical evidence** | Row-level security on 52 tables; four least-privilege roles; column-level withholding. `test_06`, `test_10` |
| A.5.16 Identity management | Partial | `lms.app_user` with status, role, groups, province access; the service account has no password and cannot be given one. Joiner/mover/leaver is organisational and the application tier does not exist |
| A.5.17 Authentication information | Partial | Verifier format enforced by CHECK; session tokens stored only as SHA-256; no credential anywhere in the schema. Actual authentication absent (APP-01) |
| A.5.18 Access rights — provisioning, review, removal | Partial | Changes to a user's role or province access are audited (`app_user`, `app_user_province`, `app_user_group` are all audited tables), and an account that has acted on a record cannot be deleted, only suspended, so the trail stays resolvable. No periodic review process |
| A.5.23 Cloud services security | Not met | No deployment |
| A.5.24–A.5.28 Incident management | Not met | No incident process, no detection (DB-09, APP-05). The audit trail would support an investigation; nothing would start one |
| A.5.29 Continuity during disruption | Partial | Backup and restore procedure tested; no continuity plan, no tested failover |
| A.5.30 ICT readiness for continuity | Not met | RTO and RPO are proposed targets only, not validated — see [DATABASE_ENGINEERING_REPORT.md](../DATABASE_ENGINEERING_REPORT.md) |
| A.5.31 Legal and regulatory requirements | Partial | The schema encodes the Land Acquisition Act 1894 case types, provincial revenue vocabulary and the DBPFC constraint. No legal register, and no assessment against Pakistani data-protection expectations |
| A.5.33 Protection of records | **Technical evidence** | Append-only audit events, version history, ownership history, the release ledger and configuration history, each protected by both grants and triggers; retention periods per document category. `test_08`. Limit at DB-02 |
| A.5.34 Privacy and PII | Partial | PII identified and column-restricted; CNIC masked for reporting; document reads logged. No privacy notice, no lawful-basis record, no data subject process |
| A.5.35 Independent review | Not met | Nobody outside this work has reviewed it |
| A.5.36 Compliance with policies | Not met | No policies to comply with |
| A.5.37 Documented operating procedures | Partial | Migration, rebuild, test, backup-verify and refresh procedures are scripted and documented; the administrative-correction procedure is written as a test (`test_15_maintenance.sql`). No operations manual |

### A.6 People controls

| Control | Status | Evidence / gap |
| --- | --- | --- |
| A.6.1–A.6.8 | **Organisational** | Screening, terms of employment, awareness and training, disciplinary process, post-employment responsibilities, confidentiality agreements, remote working, event reporting. None addressable by code; none started |

### A.7 Physical controls

| Control | Status | Evidence / gap |
| --- | --- | --- |
| A.7.1–A.7.14 | **Organisational / infrastructure** | No deployment environment exists, so there is nothing to secure physically. Note A.7.10 (storage media) and A.7.14 (secure disposal) will apply to backup media once DB-07 is addressed |

### A.8 Technological controls

This is where the database work concentrates.

| Control | Status | Evidence / gap |
| --- | --- | --- |
| A.8.1 User endpoint devices | Not met | — |
| A.8.2 Privileged access rights | **Technical evidence** | `lms_owner` owns everything and cannot log in; migration privileges are separate from runtime privileges; the application holds no DDL and no privilege on the audit or ledger tables; `api.apply_mutation` is not callable by the application at all. `test_10` (61 assertions against the catalogue) |
| A.8.3 Information access restriction | **Technical evidence** | Province policies plus column-level withholding; `security_invoker` views so a view cannot be a way round a policy; four documented owner-rights exceptions with the predicate restated and asserted equal. `test_05`, `test_06` |
| A.8.4 Access to source code | Not met | No repository access controls in scope here |
| A.8.5 Secure authentication | Not met | APP-01 |
| A.8.6 Capacity management | Partial | Volume behaviour measured at 368 MB / 296k audit events ([QUERY_PLAN_EVIDENCE.md](../QUERY_PLAN_EVIDENCE.md)); no capacity plan, no connection limits configured |
| A.8.7 Protection against malware | Not met | Upload MIME allowlist and size cap only; no scanning of uploaded documents |
| A.8.8 Management of technical vulnerabilities | Not met | APP-04 |
| A.8.9 Configuration management | **Technical evidence** | Every configuration value in `lms.system_setting`, changed only through `api.set_setting()` (Admin actor required), with before and after values and a reason in append-only `lms.setting_history`. `test_08` |
| A.8.10 Information deletion | Partial | Retention periods per document category; soft delete with a reason for documents; no automated deletion job, and the audit retention target (10 years) is recorded but not enforced |
| A.8.11 Data masking | **Technical evidence** | `api.mask_cnic` keeps the district prefix and check digit only; two masked reporting views; the unmasked equivalents are not granted to the reporting role. `test_05`, `test_10` |
| A.8.12 Data leakage prevention | Partial | Column-level withholding, masked views, no `TEMP` on the database for runtime roles, document reads logged. No egress controls, no DLP |
| A.8.13 Information backup | Partial | Dump, restore and a real comparison of row counts, financial totals, cheque numbers, audit span, schema and migration history — run and passing. Missing: encryption, off-site copies, retention enforcement, PITR (DB-07) |
| A.8.14 Redundancy | Not met | Single instance, no replication |
| A.8.15 Logging | **Technical evidence** | 31 audited tables with field-level diffs and actor attribution; authentication events; document access log; transaction grouping by `txid`. `test_03`, `test_08` |
| A.8.16 Monitoring activities | Not met | DB-09. The data to monitor exists; nothing watches it |
| A.8.17 Clock synchronisation | Not met | Server-side `clock_timestamp()` throughout, which is at least consistent within the database; NTP is an infrastructure matter |
| A.8.18 Use of privileged utility programs | Partial | The administrative-correction path is documented and still audited (`test_15`); no approval gate and no alerting around it |
| A.8.19 Software on operational systems | Not met | No deployment |
| A.8.20–A.8.22 Network security | Not met | DB-03 |
| A.8.23 Web filtering | Not applicable | — |
| A.8.24 Use of cryptography | Partial | SHA-256 for document and token integrity; cryptographically strong UUIDs. No encryption at rest, no key management (DB-07) |
| A.8.25 Secure development lifecycle | Partial | Database changes follow a reviewed, tested, versioned process; no SDLC document, no threat model |
| A.8.26 Application security requirements | Partial | The database's security requirements are stated and tested; the application's are not written |
| A.8.27 Secure system architecture | **Technical evidence** | [SECURITY_ARCHITECTURE.md](../security/SECURITY_ARCHITECTURE.md): defence placed so each control holds when the layer above it is wrong, with the reasoning for each |
| A.8.28 Secure coding | **Technical evidence** | Pinned `search_path` on every routine, asserted; schema-qualified references; no dynamic SQL from caller input; parameterised report routines; exact numeric arithmetic throughout. `test_10` |
| A.8.29 Security testing in development | **Technical evidence** | 16 test files, 400+ assertions, the majority negative — each attempts something that must be refused. `python3 db/tools/run_tests.py` |
| A.8.30 Outsourced development | Not applicable | — |
| A.8.31 Separation of environments | Partial | `lms_dev`, `lms_test` and `lms_perf` are separate databases; demo data is never loaded by a migration and refuses to load over existing data; `lms_test` as a role is documented as never existing in production. No actual production environment to separate from |
| A.8.32 Change management | **Technical evidence** | Forward-only checksummed migrations; editing an applied migration is refused as drift; a failing migration commits nothing; applying in halves reaches an identical schema. `test_16_migration.py` (24 assertions) |
| A.8.33 Test information | **Technical evidence** | All test and demo data is fictional and labelled as such at the top of every seed file; no production data is used |
| A.8.34 Protection during audit testing | Not applicable | — |

---

## Summary by category

| | Controls | Note |
| --- | --- | --- |
| Technical evidence available and tested | 15 | Concentrated in A.5.3, A.5.12, A.5.15, A.5.33, A.8.2, A.8.3, A.8.9, A.8.11, A.8.15, A.8.27–A.8.33 |
| Partial, with a stated gap | 19 | Mostly waiting on the application tier or on infrastructure |
| Not met | 28 | Infrastructure, monitoring, and the whole of A.6 |
| Organisational — not addressable by code | 21 | A.6 entirely, most of A.7, and the policy and review controls in A.5 |

---

## What must happen outside this codebase

Listed because the phase brief asks for it, and because the gap between
"technical controls exist" and "certifiable" is almost entirely here.

1. **Appoint an information security owner.** Nothing below can be assigned
   until somebody owns it.
2. **Write the information security policy** and the supporting topic policies
   (access control, cryptography, backup, incident response, acceptable use).
3. **Define a risk assessment methodology** and risk acceptance criteria, then
   assess formally. [SECURITY_FINDINGS.md](../SECURITY_FINDINGS.md) is an input,
   not an assessment: it has severities but no likelihood, no impact scale and
   no accepted-by signature.
4. **Produce the Statement of Applicability** — every Annex A control, with
   applicable or not and why.
5. **Accept the open risks, by name and date.** Four decisions are waiting;
   see "Risk acceptance" in the findings document. Until they are signed, they
   are open findings and not accepted risks, whatever this repository says.
6. **Scope the ISMS** — which systems, which data, which locations, which
   people.
7. **Staff awareness and training**, including for whoever holds the
   `lms_owner` and superuser credentials.
8. **Supplier and cloud assessments** for the hosting and object-storage
   providers once chosen.
9. **Internal audit programme** and the first internal audit.
10. **Management review**, with records.
11. **Incident response plan**, with roles, and at least one exercise.
12. **Business continuity plan**, with the recovery exercise actually performed
    against the deployed environment rather than a workstation.

## Technical dependencies that block further progress

| Dependency | Blocks |
| --- | --- |
| A deployment environment | A.7 entirely, A.8.19–A.8.22, A.8.14, DB-03 |
| Centralised log collection | A.8.16, A.5.24–A.5.28, DB-09 |
| A secret management service | A.8.24, DB-07 |
| Object storage for documents | A.8.7, DB-08 |
| A CI system | A.8.8, A.8.25, APP-04 |
| The application tier | A.8.5, A.8.26, and most of what an auditor would ask to see |
