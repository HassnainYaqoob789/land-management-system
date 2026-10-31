# SOC 2 readiness

## What a SOC 2 report is, and what this is

A SOC 2 report is issued by an independent CPA firm. A **Type I** report
opines on whether controls are *suitably designed* at a point in time. A
**Type II** report opines on whether they *operated effectively* over a period
— typically three to twelve months — and that distinction is the whole of this
document's honesty.

Nothing here is a SOC 2 report, an examination, or evidence that one would
succeed. No service auditor has been engaged. No examination period has begun.

What this is: a mapping of the technical controls that exist after the
database phase to the **Trust Services Criteria (2017, revised 2022)**,
separating controls that are *implemented* from controls that are
*operationally evidenced*. A working feature is design evidence. Only a record
of that feature having worked, repeatedly, over a period, with somebody
reviewing the record, is operating evidence.

Assessed 2026-10-27.

## Proposed scope

| | |
| --- | --- |
| System | Land Management System — the PostgreSQL database and (when built) the application tier |
| Category: Security (common criteria) | In scope. The system holds identity numbers, bank details and payment records |
| Confidentiality | In scope. Landowner personal and financial data |
| Availability | Proposed in scope, but not supportable today: single instance, no redundancy, untested RTO |
| Processing integrity | Proposed in scope. The strongest area, because the financial invariants are enforced and tested |
| Privacy | Out of scope for a first examination. Requires notice, consent and data-subject processes that do not exist |

## The position in one line

**Design evidence exists for a meaningful subset of the common criteria.
Operating evidence exists for none of them, because nothing has been running.**

| | Implemented (design) | Operationally evidenced |
| --- | --- | --- |
| Security (CC1–CC9) | 14 of 33 points of focus have technical evidence | 0 |
| Confidentiality (C1) | 2 of 2 partially | 0 |
| Processing integrity (PI1) | 4 of 5 | 0 |
| Availability (A1) | 1 of 3 partially | 0 |

---

## CC1 — Control environment

| Criterion | Implemented | Operationally evidenced | Note |
| --- | --- | --- | --- |
| CC1.1 Integrity and ethical values | No | No | Organisational; no code of conduct |
| CC1.2 Board oversight | No | No | Organisational |
| CC1.3 Structure, authority, responsibility | Partial | No | Approval authority is defined *in the system* — `lms.approval_group` and the configurable approval matrix say which position may approve which step, and changes to it are recorded in `lms.workflow_matrix_history`. The organisational structure behind those positions is not documented |
| CC1.4 Competence | No | No | Organisational |
| CC1.5 Accountability | Partial | No | Every change is attributed to a named account and the attribution cannot be rewritten. Performance accountability is organisational |

---

## CC2 — Communication and information

| Criterion | Implemented | Operationally evidenced | Note |
| --- | --- | --- | --- |
| CC2.1 Quality information | **Yes** | No | The audit trail captures who, when, what changed and from what, on 31 tables, with field-level diffs and transaction grouping. It is the information a control review would run on |
| CC2.2 Internal communication of responsibilities | Partial | No | The system tells a user what their role may do and which queue is waiting on them; no policy communication |
| CC2.3 External communication | No | No | Organisational |

---

## CC3 — Risk assessment

| Criterion | Implemented | Operationally evidenced | Note |
| --- | --- | --- | --- |
| CC3.1 Objectives specified | Partial | No | Security objectives stated in [SECURITY_ARCHITECTURE.md](../security/SECURITY_ARCHITECTURE.md); no formal objectives document |
| CC3.2 Risks identified and analysed | Partial | No | [SECURITY_FINDINGS.md](../SECURITY_FINDINGS.md) — 16 findings with severity, layer, owner-by-role, mitigation and residual risk. No likelihood scale, no formal methodology |
| CC3.3 Fraud risk | **Partial, and this is the strong point** | No | Segregation of duties is enforced rather than stated: the preparer of a compensation case cannot approve it, and nobody can approve two steps of the same case. Duplicate and double payments are prevented by constraints that hold under concurrency. Approval overrides by an Admin are permitted only when a setting allows it, and every override is recorded as such in `lms.workflow_transition` |
| CC3.4 Changes affecting controls | Partial | No | Schema change control is real and tested; no process for assessing a change's control impact |

---

## CC4 — Monitoring activities

| Criterion | Implemented | Operationally evidenced | Note |
| --- | --- | --- | --- |
| CC4.1 Evaluations of controls | Partial | No | `python3 db/tools/run_tests.py` is an automated control evaluation — 400+ assertions, mostly negative. It has never been run on a schedule, and nobody reviews the result |
| CC4.2 Deficiencies communicated | No | No | No process |

