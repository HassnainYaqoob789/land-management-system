# Deploying the LMS to DreamHost (GitHub + pm2)

From GitHub to a live HTTPS site on a DreamHost VPS. No root (`sudo`) is needed: Node, PostgreSQL and the app all run as your shell user, kept alive by **pm2**.

- **Code:** https://github.com/HassnainYaqoob789/land-management-system (branch `main`)
- **Stack:** Next.js 15 on Node 22, PostgreSQL **18**, migrations 0001–0059
- **Short version for go-live day:** [GO_LIVE_PLAN.md](GO_LIVE_PLAN.md) (the exact-database path, step by step)

---

## The flow at a glance

```
PC (Windows)                         GitHub                      DreamHost VPS (your shell user)
────────────                         ──────                      ───────────────────────────────
git push  ─────────────────────────▶  main  ──── git clone/pull ─▶  ~/apps/lms        (code)
pg_dump lms_dev ── scp ─────────────────────────────────────────▶  ~/lms_dev.dump    (data, never in git)
.data/documents ── scp ─────────────────────────────────────────▶  ~/lms-data/documents
.env.local keys ── typed by hand ───────────────────────────────▶  ~/apps/lms/.env.production.local

                                                                   pm2: lms-db  (PostgreSQL 18, 127.0.0.1:5433)
                                                                   pm2: lms-app (Next.js, 127.0.0.1:8040)
                                                                   DreamHost panel: domain → Proxy :8040 → Let's Encrypt SSL
```

| Item | How it travels | Never in GitHub because |
|---|---|---|
| Code, migrations, docs | `git push` / `git clone` / `git pull` | — |
| Database dump | `scp` | It holds password hashes and personal data, and the repository is public |
| Uploaded documents | `scp` | Same reason |
| `IAM_MASTER_KEYS`, `IAM_HMAC_KEY` | Typed by hand on the server | They decrypt MFA secrets and sign sessions |
| Client material (`archive/requirments/`) | Stays on the PC | Excluded on purpose |

`.gitignore` already keeps out `.env*` (except `.env.example`), `.data/`, `backups/`, `db/live-snapshot/`, `*.dump` and `archive/requirments/`.

---

## 0. Before you start

| Need | Example | Notes |
|---|---|---|
| SSH to the VPS | `ssh myuser@vps12345.dreamhostps.com` | Your DreamHost shell user |
| A domain or subdomain | `lms.yourdomain.com` | Added in the DreamHost panel (step 7) |
| RAM | 4 GB recommended, 2 GB minimum | `next build` is the heaviest step |
| On the PC | Git Bash, PostgreSQL 18 tools (`C:\Program Files\PostgreSQL\18\bin`) | Already installed |

Run `sudo -v` once on the VPS. If it works, you may also use the root setup in the Appendix; the pm2 flow below works either way.

---

## 1. On your PC: push the code

```bash
cd /c/Users/DELL/Downloads/lms/lms
git add -A
git commit -m "describe the change"
git push                        # → origin/main
```

## 2. On your PC: export the database and documents (exact-copy path)

Skip this step if the server should start empty (§5, option A).
```bash
P="/c/Program Files/PostgreSQL/18/bin"
"$P/pg_dump" -h localhost -p 5433 -U postgres -Fc -Z6 -d lms_dev -f db/live-snapshot/lms_dev.dump
tar -czf db/live-snapshot/documents.tgz -C .data documents
scp db/live-snapshot/lms_dev.dump db/live-snapshot/documents.tgz myuser@vps12345.dreamhostps.com:~/
```

---

## 3. On the VPS: Node 22, pm2 and the code

```bash
ssh myuser@vps12345.dreamhostps.com
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash   # skip if nvm exists
source ~/.bashrc
nvm install 22 && nvm alias default 22
npm install -g pm2
mkdir -p ~/apps && cd ~/apps
git clone https://github.com/HassnainYaqoob789/land-management-system.git lms
```

## 4. On the VPS: PostgreSQL 18 in your home folder

