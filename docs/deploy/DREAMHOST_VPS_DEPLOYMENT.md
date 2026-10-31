# Deploying the LMS to a DreamHost server

Step-by-step: server → PostgreSQL → database → app → web server and SSL → first admin → backups.
Written 31 Oct 2026 for this repository (Next.js 15, Node 22, PostgreSQL 16, migrations 0001–0059).

---

## 0. First, check which DreamHost product you have (important)

The LMS needs **PostgreSQL** and its own database roles, row-level security and extensions (`pgcrypto`, `citext`, `pg_trgm`, `btree_gist`).

| DreamHost product | Root / `sudo`? | Can it run this LMS? |
|---|---|---|
| **DreamCompute** (cloud server, you pick Ubuntu) | Yes | **Yes, recommended.** Follow this guide as written. |
| **"VPS" (managed VPS hosting)** | No: shell user only, apps run with pm2 | **Yes, with §11.** PostgreSQL is installed in your home folder (no root), and pm2 runs both the database and the app. |

To check, sign in over SSH and run `sudo -v`. If it asks for your password and accepts it, you have root and can follow this guide. If it says you are not in the sudoers file, you are on managed hosting.

- **No sudo (managed VPS, pm2):** read §2 (packaging), §5.6 (starting data) and §6 (settings), then follow **§11** step by step. Skip §3, §4, §7, §8 and §10.
- **With sudo:** follow §1–§10 (Ubuntu 24.04 LTS).

**Recommended size:** 2 vCPU, 4 GB RAM, 40 GB disk. 2 GB RAM is the minimum, and the build then needs swap (§3.3).

---

## 1. What you need before you start

| Item | Example | Notes |
|---|---|---|
| Server IP | `203.0.113.10` | From the DreamHost panel |
| SSH access | `ssh ubuntu@203.0.113.10` | Key-based login recommended |
| A domain or subdomain | `lms.marienergies.com.pk` | DNS **A record** → server IP (set it now; DNS takes time) |
| The project code | this folder | Without `node_modules`, `.next`, `.data`, `.env.local` |
| An e-mail for SSL notices | `it@example.com` | Let's Encrypt |

---

## 2. Package the code on your PC (Windows, Git Bash)

Most of the code is **not committed to git** (CLAUDE.md §9, item 7), so `git clone` on the server would miss it. Upload an archive instead:

```bash
cd /c/Users/DELL/Downloads/lms
tar --exclude='lms/node_modules' --exclude='lms/.next' --exclude='lms/.next-test' \
    --exclude='lms/.data' --exclude='lms/.env.local' --exclude='lms/test-results' \
    --exclude='lms/playwright-report' --exclude='lms/backups' --exclude='lms/graphify-out' \
    -czf lms-release.tgz lms
scp lms-release.tgz ubuntu@203.0.113.10:/tmp/
```

Never upload `.env.local` or `.data/`. They hold your local keys, passwords and database files. The server gets its own (§6).

*(Better long term: commit everything to a private Git repository, then `git clone` on the server and `git pull` for updates.)*

---

## 3. Prepare the server (once)

### 3.1 Update and basic tools
```bash
sudo apt update && sudo apt -y upgrade
sudo apt -y install curl git unzip build-essential python3 ufw nginx
sudo timedatectl set-timezone Asia/Karachi
```

### 3.2 Firewall
```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
```
Port 5432 (PostgreSQL) and 3040 (the app) stay **closed** to the internet. Only nginx (80/443) is public.

