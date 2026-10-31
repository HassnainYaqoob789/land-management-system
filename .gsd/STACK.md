# Technology Stack — Land Management System (LMS)

> Inventory of runtime environments, libraries, database systems, and dependencies for Mari Energies Limited LMS (v1.6.0).

---

## Runtime

| Technology | Version | Purpose |
|:---|:---|:---|
| **Python** | 3.10+ (Tested on 3.14.8) | Static web serving (`app/serve.py`), build pipelines (`build/*.py`), migration runner (`db/tools/migrate.py`), test runner (`db/tools/run_tests.py`) |
| **PostgreSQL** | 15 / 16 | Authoritative enterprise relational database, stored procedures, triggers, views, and RLS |
| **Browser Runtime** | Modern Evergreen (Chrome, Firefox, Edge, Safari) | ES6+ execution, CSS Grid/Custom Properties, `localStorage`, `sessionStorage`, Canvas rendering |

---

## Core Technologies

### 1. Frontend & Client Architecture
| Feature | System / Path | Purpose |
|:---|:---|:---|
| **Structure & Markup** | HTML5 Semantic Pages (`app/*/index.html`) | Clean URL screen definitions with uniform shell layout |
| **Styling & Design System** | Vanilla CSS (`app/assets/css/*.css`) | Modular stylesheets: `tokens.css`, `base.css`, `layout.css`, `components.css`, `utilities.css`, `responsive.css`, `print.css` |
| **Domain Logic** | Vanilla JS ES6+ (`app/assets/js/core/*.js`) | Specification registry (`spec.js`), calculations (`calc.js`), state machine (`engine.js`) |
| **Event Routing** | Declarative Action Dispatcher (`actions.js`) | Replaces inline handlers with `data-act` and allowlist verification (`registry.js`) |
| **Geospatial Mapping** | Vector Map Engine (`gis.js`, `gis-map.js`) | Interactive cadastral mapping and layer management |

### 2. Database & Data Architecture
| Directory | Files | Purpose |
|:---|:---|:---|
| `db/bootstrap/` | 2 SQL scripts | Database creation and least-privilege role initialization (`01_roles.sql`, `02_database.sql`) |
| `db/migrations/` | 18 SQL files | Version-controlled, forward-only schema migrations (`0001` to `0018`) |
| `db/seed/` | 2 SQL files | Realistic fictional demo datasets and transaction logs (`seed_demo.sql`, `seed_demo_transactions.sql`) |
| `db/tests/` | 13 test files | Automated SQL and Python tests validating constraints, routines, triggers, RLS, and concurrency |
| `db/tools/` | 3 utilities | Migration runner (`migrate.py`), test suite runner (`run_tests.py`), database rebuilder (`rebuild.sh`) |

---

## Dependencies

### External Libraries (All Vendored Locally — Zero CDN Dependency)

| Package | Vendored Location | Version | Purpose |
|:---|:---|:---|:---|
| **MapLibre GL** | `app/assets/js/vendor/maplibre-gl.js` | v3.6.2 | High-performance vector map rendering for cadastral parcels and satellite imagery |
| **Chart.js** | `app/assets/js/vendor/chart.umd.js` | v4.4.1 | Executive dashboard visualizations, provincial cost breakdowns, compensation summaries |
| **jsPDF** | `app/assets/js/vendor/jspdf.umd.min.js` | v2.5.1 | Client-side export of official land revenue notices, lease agreements, and payment vouchers |
| **jsPDF AutoTable** | `app/assets/js/vendor/jspdf.plugin.autotable.js` | v3.8.1 | Formatted tabular layouts for PDF exports |
| **SheetJS (XLSX)** | `app/assets/js/vendor/xlsx.full.min.js` | v0.20.1 | Client-side spreadsheet generation and bulk CSV/Excel landowner import parsing |
| **JSZip** | `app/assets/js/vendor/jszip.min.js` | v3.10.1 | Decompression of uploaded `.kmz` files to extract raw `.kml` GIS boundary definitions |

### Internal Component Dependencies

| Component | Depends On | Purpose |
|:---|:---|:---|
| `app/assets/js/app/shell.js` | `core/engine.js`, `core/spec.js` | Renders dynamic navigation, breadcrumbs, user switcher based on active session state |
| `app/assets/js/app/actions.js` | `app/assets/js/app/registry.js` | Dispatches DOM events exclusively to pre-approved business functions |
| `app/assets/js/ui/screens.js` | `core/spec.js`, `core/calc.js` | Generates data tables, search filters, form modals, and record views |
| `db/tools/migrate.py` | `psql` CLI client | Executes transactional migrations against PostgreSQL with checksum verification |
| `db/tools/run_tests.py` | `psql` CLI client | Orchestrates execution of automated SQL regression and constraint test suites |

---

## Infrastructure & Server Configuration

| Service | Technology / Command | Purpose |
|:---|:---|:---|
| **Development Server** | `python3 app/serve.py [port]` | Lightweight HTTP/1.1 server supporting clean route resolution (`/dashboard`, `/cases`) |
| **Production Web Server** | Nginx / Caddy / Apache | Static file hosting with HTTP/2, strict CSP headers, and TLS 1.3 |
| **Database Server** | PostgreSQL 16 on Linux (Debian/Ubuntu/RHEL) | Enterprise persistence, ACID transactions, and Row-Level Security |

---

## Configuration

| Variable | Purpose | Default Location |
|:---|:---|:---|
| `PGHOST` | PostgreSQL server hostname | Environment variable / libpq |
| `PGPORT` | PostgreSQL server port (default: 5432) | Environment variable / libpq |
| `PGDATABASE` | Database name (`lms`) | Environment variable / libpq |
| `PGUSER` | Database runtime or migrator user | Environment variable / libpq |
| `PGPASSWORD` | Database user authentication secret | Secure environment secret / `.pgpass` |
| `LMS_SOURCE` | Path to single-file source for build scripts | Auto-resolved in `build/*.py` |

---

## File Size & Code Inventory

| Category | Item Count | Total Lines (approx) | Total Size |
|:---|:---:|:---:|:---:|
| **Screen Directories (`app/`)** | 30 screens | 4,200 lines | ~420 KB |
| **Core JS Logic (`app/assets/js/core/`)** | 3 files | 3,400 lines | 112 KB |
| **UI JS Handlers (`app/assets/js/ui/`)** | 6 files | 4,800 lines | 185 KB |
| **App Shell & Dispatcher (`app/assets/js/app/`)** | 12 files | 3,900 lines | 145 KB |
| **CSS Stylesheets (`app/assets/css/`)** | 8 files | 3,200 lines | 98 KB |
| **Database Migrations (`db/migrations/`)** | 18 files | 5,600 lines | 305 KB |
| **Database Tests (`db/tests/`)** | 13 files | 3,100 lines | 108 KB |
| **Build & Tooling Scripts** | 7 files | 1,400 lines | 45 KB |
| **Vendored Libraries (`app/assets/js/vendor/`)** | 6 files | — | 1.34 MB |
| **Total Codebase** | **~90 files** | **~29,600 lines** | **~2.75 MB** |

---

*Last updated: 2026-10-27*