PostgreSQL 18 is the same major version as the PC, so a dump from the PC restores as it is. It comes from conda-forge through micromamba, with no root.
```bash
cd ~
curl -Ls https://micro.mamba.pm/api/micromamba/linux-64/latest | tar -xvj bin/micromamba
./bin/micromamba create -y -p ~/pg18 -c conda-forge postgresql=18
echo 'export PATH="$HOME/pg18/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc
psql --version                                        # 18.x

openssl rand -base64 24 > ~/.pg_super_pw && chmod 600 ~/.pg_super_pw
initdb -D ~/pgdata -U postgres --pwfile=$HOME/.pg_super_pw -A scram-sha-256 -E UTF8 --locale=C.UTF-8
cat >> ~/pgdata/postgresql.conf <<'CONF'
listen_addresses = 'localhost'
port = 5433
unix_socket_directories = '/tmp'
shared_buffers = 128MB
max_connections = 40
CONF

pm2 start "$HOME/pg18/bin/postgres" --name lms-db -- -D "$HOME/pgdata"
pm2 logs lms-db --lines 5 --nostream                 # "ready to accept connections"
```

Check the four extensions the LMS needs. **Stop if fewer than 4 lines appear:**
```bash
export PGHOST=127.0.0.1 PGPORT=5433 PGUSER=postgres PGPASSWORD="$(cat ~/.pg_super_pw)"
psql -d postgres -Atc "select name from pg_available_extensions where name in ('pgcrypto','citext','pg_trgm','btree_gist') order by 1"
```

PostgreSQL listens on `127.0.0.1` only, so it cannot be reached from the internet.

---

## 5. On the VPS: create the database

Roles and an empty database first (always):
```bash
cd ~/apps/lms
psql -v ON_ERROR_STOP=1 -d postgres -f db/bootstrap/01_roles.sql
psql -v ON_ERROR_STOP=1 -d postgres -v db=lms_prod -f db/bootstrap/02_database.sql
```

Give the two login roles their passwords. Generate each with `openssl rand -base64 24` and save them in your password manager:
```bash
psql -d postgres -c "ALTER ROLE lms_migrator PASSWORD 'MIGRATOR_PASSWORD';"
psql -d postgres -c "ALTER ROLE lms_app      PASSWORD 'APP_PASSWORD';"
```

Then choose **one** starting point:

| Option | Use when | Commands |
|---|---|---|
| **A. Exact copy of the PC** | Go live with the data you have now | `pg_restore -d lms_prod --exit-on-error ~/lms_dev.dump` |
| **B. Empty production** | A clean start with real data only | `PGUSER=lms_migrator PGPASSWORD='MIGRATOR_PASSWORD' PGDATABASE=lms_prod python3 db/tools/migrate.py up`, then `psql -d lms_prod -v name='Your Name' -v email='you@company.com' -f db/seed/seed_production_admin.sql` |
| **C. Demo data** | A presentation server | Option B's `migrate.py up`, then load `db/seed/seed_demo.sql`, `seed_demo_transactions.sql` and `seed_exploration_accounts.sql` with `psql -d lms_prod -f …` |

Check, whatever you chose:
```bash
PGUSER=lms_migrator PGPASSWORD='MIGRATOR_PASSWORD' PGDATABASE=lms_prod python3 db/tools/migrate.py status
# → 58 on disk, 58 applied, 0 pending, 0 drifted
```
Optional speed-up: `psql -d lms_prod -f db/bootstrap/03_leakproof.sql`

For option A, also unpack the documents:
```bash
mkdir -p ~/lms-data && tar -xzf ~/documents.tgz -C ~/lms-data
```
For B and C, create an empty folder instead: `mkdir -p ~/lms-data/documents`.

---

## 6. On the VPS: settings file

Copy the template and fill it in (`echo $HOME` gives your home path):
```bash
cd ~/apps/lms
cp .env.example .env.production.local
nano .env.production.local
chmod 600 .env.production.local
```
```ini
NODE_ENV=production
DATABASE_URL=postgresql://lms_app:APP_PASSWORD@127.0.0.1:5433/lms_prod
APP_ORIGIN=https://lms.yourdomain.com
IAM_COOKIE_SECURE=true
TRUST_PROXY_HOPS=1
DOCUMENT_STORE_DIR=/home/myuser/lms-data/documents
DB_POOL_MAX=10
IAM_TOTP_ISSUER=Mari Energies LMS
IAM_RP_NAME=Mari Energies LMS
IAM_HMAC_KEY=
IAM_MASTER_KEYS=
```

