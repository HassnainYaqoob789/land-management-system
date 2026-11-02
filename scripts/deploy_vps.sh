#!/usr/bin/env bash
# One-command update for the DreamHost VPS (pm2, PostgreSQL in ~/pg18).
#
#   cd ~/apps/lms && git pull && bash scripts/deploy_vps.sh
#
# Starts the database if it is down, backs it up, applies new migrations,
# loads the demo seeds that are idempotent, builds, (re)starts the app,
# saves the pm2 list and makes sure pm2 comes back after a reboot.
# Safe to run again: every step checks before it changes anything.
set -euo pipefail

APP_DIR="$HOME/apps/lms"
DB_NAME="${DB_NAME:-lms_prod}"
APP_PORT="${APP_PORT:-8003}"

export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"
export PATH="$HOME/pg18/bin:$PATH"
cd "$APP_DIR"

step() { printf '\n==> %s\n' "$*"; }

step "1/7 database (pm2 lms-db)"
if ! pm2 describe lms-db >/dev/null 2>&1; then
  pm2 resurrect >/dev/null 2>&1 || true
fi
if ! pm2 describe lms-db >/dev/null 2>&1; then
  pm2 start "$HOME/pg18/bin/postgres" --name lms-db -- -D "$HOME/pgdata"
fi
for _ in $(seq 1 30); do pg_isready -h 127.0.0.1 -p 5433 -q && break; sleep 1; done
pg_isready -h 127.0.0.1 -p 5433 || { echo "Database did not start: run  pm2 logs lms-db --lines 30"; exit 1; }

step "2/7 backup"
mkdir -p "$HOME/backups"
BK="$HOME/backups/${DB_NAME}_$(date +%F_%H%M).dump"
PGPASSWORD="$(cat "$HOME/.pg_super_pw")" pg_dump -h 127.0.0.1 -p 5433 -U postgres -Fc -d "$DB_NAME" -f "$BK"
echo "saved $BK"
find "$HOME/backups" -name "${DB_NAME}_*.dump" -mtime +14 -delete || true

step "3/7 migrations"
export PGHOST=127.0.0.1 PGPORT=5433 PGUSER=lms_migrator PGDATABASE="$DB_NAME"
PGPASSWORD="$(cat "$HOME/.pg_migrator_pw")"; export PGPASSWORD
python3 db/tools/migrate.py up
python3 db/tools/migrate.py status | tail -1

step "4/7 demo accounts (only if demo mode is on)"
DEMO_FILE="$HOME/lms-data/demo-credentials.json"
if grep -qs '^LMS_DEMO_MODE=on' .env.production.local && [ -f "$DEMO_FILE" ]; then
  psql -q -v ON_ERROR_STOP=1 -f db/seed/seed_exploration_accounts.sql >/dev/null
  psql -q -v ON_ERROR_STOP=1 -f db/seed/seed_director_account.sql >/dev/null
  if ! grep -q '"username": *"director"' "$DEMO_FILE"; then
    DPW="Demo-$(openssl rand -hex 8)"; export DPW
    DATABASE_URL_ADMIN="postgresql://lms_migrator:${PGPASSWORD}@127.0.0.1:5433/${DB_NAME}" \
      npx --yes tsx scripts/iam/bootstrap.ts --username director --password-from-env DPW --no-force-change >/dev/null
    node -e '
      const fs=require("fs"),f=process.argv[1],j=JSON.parse(fs.readFileSync(f,"utf8"));
      j.accounts=j.accounts.filter(a=>a.username!=="director");
      j.accounts.unshift({username:"director",password:process.env.DPW,fullName:"Asif Rehman",position:"Director (demo, all tabs)",
        roles:["demo-director"],provinces:["BAL","KPK","PNJ","SND"],sees:"Every tab, read-only"});
      fs.writeFileSync(f,JSON.stringify(j,null,2));' "$DEMO_FILE"
    unset DPW
    echo "director added to the demo sign-in list"
  else
    echo "director already in the demo list"
  fi
else
  echo "demo mode off: skipped"
fi
unset PGPASSWORD

step "5/7 build"
npm ci --no-audit --no-fund
NODE_OPTIONS=--max-old-space-size=1536 npm run build

step "6/7 start the app (pm2 lms-app, port $APP_PORT)"
if pm2 describe lms-app >/dev/null 2>&1; then
  pm2 restart lms-app
else
  pm2 start npm --name lms-app -- start -- -H 0.0.0.0 -p "$APP_PORT"
fi
pm2 save
for _ in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${APP_PORT}/login" || true)
  [ "$code" = "200" ] && break; sleep 2
done
echo "login page: HTTP $code"

step "7/7 restart after a reboot + 5-minute watchdog (cron)"
# Both lines load nvm first (the old '@reboot bash -lc pm2 resurrect' did not, so nothing came back).
# Other cron lines are kept; only our two are replaced.
REBOOT='@reboot /bin/bash -c "export NVM_DIR=\$HOME/.nvm; . \$NVM_DIR/nvm.sh; pm2 resurrect" >> $HOME/logs/pm2-reboot.log 2>&1 # pm2-reboot'
WATCH='*/5 * * * * /bin/bash -c "export NVM_DIR=\$HOME/.nvm; . \$NVM_DIR/nvm.sh; pm2 ping >/dev/null; pm2 describe lms-app >/dev/null 2>&1 || pm2 resurrect" >> $HOME/logs/pm2-watchdog.log 2>&1 # pm2-watchdog'
mkdir -p "$HOME/logs"
{ crontab -l 2>/dev/null | grep -v -e 'pm2-reboot' -e 'pm2-watchdog' -e '^@reboot.*pm2 resurrect' || true; echo "$REBOOT"; echo "$WATCH"; } | crontab -
crontab -l | grep -e 'pm2-reboot' -e 'pm2-watchdog'

pm2 list
[ "$code" = "200" ] && echo "DONE: the site is up." || { echo "The app did not answer: run  pm2 logs lms-app --lines 50"; exit 1; }
