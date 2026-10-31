/* Support for the generated A4 documents.

   printHTML() writes a complete standalone document into a hidden iframe.
   That document links assets/css/print-form.css rather than carrying a
   <style> block, both because the pages forbid inline CSS and because the
   print layout is then editable like any other stylesheet.

   The iframe starts at about:blank, so a relative href would not resolve —
   the URL is made absolute against this page first. */
'use strict';

const PRINT_CSS = new URL(assetUrl('css/print-form.css'), location.href).href;

/* Hand the document to the printer only once its stylesheet has been
   applied, otherwise the first print can come out unstyled. */
function printWhenReady(frame, doc, waited) {
  const ready = () => {
    try { return doc.styleSheets.length > 0 && doc.styleSheets[0].cssRules.length > 0; }
    catch (e) { return doc.styleSheets.length > 0; }   // cssRules can throw
  };
  const elapsed = waited || 0;
  if (!ready() && elapsed < 2000) {
    setTimeout(() => printWhenReady(frame, doc, elapsed + 50), 50);
    return;
  }
  frame.contentWindow.focus();
  frame.contentWindow.print();
  setTimeout(() => frame.remove(), 4000);
}