**This is the sharpest gap in the whole document.** The test suite is exactly
the kind of evidence a Type II examination wants — but a Type II wants it run
on a schedule, with the results retained and reviewed, over the examination
period. One run on a developer machine is design evidence only.

---

## CC5 — Control activities

| Criterion | Implemented | Operationally evidenced | Note |
| --- | --- | --- | --- |
| CC5.1 Control activities selected | **Yes** | No | Documented control-by-control in [DATABASE_SECURITY_REVIEW.md](../DATABASE_SECURITY_REVIEW.md), each with its mechanism, test and limit |
| CC5.2 Technology general controls | **Yes** | No | Role separation, least privilege, change control, logging |
| CC5.3 Policies and procedures deployed | Partial | No | Procedures are scripted (`migrate.py`, `rebuild.sh`, `run_tests.py`, `backup.sh`, `api.refresh_derived`); policies do not exist |

---

## CC6 — Logical and physical access

The most thoroughly implemented family.

| Criterion | Implemented | Operationally evidenced | Note |
| --- | --- | --- | --- |
| CC6.1 Logical access security | **Yes (database)** | No | Row-level security on 52 tables; four least-privilege roles; column-level withholding of CNIC, IBAN, bank, address, verifiers and tokens; `security_invoker` views so a view is not a way round a policy. `test_05`, `test_06`, `test_10` |
| CC6.2 Registration and authorisation of users | Partial | No | `lms.app_user` with status, role, groups and province access; a user cannot alter their own role or province (`WITH CHECK` is Admin-only, and the test asserts a `42501`); every such change is audited. The joiner/mover/leaver process is organisational, and authentication does not exist |
| CC6.3 Access rights managed and reviewed | Partial | No | Changes are recorded and an account that has acted cannot be deleted, only suspended. No periodic access review has been performed, because there have been no users |
| CC6.4 Physical access | Not applicable | — | No environment |
| CC6.5 Disposal of data | Partial | No | Retention periods per document category; no disposal job |
| CC6.6 Boundary protection | No | No | DB-03: TLS not enforced |
| CC6.7 Transmission and movement of data | Partial | No | Session tokens stored only as hashes; document bytes outside the database with a SHA-256 held; no transport encryption (DB-03) |
| CC6.8 Prevention of unauthorised software | Partial | No | Four trusted extensions, each in its own schema; no untrusted procedural language; the application holds no DDL and cannot create a table, schema or trigger — asserted |

---

## CC7 — System operations

| Criterion | Implemented | Operationally evidenced | Note |
| --- | --- | --- | --- |
| CC7.1 Detection of configuration changes | Partial | No | Configuration changes are recorded in append-only `lms.setting_history` with the reason; schema drift is refused by the migration runner. Nothing *detects* an out-of-band change — DB-09 |
| CC7.2 Monitoring for anomalies | **No** | No | DB-09. The data exists (`audit.auth_event` with a partial index on failures, `audit.audit_event.db_role`, `lms.document_access_log`); no collector, no alert, no threshold |
| CC7.3 Evaluation of security events | No | No | No process |
| CC7.4 Incident response | No | No | No plan. The audit trail would support an investigation; nothing would trigger one |
| CC7.5 Recovery from incidents | Partial | No | Backup and restore verified; no incident recovery procedure |

---

## CC8 — Change management

| Criterion | Implemented | Operationally evidenced | Note |
| --- | --- | --- | --- |
| CC8.1 Changes are authorised, designed, tested and approved | **Partial, and genuinely strong on the technical half** | No | Forward-only migrations, one transaction each, SHA-256 recorded, drift refused, a failing migration commits nothing, and applying in two halves reaches a byte-identical schema — all asserted by `test_16_migration.py`. What is missing is the human half: no change request, no approver, no release record. A SOC 2 examiner asks who approved each change, and there is no answer |

---

## CC9 — Risk mitigation

| Criterion | Implemented | Operationally evidenced | Note |
| --- | --- | --- | --- |
| CC9.1 Risk mitigation activities | Partial | No | Mitigations are documented per finding with residual risk stated |
| CC9.2 Vendor and business partner risk | No | No | No assessments; hosting and object storage not chosen |

---

## A1 — Availability

| Criterion | Implemented | Operationally evidenced | Note |
| --- | --- | --- | --- |
| A1.1 Capacity management | Partial | No | Volume behaviour measured ([QUERY_PLAN_EVIDENCE.md](../QUERY_PLAN_EVIDENCE.md)); no capacity plan, no connection limits, no `statement_timeout` |
| A1.2 Backup, recovery, environmental protection | Partial | No | Restore verified by comparison, not assumed. No redundancy, no off-site copies, no encryption, no PITR (DB-07) |
| A1.3 Recovery testing | Partial | No | Tested once, on a workstation, against a demo database. That is not a recovery test of a production system, and the RTO and RPO in [DATABASE_ENGINEERING_REPORT.md](../DATABASE_ENGINEERING_REPORT.md) are proposed targets, explicitly not validated |

