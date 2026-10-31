# Go-live plan: GitHub → DreamHost VPS (pm2), with the exact local database

**Target:** DreamHost managed VPS (no sudo, pm2).
**Code:** https://github.com/HassnainYaqoob789/land-management-system (branch `main`).
**Data:** an exact copy of the local `lms_dev`, at migration 0059, with every user, record and uploaded document.

The general guide with every option is [DREAMHOST_VPS_DEPLOYMENT.md](DREAMHOST_VPS_DEPLOYMENT.md). This page is the one path chosen.

---

## What goes where

| Item | Travels by | Why not GitHub |
|---|---|---|
| Source code, migrations, docs | **GitHub** (`git clone`) | — |
| Database `db/live-snapshot/lms_dev.dump` (1.6 MB) | **scp**, directly to the server | Holds account password hashes and personal data; must not be in a public repository |
| Uploaded documents `db/live-snapshot/documents.tgz` | **scp** | Same reason |
| `IAM_MASTER_KEYS`, `IAM_HMAC_KEY` from your PC's `.env.local` | **Typed by hand** into the server's settings file | They decrypt MFA secrets and sign sessions. Anyone holding them could forge sign-ins |
| Client material (`archive/requirments/`) | Stays on your PC | Excluded on purpose |

`db/live-snapshot/` is in `.gitignore`, so the dump can never be committed by mistake. Re-create it just before going live (step 0), so it holds the latest data.

---

## Step 0: on your PC, the day you go live (Git Bash)

```bash
cd /c/Users/DELL/Downloads/lms/lms
P="/c/Program Files/PostgreSQL/18/bin"
"$P/pg_dump" -h localhost -p 5433 -U postgres -Fc -Z6 -d lms_dev -f db/live-snapshot/lms_dev.dump
tar -czf db/live-snapshot/documents.tgz -C .data documents
scp db/live-snapshot/lms_dev.dump db/live-snapshot/documents.tgz myuser@vps12345.dreamhostps.com:~/
```
Push any new code first: `git add -A && git commit -m "…" && git push`.

On 31 Oct 2026 this dump was restored into a scratch database and checked:
- `migrate.py status` showed 58 applied and 0 drift;
- users, land requests, cheques and khasras matched `lms_dev`;
- every object was owned by `lms_owner`.

---

## Step 1: Node 22, pm2 and the code
```bash
ssh myuser@vps12345.dreamhostps.com
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash   # skip if nvm exists
source ~/.bashrc && nvm install 22 && nvm alias default 22
npm install -g pm2
mkdir -p ~/apps && cd ~/apps
git clone https://github.com/HassnainYaqoob789/land-management-system.git lms
cd lms
```

## Step 2: PostgreSQL **18** in your home folder (the same major version as your PC)
```bash
cd ~
curl -Ls https://micro.mamba.pm/api/micromamba/linux-64/latest | tar -xvj bin/micromamba
./bin/micromamba create -y -p ~/pg18 -c conda-forge postgresql=18
echo 'export PATH="$HOME/pg18/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc
psql --version                                   # 18.x

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
pm2 logs lms-db --lines 5 --nostream            # "ready to accept connections"
```
Check the extensions are there. Stop here if fewer than 4 lines appear:
```bash
export PGHOST=127.0.0.1 PGPORT=5433 PGUSER=postgres PGPASSWORD="$(cat ~/.pg_super_pw)"
psql -d postgres -Atc "select name from pg_available_extensions where name in ('pgcrypto','citext','pg_trgm','btree_gist') order by 1"
```

## Step 3: roles, an empty database, then the exact copy
```bash
cd ~/apps/lms
psql -v ON_ERROR_STOP=1 -d postgres -f db/bootstrap/01_roles.sql
psql -v ON_ERROR_STOP=1 -d postgres -v db=lms_prod -f db/bootstrap/02_database.sql
pg_restore -d lms_prod --exit-on-error ~/lms_dev.dump
```
Set passwords for the two login roles. Generate each with `openssl rand -base64 24` and keep them in your password manager:
```bash
psql -d postgres -c "ALTER ROLE lms_migrator PASSWORD 'MIGRATOR_PASSWORD';"
psql -d postgres -c "ALTER ROLE lms_app      PASSWORD 'APP_PASSWORD';"
```
Check:
```bash
PGUSER=lms_migrator PGPASSWORD='MIGRATOR_PASSWORD' PGDATABASE=lms_prod python3 db/tools/migrate.py status
# → 58 on disk, 58 applied, 0 pending, 0 drifted
psql -d lms_prod -Atc "select count(*) from lms.app_user"     # same number as on your PC
```

