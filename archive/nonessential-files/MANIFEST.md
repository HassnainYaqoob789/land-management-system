# Workspace cleanup manifest

Files moved here are **confirmed nonessential**; nothing was deleted. Each keeps
its original relative path under `archive/nonessential-files/`. To restore one,
move it back to that path. `archive/` is excluded from TypeScript checking
(`tsconfig.json`) and from the graphify index (`.graphifyignore`).

All moved files were untracked in git (no history to preserve), so a plain move
was used.

## Moved on 2026-10-30

| Original path | Size | Reason | Dependency checks |
|:---|---:|:---|:---|
| `.gsd/reference_audit/CSV Datasets/` | — | byte-identical copy of `requirments/CSV Datasets/` (diff -rq) | only reader `scripts/ingest_reference_data.ts` repointed to `requirments/CSV Datasets` first; planning notes `.gsd/GAP_ANALYSIS.md`, `.gsd/phases/8/PLAN.md` updated |
| `.gsd/reference_audit/Reports and documents/` | | byte-identical copy of `requirments/Reports and documents/` | no code reference; only the archived `read_pdf.py` |
| `.gsd/reference_audit/Sample Screen Shots/` | | byte-identical copy of `requirments/Sample Screen Shots/` | no reference |
| `.gsd/reference_audit/Workflow references/` | | byte-identical copy of `requirments/Workflow references/` | only the archived `read_pdf.py` |
| `.gsd/read_pdf.py` | | one-off PDF text dumper, not run by any script or workflow | no reference in package.json, scripts, tests, docs or CI |
| `scripts/seed_passwords.js.retired` | | retired: set every password to `<username>123`; replaced by `scripts/iam/bootstrap.ts` | no reference; README tree and the `lms-auth-rbac-security` skill corrected |
| `scripts/generate_defect_report.js` | | wrote hard-coded pass counts presented as test results | referenced only by a historical report (note added to `docs/MULTI_AGENT_RELEASE_VERIFICATION_REPORT.md`) |
| `docs/DEFECT_AND_TEST_RESULTS_REPORT.md` | | output of the script above; its figures were not from executed tests | same |
| `scripts/inspect_schema.js` | | ad-hoc debug script | no reference anywhere |
| `scripts/requirements_inventory.js` | | not wired into anything; reads a `requirements/` folder that does not exist | referenced only by the historical report |

Total about 21 MB. Verification after the move: `npx tsc --noEmit -p .` shows no
error in `scripts/`, `archive/` or `.gsd/` (remaining errors are in files other
engineers are editing); `requirments/CSV Datasets` holds the 7 CSVs the import
script reads.

## Deferred (proposed, not yet moved)

Owned by work packages still being edited; moved only after integration, if still unused:
`src/lib/iam/simulator.ts`, `src/components/ui/RoleSwitcherModal.tsx`,
`src/components/ui/WorkflowStepper.tsx`, `public/images/logo.png` (duplicate of
`mari-energies-logo.png`), `public/favicon.png`.

## Left in place deliberately

`legacy-demo/` (authoritative design reference; identical to the old tracked
`app/` — the `D app/…` git entries are that rename), `build/` (tracked pipeline
code), `backups/` (database dumps — never archive into an un-ignored folder),
agent tooling (`.agent/`, `.agents/`, `.gemini/`, `adapters/`, GSD files),
`tests/_archive/` (already archived). `.agent/skills/` (20 untracked skills,
unreferenced) is left for the owner to review.

## Documentation reorganised (2026-10-30) — moved within `docs/`, not archived

| From | To | How |
|:---|:---|:---|
| `docs/ISO27001_READINESS.md`, `SOC2_READINESS.md`, `OWASP_ASVS_TRACEABILITY.md` | `docs/compliance/` | `git mv` (history kept) |
| `docs/SECURITY_ARCHITECTURE.md` | `docs/security/` | `git mv` |
| `docs/audit.md` | `docs/reports/AUDIT_2026-10-28.md` | moved and renamed to the dated-report convention |
| `docs/REAUDIT_2026-10-28.md`, `RELEASE_ASSESSMENT_2026-10-29.md`, `MULTI_AGENT_RELEASE_VERIFICATION_REPORT.md` | `docs/reports/` | moved |

Every reference was rewritten (README, db/README, .gsd plans, the security skill,
cross-links inside docs); a link scan of `docs/` finds no broken relative link.
Applied migrations were not touched (their comments name only documents that did
not move). Two links were already broken before this change and are left as found:
`GSD-STYLE.md` → `docs/model-selection-playbook.md` (never existed) and the
2026-10-28 audit → `requirments/lms_project_analysis.md` (removed from the source folder earlier).

## Moved on 2026-10-30 (RBAC/cleanup pass)

| Original path | Reason | Dependency checks |
|:---|:---|:---|
| `src/components/ui/RoleSwitcherModal.tsx` | pre-IAM role switcher; sign-in is per account now | no import in `src/`, `tests/`, `scripts/` (grep) |
| `src/components/ui/WorkflowStepper.tsx` | unused; stage progress is rendered inside each register page | no import (grep) |
| `src/components/auth/Can.tsx` | unused wrapper; pages use `useCan` from `lib/client/permissions.ts` | no import (grep) |
