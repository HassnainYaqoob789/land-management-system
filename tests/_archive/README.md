# Archived test suites

These suites were written for the pre-IAM build: they call the API anonymously
or sign in with a username alone, and expect a demo SSO simulator and fixed
port 3030. Under the current authentication every call is refused with 401
before the rule under test is reached, so they no longer verify anything.

Every rule they asserted is re-tested, signed in as the least-privileged role
that holds the permission, in `tests/regression/business_rules.test.ts`
(SQL injection, XSS echo, unauthenticated workflow writes, lease-hold renewal,
units, KPI packages, all 15 reports, CSV export, KML) and
`tests/regression/workflows.test.ts`. The SSO checks are replaced by the
assertion that the simulator is off in production (SECURITY_FINDINGS APP-07).

Kept for reference only; they are not run by any npm script.

`lms_journeys.spec.ts` and `accessibility.spec.ts` (Playwright) sign in with a
username alone and look for the pre-legacy-design Tailwind interface, and the
accessibility spec switches colour contrast off. They are replaced by
`tests/e2e/legacy_design.spec.ts` (every screen, axe WCAG 2.1 AA with contrast
on) and `tests/e2e/user_journeys.spec.ts` (role-based journeys through the UI).