## Step 4: uploaded documents
```bash
mkdir -p ~/lms-data && tar -xzf ~/documents.tgz -C ~/lms-data
ls ~/lms-data/documents | head
```

## Step 5: settings (`~/apps/lms/.env.production.local`)
```bash
nano ~/apps/lms/.env.production.local
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
# copy these two lines EXACTLY from your PC's .env.local:
IAM_HMAC_KEY=
IAM_MASTER_KEYS=
```
```bash
chmod 600 ~/apps/lms/.env.production.local
```
- Use **the same keys as your PC**. With new keys, MFA and saved SSO settings from the copied data cannot be read.
- Replace `/home/myuser` with the output of `echo $HOME`.

**Demo sign-in list.** The copied accounts keep the passwords they have on your PC.
- If the demo list must show on the sign-in page, add these two lines:
  ```ini
  LMS_DEMO_MODE=on
  LMS_DEMO_CREDENTIALS_FILE=/home/myuser/lms-data/demo-credentials.json
  ```
- Then copy `.data/demo-credentials.json` from your PC to that path with scp.
- **Anyone who opens the site then sees every password, admin included.** Use it only for a demo period, then remove both lines and run `pm2 restart lms-app`.

## Step 6: build and start
```bash
cd ~/apps/lms
npm ci
NODE_OPTIONS=--max-old-space-size=1536 npm run build
pm2 start npm --name lms-app -- start -- -H 127.0.0.1 -p 8040
pm2 save
(crontab -l 2>/dev/null; echo "@reboot bash -lc 'pm2 resurrect'") | crontab -
curl -I http://127.0.0.1:8040/login         # HTTP/1.1 200
```
If the build is killed (out of memory), build on your PC, upload only the `.next` folder into `~/apps/lms/.next`, run `npm ci` on the server, then start.

## Step 7: domain and SSL (DreamHost panel)
1. Add `lms.yourdomain.com` under **Websites** for this VPS user.
2. **Proxy Server**: domain `lms.yourdomain.com`, path `/`, port `8040`.
3. **Secure Certificates**: Let's Encrypt (free), and force HTTPS.
4. Open `https://lms.yourdomain.com/login` and sign in with any of your PC's accounts.

## Step 8: daily backup
```bash
mkdir -p ~/backups
(crontab -l; echo '30 2 * * * PGPASSWORD="$(cat $HOME/.pg_super_pw)" $HOME/pg18/bin/pg_dump -h 127.0.0.1 -p 5433 -U postgres -Fc -d lms_prod -f $HOME/backups/lms_prod-$(date +\%F).dump && find $HOME/backups -name "*.dump" -mtime +14 -delete') | crontab -
```
Download `~/backups`, `~/lms-data/documents` and `.env.production.local` to a safe place regularly.

---

## Updating later

On the PC: `git add -A && git commit -m "…" && git push`.

On the server:
```bash
cd ~/apps/lms && pm2 stop lms-app
PGHOST=127.0.0.1 PGPORT=5433 PGUSER=postgres PGPASSWORD="$(cat ~/.pg_super_pw)" pg_dump -Fc -d lms_prod -f ~/backups/before-update.dump
git pull
PGHOST=127.0.0.1 PGPORT=5433 PGUSER=lms_migrator PGPASSWORD='MIGRATOR_PASSWORD' PGDATABASE=lms_prod python3 db/tools/migrate.py up
npm ci && npm run build && pm2 restart lms-app
```
After go-live, the **live** database is the master copy. Do not restore your PC's dump over it again, or live data is lost.

## Go-live checklist
- [ ] `pm2 ls`: `lms-db` and `lms-app` are online
- [ ] `migrate.py status`: 0 drifted
- [ ] HTTPS works; sign-in works with a copied account; MFA works for accounts that had it
- [ ] An uploaded document opens (proves `DOCUMENT_STORE_DIR`)
- [ ] Demo mode off (or a written end date for it)
- [ ] Backup cron runs; a copy is kept off the server
