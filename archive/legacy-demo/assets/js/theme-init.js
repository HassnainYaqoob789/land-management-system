/* Instant theme initializer: executes in <head> before DOM rendering to eliminate white flashes */
(function() {
  try {
    var th = localStorage.getItem('lms_theme');
    if (!th) {
      var st = localStorage.getItem('lms_demo_store_v3');
      if (st) {
        var parsed = JSON.parse(st);
        if (parsed && parsed.settings && parsed.settings.theme) th = parsed.settings.theme;
      }
    }
    var finalTheme = (th === 'dark' || th === 'night') ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', finalTheme);
    document.documentElement.dataset.theme = finalTheme;
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'light');
    document.documentElement.dataset.theme = 'light';
  }
})();
