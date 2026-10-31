#!/usr/bin/env python3
"""
Generate every LMS page from one template, so the shell cannot drift.

Each screen is a directory holding an index.html, which gives clean URLs
when the folder is served:  /surveys  instead of  surveys.html.

    app/index.html            ->  /
    app/province/index.html   ->  /province
    app/surveys/index.html    ->  /surveys

Links stay relative ('../surveys/'), so the app also works when served from
a sub-path. The sign-in page sits at the folder root, so it carries
data-root="" while every other page carries data-root="../"; session.js
reads that to build URLs.
"""
import os

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(HERE), "app")

def csp(screen=None):
    """Content-Security-Policy. Only the GIS page may reach the tile and
    elevation servers, and only it may start MapLibre's blob: web worker."""
    map_hosts = ("https://tile.openstreetmap.org https://*.tile.openstreetmap.org "
                 "https://server.arcgisonline.com https://*.tile.opentopomap.org "
                 "https://s3.amazonaws.com")
    gis = screen == 'gis'
    return ("default-src 'none'; "
            "script-src 'self'; "
            "style-src 'self'; "
            "img-src 'self' data: blob:" + (" " + map_hosts if gis else "") + "; "
            "font-src 'self' data:; "
            "connect-src 'self'" + (" " + map_hosts if gis else "") + "; "
            + ("worker-src blob:; child-src blob:; " if gis else "")
            + "frame-src 'self' blob:; "
            "object-src 'none'; base-uri 'none'; form-action 'none'")

CSS = ['tokens', 'base', 'layout', 'components', 'utilities', 'responsive', 'print', 'features']

SCRIPTS = [
    'core/engine.js', 'core/calc.js', 'core/spec.js',
    'ui/screens.js', 'ui/print.js', 'ui/extras.js', 'ui/gis.js',
    'ui/reports.js', 'ui/import.js',
    'data/demo.js',
    # scope.js wraps openView/openForm, so it must run before registry.js
    # captures those functions into the action table
    'app/session.js', 'app/scope.js', 'app/lazy.js', 'app/print-doc.js',
    # actions.js defines the actions the multi-page build adds, so it must
    # run before registry.js collects every action into one table.
    # a11y.js wraps openModal/closeModal and the renderers; it too must run
    # before registry.js captures function references
    'app/actions.js', 'app/a11y.js', 'app/forms.js', 'app/gis-map.js',
    'app/shell.js', 'app/role-ui.js', 'app/features.js', 'app/registry.js',
    'app/boot.js',
]

# screen key -> (nav group, page title)
SCREENS = [
    ('dashboard',     'Overview',           'Executive Dashboard'),
    ('projdash',      'Overview',           'Project Dashboard'),
    ('inbox',         'Overview',           'Approvals & Alerts'),
    ('calendar',      'Overview',           'Calendar'),
    ('gis',           'Overview',           'GIS Land Map'),
    ('units',         'Master Data',        'Administrative Hierarchy'),
    ('projects',      'Master Data',        'Projects / Well Locations'),
    ('surveys',       'Master Data',        'Survey / Khasra Register'),
    ('landowners',    'Master Data',        'Landowners'),
    ('acquisitions',  'Land Operations',    'Acquisition & Title'),
    ('cases',         'Land Operations',    'Compensation Cases'),
    ('leases',        'Land Operations',    'Leases & Agreements'),
    ('rows',          'Land Operations',    'ROW & Pipelines'),
    ('encroachments', 'Land Operations',    'Encroachments'),
    ('mutations',     'Land Operations',    'Mutation & Succession'),
    ('legal',         'Land Operations',    'Legal & Litigation'),
    ('payments',      'Finance',            'Payments & Cheques'),
    ('dbpfc',         'Finance',            'DBPFC — Sindh Govt Land'),
    ('budgets',       'Finance',            'Budgets'),
    ('grievances',    'Community',          'Grievances & IIR'),
    ('reports',       'Records & Reports',  'Reports'),
    ('documents',     'Records & Reports',  'Documents'),
    ('import',        'Records & Reports',  'Data Upload'),
    ('audit',         'Records & Reports',  'Audit Trail'),
    ('users',         'System',             'Users & Roles'),
    ('matrix',        'System',             'Approval Matrix'),
    ('settings',      'System',             'Settings'),
    ('arch',          'System',             'Architecture & Security'),
]