### 3.3 Swap (needed on 2–4 GB servers for `next build`)
```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

### 3.4 Node.js 22
```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt -y install nodejs
node -v      # v22.x
```

### 3.5 A service user for the app
```bash
sudo adduser --system --group --home /opt/lms lms
```

---

## 4. Install PostgreSQL 16

```bash
sudo apt -y install postgresql-16 postgresql-contrib-16
sudo systemctl enable --now postgresql
sudo -u postgres psql -c "select version();"
```

`postgresql-contrib` provides the four extensions the migrations create.

**Listen only locally** (the default on Ubuntu). Confirm in `/etc/postgresql/16/main/postgresql.conf`:
```
listen_addresses = 'localhost'
```

**Password authentication:** in `/etc/postgresql/16/main/pg_hba.conf`, keep these lines (scram, localhost only):
```
local   all   postgres                 peer
host    all   all       127.0.0.1/32   scram-sha-256
host    all   all       ::1/128        scram-sha-256
```
Then reload:
```bash
sudo systemctl reload postgresql
```

---

## 5. Create the database (roles → database → migrations)

### 5.1 Unpack the code
```bash
sudo mkdir -p /opt/lms && sudo tar -xzf /tmp/lms-release.tgz -C /opt/
# the archive contains a folder "lms" → /opt/lms
sudo chown -R lms:lms /opt/lms
cd /opt/lms
```

### 5.2 Roles (`db/bootstrap/01_roles.sql`)
This creates `lms_owner`, `lms_migrator`, `lms_app`, `lms_report`, `lms_worker` and the other roles, all **without passwords**.
```bash
sudo -u postgres psql -v ON_ERROR_STOP=1 -d postgres -f db/bootstrap/01_roles.sql
```

Give the two login roles the app and the migrations use a strong password each. Generate them, store them in your password manager, and never commit them:
```bash
openssl rand -base64 24   # → password for lms_migrator
openssl rand -base64 24   # → password for lms_app
sudo -u postgres psql -c "ALTER ROLE lms_migrator PASSWORD 'PASTE_MIGRATOR_PASSWORD';"
sudo -u postgres psql -c "ALTER ROLE lms_app      PASSWORD 'PASTE_APP_PASSWORD';"
```
*(Do the same for `lms_worker` if you will run the SAP worker, and for `lms_report` if a reporting tool connects.)*

### 5.3 Database (`02_database.sql`)
```bash
sudo -u postgres psql -v ON_ERROR_STOP=1 -d postgres -v db=lms_prod -f db/bootstrap/02_database.sql
```

### 5.4 Migrations 0001–0059
```bash
export PGHOST=127.0.0.1 PGPORT=5432 PGUSER=lms_migrator PGDATABASE=lms_prod
export PGPASSWORD='PASTE_MIGRATOR_PASSWORD'
python3 db/tools/migrate.py up
python3 db/tools/migrate.py status      # expect: 58 on disk, 58 applied, 0 drifted
unset PGPASSWORD
```

### 5.5 Optional superuser step
```bash
sudo -u postgres psql -d lms_prod -f db/bootstrap/03_leakproof.sql
```
This speeds up code searches under row-level security (see the file's header). `04_fix_ownership.sql` is only a repair script; a fresh build like this one does not need it.

### 5.6 Choose the starting data

| Option | When | Command |
|---|---|---|
| **A. Empty production** (recommended) | Real use, UAT with real data | Nothing more. Create the first admin (§9) and add real projects and users. |
| **B. Demo data** | A demo server for presentations | `psql -U lms_migrator -h 127.0.0.1 -d lms_prod -f db/seed/seed_demo.sql`, then `seed_demo_transactions.sql`, then `seed_exploration_accounts.sql` |
| **C. Copy your local `lms_dev`** | You want exactly what you have on your PC | §10.3 (dump on the PC, restore on the server) |

Never load demo data into the real production database.

---

## 6. Configure the app (`/opt/lms/.env.production.local`)

Generate the two security keys **on the server**:
```bash
echo "IAM_HMAC_KEY=$(openssl rand -base64 32)"
echo "IAM_MASTER_KEYS=k1:$(openssl rand -base64 32)"
```

Create the file:
```bash
sudo -u lms nano /opt/lms/.env.production.local
```
```ini
NODE_ENV=production
DATABASE_URL=postgresql://lms_app:PASTE_APP_PASSWORD@127.0.0.1:5432/lms_prod
APP_ORIGIN=https://lms.marienergies.com.pk
IAM_COOKIE_SECURE=true
TRUST_PROXY_HOPS=1
IAM_HMAC_KEY=PASTE_FROM_ABOVE
IAM_MASTER_KEYS=k1:PASTE_FROM_ABOVE
DOCUMENT_STORE_DIR=/var/lib/lms/documents
DB_POOL_MAX=10
IAM_TOTP_ISSUER=Mari Energies LMS
IAM_RP_NAME=Mari Energies LMS
# never in production:
# LMS_DEMO_MODE=on
```
```bash
sudo chmod 600 /opt/lms/.env.production.local
sudo mkdir -p /var/lib/lms/documents && sudo chown -R lms:lms /var/lib/lms
```

| Rule | Why |
|---|---|
| `DATABASE_URL` uses **`lms_app`**, never `postgres` or `lms_migrator` | The app refuses a superuser or owner connection (`assertSafeDbRole`); RLS depends on it |
| **Keep the keys safe and never change them casually** | `IAM_MASTER_KEYS` encrypts MFA secrets and SSO settings in the DB. Lose it, and those can't be read. Rotate by adding `k2:…` in front, keeping `k1` after it |
| If you copied `lms_dev` (option C) | Use the **same** `IAM_MASTER_KEYS` and `IAM_HMAC_KEY` as your PC's `.env.local`, or MFA and sessions from that data won't work |
| `LMS_DEMO_MODE` stays off | With it on, the sign-in page shows every demo password to anyone (audit item O1) |
| `APP_ORIGIN` = the exact public URL | The CSRF check refuses requests from any other origin |
| `DATABASE_URL_ADMIN`, `JWT_SECRET` | Not needed by the app; leave them out |

---

## 7. Build and run the app

### 7.1 Install and build
```bash
cd /opt/lms
sudo -u lms npm ci
sudo -u lms npm run build        # 3–8 minutes; needs the swap on small servers
```

### 7.2 Run as a service (systemd)
```bash
sudo nano /etc/systemd/system/lms.service
```
```ini
[Unit]
Description=Mari Energies LMS
After=network.target postgresql.service

