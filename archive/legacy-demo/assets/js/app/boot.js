/* Page entry point — the last script every page loads.

   One function decides what this particular page has to do, based on the
   two attributes in its <body>:  data-page (login | province | app)
   and data-screen (which screen an application page shows). */
'use strict';

function boot() {
  // the data store is shared by every page and every tab
  if (!restore()) { S = blankState(); buildDemo(); persist(); }
  migrateScope();
  applyTheme(S.settings.theme || 'light');

  const page = document.body.dataset.page;

  if (page === 'login') { initLogin(); return; }

  // every other page needs somebody signed in
  if (!sessionRestore()) { location.replace(LOGIN_URL); return; }

  if (page === 'province') { initProvince(); return; }

  /* ---- an application screen ---- */
  SCREEN = document.body.dataset.screen || 'dashboard';
  if (!CTX) { location.replace(pageUrl('province')); return; }

  // a screen the signed-in role may not open
  if (!screenAllowed(SCREEN)) {
    toast('Your role (' + ME.role + ') cannot open ' + navLabel(SCREEN) + '.', 'warning');
    location.replace(pageUrl(landingScreen()));
    return;
  }

  const openRecord = applyDeepLink();

  buildNav();
  fillTopbar();
  buildCrumbs();
  buildRoleBar();
  fillFooter();
  wireShell();
  render();

  if (openRecord) openView(SCREEN, openRecord);
}

/* data-store changes made in another tab repaint this one */
window.addEventListener('lms:store-changed', () => {
  if (document.body.dataset.page === 'app') render();
});

boot();
