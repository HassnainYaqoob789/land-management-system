/* Role bar — what this signed-in user may do, and what is waiting for them.

   Every screen shows the same strip under the breadcrumbs, so the person
   demonstrating the system never has to explain which account they are on
   or why a button is missing. It lives outside #content, so a re-render of
   the screen leaves it alone. */
'use strict';

/* How many of my own records are still sitting at the first workflow stage,
   i.e. created but never submitted. */
function myDraftCount() {
  let n = 0;
  for (const c of Object.keys(WF)) {
    if (!SPEC[c]) continue;
    n += ctxRows(c).filter(r =>
      r.createdBy === ME.username && r.stage === WF[c].stages[0]).length;
  }
  return n;
}

/* The one or two things this role most likely wants next. */
function roleLinks() {
  const out = [];
  const queue = myQueue().length;
  const urgent = alerts().filter(a => a.sev === 'd').length;

  if (queue) {
    out.push({ href: pageUrl('inbox'), cls: 'b-w',
      text: queue + (queue === 1 ? ' item awaits your approval' : ' items await your approval') });
  }
  if (can.create()) {
    const drafts = myDraftCount();
    if (drafts) {
      out.push({ href: pageUrl('inbox'), cls: 'b-i',
        text: drafts + (drafts === 1 ? ' draft of yours is not submitted' : ' drafts of yours are not submitted') });
    }
  }
  if (urgent) {
    out.push({ href: pageUrl('inbox'), cls: 'b-d',
      text: urgent + (urgent === 1 ? ' urgent alert' : ' urgent alerts') });
  }
  if (isRole('Viewer')) {
    out.push({ href: pageUrl('reports'), cls: 'b-n', text: 'Reports and exports' });
  }
  if (can.admin()) {
    out.push({ href: pageUrl('settings'), cls: 'b-n', text: 'System settings' });
  }
  return out;
}

function buildRoleBar() {
  const el = $('#roleBar');
  if (!el || !ME) return;

  const badge = isRole('Admin') ? 'b-p' : isRole('Approver') ? 'b-g'
    : isRole('User') ? 'b-i' : 'b-n';

  const links = roleLinks().map(l =>
    `<a class="b ${l.cls}" href="${l.href}">${esc(l.text)} &rsaquo;</a>`).join('');

  el.innerHTML =
    `<span class="b ${badge}">${esc(ME.role)}</span>`
    + `<span class="who">${esc(ME.fullName)}`
    + (ME.groups && ME.groups.length ? ` &middot; ${esc(ME.groups[0])}` : '')
    + `</span>`
    + `<span class="says">${esc(roleSummary())}</span>`
    + `<span class="grow"></span>`
    + links;

  el.classList.toggle('is-readonly', isRole('Viewer'));
  el.classList.remove('hidden');
}