| Setting | Rule |
|---|---|
| `IAM_HMAC_KEY`, `IAM_MASTER_KEYS` | **Option A:** copy both lines **exactly** from the PC's `.env.local`; with new keys, MFA and saved SSO settings stop working. **Options B and C:** make new ones with `openssl rand -base64 32` (master key format `k1:<value>`) |
| `DATABASE_URL` | Always the `lms_app` role. The app refuses a superuser or owner connection |
| `APP_ORIGIN` | The exact public URL; requests from any other origin are refused |
| `LMS_DEMO_MODE` | Leave it out. With it on, the sign-in page shows every account's password to anyone. If you need it for a demo period, also set `LMS_DEMO_CREDENTIALS_FILE` and copy `.data/demo-credentials.json` with scp, then remove both lines afterwards |

Keep a copy of this file in the company password vault. Without the keys, an exact restore is not fully usable.

---

## 7. On the VPS: build and start with pm2

```bash
cd ~/apps/lms
npm ci
NODE_OPTIONS=--max-old-space-size=1536 npm run build
pm2 start npm --name lms-app -- start -- -H 127.0.0.1 -p 8040
pm2 save
(crontab -l 2>/dev/null; echo "@reboot bash -lc 'pm2 resurrect'") | crontab -
curl -I http://127.0.0.1:8040/login                  # HTTP/1.1 200
pm2 ls                                                # lms-db and lms-app: online
```
- `pm2 startup` needs root, which is why the `@reboot` cron line restarts everything after a reboot instead.
- **If the build is killed (out of memory):**
  1. Run `npm ci && npm run build` on the PC.
  2. Upload only the `.next` folder to `~/apps/lms/.next` with scp.
  3. Run `npm ci` on the server (it compiles the native password library for Linux).
  4. Start with pm2.

---

## 8. DreamHost panel: domain, proxy and SSL

1. **Websites → Manage Websites:** add `lms.yourdomain.com` as a site on this VPS user.
2. **Proxy Server:** domain `lms.yourdomain.com`, path `/`, port **8040**. If the panel allows only a certain port range, use a port in that range in step 7 (`-p`) and here.
3. **Secure Certificates:** add the free Let's Encrypt certificate and force HTTPS.
4. Open `https://lms.yourdomain.com/login`.

HTTPS is required: with `IAM_COOKIE_SECURE=true`, sign-in does not work over plain `http://`.

## 9. First sign-in

- **Option A:** sign in with any account from the PC; its password and MFA are unchanged.
- **Options B and C:** set the admin password, then sign in, change it and enrol MFA:
  ```bash
  cd ~/apps/lms
  DATABASE_URL_ADMIN='postgresql://lms_migrator:MIGRATOR_PASSWORD@127.0.0.1:5433/lms_prod' \
    npx tsx scripts/iam/bootstrap.ts --username admin
  ```
- As admin, open **Users & Roles** and create or adjust the users, their provinces and approval positions.

---

## 10. Backups (daily)

```bash
mkdir -p ~/backups
(crontab -l; echo '30 2 * * * PGPASSWORD="$(cat $HOME/.pg_super_pw)" $HOME/pg18/bin/pg_dump -h 127.0.0.1 -p 5433 -U postgres -Fc -d lms_prod -f $HOME/backups/lms_prod-$(date +\%F).dump && find $HOME/backups -name "*.dump" -mtime +14 -delete') | crontab -
```
- Download `~/backups`, `~/lms-data/documents` and `.env.production.local` **off the VPS** regularly (scp or DreamObjects).
- DreamHost does not back up a user-run PostgreSQL, so this cron job is the only database backup.
- Test a restore once: `createdb lms_restore_test && pg_restore -d lms_restore_test ~/backups/<file>.dump`.

