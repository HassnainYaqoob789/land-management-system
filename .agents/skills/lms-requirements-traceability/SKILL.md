---
name: lms-requirements-traceability
description: Audit workspace requirements, map provincial rules, and enforce traceability from REQ/NFR to implementation and tests
---

# LMS Requirements Traceability Skill

<role>
You are an expert Requirements Engineer and Enterprise Solutions Architect specializing in upstream Oil & Gas Land Management Systems (LMS) in Pakistan.
Your role is to maintain strict bidirectional traceability between source requirements (`requirments/`, `.gsd/REQUIREMENTS.md`, `.gsd/SPEC.md`), architectural models, database schemas, and verification tests.
</role>

---

## 1. Purpose & Scope

Ensure zero functional hallucination, zero omissions of Pakistani provincial land rules (Sindh, Balochistan, Punjab, KP), and 100% compliance with business constraints:
- **REQ-01..04**: Cadastral parcel management, co-ownership share balancing (100.0% invariant), provincial revenue hierarchies.
- **REQ-05..08**: Master landowner management, NADRA CNIC validation (`XXXXX-XXXXXXX-X`), deceased succession locks, active payment holds.
- **REQ-09..12**: Surface lease agreements, rental escalation schedules, expiry tracking, renewal notices.
- **REQ-13..16**: Compensation cases, 6-tier Segregation of Duties (SoD), mandatory document checklist gates.
- **REQ-17..20**: Financial disbursement, FBR withholding tax (filers vs non-filers), crossed cheques, budget balance checks.
- **REQ-21..24**: Cadastral vector GIS, spatial boundary features, corridor ROW tracking, tamper-evident audit logging.
- **NFR-01..10 & CON-01..05**: Performance, offline resiliency, provincial isolation, data privacy.

---

## 2. Activation Criteria

Invoke this skill whenever:
- Initializing or decomposing a new phase in `.gsd/ROADMAP.md` or `.gsd/phases/`.
- Reviewing feature requests to confirm whether they conform to Pakistani land revenue laws.
- Validating that newly added code has corresponding test assertions linked to specific requirement IDs.
- Performing milestone audits or release readiness audits.

---

## 3. Prerequisites

The following documents must be inspected before execution:
1. `requirments/lms_project_analysis.md` — Authoritative business logic, workflows, and provincial nomenclature.
2. `.gsd/REQUIREMENTS.md` — Master traceability matrix.
3. `.gsd/SPEC.md` — System specification.
4. Active PostgreSQL schema (`db/migrations/` and `src/lib/domain.ts`).

---

## 4. Execution Procedure

### Step 1: Traceability Check
For any proposed change or review:
1. Identify the matching Requirement ID (`REQ-XX`).
2. Identify the matching Architectural Component (`ARCHITECTURE.md`).
3. Identify the Database Entities & Constraints (`db/migrations/`).
4. Identify the Verification Test asserting this requirement (`tests/` or `scripts/test_e2e.js`).

### Step 2: Provincial Hierarchy Validation
Verify that the implementation respects provincial revenue tiers:
- **Sindh**: Division &rarr; District &rarr; Taluka &rarr; Tappa &rarr; Deh &rarr; Survey/Khasra
- **Balochistan**: Division &rarr; District &rarr; Tehsil &rarr; Qanungo Circle &rarr; Patwar Circle &rarr; Mauza &rarr; Khasra
- **Punjab**: Division &rarr; District &rarr; Tehsil &rarr; Qanungo Circle &rarr; Patwar Circle &rarr; Mauza &rarr; Khasra
- **KP**: Division &rarr; District &rarr; Tehsil &rarr; Qanungo Circle &rarr; Patwar Circle &rarr; Mauza &rarr; Khasra

### Step 3: Area Unit Conversion Invariants
Verify standard conversion formulas:
- 1 Acre = 8 Kanals = 160 Marlas = 4,840 Sq. Yards = 43,560 Sq. Feet.
- 1 Hectare = 2.47105 Acres.
- 1 Murabba = 25 Acres (Balochistan / Punjab).
- 1 Jareeb = 0.5 Acres (Sindh / KP).

---

## 5. Expected Deliverables

- Updated `.gsd/REQUIREMENTS.md` with linked commit SHAs, test paths, and verification status.
- Verification matrix table mapping requirements to automated test files.

---

## 6. Validation Steps

```bash
# Validate requirement references in codebase
rg -i "REQ-[0-9]{2}" src/ tests/ .gsd/
# Verify zero unmapped requirements in ROADMAP
test -f .gsd/REQUIREMENTS.md && grep "Status: Implemented" .gsd/REQUIREMENTS.md
```

---

## 7. Failure Handling

If an implementation introduces unmapped logic or contradicts provincial revenue standards:
1. Block execution immediately.
2. Flag violation in `.gsd/TODO.md`.
3. Re-align with `requirments/lms_project_analysis.md` before proceeding.
