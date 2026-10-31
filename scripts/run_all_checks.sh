#!/usr/bin/env bash
# Run every automated release check in order and stop at the first failure.
# Needs: a production build serving the TEST database at $IAM_TEST_BASE / $BASE_URL,
# and $IAM_TEST_PASSWORDS (fixture passwords; never committed). It prints what
# each command printed; it does not summarise results it did not see.
set -euo pipefail
: "${IAM_TEST_BASE:?set IAM_TEST_BASE to the build under test, e.g. http://localhost:3041}"
: "${IAM_TEST_PASSWORDS:?set IAM_TEST_PASSWORDS to the fixture password file}"
export BASE_URL="${BASE_URL:-$IAM_TEST_BASE}"

step() { echo; echo "▶ $*"; }
step "typecheck";            npm run -s typecheck
step "lint";                 npm run -s lint
step "unit";                 npm run -s test:unit
step "KML parsing";          npm run -s test:integration
step "database suites";      npm run -s test:db
step "API, IAM, workflows";  npm run -s test:api
step "browser + a11y";       npm run -s test:playwright
step "dependency audit (production deps; findings are reviewed in docs/SECURITY_FINDINGS.md DEP-01)"
npm audit --omit=dev || true
echo; echo "All automated checks above ran. Read their output; this script does not grade it beyond exit codes."
