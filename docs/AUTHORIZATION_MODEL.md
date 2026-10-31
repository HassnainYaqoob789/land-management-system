# Authorization model

How the Land Management System decides who may see and do what, from the
navigation down to the database. This is the reference for anyone adding a
screen, an API route or a table.

## 1. Vocabulary

- **Permission** — `resource:action`, a row in `iam.permission`
  (e.g. `cases:approve`, `payments:release`, `pii:read`). The catalogue is the
  only list of things that can be granted; code must not invent strings.
- **Scope** — how far a granted permission reaches, stored on the grant:
  - `role_permission.scope_level`: `global` ⊇ `head_office` ⊇ `province` ⊇ `project` ⊇ `assigned`
    (`iam.permission_rank` orders them).
  - `user_role.scope_province` / `scope_project`: optional narrowing of one
    assignment to a province or a project.
  - **Data scope** — the provinces a user may see at all
    (`lms.app_user_province`), enforced by row-level security on every
    province-bearing table through `lms.actor_provinces()`.
- **Role** — a named set of permissions with scopes (`iam.role`,
  `iam.role_permission`). System roles are fixed by migration; custom roles
  are managed by administrators. Lifecycle: `active` → `inactive` (members
  keep the assignment but get nothing from it) → `retired` (terminal).
- **Department** — recorded on the user (`lms.app_user.department`) and used
  to limit *shared report templates*. Land records carry no department, so it
  is not a data scope; approval routing uses approval positions
  (`lms.app_user_group`, `lms.workflow_step_group`).

## 2. Resolution

1. **Default deny.** Nothing is allowed unless a grant allows it.
2. **Union.** A user's effective permissions are the union of the
   permissions of their active, unexpired, unrevoked assignments of active
   roles, with the widest scope winning per permission
   (`iam.effective_permissions(user)`).
3. **No explicit deny.** There are no negative grants. Separation of duties
   is not expressed as a deny but as rules that make conflicting grants
   impossible (`iam.sod_rule`: a role or a user cannot hold `payments:create`
   with `payments:release`, or `payments:verify` with `payments:release`) and
   as workflow rules (`api.advance_workflow`: the preparer cannot approve; no
   one approves two steps of one record).
4. **Data scope is applied on top.** Holding `cases:read` lets a user read
   cases *in their provinces*; row-level security removes the rest before
   any application code sees them.
5. **Freshness.** Permissions are read from the database on every API
   request (`protect()` in `src/lib/iam/http.ts`), so a revocation, a
   suspended role or a suspended account takes effect on the next request.
   The browser refreshes its copy (`/api/auth/me`) when the window regains
   focus, every 60 seconds, and after any 403; controls for withdrawn
   permissions disappear within that bound and the server refuses them
   immediately in any case.

## 3. Enforcement, layer by layer

| Layer | Mechanism | Fails |
|:---|:---|:---|
| Navigation | `NAV[].perm` (`src/components/layout/nav.ts`) hides entries | closed |
| Page | `PageGuard` in `Shell` checks the page's permission (same table) and renders a "not authorised" panel; nothing of the page mounts | closed |
| Controls | `useCan()` / `<Can perm>` hide create, edit, approve, release, export and admin controls | closed |
| Fields | `pii:read` decides whether CNIC, phone, IBAN and address arrive unmasked; the API masks them, the UI never receives them | closed |
| API route | `protect({ permission })` on every handler; multiplexed actions map each `action` to its permission before any work | closed (403) |
| Record | `ctx.can(resource, action, { province, project, assignedTo })` for scope-limited grants, mirrored in the database by `iam.has_permission_in()` / `iam.require_in()` (used by the payment-release rule); row-level security for province scope | closed |
| Database | row-level security keyed on `util.actor_id()`; privileged routines call `iam.require()`; guards on role, grant and assignment changes | closed |

`util.actor_id()` is set with `set_config(..., true)` inside the request's
own transaction (`withActor` in `src/lib/db.ts`), so it cannot outlive the
request or leak to the next user of a pooled connection.

### Who may assert an identity (0041)

| Session (login role) | Actor it may assert | Notes |
|:---|:---|:---|
| Application (`lms_app`, `lms_test`, `lms_worker` — members of `lms_readwrite`) | any **active human** account, via `api.set_actor` | the accepted trust in the application tier (DB-04); service accounts are refused |
| Reporting (`lms_report`, `lms_readonly` only) | none — `util.actor_id()` is always NULL | row-level security therefore shows it nothing; the reporting module in the application is the supported path |
| Maintenance (`lms_migrator` and other members of `lms_owner`) | any account, including the system account | migrations, bootstrap, data loads (`scripts/ingest_reference_data.ts`) |