[Service]
Type=simple
User=lms
WorkingDirectory=/opt/lms
EnvironmentFile=/opt/lms/.env.production.local
ExecStart=/usr/bin/npx next start -H 127.0.0.1 -p 3040
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now lms
sudo systemctl status lms            # active (running)
curl -I http://127.0.0.1:3040/login  # HTTP/1.1 200
```
Logs: `journalctl -u lms -f`

---

## 8. Nginx, domain and SSL

### 8.1 Nginx reverse proxy
```bash
sudo nano /etc/nginx/sites-available/lms
```
```nginx
server {
    listen 80;
    server_name lms.marienergies.com.pk;

    client_max_body_size 55m;          # documents up to 50 MB, KML uploads

    location / {
        proxy_pass         http://127.0.0.1:3040;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_set_header   Upgrade           $http_upgrade;
        proxy_set_header   Connection        "upgrade";
        proxy_read_timeout 120s;
    }
}
```
```bash
sudo ln -s /etc/nginx/sites-available/lms /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

### 8.2 Free SSL certificate (Let's Encrypt)
The DNS A record must already point at the server.
```bash
sudo apt -y install certbot python3-certbot-nginx
sudo certbot --nginx -d lms.marienergies.com.pk -m it@example.com --agree-tos --redirect
```
Renewal is automatic (`sudo certbot renew --dry-run` to test).

The app needs HTTPS. With `IAM_COOKIE_SECURE=true` the session cookie is sent only over HTTPS, so sign-in fails on plain `http://`.

---

## 9. First administrator and users

On an **empty** database (option A), create the first admin account. On a demo or copied database, skip this step, because `admin` already exists:
```bash
cd /opt/lms
PGPASSWORD='PASTE_MIGRATOR_PASSWORD' psql -h 127.0.0.1 -U lms_migrator -d lms_prod   -v name='Your Full Name' -v email='you@marienergies.com.pk' -f db/seed/seed_production_admin.sql
```
This gives `admin` the system-administrator role, the System Administrator position and all four provinces. Running it twice does no harm.

Then set its password:
```bash
export DATABASE_URL_ADMIN='postgresql://lms_migrator:PASTE_MIGRATOR_PASSWORD@127.0.0.1:5432/lms_prod'
sudo -E -u lms npx tsx scripts/iam/bootstrap.ts --username admin
unset DATABASE_URL_ADMIN
```
- The script prints a one-time password. Sign in at `https://lms.marienergies.com.pk/login`, change it, and enrol MFA under **Account & Security**.
- Then, as admin, open **Users & Roles** and create the real users, roles, provinces and approval positions (Director Operations, Regional Manager, DM / TL Land Affairs, Land Officer and the rest).
- Optional: in **Settings → Policy**, turn MFA on for everyone.

**Check it works:**

| Test | Expected |
|---|---|
| `https://…/login` | Sign-in page with the logo, padlock in the browser |
| Sign in as admin | Lands on the dashboard; MFA prompt if required |
| `http://…` | Redirects to `https://` |
| A user from Sindh only | Sees only Sindh records |

