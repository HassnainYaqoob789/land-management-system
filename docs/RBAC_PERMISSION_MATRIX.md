# RBAC permission matrix

Generated 2026-10-29 19:27 UTC by `scripts/iam/permission_matrix.mjs` from the database (postgresql://…@/lms_test?host=/tmp) and the source tree. Do not edit by hand.

Scope codes: **G** global, **HO** head office, **P** the holder's provinces, **Pr** project, **A** assigned records.
A sensitive permission (⚠) requires multi-factor sign-in for its holders (`iam.mfa_for_sensitive_permissions`).

## 1. Roles

| Role | Name | Database tier | Status | System |
|:---|:---|:---|:---|:---|
| `case-approver` | Case approver | User | active | yes |
| `data-entry` | Data entry | User | active | yes |
| `finance-approver` | Finance approver | User | active | yes |
| `land-manager` | Land manager (HO) | Approver | active | yes |
| `security-auditor` | Security auditor | Viewer | active | yes |
| `system-administrator` | System administrator | Admin | active | yes |
| `viewer` | Viewer | Viewer | active | yes |

## 2. Permissions by role

| Permission | `case-approver` | `data-entry` | `finance-approver` | `land-manager` | `security-auditor` | `system-administrator` | `viewer` | Description |
|:---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---|
| `acquisitions:create` | P | P |  | P |  | G |  | Initiate LAA 1894 land acquisitions |
| `acquisitions:read` | P | P | P | P | G | G | P | View LAA 1894 acquisitions and title checklists |
| `acquisitions:update` | P | P |  | P |  | G |  | Update title checklists and advance acquisition workflow |
| ⚠ `audit_logs:export` |  |  |  |  |  | G |  | Export audit and security records |
| `audit_logs:read` |  |  |  |  | G | G |  | View the business audit trail and security log |
| `budgets:create` |  |  | P | P |  | G |  | Create fiscal year project budgets |
| `budgets:read` | P | P | P | P | G | G | P | View fiscal year project budgets and utilisation |
| ⚠ `budgets:update` |  |  | P | P |  | G |  | Amend fiscal year project budgets |
| `cases:approve` | P |  |  | P |  |  |  | Advance a case through its workflow (the approval matrix decides which step) |
| `cases:create` | P | P |  | P |  | G |  | Create compensation cases |
| `cases:read` | P | P | P | P | G | G | P | View compensation cases |
| `cases:update` | P | P |  | P |  | G |  | Edit compensation case lines and checklists |
| `dbpfc:create` | P | P |  | P |  | G |  | Create DBPFC land rate estimates |
| `dbpfc:read` | P | P | P | P | G | G | P | View DBPFC estimates |
| `dbpfc:update` | P | P |  | P |  | G |  | Update DBPFC rate fixation and advance workflow |
| `documents:create` | P | P |  | P |  | G |  | Register and upload documents |
| `documents:read` | P | P | P | P | G | G | P | View document repository and checksum registry |
| `documents:update` | P | P |  | P |  | G |  | Update document metadata or soft-delete records |
| `encroachments:create` | P | P |  | P |  | G |  | Report ROW or parcel encroachments |
| `encroachments:read` | P | P | P | P | G | G | P | View ROW and parcel encroachment cases |
| `encroachments:update` | P | P |  | P |  | G |  | Update corrective actions and resolve encroachments |
| `gis:create` | P | P |  | P |  | G |  | Import KML/KMZ layers and merge them |
| `gis:read` | P | P | P | P | G | G | P | View the GIS layers |
| `grievances:create` | P | P |  | P |  | G |  | Register community grievances |
| `grievances:read` | P | P | P | P | G | G | P | View community grievances and IIR investigations |
| `grievances:update` | P | P |  | P |  | G |  | Investigate, escalate and resolve grievances |
| ⚠ `identity_settings:configure` |  |  |  |  |  | G |  | Configure providers, policies and emergency access |
| `identity_settings:read` |  |  |  |  | G | G |  | View authentication providers and policies |
| `import:create` | P | P |  | P |  | G |  | Stage and validate bulk import batches |
| `import:read` | P | P | P | P | G | G | P | View bulk import batches, staging rows and validation errors |
| ⚠ `import:update` |  |  |  | P |  | G |  | Promote validated bulk import batches into the live register |
| `inbox:read` | P | P | P | P | G | G | P | View workflow approval queue and notifications |
| `landowners:create` | P | P |  | P |  | G |  | Create landowners |
| `landowners:read` | P | P | P | P | G | G | P | View landowners |
| `landowners:update` | P | P |  | P |  | G |  | Edit landowner details, bank and tax status |
| `leases:create` | P | P |  | P |  | G |  | Create leases |
| `leases:read` | P | P | P | P | G | G | P | View leases |
| ⚠ `leases:update` | P |  |  | P |  | G |  | Place or lift a hold on a lease, or renew it |
| `legal:create` | P | P |  | P |  | G |  | Register legal cases and court proceedings |
| `legal:read` | P | P | P | P | G | G | P | View litigation register, stay orders and court hearings |
| `legal:update` | P | P |  | P |  | G |  | Update litigation status, stay orders and record hearings |
| `mutations:create` | P | P |  | P |  | G |  | Initiate mutation / succession cases |
| `mutations:read` | P | P | P | P | G | G | P | View mutations and succession (Intiqal / Wirasat) records |
| ⚠ `mutations:update` | P | P |  | P |  | G |  | Update mutation heirs and advance workflow to apply share transfer |
| `payments:create` |  | P | P |  |  |  |  | Raise a payment request |
| `payments:read` | P | P | P | P | G | G | P | View payments |
| ⚠ `payments:release` |  |  |  | P |  |  |  | Release a payment (issue a cheque) |
| ⚠ `payments:update` |  |  | P | P |  |  |  | Allocate payments, manage holds, record receipts and reconcile |
| ⚠ `payments:verify` |  |  | P |  |  |  |  | Verify a payment request |
| ⚠ `pii:read` | P | P | P | P |  | G |  | See full CNIC, phone, IBAN and address of landowners and payees (others see them masked) |
| `projects:create` | P | P |  | P |  | G |  | Create projects |
| `projects:read` | P | P | P | P | G | G | P | View projects |
| `projects:update` | P | P |  | P |  | G |  | Edit projects and linked surveys |
| ⚠ `reports:export` | P |  | P | P |  | G |  | Export reports |
| `reports:read` | P | P | P | P | G | G | P | View reports and dashboards |
| `reports:share` |  |  | P | P |  | G |  | Publish report templates for colleagues |
| `requests:approve` | P |  |  | P |  |  |  | Approve, reject or return a land request at your tier |
| `requests:create` | P | P |  | P |  | G |  | Raise a land request |
| `requests:read` | P | P | P | P | G | G | P | View land requests |
| ⚠ `roles:create` |  |  |  |  |  | G |  | Create custom roles |
| ⚠ `roles:delete` |  |  |  |  |  | G |  | Delete unused custom roles |
| ⚠ `roles:manage_permissions` |  |  |  |  |  | G |  | Change the permissions of a custom role |
| `roles:read` |  |  |  |  | G | G |  | View roles and their permissions |
| ⚠ `roles:update` |  |  |  |  |  | G |  | Edit custom roles |
| `rows:create` | P | P |  | P |  | G |  | Create ROW corridors |
| `rows:read` | P | P | P | P | G | G | P | View ROW corridors |
| `rows:update` | P | P |  | P |  | G |  | Update ROW corridors and advance workflow |
| `sessions:read` |  |  |  |  | G | G |  | View active sessions |
| ⚠ `sessions:revoke` |  |  |  |  |  | G |  | End any session |
| `settings:read` | P | P | P | P | G | G | P | View system configuration and workflow approval matrix |
| ⚠ `settings:update` |  |  |  |  |  | G |  | Modify system configuration settings |
| `surveys:create` | P | P |  | P |  | G |  | Create parcels |
| `surveys:read` | P | P | P | P | G | G | P | View parcels |
| `surveys:update` | P | P |  | P |  | G |  | Edit parcels and ownership shares |
| ⚠ `users:assign` |  |  |  |  |  | G |  | Assign and revoke roles |
| ⚠ `users:create` |  |  |  |  |  | G |  | Create accounts and send invitations; approve external-identity provisioning |
| ⚠ `users:delete` |  |  |  |  |  | G |  | Anonymise an account |
| `users:read` |  |  |  |  | G | G |  | View user accounts, their roles and effective permissions |
| ⚠ `users:reset_mfa` |  |  |  |  |  | G |  | Reset another user's MFA (justification required) |
| ⚠ `users:revoke_sessions` |  |  |  |  |  | G |  | End another user's sessions |
| ⚠ `users:update` |  |  |  |  |  | G |  | Edit accounts, change status, issue password resets, unlink external identities |

## 3. API handlers

The gate is what `protect()` checks before the handler runs; "also" lists permissions the handler checks itself (per action or per record).

| Route | Method | Gate | Re-auth | Also checks |
|:---|:---|:---|:---:|:---|
| `/api/acquisitions` | GET | acquisitions:read |  |  |
| `/api/acquisitions` | POST | acquisitions:create |  |  |
| `/api/acquisitions` | PUT | acquisitions:update |  |  |
| `/api/analytics/kpis` | GET | reports:read |  |  |
| `/api/analytics/reports` | GET | reports:read |  | reports:export |
| `/api/audit` | GET | audit_logs:read |  |  |
| `/api/auth/login` | POST | public (pre-sign-in) |  |  |
| `/api/auth/logout` | POST | any signed-in user |  |  |
| `/api/auth/me` | GET | any signed-in user |  |  |
| `/api/auth/mfa/recovery` | POST | any signed-in user | yes |  |
| `/api/auth/mfa/totp/confirm` | POST | any signed-in user |  |  |
| `/api/auth/mfa/totp/start` | POST | any signed-in user |  |  |
| `/api/auth/mfa/verify` | POST | public (pre-sign-in) |  |  |
| `/api/auth/options` | GET | public (pre-sign-in) |  |  |
| `/api/auth/password/forgot` | POST | public (pre-sign-in) |  |  |
| `/api/auth/password/reset` | POST | public (pre-sign-in) |  |  |
| `/api/auth/password` | POST | any signed-in user |  |  |
| `/api/auth/reauth` | POST | any signed-in user |  |  |
| `/api/auth/sso/callback` | POST | public (pre-sign-in) |  |  |
| `/api/auth/sso/login` | GET | public (pre-sign-in) |  |  |
| `/api/auth/sso/metadata` | GET | public (pre-sign-in) |  |  |
| `/api/budgets` | GET | budgets:read |  |  |
| `/api/budgets` | POST | budgets:create |  |  |
| `/api/budgets` | PUT | budgets:update |  |  |
| `/api/calendar` | GET | any signed-in user |  |  |
| `/api/cases/[id]/transition` | POST | cases:approve |  |  |
| `/api/cases` | GET | cases:read |  | cases:approve |
| `/api/cases` | POST | cases:create |  | cases:approve |
| `/api/cases` | PUT | cases:update |  | cases:approve |
| `/api/dbpfc` | GET | dbpfc:read |  |  |
| `/api/dbpfc` | POST | dbpfc:create |  |  |
| `/api/dbpfc` | PUT | dbpfc:update |  |  |
| `/api/documents` | GET | documents:read |  | documents:update |
| `/api/documents` | POST | documents:create |  | documents:update |
| `/api/documents` | PUT | documents:read |  | documents:update |
| `/api/encroachments` | GET | encroachments:read |  |  |
| `/api/encroachments` | POST | encroachments:create |  |  |
| `/api/encroachments` | PUT | encroachments:update |  |  |
| `/api/gis/kml/merge` | GET | gis:read |  |  |
| `/api/gis/kml/merge` | POST | gis:create |  |  |
| `/api/gis/kml` | GET | gis:read |  |  |
| `/api/gis/kml` | POST | gis:create |  |  |
| `/api/gis` | GET | gis:read |  |  |
| `/api/grievances` | GET | grievances:read |  |  |
| `/api/grievances` | POST | grievances:create |  |  |
| `/api/grievances` | PUT | grievances:update |  |  |
| `/api/import` | GET | import:read |  |  |
| `/api/import` | POST | import:create |  |  |
| `/api/inbox` | GET | inbox:read |  |  |
| `/api/inbox` | POST | inbox:read |  |  |
| `/api/landowners` | GET | landowners:read |  |  |
| `/api/landowners` | POST | landowners:create |  |  |
| `/api/landowners` | PUT | landowners:update |  |  |
| `/api/leases/[id]/hold` | POST | leases:update |  |  |
| `/api/leases/[id]/renew` | POST | leases:update |  |  |
| `/api/leases` | GET | leases:read |  |  |
| `/api/leases` | POST | leases:create |  |  |
| `/api/leases` | PUT | leases:update |  |  |
| `/api/legal` | GET | legal:read |  |  |
| `/api/legal` | POST | legal:create |  |  |
| `/api/legal` | PUT | legal:update |  |  |
| `/api/mutations` | GET | mutations:read |  |  |
| `/api/mutations` | POST | mutations:create |  |  |
| `/api/mutations` | PUT | mutations:update |  |  |
| `/api/payments` | GET | payments:read |  |  |
| `/api/payments` | POST | any signed-in user |  |  |
| `/api/projects` | GET | projects:read |  |  |
| `/api/projects` | POST | projects:create |  |  |
| `/api/projects` | PUT | projects:update |  |  |
| `/api/provinces` | GET | any signed-in user |  |  |
| `/api/reference` | GET | any signed-in user |  |  |
| `/api/requests/[id]/transition` | POST | requests:approve |  |  |
| `/api/requests` | GET | requests:read |  |  |
| `/api/requests` | POST | requests:create |  |  |
| `/api/roles/[code]/history` | GET | roles:read |  |  |
| `/api/roles/[code]/permissions` | PUT | roles:manage_permissions | yes |  |
| `/api/roles/[code]` | GET | roles:read |  |  |
| `/api/roles/[code]` | PATCH | roles:update | yes |  |
| `/api/roles/reviews/[id]` | GET | users:read |  | users:assign |
| `/api/roles/reviews/[id]` | POST | users:assign | yes |  |
| `/api/roles/reviews` | GET | users:read |  | users:assign |
| `/api/roles/reviews` | POST | users:assign | yes |  |
| `/api/roles` | GET | roles:read |  | roles:create, roles:update, roles:delete, roles:manage_permissions, users:read, users:assign |
| `/api/roles` | POST | roles:create | yes | roles:update, roles:delete, roles:manage_permissions, users:read, users:assign |
| `/api/rows` | GET | rows:read |  |  |
| `/api/rows` | POST | rows:create |  |  |
| `/api/rows` | PUT | rows:update |  |  |
| `/api/settings/policy` | GET | identity_settings:read |  | identity_settings:configure |
| `/api/settings/policy` | PUT | identity_settings:configure | yes |  |
| `/api/settings` | GET | settings:read |  | identity_settings:read |
| `/api/settings` | PUT | settings:update | yes | identity_settings:read |
| `/api/surveys` | GET | surveys:read |  |  |
| `/api/surveys` | POST | surveys:create |  |  |
| `/api/surveys` | PUT | surveys:update |  |  |
| `/api/units` | GET | any signed-in user |  |  |
| `/api/units` | POST | any signed-in user |  |  |
| `/api/users` | GET | users:read |  | users:create |
| `/api/users` | POST | any signed-in user |  | users:create |

## 4. Pages

| Page | Needs |
|:---|:---|
| `/dashboard` | reports:read |
| `/projdash` | projects:read |
| `/inbox` | inbox:read |
| `/gis` | gis:read |
| `/province` | reports:read |
| `/projects` | projects:read |
| `/surveys` | surveys:read |
| `/landowners` | landowners:read |
| `/requests` | requests:read |
| `/acquisitions` | acquisitions:read |
| `/cases` | cases:read |
| `/leases` | leases:read |
| `/rows` | rows:read |
| `/encroachments` | encroachments:read |
| `/mutations` | mutations:read |
| `/legal` | legal:read |
| `/payments` | payments:read |
| `/dbpfc` | dbpfc:read |
| `/budgets` | budgets:read |
| `/grievances` | grievances:read |
| `/reports` | reports:read |
| `/documents` | documents:read |
| `/import` | import:read |
| `/audit` | audit_logs:read |
| `/users` | users:read |
| `/roles` | roles:read |
| `/matrix` | settings:read |
| `/settings` | settings:read |