The system account (`00000000-0000-0000-0000-000000000001`) is honoured
(`iam.is_system_actor()`, its Admin tier in `lms.actor_role()`) only in a
maintenance session or inside a routine that entered a **signed system
context** (`iam.enter_system_context()`: an HMAC over the backend and
transaction with a key only the owner can read, cleared again before the
routine returns). Directory provisioning (`iam.provision_external`) and the
integration worker's routines are the only such routines. Setting
`lms.actor_id` by hand from the application or reporting role gives no tier
and no rows.

The **database tier** that row-level security uses (`lms.actor_role()`) is
computed on every call from the actor's active, unexpired assignments of
active roles; `app_user.role_code` is kept in step for display only. Accounts,
province access and approval positions cannot be written directly by the
application role (grants revoked, triggers refuse); only the identity routines
change them.

Background work runs as an explicit identity: the integration worker logs in
as `lms_worker` and uses `api.outbox_next` / `api.outbox_mark_sent` /
`api.outbox_mark_failed`, which refuse any other session; report exports run
as the requesting user, so row-level security applies.

## 4. Administration safeguards

- An administrator can grant only what they hold, at the same or a wider
  scope (`iam.actor_covers_role`, `iam.tg_role_permission_guard`).
- No one can assign a role to themselves.
- The last working system administrator cannot be revoked, suspended,
  deactivated or anonymised.
- Assignments cannot be edited, only revoked and re-granted. The grantor,
  grant time and grant reason are the database's and immutable; revocation
  records the revoker and its own reason (`revoke_reason`). Expiry cannot be
  extended in place. Assignments are never deleted.
- A system-administrator grant cannot be time-limited or scoped, and an
  administrator cannot remove their own administrator role.
- Approval positions (workflow-step groups) are delegated authority: they need
  `users:assign`, nobody can change their own positions or provinces, and a
  system administrator cannot hold an approval position (separation of
  identity administration from business approval). The administrator approval
  override (`workflow.admin_override`) cannot be switched on.
- A role's database tier cannot exceed its creator's; a custom role cannot
  become a system role; a permission cannot be moved out of a role by update;
  adding a permission that would give a current holder a forbidden pair is
  refused.
- Roles cannot be given to service accounts or deactivated accounts.
  Deactivation is permanent.
- Security and identity settings change only through `iam.set_policy`, which
  validates every key and logs a `policy_changed` security event;
  `api.set_setting` refuses them and validates the rest.
- Granting a role requires holding all of its permissions. In the seeded
  model no administrator holds the finance and land-management permissions
  (separation of duties), so those roles are granted by the bootstrap tooling
  (`scripts/iam/bootstrap.ts`) until a two-person delegation process is agreed.
- Every change to roles, grants and assignments is in `audit.audit_event`;
  status and security events are in `audit.auth_event`.

## 5. Authentication and its link to authorization

Every sign-in method ends in the same place: a session for an `lms.app_user`
row, whose permissions come only from its role assignments.

| Method | Identity proof | Becomes a user by | Grants roles? |
|:---|:---|:---|:---|
| Local password | Argon2id + rate limit + lockout | the account itself | no |
| Passkey (WebAuthn) | signature by a registered authenticator with user verification | the credential's owner | no |
| LDAP / Active Directory | bind as the user over TLS | `iam.external_identity` link | only through `iam.group_mapping` rows an administrator created |
| OIDC | authorization code + PKCE + state + nonce | `iam.external_identity` link | same |
| SAML 2.0 | signed assertion, audience and time checks, single-use request id | `iam.external_identity` link | same |

Unknown external identities are not let in: they become a provisioning request
for an administrator (`iam.setting provisioning_mode = approval`, the
default). A method that is not configured, not enabled or failing its test is
shown on the sign-in page as unavailable with a message, never as a working
button.

## 6. Adding something new

1. Add the permission to `iam.permission` in a migration if no existing one
   fits, and grant it to roles there.
2. Put the route behind `protect({ permission })`; map every body `action`.
3. Add the page to `NAV` with `perm`, and gate its controls with `useCan`.
4. Add a row to the access matrix test (`tests/regression/rbac_matrix.test.ts`).
