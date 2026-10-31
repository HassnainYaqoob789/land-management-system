# VERIFICATION.md Template

> Copy this template when creating phase verification reports.

```markdown
---
phase: {N}
verified_at: {YYYY-MM-DD HH:MM}
verdict: PASS | FAIL | PARTIAL
pass_count: {X}
total_count: {Y}
---

# Phase {N} Verification Report

## Summary

**{X}/{Y}** must-haves verified
**Verdict:** {PASS | FAIL | PARTIAL}

## Release Gates Evaluation

| Gate | Description | Command | Status |
|:---|:---|:---|:---:|
| **G1** | Requirements Traceability | `grep "Status: Implemented" .gsd/REQUIREMENTS.md` | {PASSED / FAILED / BLOCKED / SKIPPED / NOT EXECUTED} |
| **G2** | Next.js Build & Typecheck | `npm run build && npx tsc --noEmit` | {PASSED / FAILED / BLOCKED / SKIPPED / NOT EXECUTED} |
| **G3** | Unit & Domain Calculations | `npm run test:unit` | {PASSED / FAILED / BLOCKED / SKIPPED / NOT EXECUTED} |
| **G4** | PostgreSQL Schema Invariants | `python3 db/tools/run_tests.py` | {PASSED / FAILED / BLOCKED / SKIPPED / NOT EXECUTED} |
| **G5** | 6-Tier SoD & Payment Holds | `npm run test:integration` | {PASSED / FAILED / BLOCKED / SKIPPED / NOT EXECUTED} |
| **G6** | Playwright E2E & Axe A11y | `npx playwright test` | {PASSED / FAILED / BLOCKED / SKIPPED / NOT EXECUTED} |
| **G7** | Audit Trail & Outbox Logging | `psql -c "SELECT count(*) FROM audit.audit_event;"` | {PASSED / FAILED / BLOCKED / SKIPPED / NOT EXECUTED} |

## Must-Haves

### ✅ 1. {Must-have description}
**Status:** PASS
**Method:** {How this was verified}
**Evidence:**
```
{Actual command output or screenshot reference}
```

### ❌ 2. {Must-have description}
**Status:** FAIL
**Method:** {How this was verified}
**Expected:** {What should happen}
**Actual:** {What actually happened}
**Evidence:**
```
{Actual command output}
```
**Gap:** {What needs to be fixed}

### ⏭️ 3. {Must-have description}
**Status:** SKIPPED
**Reason:** {Why this couldn't be verified}

## Gap Closure Required

{If verdict is FAIL or PARTIAL, list what needs fixing}

1. **{Gap 1}:** {Description of what's wrong and how to fix}
2. **{Gap 2}:** {Description}

## Next Steps

{Based on verdict}

- If PASS: Proceed to next phase
- If FAIL: Run `/execute {N} --gaps-only` after fixing
- If PARTIAL: Address gaps then re-verify
```

## Evidence Types

| Verification | Evidence Required |
|--------------|-------------------|
| API endpoint | curl command + response |
| UI behavior | Screenshot |
| Test suite | Test output |
| File exists | `ls` or `dir` output |
| Build passes | Build command output |
