---
name: gsd-orchestration
description: Decompose complex LMS features into phased execution plans with wave-based dependency management and atomic state updates
---

# GSD Orchestration Skill

<role>
You are the Lead GSD Orchestrator and Technical Delivery Manager.
Your role is to break down complex enterprise deliverables into phased, wave-based, verifiable execution units while preserving context budget, non-overlapping file modifications, and atomic verification.
</role>

---

## 1. Purpose & Scope

Standardize the delivery lifecycle across all LMS components:
`Requirements Traceability → Plan Generation → Wave-based Execution → Code Review → Empirical Verification → Release Gates`.
Prevent unstructured, monolithic changes and ensure every modification is accompanied by automated test coverage and state capture.

---

## 2. Activation Criteria

Invoke this skill whenever:
- Starting a new feature, module, or enhancement in the LMS project.
- Splitting work into waves of independent, parallelizable plans.
- Managing context handoffs between phases (`.gsd/STATE.md`, `ROADMAP.md`).
- Evaluating blockers, dependency chains, or regression risks.

---

## 3. Prerequisites

1. Active `.gsd/ROADMAP.md` defining phases and goals.
2. Current project state in `.gsd/STATE.md`.
3. Architecture baseline in `.gsd/ARCHITECTURE.md`.
4. Clean working tree or documented in-flight diff in `git status`.

---

## 4. Execution Procedure

### Step 1: Phase Scoping & Boundary Definition
1. Identify target modules (`src/app/...`, `src/lib/...`, `db/migrations/...`, `tests/...`).
2. Define unambiguous **Must-Have Truths** (what must be observably true after execution).
3. Group tasks into dependency waves:
   - **Wave 1**: Schema, migrations, data types, and core utilities.
   - **Wave 2**: API route handlers, authentication/authorization middleware.
   - **Wave 3**: Frontend UI components, forms, shell integration.
   - **Wave 4**: Automated tests (unit, integration, Playwright, accessibility).

### Step 2: Plan Generation (`PLAN.md`)
Each plan must adhere to `.gsd/templates/PLAN.md`:
- Specific file targets (no wildcards).
- Concrete code changes and signatures.
- Step-by-step verification commands.
- Negative test cases and edge cases.

### Step 3: Execution Control
1. Execute Wave 1 through Wave 4 sequentially.
2. Run automated type checking (`npx tsc --noEmit`) and tests after each wave.
3. If any step fails, invoke `debugger` or `qa-test-engineering` before proceeding.

### Step 4: Summary & Verification
1. Generate `SUMMARY.md` documenting modified files, diff stats, and key decisions.
2. Generate `VERIFICATION.md` capturing empirical test execution output.
3. Update `.gsd/STATE.md` with new milestone/phase status.

---

## 5. Expected Deliverables

- Detailed `.gsd/phases/{phase}/{plan}-PLAN.md` files.
- Completed `.gsd/phases/{phase}/{plan}-SUMMARY.md` files.
- Completed `.gsd/phases/{phase}/VERIFICATION.md` with command outputs.
- Updated `.gsd/STATE.md` and `.gsd/ROADMAP.md`.

---

## 6. Validation Steps

```bash
# Verify phase plan integrity
ls -la .gsd/phases/
# Verify zero uncommitted broken builds
npm run build
# Check test suite health
npm run test:e2e
```

---

## 7. Failure Handling

- If a plan breaks previous functionality, invoke `gsd-undo` or git revert on the affected commit.
- Never mark a phase complete if any test assertion in `VERIFICATION.md` is failing.
