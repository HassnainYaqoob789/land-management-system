#!/bin/sh
# Drop and rebuild a database from the migrations, optionally loading the
# fictional demo seed. Development convenience; never point it at anything
# that holds real data.
#
#   db/tools/rebuild.sh                  # lms_dev, with the demo seed
#   db/tools/rebuild.sh lms_test noseed  # empty lms_test, schema only
set -e
DB="${1:-lms_dev}"
SEED="${2:-seed}"
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"

# Disconnect anything still attached, or DROP DATABASE refuses.
psql -q -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$DB' AND pid <> pg_backend_pid()" >/dev/null
psql -q -d postgres -c "DROP DATABASE IF EXISTS $DB"
psql -q -v ON_ERROR_STOP=1 -d postgres -v db="$DB" -f db/bootstrap/02_database.sql
LMS_DSN="postgresql:///$DB?user=lms_migrator" python3 db/tools/migrate.py up
if [ "$SEED" = "seed" ]; then
  psql -q -v ON_ERROR_STOP=1 -U lms_migrator -d "$DB" -f db/seed/seed_demo.sql
  psql -q -v ON_ERROR_STOP=1 -U lms_migrator -d "$DB" -f db/seed/seed_demo_transactions.sql
  # The materialized views are created empty by migration 0019, before the seed
  # exists, and a trigger marks them stale rather than refreshing them (REFRESH
  # cannot run inside the transaction that changed the source). Refresh them
  # here so a seeded database is immediately usable.
  psql -q -At -U lms_migrator -d "$DB" -c "SELECT * FROM api.refresh_derived()" >/dev/null
fi
echo "$DB rebuilt"