# screens that need a library up front (everything else loads on demand)
EAGER = {
    'dashboard': ['chart.umd.js'],
    'projdash':  ['chart.umd.js'],
    'gis':       ['maplibre-gl.js', 'jszip.min.js'],   # GL map; JSZip reads .kmz
    'import':    ['xlsx.full.min.js'],
}
EAGER_CSS = {'gis': ['vendor/maplibre-gl.css']}


def head(title, up, extra_css=(), screen=None):
    links = ''.join('\n<link rel="stylesheet" href="%sassets/css/%s">' % (up, c) for c in extra_css)
    links += ''.join('\n<link rel="stylesheet" href="%sassets/css/%s.css">' % (up, c) for c in CSS)
    return f'''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="{csp(screen)}">
<meta name="robots" content="noindex">
<link rel="icon" href="data:,">
<title>{title} · LMS</title>
<script src="{up}assets/js/theme-init.js"></script>{links}
</head>'''


def scripts(up, screen=None):
    out = ''
    for v in EAGER.get(screen, []):
        out += '\n<script src="%sassets/js/vendor/%s"></script>' % (up, v)
    for s in SCRIPTS:
        out += '\n<script src="%sassets/js/%s"></script>' % (up, s)
    return out


MODALS = '''
<!-- record form -->
<div class="mb hidden" id="frm">
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="fTitle">
    <div class="mh"><h3 id="fTitle"></h3>
      <button class="x" data-act="closeModal" data-a1="frm" aria-label="Close">&times;</button></div>
    <div class="mbody" id="fBody"></div>
    <div class="mf">
      <button class="btn btn-s" data-act="closeModal" data-a1="frm">Cancel</button>
      <button class="btn btn-p" data-act="saveForm"><svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>Save</button>
    </div>
  </div>
</div>
<!-- record view -->
<div class="mb hidden" id="view">
  <div class="modal lg" role="dialog" aria-modal="true" aria-labelledby="vTitle">
    <div class="mh"><h3 id="vTitle"></h3>
      <button class="x" data-act="closeModal" data-a1="view" aria-label="Close">&times;</button></div>
    <div class="mbody" id="vBody"></div>
    <div class="mf" id="vFoot"></div>
  </div>
</div>
<!-- unit converter -->
<div class="mb hidden top2" id="conv">
  <div class="modal sm" role="dialog" aria-modal="true" aria-labelledby="convTitle">
    <div class="mh"><h3 id="convTitle"><span class="ico"><svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 3l4 4-4 4M20 7H4M8 21l-4-4 4-4M4 17h16"/></svg></span> Land unit conversion</h3>
      <button class="x" data-act="closeModal" data-a1="conv" aria-label="Close">&times;</button></div>
    <div class="mbody" id="cvBody"></div>
    <div class="mf">
      <button class="btn btn-s" data-act="closeModal" data-a1="conv">Close</button>
      <button class="btn btn-p hidden" id="cvUse" data-act="useConverted">Use value (acres)</button>
    </div>
  </div>
</div>
<!-- prompt / confirm -->
<div class="mb hidden top2" id="dlg">
  <div class="modal sm" role="dialog" aria-modal="true" aria-labelledby="dTitle">
    <div class="mh"><h3 id="dTitle"></h3>
      <button class="x" id="dX" aria-label="Close">&times;</button></div>
    <div class="mbody" id="dBody"></div>
    <div class="mf">
      <button class="btn btn-s" id="dCancel">Cancel</button>
      <button class="btn btn-p" id="dOk">OK</button>
    </div>
  </div>
</div>
<!-- global search palette -->
<div class="mb hidden top2" id="globalSearchModal">
  <div class="modal lg search-modal" role="dialog" aria-modal="true" aria-label="Global Search">
    <div class="search-head">
      <span class="search-icon"><svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></span>
      <input type="search" id="globalSearchInput" class="search-input" placeholder="Search by landowner, CNIC, khasra #, lease, case, pipeline, screen..." autocomplete="off" spellcheck="false" aria-label="Search all records">
      <button class="x" data-act="closeGlobalSearch" aria-label="Close search">&times;</button>
    </div>
    <div class="search-filters" id="searchFilters">
      <button class="s-filter is-active" data-act="setSearchScope" data-a1="all">All Records</button>
      <button class="s-filter" data-act="setSearchScope" data-a1="landowners">Landowners</button>
      <button class="s-filter" data-act="setSearchScope" data-a1="surveys">Khasras</button>
      <button class="s-filter" data-act="setSearchScope" data-a1="leases">Leases</button>
      <button class="s-filter" data-act="setSearchScope" data-a1="cases">Cases</button>
      <button class="s-filter" data-act="setSearchScope" data-a1="rows">Pipelines &amp; ROW</button>
      <button class="s-filter" data-act="setSearchScope" data-a1="payments">Payments</button>
      <button class="s-filter" data-act="setSearchScope" data-a1="screens">Screens</button>
    </div>
    <div class="search-results" id="globalSearchResults" role="listbox"></div>
    <div class="search-foot">
      <span class="sf-hint"><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
      <span class="sf-hint"><kbd>Enter</kbd> open</span>
      <span class="sf-hint"><kbd>Esc</kbd> close</span>
      <span class="grow"></span>
      <span class="sf-count" id="searchCount">Pakistan E&amp;P Cadastral Database</span>
    </div>
  </div>
</div>
<div class="toasts" id="toasts" role="status" aria-live="polite"></div>'''