**Availability should not be in the scope of a first examination.** A single
instance with no failover cannot support an availability opinion.

---

## C1 — Confidentiality

| Criterion | Implemented | Operationally evidenced | Note |
| --- | --- | --- | --- |
| C1.1 Confidential information is identified and protected | **Partial** | No | Seven data classes identified with the controls per class; CNIC, IBAN, bank, address, verifiers and tokens withheld from the reporting role at column level; masked views for reporting; province scoping on every table; document reads logged. Missing: encryption at rest, transport encryption |
| C1.2 Confidential information is disposed of | Partial | No | Retention periods defined per document category; audit retention target recorded. No disposal process |

---

## PI1 — Processing integrity

The strongest family, and the one where the database work is most directly
relevant.

| Criterion | Implemented | Operationally evidenced | Note |
| --- | --- | --- | --- |
| PI1.1 Processing specifications | **Yes** | No | Workflows are data, not code: `lms.workflow`, `lms.workflow_stage`, `lms.workflow_step_group`. The approval path, the locking stage and the segregation rule are all inspectable in the database |
| PI1.2 Inputs are complete and accurate | **Yes** | No | Domains and CHECK constraints; generated amounts that the client cannot supply; the import pipeline validates every row and refuses to promote a batch with unresolved errors, with an exception per failing line. `test_01`, `test_12` |
| PI1.3 Processing is complete, accurate, timely and authorised | **Yes** | No | One stage at a time; the matrix decides who may; segregation of duties refuses the preparer and earlier approvers; the budget check and stay orders gate the financial steps; a release writes its ledger entry, audit event, workflow decision and outbox message in one transaction or none of them. `test_04`, `test_07` |
| PI1.4 Outputs are complete and accurate | **Partial** | No | Reports are parameterised routines, so the same figure comes out wherever it is run; `api.reconcile()` compares stored totals against their components, allocations against approvals, and voucher stages against the release ledger, and reports mismatches without rewriting anything. Missing: scheduled reconciliation with somebody reviewing the exceptions |
| PI1.5 Inputs and outputs are retained | **Yes** | No | Append-only audit events, version snapshots, ownership history, import staging retained with raw and normalised values side by side, and provenance per imported record |

---

## What turns this into an examinable system

In order. Nothing after step 1 can start without it.

1. **Build the application tier.** There is no system to examine without it.
2. **Deploy it.** CC6.4, CC6.6, A1 and most of CC7 need an environment.
3. **Run the control-evaluation suite on a schedule and keep the results.** The
   single highest-value step for a Type II: `db/tools/run_tests.py` in CI, on
   every change and nightly, with retained output. It converts the existing
   design evidence into operating evidence, over time, at almost no cost.
4. **Run `db/tools/backup.sh verify` on a schedule and keep the comparison
   output.** Same logic: the procedure is already verifiable, it just has to
   be verified repeatedly and the evidence retained.
5. **Run `api.reconcile()` on a schedule and have somebody review the
   exceptions.** The routine deliberately does not fix anything, so a
   reconciliation with nobody reading it is useless. Once reviewed and
   recorded, it is PI1.4 operating evidence.
6. **Stand up log collection and alerting.** CC7.1–CC7.3 are entirely absent
   and cannot be closed from inside the database.
7. **Introduce change requests with a named approver.** CC8.1's technical half
   is done; the human half is missing entirely.
8. **Perform an access review**, record it, and repeat it quarterly.
9. **Write and exercise the incident response plan.** CC7.4.
10. **Define the examination period** and only then engage a service auditor.

## Evidence that would be requested, and whether it could be produced today

| Request | Could it be produced? |
| --- | --- |
| A list of users with access, and their privileges | Yes — `lms.app_user` with roles, groups and provinces |
| Evidence that a terminated user's access was removed | No — no users, no process |
| Evidence of an access review | No |
| Change records for every production change in the period | Partially — `lms_meta.schema_migration` has the what, when and checksum, but no approver |
| Evidence that unauthorised changes were prevented | Yes, as design evidence — the drift refusal and the failing-migration rollback are tested |
| Backup success records for the period | No — no scheduled backups have run |
| Evidence a restore was tested | Yes, once, with the comparison output |
| Security incident records | No |
| Evidence of monitoring and alerting | No |
| Evidence that segregation of duties operated | Yes, as design evidence and in the demo data — a case walked through six people because it cannot be done with fewer. No production history |
| Evidence that no payment was released twice | Yes, as design evidence — a unique constraint plus a concurrency test. The ledger would be the operating evidence once there is one |