---

## 10. Day-two operations

### 10.1 Updating the app to a new version
```bash
# on the PC: build a new archive (§2) and scp it, then on the server:
sudo systemctl stop lms
sudo tar -xzf /tmp/lms-release.tgz -C /opt/ && sudo chown -R lms:lms /opt/lms
cd /opt/lms
PGHOST=127.0.0.1 PGUSER=lms_migrator PGDATABASE=lms_prod PGPASSWORD='…' python3 db/tools/migrate.py up
sudo -u lms npm ci && sudo -u lms npm run build
sudo systemctl start lms
```
The archive does not contain `.env.production.local`, so the server keeps its own settings. **Take a backup (§10.2) before every update.** Migrations only go forward; there is no undo.

### 10.2 Daily backups
```bash
sudo mkdir -p /var/backups/lms && sudo chown postgres:postgres /var/backups/lms
sudo crontab -u postgres -e
```
```cron
30 2 * * * pg_dump -Fc -Z6 -d lms_prod -f /var/backups/lms/lms_prod-$(date +\%F).dump && find /var/backups/lms -name '*.dump' -mtime +14 -delete
40 2 * * * pg_dumpall --globals-only > /var/backups/lms/globals-$(date +\%F).sql
```
Also back up `/var/lib/lms/documents` (uploaded files) and `/opt/lms/.env.production.local` (keys). Copy all three **off the server** (DreamHost DreamObjects, or another location). Encrypt the copies (audit item DB-07).

**Restore test** (do it once):
```bash
sudo -u postgres createdb -O lms_owner lms_restore_test
sudo -u postgres pg_restore -d lms_restore_test /var/backups/lms/lms_prod-YYYY-MM-DD.dump
```

### 10.3 Copy your local `lms_dev` to the server (option C)
On the PC (Git Bash):
```bash
"/c/Program Files/PostgreSQL/18/bin/pg_dump" -h localhost -p 5433 -U postgres -Fc -d lms_dev -f lms_dev.dump
scp lms_dev.dump ubuntu@203.0.113.10:/tmp/
```
On the server, do §5.2 (roles) **but skip §5.3–5.4**, then:
```bash
sudo -u postgres createdb -O lms_owner -E UTF8 lms_prod
sudo -u postgres psql -c "REVOKE ALL ON DATABASE lms_prod FROM PUBLIC; GRANT CONNECT ON DATABASE lms_prod TO lms_migrator, lms_app, lms_report;"
sudo -u postgres pg_restore --no-owner --role=lms_owner -d lms_prod /tmp/lms_dev.dump
PGHOST=127.0.0.1 PGUSER=lms_migrator PGDATABASE=lms_prod PGPASSWORD='…' python3 db/tools/migrate.py status   # 0 drifted
```
Use your PC's `IAM_MASTER_KEYS` and `IAM_HMAC_KEY` (§6). Your PC runs PostgreSQL 18 and the server runs 16, so a dump from 18 may not restore into 16. If `pg_restore` refuses it, install PostgreSQL 18 on the server instead (from the PGDG apt repository).

### 10.4 Useful commands

| Task | Command |
|---|---|
| App logs | `journalctl -u lms -f` |
| Restart app | `sudo systemctl restart lms` |
| Nginx errors | `sudo tail -f /var/log/nginx/error.log` |
| DB size | `sudo -u postgres psql -d lms_prod -c "select pg_size_pretty(pg_database_size('lms_prod'))"` |
| Migration status | `PGHOST=127.0.0.1 PGUSER=lms_migrator PGDATABASE=lms_prod PGPASSWORD=… python3 db/tools/migrate.py status` |

### 10.5 Optional: SAP outbox worker
Only once a real SAP gateway exists. It runs as its own service with `lms_worker` (see `scripts/sap_outbox_worker.ts` and `npm run worker:sap`).

---

## 11. DreamHost managed VPS (no sudo): pm2 + PostgreSQL in your home folder

Use this path if `sudo` does not work and you run apps with **pm2**. Nothing needs root:
- PostgreSQL is installed into your home folder with micromamba (conda-forge packages), which you download with `curl`.
- Node comes from `nvm`.
- `pm2` keeps PostgreSQL and the app running.
- DreamHost's panel gives the domain, the proxy and the SSL.

