/* Sets data-theme before the first paint so a saved dark theme never flashes light.
   Mirrors legacy-demo/assets/js/theme-init.js. */
(function () {
  var t = 'light';
  try { if (localStorage.getItem('lms_theme') === 'dark') t = 'dark'; } catch (e) {}
  document.documentElement.setAttribute('data-theme', t);
})();