def app_page(key, group, title):
    up = '../'
    return head(title, up, EAGER_CSS.get(key, ()), key) + f'''
<body data-page="app" data-screen="{key}" data-root="{up}">
<a class="skip-link" href="#content">Skip to main content</a>
<div class="layout">

  <nav class="side" id="side" aria-label="Main">
    <a class="side-brand" href="{up}dashboard/">
      <span class="brand-mark">LMS</span>
      <span><b>Land Management</b><small>LAND MANAGEMENT SYSTEM</small></span>
    </a>
    <div id="nav"></div>
    <div class="side-foot">LMS Enterprise &middot; Mari Energies E&amp;P</div>
  </nav>

  <div class="main">
    <header class="top">
      <button class="burger" id="burger" aria-label="Show navigation"
              aria-expanded="false" aria-controls="side"><svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg></button>
      <div class="ttl"><h1 id="pgTitle">{title}</h1><small id="pgSub"></small></div>
      <div class="top-search" role="search">
        <button type="button" class="top-search-btn" id="globalSearchBtn" data-act="openGlobalSearch" aria-label="Search all records (Press / or Ctrl+K)">
          <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <span class="top-search-text">Search khasras, CNIC, leases, cases...</span>
          <span class="top-search-kbd"><kbd>/</kbd></span>
        </button>
      </div>
      <span class="sp"></span>
      <span class="chip is-static hide-m"
            title="Pre-award prototype. All records are fictional."><span class="status-pulse-dot"></span>PAKISTAN E&amp;P &middot; PROTOTYPE</span>
      <button class="chip" id="provChip" data-act="showProvince" title="Change province"></button>
      <button class="ibtn hide-m" data-act="openConverter"
              title="Unit conversion" aria-label="Unit conversion"><svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 3l4 4-4 4M20 7H4M8 21l-4-4 4-4M4 17h16"/></svg></button>
      <button class="ibtn has-badge" id="stickyBtn" data-act="toggleStickyDock"
              title="Sticky Notes &amp; Scratchpad (Alt+N)" aria-label="Sticky Notes"><svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15.5 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8.5L15.5 3z"/><path d="M15 3v6h6"/><path d="M9 13h6M9 17h4"/></svg><span class="badge-count hidden info" id="stickyN"></span></button>
      <button class="ibtn has-badge" id="remindersBtn" data-act="openFollowUps"
              title="Follow-up Reminders &amp; Schedule (Alt+R)" aria-label="Follow-up Reminders"><svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 15"/></svg><span class="badge-count hidden" id="reminderN"></span></button>
      <a class="ibtn" href="{up}inbox/" title="Approvals &amp; alerts"
         aria-label="Approvals and alerts"><svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg><span class="badge-n hidden" id="bellN"></span></a>
      <button class="ibtn hide-m" id="a11yBtn" data-act="openA11yModal"
              title="Accessibility &amp; Display Options (Alt+A)" aria-label="Accessibility preferences"><svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="4" r="2"/><path d="M18 9h-4V7h-4v2H6a1 1 0 0 0 0 2h3v10a1 1 0 0 0 2 0v-5h2v5a1 1 0 0 0 2 0V11h3a1 1 0 0 0 0-2z"/></svg></button>
      <button class="ibtn" id="thBtn" data-act="toggleTheme"
              title="Dark / light mode" aria-label="Toggle dark mode"><svg class="th-moon" viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg></button>
      <div class="user" id="userBtn" role="button" tabindex="0"
           aria-haspopup="menu" aria-expanded="false" aria-controls="uMenu">
        <span class="avatar" id="uAv">A</span>
        <span class="hide-m"><span class="n" id="uName"></span><span class="r" id="uRole"></span></span>
        <div class="menu hidden" id="uMenu" role="menu">
          <div class="info" id="uInfo"></div>
          <button role="menuitem" data-act="showProvince"><span class="m-ic"><svg viewBox="0 0 24 24"><path d="M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3z"/><path d="M9 3v15M15 6v15"/></svg></span>Change province</button>
          <button role="menuitem" id="uMenuTheme" data-act="toggleTheme"><span class="m-ic"><svg viewBox="0 0 24 24"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg></span>Toggle dark / light mode</button>
          <a role="menuitem" href="{up}inbox/"><span class="m-ic"><svg viewBox="0 0 24 24"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg></span>My approvals</a>
          <button role="menuitem" data-act="toggleStickyDock"><span class="m-ic"><svg viewBox="0 0 24 24"><path d="M15.5 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8.5L15.5 3z"/><path d="M15 3v6h6"/><path d="M9 13h6M9 17h4"/></svg></span>Sticky Notes (Alt+N)</button>
          <button role="menuitem" data-act="openFollowUps"><span class="m-ic"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 15"/></svg></span>Follow-up Reminders (Alt+R)</button>
          <button role="menuitem" data-act="openConverter"><span class="m-ic"><svg viewBox="0 0 24 24"><path d="M16 3l4 4-4 4M20 7H4M8 21l-4-4 4-4M4 17h16"/></svg></span>Unit converter</button>
          <button role="menuitem" data-act="openA11yModal"><span class="m-ic"><svg viewBox="0 0 24 24"><circle cx="12" cy="4" r="2"/><path d="M18 9h-4V7h-4v2H6a1 1 0 0 0 0 2h3v10a1 1 0 0 0 2 0v-5h2v5a1 1 0 0 0 2 0V11h3a1 1 0 0 0 0-2z"/></svg></span>Accessibility &amp; Display</button>
          <button role="menuitem" data-act="openSampleDataModal"><span class="m-ic"><svg viewBox="0 0 24 24"><path d="M21 16V8l-9-5-9 5v8l9 5z"/><path d="M3.3 7L12 12l8.7-5M12 22V12"/></svg></span>Generate sample data</button>
          <button role="menuitem" id="swUser" data-act="switchUserDialog"><span class="m-ic"><svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg></span>Switch user (demo)</button>
          <button role="menuitem" data-act="logout"><span class="m-ic"><svg viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg></span>Sign out</button>
        </div>
      </div>
    </header>

    <nav class="crumbs" id="crumbs" aria-label="Breadcrumb"></nav>
    <div class="role-bar hidden" id="roleBar"></div>

    <h2 class="sr-only">{title} — page content</h2>
    <main class="content" id="content" tabindex="-1"></main>

    <footer class="site-foot">
      <span id="footMeta"></span>
      <span class="grow"></span>
      <nav aria-label="Footer links">
        <a href="{up}dashboard/">Dashboard</a>
        <a href="{up}reports/">Reports</a>
        <a href="{up}audit/">Audit trail</a>
        <a href="{up}arch/">Architecture &amp; security</a>
      </nav>
    </footer>
  </div>
</div>
<div class="side-backdrop" id="sideBackdrop"></div>
{MODALS}
{scripts(up, key)}
</body>
</html>
'''