> DreamHost does not officially support a user-run PostgreSQL. It works, but **backups (§11.9) are your responsibility**, and the plan's RAM limit applies. Pick a plan with 4 GB RAM, or at least 2 GB.

Everything below runs as your normal shell user (e.g. `ssh myuser@vps12345.dreamhostps.com`).

### 11.1 Node 22 and pm2 (skip if you have them)
```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc
nvm install 22 && nvm alias default 22
npm install -g pm2
node -v && pm2 -v
```

### 11.2 PostgreSQL 16, without root
```bash
cd ~
curl -Ls https://micro.mamba.pm/api/micromamba/linux-64/latest | tar -xvj bin/micromamba
./bin/micromamba create -y -p ~/pg16 -c conda-forge postgresql=16
echo 'export PATH="$HOME/pg16/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc
psql --version        # psql (PostgreSQL) 16.x
```

Create the database cluster. Its superuser is called `postgres` and gets its own password:
```bash
openssl rand -base64 24 > ~/.pg_super_pw && chmod 600 ~/.pg_super_pw
initdb -D ~/pgdata -U postgres --pwfile=$HOME/.pg_super_pw -A scram-sha-256 -E UTF8 --locale=C.UTF-8
```

Make it listen **only on localhost**, on a free port such as **5433**:
```bash
cat >> ~/pgdata/postgresql.conf <<'CONF'
listen_addresses = 'localhost'
port = 5433
unix_socket_directories = '/tmp'
shared_buffers = 128MB
max_connections = 40
CONF
```

Start it with pm2 so it survives restarts:
```bash
pm2 start "$HOME/pg16/bin/postgres" --name lms-db -- -D "$HOME/pgdata"
pm2 logs lms-db --lines 20      # "database system is ready to accept connections"
```

Check the four extensions the LMS needs are present:
```bash
export PGHOST=127.0.0.1 PGPORT=5433 PGUSER=postgres PGPASSWORD="$(cat ~/.pg_super_pw)"
psql -d postgres -Atc "select name from pg_available_extensions where name in ('pgcrypto','citext','pg_trgm','btree_gist') order by 1"
# expect 4 lines: btree_gist, citext, pg_trgm, pgcrypto
```
If any is missing, stop and tell the developer before continuing.

### 11.3 Upload and unpack the code
Package the code on your PC as in §2, then:
```bash
scp lms-release.tgz myuser@vps12345.dreamhostps.com:~/
ssh myuser@vps12345.dreamhostps.com
mkdir -p ~/apps && tar -xzf ~/lms-release.tgz -C ~/apps     # → ~/apps/lms
cd ~/apps/lms
```

### 11.4 Database: roles → database → migrations
Use the `PGHOST/PGPORT/PGUSER/PGPASSWORD` set in 11.2 (the cluster superuser).
```bash
psql -v ON_ERROR_STOP=1 -d postgres -f db/bootstrap/01_roles.sql

openssl rand -base64 24    # → MIGRATOR password (save it)
openssl rand -base64 24    # → APP password (save it)
psql -d postgres -c "ALTER ROLE lms_migrator PASSWORD 'PASTE_MIGRATOR_PASSWORD';"
psql -d postgres -c "ALTER ROLE lms_app      PASSWORD 'PASTE_APP_PASSWORD';"

psql -v ON_ERROR_STOP=1 -d postgres -v db=lms_prod -f db/bootstrap/02_database.sql
psql -d lms_prod -f db/bootstrap/03_leakproof.sql        # optional, see §5.5

export PGUSER=lms_migrator PGPASSWORD='PASTE_MIGRATOR_PASSWORD' PGDATABASE=lms_prod
python3 db/tools/migrate.py up
python3 db/tools/migrate.py status       # 0 pending, 0 drifted
```

Starting data: choose A, B or C from §5.6. For **A (empty production)**, create the first admin now:
```bash
psql -d lms_prod -v name='Your Full Name' -v email='you@marienergies.com.pk' -f db/seed/seed_production_admin.sql
```
Then close the shell, so these passwords leave the environment.

### 11.5 App settings
Create `~/apps/lms/.env.production.local` with the values from §6, with these changes:
```ini
DATABASE_URL=postgresql://lms_app:PASTE_APP_PASSWORD@127.0.0.1:5433/lms_prod
APP_ORIGIN=https://lms.yourdomain.com
DOCUMENT_STORE_DIR=/home/myuser/lms-documents
TRUST_PROXY_HOPS=1
IAM_COOKIE_SECURE=true
```
```bash
chmod 600 ~/apps/lms/.env.production.local
mkdir -p ~/lms-documents
```
Generate `IAM_HMAC_KEY` and `IAM_MASTER_KEYS` exactly as in §6.