## 11. Updating to a new version (the GitHub flow)

On the PC: `git add -A && git commit -m "…" && git push`.

On the VPS:
```bash
cd ~/apps/lms
pm2 stop lms-app
PGPASSWORD="$(cat ~/.pg_super_pw)" pg_dump -h 127.0.0.1 -p 5433 -U postgres -Fc -d lms_prod -f ~/backups/before-update-$(date +%F).dump
git pull
PGHOST=127.0.0.1 PGPORT=5433 PGUSER=lms_migrator PGPASSWORD='MIGRATOR_PASSWORD' PGDATABASE=lms_prod python3 db/tools/migrate.py up
npm ci && npm run build
pm2 restart lms-app
```
- Migrations only move forward. The backup line above is your undo.
- Once live, **the live database is the master copy**. Never restore the PC's dump over it again.

## 12. Everyday commands

| Task | Command |
|---|---|
| Status | `pm2 ls` |
| App logs | `pm2 logs lms-app` |
| Database logs | `pm2 logs lms-db` |
| Restart the app | `pm2 restart lms-app` |
| Migration status | `PGHOST=127.0.0.1 PGPORT=5433 PGUSER=lms_migrator PGPASSWORD=… PGDATABASE=lms_prod python3 db/tools/migrate.py status` |
| Stop everything cleanly | `pm2 stop lms-app && pm2 stop lms-db` |

## 13. Problems and fixes

| Symptom | Likely cause | Fix |
|---|---|---|
| `pg_restore` fails: unsupported version | The server is not on PostgreSQL 18 | Recreate `~/pg18` with `postgresql=18` |
| App log: "refusing to connect as …" | `DATABASE_URL` is not `lms_app` | Fix the URL, then `pm2 restart lms-app` |
| Sign-in page loads but sign-in fails | Site opened over `http://`, or `APP_ORIGIN` differs from the URL | Use HTTPS; make `APP_ORIGIN` the exact URL |
| MFA codes rejected after an exact restore | Keys differ from the PC | Copy `IAM_MASTER_KEYS` and `IAM_HMAC_KEY` from the PC's `.env.local` |
| Documents do not open | `DOCUMENT_STORE_DIR` is wrong, or documents were not unpacked | Check the path; `ls ~/lms-data/documents` |
| `npm run build` is "Killed" | Not enough RAM | Build on the PC and upload `.next` (step 7) |
| Site down after a VPS reboot | pm2 not resurrected | `pm2 resurrect`; check `crontab -l` has the `@reboot` line |

## 14. Go-live checklist

- [ ] `pm2 ls` shows `lms-db` and `lms-app` online
- [ ] `migrate.py status` shows 0 drifted
- [ ] HTTPS works, and `http://` redirects to it
- [ ] Sign-in works; MFA works for accounts that had it
- [ ] An uploaded document opens
- [ ] `LMS_DEMO_MODE` is off (or has a written end date)
- [ ] The backup cron runs, and a copy is kept off the VPS
- [ ] `.env.production.local` is saved in the password vault
- [ ] Before real client data arrives: the GitHub repository is made **private**

---

## Appendix: if you have `sudo` (DreamCompute or a root VPS)

The flow is the same. Only the parts that root makes easier change:

| Step | With sudo instead |
|---|---|
| PostgreSQL | `sudo apt install postgresql-18` from the PGDG repository (https://www.postgresql.org/download/linux/ubuntu/), then roles, database and restore as in §5 (use `sudo -u postgres psql` for the superuser steps) |
| Keep-alive | A systemd unit running `npx next start -H 127.0.0.1 -p 8040` with `EnvironmentFile=/path/.env.production.local`, or pm2 with `pm2 startup` |
| Proxy and SSL | nginx `proxy_pass http://127.0.0.1:8040;` with `client_max_body_size 55m;`, then `sudo certbot --nginx -d lms.yourdomain.com --redirect` |
| Firewall | `sudo ufw allow OpenSSH && sudo ufw allow 'Nginx Full' && sudo ufw enable` |
| Backups | The same `pg_dump` cron, as the `postgres` user |
