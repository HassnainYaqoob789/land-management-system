# Documentation

| Folder / file | What is in it |
|:---|:---|
| [`architecture/`](architecture/) | How the system is built: [data flow diagrams](architecture/DATA_FLOW_DIAGRAMS.md) (context, level 1, level 2, trust boundaries) |
| [`requirements/`](requirements/) | What the system must do: [inventory](requirements/REQUIREMENTS_INVENTORY.md), [traceability matrix](requirements/TRACEABILITY_MATRIX.md), [gap list](requirements/GAP_LIST.md) — built from `requirments/` (the client's source material) |
| [`security/`](security/) | [Security architecture](security/SECURITY_ARCHITECTURE.md) |
| [`compliance/`](compliance/) | [OWASP ASVS traceability](compliance/OWASP_ASVS_TRACEABILITY.md), [ISO 27001](compliance/ISO27001_READINESS.md) and [SOC 2](compliance/SOC2_READINESS.md) readiness |
| [`reports/`](reports/) | Dated audits and release assessments (historical record; the newest assessment is the current one) |
| [`visual_regression/`](visual_regression/) | Screenshots and report from `scripts/visual_regression.js` |
| [`AUTHORIZATION_MODEL.md`](AUTHORIZATION_MODEL.md) | Roles, permissions, scope, enforcement layers, administration safeguards |
| [`REPORTING_MODEL.md`](REPORTING_MODEL.md) | Report sources, money definitions, units of measure, engine contract |
| [`RBAC_PERMISSION_MATRIX.md`](RBAC_PERMISSION_MATRIX.md) | Generated role × permission and route × permission matrix (`scripts/iam/permission_matrix.mjs`) |
| [`SECURITY_FINDINGS.md`](SECURITY_FINDINGS.md) | The security findings register and risk acceptances |
| [`DATABASE_ENGINEERING_REPORT.md`](DATABASE_ENGINEERING_REPORT.md), [`DATABASE_SECURITY_REVIEW.md`](DATABASE_SECURITY_REVIEW.md), [`QUERY_PLAN_EVIDENCE.md`](QUERY_PLAN_EVIDENCE.md) | Database design, security review and query-plan evidence |

Conventions:

- A dated report (`NAME_YYYY-MM-DD.md`) goes in `reports/` and is not edited afterwards except for a dated note at the top.
- Living documents (models, registers, matrices) stay current with the code.
- The database documents at the top level are referenced by path from applied
  migrations (which are checksummed and never edited), so they stay where they are.
- The model and register files at the top level move to `security/` and
  `architecture/` once the current implementation round is integrated.