### 11.6 Build and run with pm2
```bash
cd ~/apps/lms
npm ci
NODE_OPTIONS=--max-old-space-size=1536 npm run build
pm2 start npm --name lms-app -- start -- -H 127.0.0.1 -p 8040
pm2 save
curl -I http://127.0.0.1:8040/login     # HTTP/1.1 200
```
Next.js reads `.env.production.local` by itself in production, so pm2 needs no extra environment.

**Restart after a server reboot** (`pm2 startup` needs root, so use cron instead):
```bash
crontab -e
@reboot  bash -lc 'pm2 resurrect'
```

**If the build is killed for lack of memory:** run `npm ci && npm run build` on your PC. Then upload only the `.next` folder into `~/apps/lms/.next`, run `npm ci` on the server (it compiles the native password library for Linux), and start with pm2.

### 11.7 Domain, proxy and SSL (DreamHost panel)
1. **Websites → Manage Websites**: add `lms.yourdomain.com` as a fully hosted site on this VPS user.
2. **Proxy Server** (in the panel under Advanced, or Servers → VPS): add a proxy for `lms.yourdomain.com`, path `/`, port **8040**.
3. **Websites → Secure Certificates**: add the free **Let's Encrypt** certificate to the domain, and turn on "force HTTPS" if offered.
4. Open `https://lms.yourdomain.com/login`.

If the panel only allows proxy ports in a certain range, start the app on a port in that range (change `-p 8040`) and use the same port in step 2.

The PostgreSQL port (5433) and the app port are bound to `127.0.0.1`, so they are not reachable from the internet.

### 11.8 First admin password and users
```bash
cd ~/apps/lms
DATABASE_URL_ADMIN='postgresql://lms_migrator:PASTE_MIGRATOR_PASSWORD@127.0.0.1:5433/lms_prod' \
  npx tsx scripts/iam/bootstrap.ts --username admin
```
Sign in with the printed password, change it, enrol MFA, then create the real users (as in §9).

### 11.9 Backups (very important on this path)
```bash
mkdir -p ~/backups/lms
crontab -e
```
```cron
30 2 * * * PGPASSWORD="$(cat $HOME/.pg_super_pw)" $HOME/pg16/bin/pg_dump -h 127.0.0.1 -p 5433 -U postgres -Fc -Z6 -d lms_prod -f $HOME/backups/lms/lms_prod-$(date +\%F).dump && find $HOME/backups/lms -name '*.dump' -mtime +14 -delete
```
Copy `~/backups/lms`, `~/lms-documents` and `~/apps/lms/.env.production.local` **off the VPS** regularly, for example with DreamObjects or by downloading them with `scp`.

### 11.10 Everyday pm2 commands

| Task | Command |
|---|---|
| Status | `pm2 ls` (both `lms-db` and `lms-app` should be *online*) |
| Logs | `pm2 logs lms-app` · `pm2 logs lms-db` |
| Restart app | `pm2 restart lms-app` |
| Update to a new version | `pm2 stop lms-app` → unpack the new archive → `python3 db/tools/migrate.py up` (as lms_migrator) → `npm ci && npm run build` → `pm2 start lms-app` |
| Stop the database cleanly | `pm2 stop lms-db` (only with the app stopped) |

### 11.11 Other options if this does not suit you
- **DreamCompute** (root), following §3–§10.
- PostgreSQL on a separate server you control, with port 5432 open only to the VPS's IP.
- Hosted services such as Neon or Supabase often refuse the role setup in `01_roles.sql`. Test before relying on one.

---

## 12. Final checklist before giving the link to users

- [ ] HTTPS works; `http://` redirects
- [ ] `LMS_DEMO_MODE` **not** set; no demo accounts on the production DB
- [ ] Admin password changed, MFA enrolled
- [ ] Ports 5432 and 3040 closed in `ufw`
- [ ] `migrate.py status` shows 0 drift
- [ ] Daily backup runs, a copy is off the server, and one restore has been tested
- [ ] `.env.production.local` (keys) saved in the company password vault
- [ ] Real users created with the correct provinces and approval positions