LOGIN = head('Sign in', '') + f'''
<body data-page="login" data-root="">
<main class="screen" id="login">
  <div class="login-card">
    <div class="brand-mark">LMS</div>
    <h1>Land Management System</h1>
    <p class="sub">E&amp;P land lifecycle &mdash; acquisition, leases, ROW, compensation, GIS
      &middot; <span id="lgCo"></span></p>
    <form id="loginForm" novalidate>
      <label for="lgU">Username</label>
      <input id="lgU" name="username" autocomplete="username" value="admin" required>
      <label for="lgP">Password</label>
      <input id="lgP" name="password" type="password" autocomplete="current-password"
             value="admin123" required>
      <p class="err-msg hidden" id="lgErr" role="alert"></p>
      <button class="btn btn-p" type="submit">Sign in</button>
    </form>
    <div class="demo-accts">
      <b>Demo accounts</b> &mdash; click a row to fill (role-based rights are enforced)
      <table><caption class="sr-only">Demo accounts and their roles</caption>
        <tbody id="lgUsers"></tbody></table>
    </div>
  </div>
</main>
<div class="toasts" id="toasts" role="status" aria-live="polite"></div>
{scripts('')}
</body>
</html>
'''

PROVINCE = head('Select province', '../') + f'''
<body data-page="province" data-root="../">
<main class="screen" id="prov">
  <div class="prov-wrap">
    <h2>Select province</h2>
    <p id="provHello"></p>
    <div class="prov-grid" id="provGrid"></div>
    <a class="prov-all" id="provAll" href="../dashboard/"
       data-act="enterProvince" data-a1="ALL">All provinces &mdash; Head Office consolidated view</a>
    <p class="u-mt-16 u-fs-12">
      <a class="u-link-on-dark" href="../" data-act="logout">Sign out</a></p>
  </div>
</main>
<div class="toasts" id="toasts" role="status" aria-live="polite"></div>
{scripts('../')}
</body>
</html>
'''


def write(rel_path, text):
    path = os.path.join(OUT, rel_path)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    open(path, 'w', encoding='utf-8').write(text)


if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    # remove page directories from an earlier build so renames cannot linger
    for key, _, _ in SCREENS:
        old = os.path.join(OUT, key + '.html')
        if os.path.exists(old):
            os.remove(old)
    for stale in ('province.html',):
        if os.path.exists(os.path.join(OUT, stale)):
            os.remove(os.path.join(OUT, stale))

    write('index.html', LOGIN)
    write('province/index.html', PROVINCE)
    for key, group, title in SCREENS:
        write(key + '/index.html', app_page(key, group, title))
    print("generated %d pages (clean URLs: /, /province, /%s, …)"
          % (len(SCREENS) + 2, SCREENS[0][0]))
