/* ============================================================
   LMS FEATURES & UTILITIES SUITE
   - User Accessibility & Display Suite (WCAG AA/AAA, Contrast, Zoom, Announcer)
   - Sticky Notes Utility (Interactive, Color-coded, Checklists, Screen/Record Pinning)
   - Follow-up Reminders & Calendar Integration (Scheduling, Snoozing, RFC-5545 iCal Sync)
   ============================================================ */
'use strict';

/* Register actions into LMS_ACTIONS so delegated dispatcher runs them */
window.LMS_ACTIONS = window.LMS_ACTIONS || {};

const toIsoDate = d => typeof iso === 'function' ? iso(d) : (d instanceof Date ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : String(d));
const fNowStr = () => (new Date()).toISOString().replace('T', ' ').substring(0, 19);
const getCurrentScreen = () => (typeof SCREEN !== 'undefined' ? SCREEN : '');
const getCurrentView = () => (typeof VIEW !== 'undefined' ? VIEW : null);
const getCurrentUser = () => (typeof ME !== 'undefined' && ME ? ME.fullName : 'User');
if (typeof uid === 'undefined') window.uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-5);
if (typeof esc === 'undefined') window.esc = v => v == null ? '' : String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ============================================================
   1. USER ACCESSIBILITY & DISPLAY PREFERENCES
   ============================================================ */
const A11Y_STORAGE_KEY = 'lms_a11y_prefs';

const A11Y_DEFAULTS = {
  contrast: 'standard', // 'standard' | 'high'
  textSize: 'normal',   // 'normal' | 'large' | 'xlarge'
  font: 'default',      // 'default' | 'dyslexic'
  motion: 'default',    // 'default' | 'reduced'
  focus: 'standard',    // 'standard' | 'high'
  announcer: true,
};

function getA11yPrefs() {
  try {
    const raw = localStorage.getItem(A11Y_STORAGE_KEY);
    return raw ? Object.assign({}, A11Y_DEFAULTS, JSON.parse(raw)) : Object.assign({}, A11Y_DEFAULTS);
  } catch (e) {
    return Object.assign({}, A11Y_DEFAULTS);
  }
}

function saveA11yPrefs(prefs) {
  try {
    localStorage.setItem(A11Y_STORAGE_KEY, JSON.stringify(prefs));
  } catch (e) {
    console.warn('A11y prefs save error', e);
  }
  applyA11yPrefs(prefs);
}

function applyA11yPrefs(prefs) {
  const p = prefs || getA11yPrefs();
  const root = document.documentElement;

  if (p.contrast === 'high') root.setAttribute('data-contrast', 'high');
  else root.removeAttribute('data-contrast');

  if (p.textSize && p.textSize !== 'normal') root.setAttribute('data-text-size', p.textSize);
  else root.removeAttribute('data-text-size');

  if (p.font === 'dyslexic') root.setAttribute('data-font', 'dyslexic');
  else root.removeAttribute('data-font');

  if (p.motion === 'reduced') root.setAttribute('data-motion', 'reduced');
  else root.removeAttribute('data-motion');

  if (p.focus === 'high') root.setAttribute('data-focus', 'high');
  else root.removeAttribute('data-focus');
}

/* Screen reader announcement live region */
function announceA11y(text, politeness = 'polite') {
  if (!document.body) return;
  let el = document.getElementById('a11yAnnouncer');
  if (!el) {
    el = document.createElement('div');
    el.id = 'a11yAnnouncer';
    el.className = 'a11y-live-region';
    el.setAttribute('aria-live', politeness);
    el.setAttribute('aria-atomic', 'true');
    document.body.appendChild(el);
  }
  el.textContent = '';
  setTimeout(() => { el.textContent = text; }, 50);
}

/* Open Accessibility Options Modal */
function openA11yModal() {
  const p = getA11yPrefs();
  const body = `
    <div class="a11y-grid">
      <div class="a11y-card">
        <h4>🎨 Contrast Mode</h4>
        <p>Enhance border weights and color ratios for outdoor sunlight & low vision.</p>
        <div class="a11y-options">
          <button class="a11y-btn ${p.contrast === 'standard' ? 'active' : ''}" data-act="setA11yOpt" data-a1="contrast" data-a2="standard">Standard</button>
          <button class="a11y-btn ${p.contrast === 'high' ? 'active' : ''}" data-act="setA11yOpt" data-a1="contrast" data-a2="high">High Contrast (7:1+)</button>
        </div>
      </div>

      <div class="a11y-card">
        <h4>🔍 Text Scaling</h4>
        <p>Increase interface font size across all modules without breaking grids.</p>
        <div class="a11y-options">
          <button class="a11y-btn ${p.textSize === 'normal' ? 'active' : ''}" data-act="setA11yOpt" data-a1="textSize" data-a2="normal">Normal (100%)</button>
          <button class="a11y-btn ${p.textSize === 'large' ? 'active' : ''}" data-act="setA11yOpt" data-a1="textSize" data-a2="large">Large (115%)</button>
          <button class="a11y-btn ${p.textSize === 'xlarge' ? 'active' : ''}" data-act="setA11yOpt" data-a1="textSize" data-a2="xlarge">Extra Large (130%)</button>
        </div>
      </div>

      <div class="a11y-card">
        <h4>📖 Reading Font</h4>
        <p>Enable high-legibility letterforms designed for low vision & dyslexia.</p>
        <div class="a11y-options">
          <button class="a11y-btn ${p.font === 'default' ? 'active' : ''}" data-act="setA11yOpt" data-a1="font" data-a2="default">System Default</button>
          <button class="a11y-btn ${p.font === 'dyslexic' ? 'active' : ''}" data-act="setA11yOpt" data-a1="font" data-a2="dyslexic">High Legibility</button>
        </div>
      </div>

      <div class="a11y-card">
        <h4>⚡ Motion & Transitions</h4>
        <p>Disable interface animations and transitions for vestibular comfort.</p>
        <div class="a11y-options">
          <button class="a11y-btn ${p.motion === 'default' ? 'active' : ''}" data-act="setA11yOpt" data-a1="motion" data-a2="default">Full Motion</button>
          <button class="a11y-btn ${p.motion === 'reduced' ? 'active' : ''}" data-act="setA11yOpt" data-a1="motion" data-a2="reduced">Reduced Motion</button>
        </div>
      </div>

      <div class="a11y-card">
        <h4>🎯 Focus Indicator</h4>
        <p>Highlight keyboard focus with a high-visibility amber/black double ring.</p>
        <div class="a11y-options">
          <button class="a11y-btn ${p.focus === 'standard' ? 'active' : ''}" data-act="setA11yOpt" data-a1="focus" data-a2="standard">Standard Blue</button>
          <button class="a11y-btn ${p.focus === 'high' ? 'active' : ''}" data-act="setA11yOpt" data-a1="focus" data-a2="high">High Visibility</button>
        </div>
      </div>

      <div class="a11y-card">
        <h4>⌨️ Keyboard Navigation</h4>
        <p>Access full navigation and shortcuts reference guide.</p>
        <button class="btn btn-s btn-sm" data-act="openShortcutsModal">View Keyboard Shortcuts (?)</button>
      </div>
    </div>
  `;

  showAppModal('a11yModal', '♿ Accessibility & Display Preferences', body, `
    <button class="btn btn-s" data-act="resetA11yOpts">Reset to Defaults</button>
    <button class="btn btn-p" data-act="closeAppModal" data-a1="a11yModal">Done</button>
  `);
}

function setA11yOpt(key, val) {
  const p = getA11yPrefs();
  p[key] = val;
  saveA11yPrefs(p);
  announceA11y(`Accessibility setting ${key} updated to ${val}`);
  openA11yModal(); // redraw active buttons
}

function resetA11yOpts() {
  saveA11yPrefs(Object.assign({}, A11Y_DEFAULTS));
  announceA11y('Accessibility settings reset to defaults');
  openA11yModal();
}

function openShortcutsModal() {
  const body = `
    <table class="shortcut-table">
      <tbody>
        <tr><td><kbd>Alt</kbd> + <kbd>N</kbd></td><td>Toggle <b>Sticky Notes</b> Dock</td></tr>
        <tr><td><kbd>Alt</kbd> + <kbd>R</kbd></td><td>Open <b>Follow-up Reminders & Schedule</b></td></tr>
        <tr><td><kbd>Alt</kbd> + <kbd>C</kbd></td><td>Navigate to <b>Calendar</b> Screen</td></tr>
        <tr><td><kbd>Alt</kbd> + <kbd>A</kbd></td><td>Open <b>Accessibility & Display</b> Preferences</td></tr>
        <tr><td><kbd>Alt</kbd> + <kbd>U</kbd></td><td>Open <b>Land Unit Converter</b></td></tr>
        <tr><td><kbd>Alt</kbd> + <kbd>T</kbd></td><td>Toggle <b>Dark / Light</b> Theme</td></tr>
        <tr><td><kbd>?</kbd></td><td>Show this <b>Keyboard Shortcuts</b> Help</td></tr>
        <tr><td><kbd>Esc</kbd></td><td>Close any active Modal, Drawer, or Dock</td></tr>
        <tr><td><kbd>Tab</kbd> / <kbd>Shift + Tab</kbd></td><td>Traverse interactive controls (trapped in active modal)</td></tr>
      </tbody>
    </table>
  `;
  showAppModal('shortcutsModal', '⌨️ Keyboard Navigation & Shortcuts', body, `
    <button class="btn btn-p" data-act="closeAppModal" data-a1="shortcutsModal">Got it</button>
  `);
}

/* ============================================================
   2. STICKY NOTES UTILITY ("stciky notes")
   ============================================================ */
const NOTES_STORAGE_KEY = 'lms_sticky_notes';

function getStickyNotes() {
  try {
    const raw = localStorage.getItem(NOTES_STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {
    console.warn('Notes load error', e);
  }
  // Default seeded notes
  const seeds = [
    {
      id: 'sn_1',
      title: 'NADRA CNIC Verification Required',
      content: 'Check that landowner CNIC has been authenticated against NADRA Verisys before Section 11 award issuance.',
      color: 'yellow',
      tag: 'Verification',
      screen: 'landowners',
      recordType: 'landowners',
      recordId: 'lo_001',
      recordCode: 'LO-000001',
      pinned: true,
      checklist: [
        { text: 'CNIC copy verified by Revenue Mukhtiarkar', done: true },
        { text: 'NADRA active status checked', done: true },
        { text: 'Active Taxpayer List (ATL) status confirmed', done: false }
      ],
      createdAt: fNowStr(),
      createdBy: 'System'
    },
    {
      id: 'sn_2',
      title: 'Sindh 10% Annual Lease Escalation',
      content: 'Standard clause in Section 3 leases: 10% rent escalation takes effect automatically on month 37.',
      color: 'mint',
      tag: 'To-Do',
      screen: 'leases',
      recordType: 'leases',
      recordId: null,
      recordCode: null,
      pinned: false,
      checklist: [
        { text: 'Notify Land Manager 60 days before renewal', done: false },
        { text: 'Cross-check Board of Revenue gazette valuation', done: false }
      ],
      createdAt: fNowStr(),
      createdBy: 'System'
    },
    {
      id: 'sn_3',
      title: 'DBPFC Collector Rate Revisions',
      content: 'District Ghotki revised notification received for agricultural land. Verify updated rates in compensation calculations.',
      color: 'lavender',
      tag: 'General',
      screen: 'dbpfc',
      recordType: 'dbpfc',
      recordId: null,
      recordCode: null,
      pinned: true,
      checklist: [],
      createdAt: fNowStr(),
      createdBy: 'System'
    }
  ];
  try {
    localStorage.setItem(NOTES_STORAGE_KEY, JSON.stringify(seeds));
  } catch (e) {}
  return seeds;
}

function saveStickyNotes(notes) {
  try {
    localStorage.setItem(NOTES_STORAGE_KEY, JSON.stringify(notes));
  } catch (e) {
    console.warn('Notes save error', e);
  }
  updateStickyBadge();
  renderFloatingNotes();
}

let STICKY_FILTER = 'all'; // 'all' | 'screen' | 'pinned'

function toggleStickyDock() {
  ensureStickyDock();
  const dock = document.getElementById('stickyDock');
  const backdrop = document.getElementById('stickyBackdrop');
  if (!dock) return;
  const isOpen = dock.classList.toggle('open');
  if (backdrop) backdrop.classList.toggle('show', isOpen);
  if (isOpen) {
    renderStickyDock();
    announceA11y('Sticky notes drawer opened');
  } else {
    announceA11y('Sticky notes drawer closed');
  }
}

function setStickyFilter(filter) {
  STICKY_FILTER = filter;
  renderStickyDock();
}

function renderStickyDock() {
  const dock = document.getElementById('stickyDock');
  if (!dock) return;

  const notes = getStickyNotes();
  const scr = getCurrentScreen();
  const v = getCurrentView();
  const currentScreenNotes = notes.filter(n => (scr && n.screen === scr) || (v && n.recordId === v.id));
  const pinnedNotes = notes.filter(n => n.pinned);

  let displayed = notes;
  if (STICKY_FILTER === 'screen') displayed = currentScreenNotes;
  else if (STICKY_FILTER === 'pinned') displayed = pinnedNotes;

  const bodyEl = dock.querySelector('.sticky-dock-body');
  const tabsEl = dock.querySelector('.sticky-dock-tabs');

  if (tabsEl) {
    tabsEl.innerHTML = `
      <div class="sticky-dock-tab ${STICKY_FILTER === 'all' ? 'active' : ''}" data-act="setStickyFilter" data-a1="all">All Notes (${notes.length})</div>
      <div class="sticky-dock-tab ${STICKY_FILTER === 'screen' ? 'active' : ''}" data-act="setStickyFilter" data-a1="screen">This Screen (${currentScreenNotes.length})</div>
      <div class="sticky-dock-tab ${STICKY_FILTER === 'pinned' ? 'active' : ''}" data-act="setStickyFilter" data-a1="pinned">📌 Pinned (${pinnedNotes.length})</div>
    `;
  }

  if (bodyEl) {
    let cardsHtml = displayed.map(n => renderStickyCardHtml(n)).join('');
    if (!displayed.length) {
      cardsHtml = `<div class="card empty"><p>No sticky notes found in this view.</p><p><button class="btn btn-s btn-sm" data-act="openAddStickyNote">+ Create Note</button></p></div>`;
    }
    bodyEl.innerHTML = cardsHtml;
  }
}

function renderStickyCardHtml(n) {
  const contextLink = n.recordType && n.recordId && n.recordCode
    ? `<span class="sticky-context">📎 Linked: <a href="javascript:void(0)" data-act="openView" data-a1="${esc(n.recordType)}" data-a2="${esc(n.recordId)}">${esc(n.recordCode)}</a></span>`
    : (n.screen ? `<span class="sticky-context">🖥️ Screen: <b>${esc(navLabel(n.screen))}</b></span>` : '');

  const checks = (n.checklist || []).map((c, idx) => `
    <div class="sticky-check-item ${c.done ? 'done' : ''}">
      <input type="checkbox" ${c.done ? 'checked' : ''} data-act="toggleStickyCheck" data-a1="${esc(n.id)}" data-a2="${idx}" id="chk_${n.id}_${idx}">
      <label for="chk_${n.id}_${idx}"><span>${esc(c.text)}</span></label>
    </div>
  `).join('');

  return `
    <div class="sticky-card c-${esc(n.color || 'yellow')}" id="sn_card_${esc(n.id)}">
      <div class="sticky-head">
        <span class="sticky-title">${esc(n.title)}</span>
        ${n.tag ? `<span class="sticky-tag">${esc(n.tag)}</span>` : ''}
        <button class="btn btn-s btn-sm" data-act="togglePinSticky" data-a1="${esc(n.id)}" title="${n.pinned ? 'Unpin note' : 'Pin note to screen'}">${n.pinned ? '📌' : '📍'}</button>
      </div>
      <div class="sticky-body-text">${esc(n.content)}</div>
      ${checks ? `<div class="sticky-checklist">${checks}</div>` : ''}
      ${contextLink}
      <div class="sticky-actions">
        <button class="sticky-btn" data-act="convertNoteToReminder" data-a1="${esc(n.id)}" title="Convert note to scheduled follow-up reminder">⏰ Make Reminder</button>
        <button class="sticky-btn" data-act="openEditStickyNote" data-a1="${esc(n.id)}">✏️ Edit</button>
        <span class="grow"></span>
        <button class="sticky-btn" data-act="deleteStickyNote" data-a1="${esc(n.id)}" title="Delete note">🗑</button>
      </div>
    </div>
  `;
}

/* Floating Pinned Notes on Screen */
function renderFloatingNotes() {
  if (!document.body) return;
  let container = document.getElementById('floatingNotes');
  if (!container) {
    container = document.createElement('div');
    container.id = 'floatingNotes';
    container.className = 'floating-notes-container';
    document.body.appendChild(container);
  }

  const notes = getStickyNotes().filter(n => n.pinned);
  // Only show pinned notes that belong to current screen/record, or general notes
  const scr = getCurrentScreen();
  const v = getCurrentView();
  const relevant = notes.filter(n => !n.screen || (scr && n.screen === scr) || (v && n.recordId === v.id));

  if (!relevant.length) {
    container.innerHTML = '';
    return;
  }

  container.innerHTML = relevant.slice(0, 3).map(n => `
    <div class="floating-note sticky-card c-${esc(n.color || 'yellow')}">
      <div class="sticky-head">
        <span class="sticky-title">${esc(n.title)}</span>
        <button class="btn btn-s btn-sm" data-act="togglePinSticky" data-a1="${esc(n.id)}" title="Unpin from floating view">✕</button>
      </div>
      <div class="sticky-body-text" style="font-size:11.5px;max-height:80px;overflow:hidden">${esc(n.content)}</div>
    </div>
  `).join('');
}

function updateStickyBadge() {
  const badge = document.getElementById('stickyN');
  if (!badge) return;
  const notes = getStickyNotes();
  const scr = getCurrentScreen();
  const v = getCurrentView();
  const screenNotes = notes.filter(n => (scr && n.screen === scr) || (v && n.recordId === v.id));
  const count = screenNotes.length;
  badge.textContent = count;
  badge.classList.toggle('hidden', count === 0);
  if (count > 0) badge.classList.add('info');
}

/* Add / Edit Sticky Note */
function openAddStickyNote(prefillRecord = null) {
  const v = getCurrentView();
  const linked = prefillRecord || (v ? { c: v.c, id: v.id, code: typeof byId === 'function' ? byId(v.c, v.id)?.code : null } : null);
  const body = `
    <div class="f fg">
      <label>Title *</label>
      <input type="text" id="snTitle" placeholder="e.g. Mukhtiarkar Demarcation Follow-up" required>
    </div>
    <div class="f fg">
      <label>Note Content *</label>
      <textarea id="snContent" rows="4" placeholder="Write observation, task, or note details..." required></textarea>
    </div>
    <div class="grid2">
      <div class="f fg">
        <label>Sticky Note Color</label>
        <select id="snColor">
          <option value="yellow">💛 Classic Yellow</option>
          <option value="mint">💚 Mint Green</option>
          <option value="lavender">💜 Lavender Blue</option>
          <option value="peach">🧡 Coral Peach</option>
          <option value="rose">💗 Rose Pink</option>
          <option value="slate">🔘 Slate Gray</option>
        </select>
      </div>
      <div class="f fg">
        <label>Tag / Category</label>
        <select id="snTag">
          <option value="To-Do">To-Do</option>
          <option value="Verification">Verification</option>
          <option value="Urgent">Urgent</option>
          <option value="Landowner">Landowner Follow-up</option>
          <option value="Legal">Legal Notice</option>
          <option value="General">General</option>
        </select>
      </div>
    </div>
    <div class="f fg">
      <label>Checklist Tasks (one per line, optional)</label>
      <textarea id="snChecklist" rows="2" placeholder="Task item 1&#10;Task item 2"></textarea>
    </div>
    <div class="f fg">
      <label class="u-flex-align">
        <input type="checkbox" id="snPinned" checked> 📌 Pin note to floating screen view
      </label>
    </div>
    ${linked ? `<input type="hidden" id="snRecordType" value="${esc(linked.c)}"><input type="hidden" id="snRecordId" value="${esc(linked.id)}"><input type="hidden" id="snRecordCode" value="${esc(linked.code)}"><p class="note">📎 This note will link to ${esc(linked.code)}</p>` : ''}
  `;

  showAppModal('addStickyModal', '📝 New Sticky Note', body, `
    <button class="btn btn-s" data-act="closeAppModal" data-a1="addStickyModal">Cancel</button>
    <button class="btn btn-p" data-act="saveNewStickyNote">Save Note</button>
  `);
}

function saveNewStickyNote() {
  const title = (document.getElementById('snTitle')?.value || '').trim();
  const content = (document.getElementById('snContent')?.value || '').trim();
  if (!title || !content) {
    toast('Please enter note title and content.', 'warning');
    return;
  }
  const color = document.getElementById('snColor')?.value || 'yellow';
  const tag = document.getElementById('snTag')?.value || 'General';
  const pinned = !!document.getElementById('snPinned')?.checked;
  const rawChecks = (document.getElementById('snChecklist')?.value || '').split('\n').map(s => s.trim()).filter(Boolean);
  const checklist = rawChecks.map(text => ({ text, done: false }));

  const rType = document.getElementById('snRecordType')?.value || null;
  const rId = document.getElementById('snRecordId')?.value || null;
  const rCode = document.getElementById('snRecordCode')?.value || null;

  const note = {
    id: 'sn_' + uid(),
    title,
    content,
    color,
    tag,
    screen: getCurrentScreen(),
    recordType: rType,
    recordId: rId,
    recordCode: rCode,
    pinned,
    checklist,
    createdAt: fNowStr(),
    createdBy: getCurrentUser()
  };

  const notes = getStickyNotes();
  notes.unshift(note);
  saveStickyNotes(notes);
  closeAppModal('addStickyModal');
  renderStickyDock();
  toast('Sticky note added!', 'success');
  announceA11y(`Sticky note ${title} created`);
}

function togglePinSticky(id) {
  const notes = getStickyNotes();
  const n = notes.find(x => x.id === id);
  if (n) {
    n.pinned = !n.pinned;
    saveStickyNotes(notes);
    renderStickyDock();
    toast(n.pinned ? 'Note pinned to screen' : 'Note unpinned', 'info');
  }
}

function toggleStickyCheck(noteId, idx) {
  const notes = getStickyNotes();
  const n = notes.find(x => x.id === noteId);
  if (n && n.checklist && n.checklist[idx]) {
    n.checklist[idx].done = !n.checklist[idx].done;
    saveStickyNotes(notes);
    renderStickyDock();
  }
}

function deleteStickyNote(id) {
  if (!confirm('Are you sure you want to delete this note?')) return;
  let notes = getStickyNotes();
  notes = notes.filter(n => n.id !== id);
  saveStickyNotes(notes);
  renderStickyDock();
  toast('Note deleted', 'info');
}

function convertNoteToReminder(noteId) {
  const notes = getStickyNotes();
  const n = notes.find(x => x.id === noteId);
  if (!n) return;
  toggleStickyDock();
  openAddFollowUp({
    title: n.title,
    notes: n.content,
    recordType: n.recordType,
    recordId: n.recordId,
    recordCode: n.recordCode
  });
}

/* ============================================================
   3. FOLLOW-UP REMINDERS & SCHEDULING CALENDAR INTEGRATION
   ============================================================ */
const REMINDERS_STORAGE_KEY = 'lms_follow_ups';

function getCustomFollowUps() {
  try {
    const raw = localStorage.getItem(REMINDERS_STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {
    console.warn('Follow-ups load error', e);
  }
  // Default seeded operational follow-ups
  const td = today();
  const d3 = dOff(3);
  const d7 = dOff(7);
  const dMinus1 = dOff(-1);

  const seeds = [
    {
      id: 'rem_1',
      title: 'Hearing Prep: File Counter-Affidavit in Daharki Court',
      recordType: 'legal',
      recordId: 'leg_001',
      recordCode: 'LEG-000001',
      dueDate: d3,
      dueTime: '10:00',
      priority: 'Critical',
      assigneeRole: 'Legal Counsel',
      status: 'Pending',
      notes: 'Prepare certified copy of Section 6 notification to contest interim stay order.',
      createdAt: fNowStr()
    },
    {
      id: 'rem_2',
      title: 'Field Verification: Boundary Demarcation with Revenue Staff',
      recordType: 'surveys',
      recordId: 'srv_001',
      recordCode: 'SRV-000001',
      dueDate: td,
      dueTime: '14:30',
      priority: 'High',
      assigneeRole: 'Field Officer',
      status: 'Pending',
      notes: 'Verify Survey 102/4 corner pillars with Tapedar and adjacent landowners.',
      createdAt: fNowStr()
    },
    {
      id: 'rem_3',
      title: 'Overdue: Succession Intiqal Documents for Deceased Owner',
      recordType: 'landowners',
      recordId: 'lo_002',
      recordCode: 'LO-000002',
      dueDate: dMinus1,
      dueTime: '11:00',
      priority: 'Critical',
      assigneeRole: 'Field Officer',
      status: 'Pending',
      notes: 'Succession certificate pending from Civil Court. Withhold compensation cheque release.',
      createdAt: fNowStr()
    },
    {
      id: 'rem_4',
      title: 'ROW Corridor Joint Inspection with Pipeline Security',
      recordType: 'rows',
      recordId: 'row_001',
      recordCode: 'ROW-000001',
      dueDate: d7,
      dueTime: '09:00',
      priority: 'Medium',
      assigneeRole: 'Admin',
      status: 'Pending',
      notes: 'Annual pipeline safety right-of-way easement walkthrough.',
      createdAt: fNowStr()
    }
  ];
  try {
    localStorage.setItem(REMINDERS_STORAGE_KEY, JSON.stringify(seeds));
  } catch (e) {}
  return seeds;
}

function saveCustomFollowUps(list) {
  try {
    localStorage.setItem(REMINDERS_STORAGE_KEY, JSON.stringify(list));
  } catch (e) {
    console.warn('Follow-ups save error', e);
  }
  updateReminderBadge();
  if (typeof render === 'function' && typeof SCREEN !== 'undefined' && SCREEN === 'calendar') render();
}

function addFollowUp(item) {
  const list = getCustomFollowUps();
  const newItem = Object.assign({
    id: 'rem_' + uid(),
    status: 'Pending',
    createdAt: fNowStr(),
    createdBy: ME ? ME.fullName : 'User'
  }, item);
  list.unshift(newItem);
  saveCustomFollowUps(list);
  toast('Follow-up reminder scheduled!', 'success');
  announceA11y(`Follow-up scheduled: ${item.title}`);
  return newItem;
}

function completeFollowUp(id) {
  const list = getCustomFollowUps();
  const it = list.find(x => x.id === id);
  if (it) {
    it.status = 'Completed';
    it.completedAt = fNowStr();
    saveCustomFollowUps(list);
    toast('Follow-up marked as completed!', 'success');
    announceA11y(`Follow-up marked completed: ${it.title}`);
    if (document.getElementById('remindersModal')) openFollowUps(REMINDERS_FILTER);
  }
}

function reopenFollowUp(id) {
  const list = getCustomFollowUps();
  const it = list.find(x => x.id === id);
  if (it) {
    it.status = 'Pending';
    it.completedAt = null;
    saveCustomFollowUps(list);
    toast('Follow-up reopened!', 'info');
    if (document.getElementById('remindersModal')) openFollowUps(REMINDERS_FILTER);
  }
}

function snoozeFollowUp(id, days = 3) {
  days = parseInt(days, 10) || 3;
  const list = getCustomFollowUps();
  const it = list.find(x => x.id === id);
  if (it) {
    const baseDate = it.dueDate && it.dueDate >= today() ? new Date(it.dueDate) : new Date(today());
    baseDate.setDate(baseDate.getDate() + days);
    it.dueDate = toIsoDate(baseDate);
    saveCustomFollowUps(list);
    toast(`Follow-up snoozed to ${fdt(it.dueDate)} (+${days}d)`, 'info');
    announceA11y(`Follow-up snoozed to ${fdt(it.dueDate)}`);
    if (document.getElementById('remindersModal')) openFollowUps(REMINDERS_FILTER);
  }
}

function deleteFollowUp(id) {
  if (!confirm('Are you sure you want to delete this reminder?')) return;
  let list = getCustomFollowUps();
  list = list.filter(x => x.id !== id);
  saveCustomFollowUps(list);
  toast('Reminder deleted', 'info');
  if (document.getElementById('remindersModal')) openFollowUps(REMINDERS_FILTER);
}

function updateReminderBadge() {
  const badge = document.getElementById('reminderN');
  if (!badge) return;
  const list = getCustomFollowUps().filter(r => r.status === 'Pending');
  const td = today();
  const overdue = list.filter(r => r.dueDate < td).length;
  const dueToday = list.filter(r => r.dueDate === td).length;
  const totalDue = overdue + dueToday;

  badge.textContent = totalDue;
  badge.classList.toggle('hidden', totalDue === 0);

  if (overdue > 0) {
    badge.className = 'badge-n pulse-badge';
    badge.title = `${overdue} overdue, ${dueToday} due today`;
  } else {
    badge.className = 'badge-n warn';
    badge.title = `${dueToday} due today`;
  }
}

let REMINDERS_FILTER = 'pending'; // 'pending' | 'overdue' | 'today' | 'upcoming' | 'completed'

function openFollowUps(filter = 'pending') {
  if (typeof filter !== 'string' || !filter) filter = 'pending';
  REMINDERS_FILTER = filter;
  const all = getCustomFollowUps();
  const td = today();

  let filtered = all;
  if (filter === 'pending') filtered = all.filter(r => r.status === 'Pending');
  else if (filter === 'overdue') filtered = all.filter(r => r.status === 'Pending' && r.dueDate < td);
  else if (filter === 'today') filtered = all.filter(r => r.status === 'Pending' && r.dueDate === td);
  else if (filter === 'upcoming') filtered = all.filter(r => r.status === 'Pending' && r.dueDate > td && daysTo(r.dueDate) <= 14);
  else if (filter === 'completed') filtered = all.filter(r => r.status === 'Completed');

  const overdueCount = all.filter(r => r.status === 'Pending' && r.dueDate < td).length;
  const todayCount = all.filter(r => r.status === 'Pending' && r.dueDate === td).length;

  const body = `
    <div class="reminders-panel">
      <div class="reminders-filter-bar">
        <button class="btn btn-sm ${filter === 'pending' ? 'btn-p' : 'btn-s'}" data-act="openFollowUps" data-a1="pending">All Pending (${all.filter(r => r.status === 'Pending').length})</button>
        <button class="btn btn-sm ${filter === 'overdue' ? 'btn-d' : 'btn-s'}" data-act="openFollowUps" data-a1="overdue">⚠️ Overdue (${overdueCount})</button>
        <button class="btn btn-sm ${filter === 'today' ? 'btn-w' : 'btn-s'}" data-act="openFollowUps" data-a1="today">📅 Today (${todayCount})</button>
        <button class="btn btn-sm ${filter === 'upcoming' ? 'btn-p' : 'btn-s'}" data-act="openFollowUps" data-a1="upcoming">Upcoming (14d)</button>
        <button class="btn btn-sm ${filter === 'completed' ? 'btn-g' : 'btn-s'}" data-act="openFollowUps" data-a1="completed">Completed (${all.filter(r => r.status === 'Completed').length})</button>
        <span class="grow"></span>
        <button class="btn btn-s btn-sm" data-act="exportICal" title="Export schedule in iCalendar format (.ics)">📅 Export iCal</button>
        <button class="btn btn-p btn-sm" data-act="openAddFollowUp">+ Add Reminder</button>
      </div>

      <div class="reminders-list">
        ${filtered.map(r => renderReminderItemHtml(r, td)).join('') || '<div class="card empty">No follow-up reminders found for this filter.</div>'}
      </div>
    </div>
  `;

  showAppModal('remindersModal', '⏰ Follow-up Reminders & Schedule Manager', body, `
    <button class="btn btn-s" data-act="closeAppModal" data-a1="remindersModal">Close</button>
  `);
}

function renderReminderItemHtml(r, td) {
  const isOverdue = r.status === 'Pending' && r.dueDate < td;
  const isToday = r.status === 'Pending' && r.dueDate === td;
  const priorityClass = `p-${(r.priority || 'medium').toLowerCase()}`;

  const linkHtml = r.recordType && r.recordId && r.recordCode
    ? `<span class="pill">📎 <a href="javascript:void(0)" data-act="openView" data-a1="${esc(r.recordType)}" data-a2="${esc(r.recordId)}">${esc(r.recordCode)}</a></span>`
    : '';

  return `
    <div class="reminder-item ${r.status === 'Completed' ? 'completed' : priorityClass}">
      <div class="reminder-content">
        <div class="reminder-title">${esc(r.title)}</div>
        <div class="reminder-meta">
          ${isOverdue ? `<span class="reminder-tag overdue">⚠️ OVERDUE by ${Math.abs(daysTo(r.dueDate))} day(s)</span>` : ''}
          ${isToday ? `<span class="reminder-tag today">📌 DUE TODAY</span>` : ''}
          <span>Due: <b>${fdt(r.dueDate)}</b> ${r.dueTime ? 'at ' + esc(r.dueTime) : ''}</span>
          <span class="pill">${esc(r.priority || 'Medium')} Priority</span>
          ${r.assigneeRole ? `<span class="pill">👤 ${esc(r.assigneeRole)}</span>` : ''}
          ${linkHtml}
        </div>
        ${r.notes ? `<div class="note u-mt-4">${esc(r.notes)}</div>` : ''}
      </div>

      <div class="reminder-actions">
        ${r.status === 'Pending' ? `
          <button class="btn btn-g btn-sm" data-act="completeFollowUp" data-a1="${esc(r.id)}">✔ Done</button>
          <div class="bar u-m-0">
            <button class="btn btn-s btn-sm" data-act="snoozeFollowUp" data-a1="${esc(r.id)}" data-a2="1" title="Snooze 1 day">+1d</button>
            <button class="btn btn-s btn-sm" data-act="snoozeFollowUp" data-a1="${esc(r.id)}" data-a2="3" title="Snooze 3 days">+3d</button>
            <button class="btn btn-s btn-sm" data-act="snoozeFollowUp" data-a1="${esc(r.id)}" data-a2="7" title="Snooze 1 week">+1w</button>
          </div>
        ` : `
          <button class="btn btn-s btn-sm" data-act="reopenFollowUp" data-a1="${esc(r.id)}">↩ Reopen</button>
        `}
        <button class="btn btn-s btn-sm" data-act="deleteFollowUp" data-a1="${esc(r.id)}" title="Delete reminder">🗑</button>
      </div>
    </div>
  `;
}

function openAddFollowUp(prefill = {}) {
  const linked = prefill.recordCode ? prefill : (VIEW ? { recordType: VIEW.c, recordId: VIEW.id, recordCode: byId(VIEW.c, VIEW.id)?.code } : {});
  const defaultDate = prefill.dueDate || today();

  const body = `
    <div class="f fg">
      <label>Follow-up Title *</label>
      <input type="text" id="remTitle" value="${esc(prefill.title || '')}" placeholder="e.g. Call Mukhtiarkar for Revenue Settlement record" required>
    </div>
    <div class="grid2">
      <div class="f fg">
        <label>Due Date *</label>
        <input type="date" id="remDueDate" value="${esc(defaultDate)}" required>
      </div>
      <div class="f fg">
        <label>Time (optional)</label>
        <input type="time" id="remDueTime" value="${esc(prefill.dueTime || '10:00')}">
      </div>
    </div>
    <div class="grid2">
      <div class="f fg">
        <label>Priority</label>
        <select id="remPriority">
          <option value="Critical">🔴 Critical (Immediate Attention)</option>
          <option value="High" selected>🟠 High Priority</option>
          <option value="Medium">🔵 Medium Priority</option>
          <option value="Low">⚪ Low / Routine</option>
        </select>
      </div>
      <div class="f fg">
        <label>Responsible Role</label>
        <select id="remRole">
          <option value="Field Officer">Field Officer</option>
          <option value="Legal Counsel">Legal Counsel</option>
          <option value="Land Manager">Land Manager</option>
          <option value="Finance Officer">Finance Officer</option>
          <option value="Admin">Administrator</option>
        </select>
      </div>
    </div>
    <div class="f fg">
      <label>Notes & Context</label>
      <textarea id="remNotes" rows="3" placeholder="Additional instructions or background notes...">${esc(prefill.notes || '')}</textarea>
    </div>
    ${linked.recordCode ? `
      <input type="hidden" id="remRecType" value="${esc(linked.recordType)}">
      <input type="hidden" id="remRecId" value="${esc(linked.recordId)}">
      <input type="hidden" id="remRecCode" value="${esc(linked.recordCode)}">
      <p class="note">📎 Linking to Record: <b>${esc(linked.recordCode)}</b> (${esc(linked.recordType)})</p>
    ` : ''}
  `;

  showAppModal('addReminderModal', '⏰ Schedule Follow-up Reminder', body, `
    <button class="btn btn-s" data-act="closeAppModal" data-a1="addReminderModal">Cancel</button>
    <button class="btn btn-p" data-act="saveNewFollowUp">Save & Schedule</button>
  `);
}

function saveNewFollowUp() {
  const title = (document.getElementById('remTitle')?.value || '').trim();
  const dueDate = document.getElementById('remDueDate')?.value;
  if (!title || !dueDate) {
    toast('Please specify a title and due date.', 'warning');
    return;
  }
  const dueTime = document.getElementById('remDueTime')?.value || '';
  const priority = document.getElementById('remPriority')?.value || 'High';
  const assigneeRole = document.getElementById('remRole')?.value || 'Field Officer';
  const notes = (document.getElementById('remNotes')?.value || '').trim();

  const recordType = document.getElementById('remRecType')?.value || null;
  const recordId = document.getElementById('remRecId')?.value || null;
  const recordCode = document.getElementById('remRecCode')?.value || null;

  addFollowUp({
    title,
    dueDate,
    dueTime,
    priority,
    assigneeRole,
    notes,
    recordType,
    recordId,
    recordCode
  });

  closeAppModal('addReminderModal');
  if (document.getElementById('remindersModal')) openFollowUps(REMINDERS_FILTER);
}

/* iCalendar RFC-5545 Export */
function exportICal() {
  const custom = getCustomFollowUps().filter(r => r.status === 'Pending');
  const stat = typeof calEvents === 'function' ? calEvents() : [];

  let ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Mari Petroleum//LMS Land Management System//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:LMS Land Operations & Reminders'
  ];

  // Export custom follow-ups
  custom.forEach(c => {
    const dt = c.dueDate.replace(/-/g, '');
    ics.push(
      'BEGIN:VEVENT',
      `UID:${c.id}@lms.local`,
      `DTSTAMP:${dt}T090000Z`,
      `DTSTART;VALUE=DATE:${dt}`,
      `SUMMARY:[${c.priority}] ${c.title}`,
      `DESCRIPTION:${c.notes ? c.notes.replace(/\n/g, '\\n') : ''}${c.recordCode ? ' (Linked: ' + c.recordCode + ')' : ''}`,
      `STATUS:CONFIRMED`,
      'END:VEVENT'
    );
  });

  // Export statutory milestones
  stat.forEach((s, idx) => {
    const dt = s.d.replace(/-/g, '');
    ics.push(
      'BEGIN:VEVENT',
      `UID:stat_${idx}_${dt}@lms.local`,
      `DTSTAMP:${dt}T090000Z`,
      `DTSTART;VALUE=DATE:${dt}`,
      `SUMMARY:${s.type}: ${s.t}`,
      `STATUS:CONFIRMED`,
      'END:VEVENT'
    );
  });

  ics.push('END:VCALENDAR');

  const blob = new Blob([ics.join('\r\n')], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `LMS_Schedule_${today()}.ics`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  toast('Schedule exported in iCalendar (.ics) format!', 'success');
  announceA11y('Schedule exported as iCalendar file');
}

/* ============================================================
   4. CALENDAR ENHANCEMENT & INTEGRATION HOOKS
   ============================================================ */

/* Hook calEvents to incorporate active custom follow-up reminders */
if (typeof calEvents === 'function') {
  const _origCalEvents = calEvents;
  window.calEvents = function () {
    const events = _origCalEvents.apply(this, arguments);
    const custom = getCustomFollowUps().filter(r => r.status === 'Pending');

    const priColors = {
      Critical: '#d93a3a',
      High: '#e09a1a',
      Medium: '#2368b0',
      Low: '#5f6f84'
    };

    custom.forEach(r => {
      events.push({
        d: r.dueDate,
        type: '⏰ Follow-up',
        t: `[${r.priority}] ${r.title}`,
        c: r.recordType || 'calendar',
        id: r.recordId || r.id,
        col: priColors[r.priority] || '#2368b0',
        isFollowUp: true,
        followUpId: r.id,
        priority: r.priority
      });
    });

    return events;
  };
}

/* Enhance scrCalendar rendering with controls and day-click triggers */
if (typeof scrCalendar === 'function') {
  const _origScrCalendar = scrCalendar;
  window.scrCalendar = function () {
    const base = UI.calM ? new Date(UI.calM) : new Date(); base.setDate(1); const y = base.getFullYear(), m = base.getMonth();
    const E = calEvents(); const first = (new Date(y, m, 1).getDay() + 6) % 7; const days = new Date(y, m + 1, 0).getDate(); const td = today();

    let cells = ''; for (let i = 0; i < first; i++) cells += '<div class="cal-d off"></div>';
    for (let d = 1; d <= days; d++) {
      const ds = toIsoDate(new Date(y, m, d));
      const ev = E.filter(e => e.d === ds);
      const hasFollowUps = ev.some(e => e.isFollowUp);

      cells += `
        <div class="cal-d ${ds === td ? 'today' : ''} ${hasFollowUps ? 'has-followups' : ''}" data-act="openAddFollowUpDate" data-a1="${ds}">
          <div class="n">${d} <span class="cal-add-btn" title="Add reminder for this day">+ add</span></div>
          ${ev.slice(0, 4).map(e => `
            <div class="cal-e ${e.isFollowUp ? 'cal-followup' : ''}"
                 title="${esc(e.type + ': ' + e.t)}"
                 data-act="${e.isFollowUp ? 'openFollowUpDetail' : 'openView'}"
                 data-a1="${e.isFollowUp ? esc(e.followUpId) : esc(e.c)}"
                 data-a2="${esc(e.id)}"
                 data-accent="${esc(e.col)}">${esc(e.t)}</div>
          `).join('')}
          ${ev.length > 4 ? `<div class="note">+${ev.length - 4} more</div>` : ''}
        </div>
      `;
    }

    const up = E.filter(e => e.d >= td && daysTo(e.d) <= 45).sort((a, b) => a.d.localeCompare(b.d));
    const types = uniq(E.map(e => e.type + '|' + e.col));

    return `
      <div class="split u-split-330">
        <div class="card">
          <div class="card-h">
            <div>
              <h3>🗓 Land Operations Calendar — ${base.toLocaleString('en-GB', { month: 'long', year: 'numeric' })}</h3>
              <p>Lease expiries, rent dues, court hearings, statutory deadlines & scheduled follow-up reminders</p>
            </div>
            <div class="bar u-m-0">
              <button class="btn btn-s btn-sm" data-act="setCalMonth" data-a1="${y}" data-a2="${m - 1}">‹</button>
              <button class="btn btn-s btn-sm" data-act="setCalMonth">Today</button>
              <button class="btn btn-s btn-sm" data-act="setCalMonth" data-a1="${y}" data-a2="${m + 1}">›</button>
              <button class="btn btn-s btn-sm" data-act="exportICal" title="Export schedule to Outlook / Google Calendar (.ics)">📅 Export .ics</button>
              <button class="btn btn-p btn-sm" data-act="openAddFollowUp">+ Follow-up</button>
            </div>
          </div>
          <div class="cal-h">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => `<div>${d}</div>`).join('')}</div>
          <div class="cal">${cells}</div>
          <div class="bar u-mt-10">
            ${types.map(t => { const [n, c] = t.split('|'); return `<span class="pill" data-accent-full="${esc(c)}">${esc(n)}</span>`; }).join('')}
          </div>
        </div>

        <div class="card">
          <div class="card-h">
            <div>
              <h3>Next 45 days (${up.length})</h3>
              <p>Statutory deadlines & assigned follow-ups</p>
            </div>
            <button class="btn btn-s btn-sm" data-act="openFollowUps">Manage All</button>
          </div>
          ${up.map(e => `
            <div class="al" data-accent-full="${esc(e.col)}">
              <div class="tx" data-act="${e.isFollowUp ? 'openFollowUpDetail' : 'openView'}" data-a1="${e.isFollowUp ? esc(e.followUpId) : esc(e.c)}" data-a2="${esc(e.id)}">
                <b>${fdt(e.d)}</b> · ${esc(e.type)}
                <small>${esc(e.t)} · in ${daysTo(e.d)} day(s)</small>
              </div>
              ${e.isFollowUp ? `
                <button class="btn btn-g btn-sm" data-act="completeFollowUp" data-stop="1" data-a1="${esc(e.followUpId)}" title="Mark completed">✔</button>
                <button class="btn btn-s btn-sm" data-act="snoozeFollowUp" data-stop="1" data-a1="${esc(e.followUpId)}" data-a2="3" title="Snooze 3 days">⏰</button>
              ` : (!isRole('Viewer') ? `
                <button class="btn btn-s btn-sm" data-act="remind" data-stop="1" data-a1="${esc(e.c)}" data-a2="${esc(e.id)}">📨</button>
              ` : '')}
            </div>
          `).join('') || '<div class="empty">Nothing due in next 45 days</div>'}
        </div>
      </div>
    `;
  };
}

/* ============================================================
   5. RECORD VIEW ENHANCEMENT (drawView)
   ============================================================ */
if (typeof drawView === 'function') {
  const _origDrawView = drawView;
  window.drawView = function () {
    _origDrawView.apply(this, arguments);
    if (!VIEW) return;
    const { c, id } = VIEW;
    const r = byId(c, id);
    if (!r) return;

    const foot = document.getElementById('vFoot');
    if (foot) {
      // Add sticky note button and follow-up button to record modal footer
      const recStickyBtn = document.createElement('button');
      recStickyBtn.className = 'btn btn-s';
      recStickyBtn.innerHTML = '📝 Add Note';
      recStickyBtn.setAttribute('data-act', 'openAddStickyNoteRecord');
      recStickyBtn.setAttribute('data-a1', c);
      recStickyBtn.setAttribute('data-a2', id);

      const recFollowUpBtn = document.createElement('button');
      recFollowUpBtn.className = 'btn btn-s';
      recFollowUpBtn.innerHTML = '⏰ + Follow-up';
      recFollowUpBtn.setAttribute('data-act', 'openAddFollowUpRecord');
      recFollowUpBtn.setAttribute('data-a1', c);
      recFollowUpBtn.setAttribute('data-a2', id);

      foot.prepend(recFollowUpBtn);
      foot.prepend(recStickyBtn);
    }
    updateStickyBadge();
  };
}

/* ============================================================
   6. MODAL SYSTEM & TOPBAR INJECTION
   ============================================================ */
function showAppModal(id, title, bodyHtml, footerHtml = '') {
  if (!document.body) return;
  let modalContainer = document.getElementById(id);
  if (!modalContainer) {
    modalContainer = document.createElement('div');
    modalContainer.id = id;
    modalContainer.className = 'mb hidden top2';
    modalContainer.innerHTML = `
      <div class="modal lg" role="dialog" aria-modal="true" aria-labelledby="${id}Title">
        <div class="mh">
          <h3 id="${id}Title"></h3>
          <button class="x" data-act="closeAppModal" data-a1="${id}" aria-label="Close">&times;</button>
        </div>
        <div class="mbody" id="${id}Body"></div>
        <div class="mf" id="${id}Foot"></div>
      </div>
    `;
    document.body.appendChild(modalContainer);
  }

  const tEl = document.getElementById(`${id}Title`);
  const bEl = document.getElementById(`${id}Body`);
  const fEl = document.getElementById(`${id}Foot`);
  if (tEl) tEl.innerHTML = title;
  if (bEl) bEl.innerHTML = bodyHtml;
  if (fEl) fEl.innerHTML = footerHtml;

  modalContainer.classList.remove('hidden');
  if (typeof a11yPass === 'function') a11yPass(modalContainer);
}

function closeAppModal(id) {
  const m = document.getElementById(id);
  if (m) m.classList.add('hidden');
}

/* Ensure Sticky Dock markup exists */
function ensureStickyDock() {
  if (!document.body || document.getElementById('stickyDock')) return;

  const backdrop = document.createElement('div');
  backdrop.id = 'stickyBackdrop';
  backdrop.className = 'sticky-dock-backdrop';
  backdrop.setAttribute('data-act', 'toggleStickyDock');
  document.body.appendChild(backdrop);

  const dock = document.createElement('div');
  dock.id = 'stickyDock';
  dock.className = 'sticky-dock';
  dock.innerHTML = `
    <div class="sticky-dock-header">
      <h3>📝 Sticky Notes & Scratchpad</h3>
      <span class="grow"></span>
      <button class="btn btn-p btn-sm" data-act="openAddStickyNote">+ New Note</button>
      <button class="x" data-act="toggleStickyDock" aria-label="Close">&times;</button>
    </div>
    <div class="sticky-dock-tabs"></div>
    <div class="sticky-dock-body"></div>
  `;
  document.body.appendChild(dock);
}

/* Inject buttons into header topbar if missing (e.g. dynamic render) */
function ensureTopbarButtons() {
  const top = document.querySelector('.top');
  if (!top) return;

  // Follow-up Reminders button
  if (!document.getElementById('remindersBtn')) {
    const remBtn = document.createElement('button');
    remBtn.id = 'remindersBtn';
    remBtn.className = 'ibtn has-badge';
    remBtn.title = 'Follow-up Reminders & Schedule (Alt+R)';
    remBtn.setAttribute('aria-label', 'Follow-up Reminders');
    remBtn.setAttribute('data-act', 'openFollowUps');
    remBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 15"/></svg><span class="badge-count hidden" id="reminderN"></span>';
    const bell = document.querySelector('.top a[href*="inbox"]') || document.getElementById('thBtn');
    if (bell && bell.parentNode) bell.parentNode.insertBefore(remBtn, bell);
  }

  // Sticky Notes button
  if (!document.getElementById('stickyBtn')) {
    const stBtn = document.createElement('button');
    stBtn.id = 'stickyBtn';
    stBtn.className = 'ibtn has-badge';
    stBtn.title = 'Sticky Notes & Scratchpad (Alt+N)';
    stBtn.setAttribute('aria-label', 'Sticky Notes');
    stBtn.setAttribute('data-act', 'toggleStickyDock');
    stBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15.5 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8.5L15.5 3z"/><path d="M15 3v6h6"/><path d="M9 13h6M9 17h4"/></svg><span class="badge-count hidden info" id="stickyN"></span>';
    const remBtn = document.getElementById('remindersBtn');
    if (remBtn && remBtn.parentNode) remBtn.parentNode.insertBefore(stBtn, remBtn);
  }

  // Accessibility Preferences button
  if (!document.getElementById('a11yBtn')) {
    const a11yBtn = document.createElement('button');
    a11yBtn.id = 'a11yBtn';
    a11yBtn.className = 'ibtn hide-m';
    a11yBtn.title = 'Accessibility & Display Options (Alt+A)';
    a11yBtn.setAttribute('aria-label', 'Accessibility preferences');
    a11yBtn.setAttribute('data-act', 'openA11yModal');
    a11yBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="4" r="2"/><path d="M18 9h-4V7h-4v2H6a1 1 0 0 0 0 2h3v10a1 1 0 0 0 2 0v-5h2v5a1 1 0 0 0 2 0V11h3a1 1 0 0 0 0-2z"/></svg>';
    const thBtn = document.getElementById('thBtn');
    if (thBtn && thBtn.parentNode) thBtn.parentNode.insertBefore(a11yBtn, thBtn);
  }
}

/* ============================================================
   7. ENTERPRISE GLOBAL SEARCH (OMNISRCH)
   - Real-time Cadastral Search Across Landowners, Khasras/Surveys,
     Leases, Compensation Cases, Pipeline ROW, Payments & Screens
   ============================================================ */
let SEARCH_SCOPE = 'all';
let SEARCH_SELECTED_INDEX = -1;
let SEARCH_CURRENT_RESULTS = [];

function openGlobalSearch() {
  const m = document.getElementById('globalSearchModal');
  if (!m) return;
  m.classList.remove('hidden');
  const inp = document.getElementById('globalSearchInput');
  if (inp) {
    inp.value = '';
    setTimeout(() => inp.focus(), 50);
  }
  SEARCH_SELECTED_INDEX = -1;
  renderGlobalSearchResults('');
  announceA11y('Global search opened');
}

function closeGlobalSearch() {
  const m = document.getElementById('globalSearchModal');
  if (m) m.classList.add('hidden');
  SEARCH_SELECTED_INDEX = -1;
}

function setSearchScope(scope) {
  SEARCH_SCOPE = scope || 'all';
  const pills = document.querySelectorAll('#searchFilters .s-filter');
  pills.forEach(p => p.classList.toggle('is-active', p.getAttribute('data-a1') === SEARCH_SCOPE));
  const inp = document.getElementById('globalSearchInput');
  renderGlobalSearchResults(inp ? inp.value.trim() : '');
}

function getSearchCollections() {
  const allColls = [
    { key: 'landowners', label: 'Landowners', icon: '👤' },
    { key: 'surveys',    label: 'Khasras & Surveys', icon: '🗺️' },
    { key: 'leases',     label: 'Leases & Agreements', icon: '📜' },
    { key: 'cases',      label: 'Compensation Cases', icon: '⚖️' },
    { key: 'rows',       label: 'Pipelines & ROW', icon: '🛣️' },
    { key: 'payments',   label: 'Payments & Cheques', icon: '💳' }
  ];
  if (SEARCH_SCOPE === 'all') return allColls;
  return allColls.filter(c => c.key === SEARCH_SCOPE);
}

function searchRecords(query) {
  const q = (query || '').toLowerCase().trim();
  const results = [];
  const maxPerGroup = q ? 6 : 3;

  // 1. Screens / Navigation
  if (SEARCH_SCOPE === 'all' || SEARCH_SCOPE === 'screens') {
    const screensToSearch = [];
    if (typeof NAV !== 'undefined' && Array.isArray(NAV)) {
      NAV.forEach(([group, items]) => {
        (items || []).forEach(([key, , title]) => {
          screensToSearch.push({ key, group, title });
        });
      });
    } else if (typeof SCREENS !== 'undefined' && Array.isArray(SCREENS)) {
      SCREENS.forEach(s => {
        if (Array.isArray(s)) screensToSearch.push({ key: s[0], group: s[1], title: s[2] });
        else screensToSearch.push(s);
      });
    }

    const matchedScreens = screensToSearch.filter(s => {
      if (!q) return false;
      if (typeof screenAllowed === 'function' && !screenAllowed(s.key)) return false;
      const keyL = (s.key || '').toLowerCase();
      const grpL = (s.group || '').toLowerCase();
      const ttlL = (s.title || '').toLowerCase();

      const aliases = [];
      if (s.key === 'surveys') aliases.push('khasra', 'survey', 'land record', 'patwari', 'mauza', 'deh');
      if (s.key === 'landowners') aliases.push('owner', 'landowner', 'cnic', 'malik', 'khata');
      if (s.key === 'leases') aliases.push('lease', 'agreement', 'rent', 'term');
      if (s.key === 'rows') aliases.push('pipeline', 'row', 'corridor', 'right of way', 'easement');
      if (s.key === 'payments') aliases.push('payment', 'cheque', 'voucher', 'finance', 'sap', 'wht');
      if (s.key === 'cases') aliases.push('case', 'compensation', 'award', 'section 4', 'section 6');
      if (s.key === 'legal') aliases.push('court', 'legal', 'litigation', 'stay', 'suit');
      if (s.key === 'gis') aliases.push('map', 'gis', 'spatial', 'coordinates', 'lat', 'lng', 'polygon');
      if (s.key === 'inbox') aliases.push('approval', 'alert', 'pending', 'task', 'notification');
      if (s.key === 'mutations') aliases.push('mutation', 'intiqal', 'succession', 'inheritance', 'varasati');
      if (s.key === 'encroachments') aliases.push('encroachment', 'unauthorized', 'trespass', 'structure');
      if (s.key === 'grievances') aliases.push('grievance', 'complaint', 'community', 'iir');
      if (s.key === 'audit') aliases.push('audit', 'history', 'log', 'trail');
      if (s.key === 'dbpfc') aliases.push('dbpfc', 'sindh govt', 'forest');

      const matchesAlias = aliases.some(a => a.includes(q) || q.includes(a));
      return keyL.includes(q) || grpL.includes(q) || ttlL.includes(q) || matchesAlias;
    }).slice(0, 5);

    matchedScreens.forEach(s => {
      results.push({
        type: 'screen',
        screenKey: s.key,
        title: s.title,
        subtitle: s.group + ' · Quick navigation',
        code: s.key.toUpperCase(),
        tag: 'Screen',
        icon: '🧭'
      });
    });
  }

  // 2. Data Collections
  if (typeof S !== 'undefined' && S) {
    const collsToSearch = getSearchCollections();
    for (const c of collsToSearch) {
      const records = S[c.key] || [];
      const matched = records.filter(r => {
        if (typeof inScope === 'function' && !inScope(c.key, r)) return false;
        if (!q) return true; // show sample when empty

        const code = (r.code || '').toLowerCase();
        if (code.includes(q)) return true;

        if (c.key === 'landowners') {
          const fn = (r.father || r.fatherName || '').toLowerCase();
          return (r.name && r.name.toLowerCase().includes(q)) ||
                 (r.nameUrdu && r.nameUrdu.includes(q)) ||
                 (r.cnic && r.cnic.toLowerCase().includes(q)) ||
                 fn.includes(q) ||
                 (r.mauza && r.mauza.toLowerCase().includes(q)) ||
                 (r.district && r.district.toLowerCase().includes(q)) ||
                 (r.mobile && r.mobile.includes(q)) ||
                 (r.status && r.status.toLowerCase().includes(q)) ||
                 (r.filer && r.filer.toLowerCase().includes(q)) ||
                 (q === 'landowner' || q === 'owner');
        }
        if (c.key === 'surveys') {
          const locName = (typeof unitName === 'function' && r.unitId) ? unitName(r.unitId).toLowerCase() : '';
          const locPath = (typeof unitPath === 'function' && r.unitId) ? unitPath(r.unitId).toLowerCase() : '';
          const sNo = String(r.surveyNo || '').toLowerCase();
          const cleanQ = q.replace(/^khasra\s*|^survey\s*/i, '').trim();
          const matchesNum = cleanQ && (sNo.includes(cleanQ) || (r.code || '').toLowerCase().includes(cleanQ));
          return sNo.includes(q) ||
                 matchesNum ||
                 (r.mauza && r.mauza.toLowerCase().includes(q)) ||
                 locName.includes(q) ||
                 locPath.includes(q) ||
                 (r.district && r.district.toLowerCase().includes(q)) ||
                 (r.blockNo && String(r.blockNo).toLowerCase().includes(q)) ||
                 (r.landClass && r.landClass.toLowerCase().includes(q)) ||
                 (r.status && r.status.toLowerCase().includes(q)) ||
                 (q === 'khasra' || q === 'survey');
        }
        if (c.key === 'leases') {
          const pName = (typeof byId === 'function' && r.projectId) ? (byId('projects', r.projectId)?.name || '').toLowerCase() : '';
          const pCode = (typeof projCode === 'function' && r.projectId) ? projCode(r.projectId).toLowerCase() : '';
          return (r.project && r.project.toLowerCase().includes(q)) ||
                 pName.includes(q) ||
                 pCode.includes(q) ||
                 (r.type && r.type.toLowerCase().includes(q)) ||
                 (r.status && r.status.toLowerCase().includes(q)) ||
                 (r.term && String(r.term).toLowerCase().includes(q)) ||
                 (q === 'lease' || q === 'agreement');
        }
        if (c.key === 'cases') {
          const pName = (typeof byId === 'function' && r.projectId) ? (byId('projects', r.projectId)?.name || '').toLowerCase() : '';
          const pCode = (typeof projCode === 'function' && r.projectId) ? projCode(r.projectId).toLowerCase() : '';
          return (r.title && r.title.toLowerCase().includes(q)) ||
                 pName.includes(q) ||
                 pCode.includes(q) ||
                 (r.type && r.type.toLowerCase().includes(q)) ||
                 (r.stage && r.stage.toLowerCase().includes(q)) ||
                 (r.district && r.district.toLowerCase().includes(q)) ||
                 (q === 'case' || q === 'compensation');
        }
        if (c.key === 'rows') {
          return (r.name && r.name.toLowerCase().includes(q)) ||
                 (r.corridor && r.corridor.toLowerCase().includes(q)) ||
                 (r.status && r.status.toLowerCase().includes(q)) ||
                 (r.diameter && String(r.diameter).includes(q)) ||
                 (q === 'row' || q === 'pipeline');
        }
        if (c.key === 'payments') {
          return (r.payee && r.payee.toLowerCase().includes(q)) ||
                 (r.chequeNo && r.chequeNo.toLowerCase().includes(q)) ||
                 (r.stage && r.stage.toLowerCase().includes(q)) ||
                 (r.sapDoc && r.sapDoc.toLowerCase().includes(q)) ||
                 (q === 'payment' || q === 'cheque' || q === 'voucher');
        }
        return false;
      }).slice(0, maxPerGroup);

      matched.forEach(r => {
        let title = r.code || 'Record';
        let subtitle = '';
        let tag = c.label;

        if (c.key === 'landowners') {
          title = `${r.name || 'Landowner'}${r.nameUrdu ? ' · ' + r.nameUrdu : ''}`;
          subtitle = `CNIC: ${r.cnic || '—'} · ${r.father ? 's/o ' + r.father + ' · ' : ''}${r.mobile ? 'Mob: ' + r.mobile + ' · ' : ''}${r.filer || ''}`;
          tag = r.status || r.ownerType || 'Owner';
        } else if (c.key === 'surveys') {
          const loc = (typeof unitName === 'function' && r.unitId) ? unitName(r.unitId) : (r.mauza || '—');
          title = `Khasra ${r.surveyNo || '—'}${r.blockNo ? ' / Blk ' + r.blockNo : ''} · ${loc}`;
          subtitle = `${r.totalArea ? r.totalArea + ' ' + (r.areaUnit || 'acres') : ''} · ${r.landClass || 'Private'} · ${r.code || ''}`;
          tag = r.status || 'Survey';
        } else if (c.key === 'leases') {
          const pName = (typeof byId === 'function' && r.projectId) ? (byId('projects', r.projectId)?.name || '') : (r.project || 'Well Location');
          title = `${r.code} · ${pName}`;
          subtitle = `Rent: PKR ${r.rent ? Number(r.rent).toLocaleString() : '—'}/yr · Term: ${r.term || '—'} yrs · Type: ${r.type || 'Standard'}`;
          tag = r.status || 'Lease';
        } else if (c.key === 'cases') {
          const pName = (typeof byId === 'function' && r.projectId) ? (byId('projects', r.projectId)?.name || '') : '';
          title = `${r.code} · ${r.title || 'Compensation Case'}`;
          subtitle = `${r.type || 'Section 4'} · ${pName ? pName + ' · ' : ''}Stage: ${r.stage || 'In Progress'}`;
          tag = r.stage || 'Case';
        } else if (c.key === 'rows') {
          title = `${r.code} · ${r.name || 'Pipeline Corridor'}`;
          subtitle = `Dia: ${r.diameter ? r.diameter + '"' : '—'} · Status: ${r.status || 'Active'}${r.corridor ? ' · ' + r.corridor : ''}`;
          tag = r.status || 'Pipeline';
        } else if (c.key === 'payments') {
          title = `${r.code} · Payee: ${r.payee || '—'}`;
          subtitle = `Amount: PKR ${r.amount ? Number(r.amount).toLocaleString() : (r.gross ? Number(r.gross).toLocaleString() : '—')} · Cheque: ${r.chequeNo || 'Pending'}${r.sapDoc ? ' · SAP: ' + r.sapDoc : ''}`;
          tag = r.stage || 'Payment';
        }

        results.push({
          type: 'record',
          coll: c.key,
          id: r.id,
          code: r.code,
          title,
          subtitle,
          tag,
          icon: c.icon
        });
      });
    }
  }

  return results;
}

function renderGlobalSearchResults(query) {
  const container = document.getElementById('globalSearchResults');
  const countEl = document.getElementById('searchCount');
  if (!container) return;

  const results = searchRecords(query);
  SEARCH_CURRENT_RESULTS = results;
  SEARCH_SELECTED_INDEX = results.length > 0 ? 0 : -1;

  if (countEl) {
    if (!query) countEl.textContent = 'Showing recent records & quick navigation';
    else countEl.textContent = `${results.length} result${results.length === 1 ? '' : 's'} found`;
  }

  if (!results.length) {
    container.innerHTML = `
      <div class="search-empty">
        <div class="search-empty-icon">🔍</div>
        <div class="search-empty-title">No matching records found</div>
        <p>Try searching for a Landowner Name, CNIC, Khasra #, Lease code, or Pipeline name.</p>
      </div>
    `;
    return;
  }

  let html = '';
  let currentGroup = '';

  results.forEach((item, idx) => {
    const groupName = item.type === 'screen' ? 'Navigation & Modules' : (item.coll ? (SPEC[item.coll]?.title || item.tag) : 'Records');
    if (groupName !== currentGroup) {
      currentGroup = groupName;
      html += `<div class="search-group-title">${esc(currentGroup)}</div>`;
    }

    const isSelected = idx === SEARCH_SELECTED_INDEX;
    const actAttr = item.type === 'screen'
      ? `data-act="selectSearchResult" data-a1="screen" data-a2="${esc(item.screenKey)}"`
      : `data-act="selectSearchResult" data-a1="${esc(item.coll)}" data-a2="${esc(item.id)}"`;

    html += `
      <div class="search-item ${isSelected ? 'is-selected' : ''}" role="option" aria-selected="${isSelected}" data-idx="${idx}" ${actAttr}>
        <div class="search-item-icon" aria-hidden="true">${item.icon}</div>
        <div class="search-item-main">
          <div class="search-item-line1">
            <span class="search-item-title">${esc(item.title)}</span>
            ${item.code ? `<span class="search-item-code">${esc(item.code)}</span>` : ''}
            <span class="search-item-tag">${esc(item.tag)}</span>
          </div>
          <div class="search-item-line2">${esc(item.subtitle)}</div>
        </div>
        <div class="search-item-action">Open ↵</div>
      </div>
    `;
  });

  container.innerHTML = html;
}

function moveSearchSelection(delta) {
  if (!SEARCH_CURRENT_RESULTS.length) return;
  const items = document.querySelectorAll('#globalSearchResults .search-item');
  if (!items.length) return;

  if (SEARCH_SELECTED_INDEX < 0) {
    SEARCH_SELECTED_INDEX = delta > 0 ? 0 : items.length - 1;
  } else {
    SEARCH_SELECTED_INDEX = (SEARCH_SELECTED_INDEX + delta + items.length) % items.length;
  }

  items.forEach((it, idx) => {
    const isSel = idx === SEARCH_SELECTED_INDEX;
    it.classList.toggle('is-selected', isSel);
    it.setAttribute('aria-selected', String(isSel));
    if (isSel) it.scrollIntoView({ block: 'nearest' });
  });
}

function activateSearchSelection() {
  if (SEARCH_SELECTED_INDEX >= 0 && SEARCH_SELECTED_INDEX < SEARCH_CURRENT_RESULTS.length) {
    const item = SEARCH_CURRENT_RESULTS[SEARCH_SELECTED_INDEX];
    if (item.type === 'screen') {
      selectSearchResult('screen', item.screenKey);
    } else {
      selectSearchResult(item.coll, item.id);
    }
  }
}

function selectSearchResult(arg1, arg2) {
  closeGlobalSearch();
  if (arg1 === 'screen') {
    if (typeof pageUrl === 'function') location.href = pageUrl(arg2);
  } else {
    if (typeof openView === 'function') {
      const rec = (typeof byId === 'function' ? byId(arg1, arg2) : null) || (typeof byCode === 'function' ? byCode(arg1, arg2) : null);
      if (rec) openView(arg1, rec.id);
      else openView(arg1, arg2);
    } else if (typeof pageUrl === 'function') {
      location.href = pageUrl(arg1) + '?view=' + encodeURIComponent(arg2);
    }
  }
}

function openAddStickyNoteRecord(c, id) {
  const r = typeof byId === 'function' ? byId(c, id) : null;
  openAddStickyNote({ c, id, code: r ? r.code : '' });
}

function openEditStickyNote(id) {
  const n = getStickyNotes().find(x => x.id === id);
  if (!n) return;
  openAddStickyNote({ c: n.recordType, id: n.recordId, code: n.recordCode });
  setTimeout(() => {
    if (document.getElementById('snTitle')) document.getElementById('snTitle').value = n.title;
    if (document.getElementById('snContent')) document.getElementById('snContent').value = n.content;
    if (document.getElementById('snColor')) document.getElementById('snColor').value = n.color || 'yellow';
    if (document.getElementById('snTag')) document.getElementById('snTag').value = n.tag || 'General';
    if (document.getElementById('snChecklist')) {
      document.getElementById('snChecklist').value = (n.checklist || []).map(x => x.text).join('\n');
    }
  }, 50);
}

function openAddFollowUpDate(d) {
  openAddFollowUp({ dueDate: d });
}

function openAddFollowUpRecord(c, id) {
  const r = typeof byId === 'function' ? byId(c, id) : null;
  openAddFollowUp({ recordType: c, recordId: id, recordCode: r ? r.code : '' });
}

function openFollowUpDetail(fId) {
  const all = getCustomFollowUps();
  const it = all.find(x => x.id === fId);
  if (it && it.recordType && it.recordId) {
    if (typeof openView === 'function') openView(it.recordType, it.recordId);
  } else {
    openFollowUps('pending');
  }
}

/* Register action handlers into LMS_ACTIONS and window for delegated actions.js */
const ALL_FEATURE_ACTIONS = {
  openA11yModal,
  setA11yOpt,
  resetA11yOpts,
  openShortcutsModal,
  toggleStickyDock,
  setStickyFilter,
  openAddStickyNote,
  openAddStickyNoteRecord,
  saveNewStickyNote,
  togglePinSticky,
  toggleStickyCheck,
  deleteStickyNote,
  convertNoteToReminder,
  openEditStickyNote,
  openFollowUps,
  openAddFollowUp,
  openAddFollowUpDate,
  openAddFollowUpRecord,
  openFollowUpDetail,
  saveNewFollowUp,
  completeFollowUp,
  reopenFollowUp,
  snoozeFollowUp,
  deleteFollowUp,
  exportICal,
  closeAppModal,
  openSampleDataModal,
  closeSampleDataModal,
  generateSampleDataAction,
  openGlobalSearch,
  closeGlobalSearch,
  setSearchScope,
  selectSearchResult
};

Object.assign(window.LMS_ACTIONS, ALL_FEATURE_ACTIONS);
Object.assign(window, ALL_FEATURE_ACTIONS);

/* =====================================================================
   4. SAMPLE DATA GENERATOR & DEMONSTRATION ENGINE
   ===================================================================== */
function ensureSampleDataModal() {
  let modal = document.getElementById('sampleDataModal');
  if (modal) return modal;
  modal = document.createElement('div');
  modal.id = 'sampleDataModal';
  modal.className = 'mb hidden top2';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'sdTitle');
  modal.innerHTML = `
    <div class="modal sd-box">
      <div class="mh">
        <h3 id="sdTitle"><span class="ico"><svg viewBox="0 0 24 24"><path d="M21 16V8l-9-5-9 5v8l9 5z"/><path d="M3.3 7L12 12l8.7-5M12 22V12"/></svg></span> Sample Data Generator</h3>
        <button class="x" data-act="closeSampleDataModal" aria-label="Close">&times;</button>
      </div>
      <div class="mbody">
        <p class="sd-desc">
          Generate realistic, multi-province Pakistani E&amp;P land management records with authentic cadastral Khasra surveys, CNIC-based landowners, lease agreements, compensation cases, ROW pipelines, payment vouchers, follow-up reminders, and sticky notes.
        </p>
        <div class="fg">
          <label for="sdPreset">Dataset Scale &amp; Scope</label>
          <select id="sdPreset">
            <option value="standard">Standard E&amp;P Demonstration (60+ active records across 4 provinces)</option>
            <option value="expanded" selected>Comprehensive Field Operations (200+ landowners, 80 surveys, 50 leases &amp; payments)</option>
            <option value="stress">High-Volume Scale Test (1,000+ landowners, surveys &amp; vouchers)</option>
          </select>
        </div>
        <div class="fg">
          <label>Target Provinces</label>
          <div class="sd-provs">
            <label class="sd-check"><input type="checkbox" id="sdSnd" checked> <span>Sindh (Ghotki, Khairpur, Badin)</span></label>
            <label class="sd-check"><input type="checkbox" id="sdPnj" checked> <span>Punjab (Chakwal, Attock)</span></label>
            <label class="sd-check"><input type="checkbox" id="sdBal" checked> <span>Balochistan (Harnai, Kohlu)</span></label>
            <label class="sd-check"><input type="checkbox" id="sdKpk" checked> <span>Khyber Pakhtunkhwa (Karak, Kohat)</span></label>
          </div>
        </div>
        <div class="fg">
          <label class="sd-check"><input type="checkbox" id="sdReminders" checked> <span>Generate Follow-Up Reminders &amp; Calendar Tasks</span></label>
          <label class="sd-check"><input type="checkbox" id="sdNotes" checked> <span>Generate Field Sticky Notes &amp; Audit Checklists</span></label>
          <label class="sd-check"><input type="checkbox" id="sdClean" checked> <span>Reset and refresh state before generating</span></label>
        </div>
      </div>
      <div class="mf">
        <button class="btn btn-s" data-act="closeSampleDataModal">Cancel</button>
        <button class="btn btn-p" data-act="generateSampleDataAction"><svg viewBox="0 0 24 24"><path d="M21 16V8l-9-5-9 5v8l9 5z"/><path d="M3.3 7L12 12l8.7-5M12 22V12"/></svg> Generate Dataset</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  return modal;
}

function openSampleDataModal() {
  const m = ensureSampleDataModal();
  m.classList.remove('hidden');
}

function closeSampleDataModal() {
  const m = document.getElementById('sampleDataModal');
  if (m) m.classList.add('hidden');
}

function generateSampleDataAction() {
  const preset = document.getElementById('sdPreset')?.value || 'expanded';
  const clean = document.getElementById('sdClean')?.checked ?? true;
  const genReminders = document.getElementById('sdReminders')?.checked ?? true;
  const genNotes = document.getElementById('sdNotes')?.checked ?? true;

  const safeDOff = n => (typeof dOff === 'function' ? dOff(n) : toIsoDate(new Date(Date.now() + n * 864e5)));
  let state = (typeof S !== 'undefined' && S) ? S : (window.S || null);

  if (clean && state) {
    const keep = { users: state.users, settings: state.settings, sessions: state.sessions };
    if (typeof blankState === 'function') {
      const fresh = blankState();
      Object.assign(fresh, keep);
      if (typeof S !== 'undefined') S = fresh;
      window.S = fresh;
      state = fresh;
    }
  }

  // 1. Establish baseline demo hierarchy & records
  if (typeof buildDemo === 'function') {
    buildDemo();
    state = (typeof S !== 'undefined' && S) ? S : (window.S || state);
  }

  // 2. Expand dataset based on preset
  let addedCount = 45;
  if (state && (preset === 'expanded' || preset === 'stress')) {
    const multiplier = preset === 'stress' ? 20 : 3;
    const FIRST_NAMES = ['Tariq', 'Farhan', 'Rashid', 'Naveed', 'Khurram', 'Sikandar', 'Shahbaz', 'Zulfiqar', 'Bilal', 'Asad', 'Mansoor', 'Habibullah', 'Bashir', 'Shahid', 'Jamil', 'Zahid', 'Arshad', 'Sohail'];
    const LAST_NAMES = ['Khan', 'Memon', 'Soomro', 'Mahar', 'Lund', 'Junejo', 'Tareen', 'Marri', 'Awan', 'Khattak', 'Qureshi', 'Chughtai', 'Bhatti', 'Jatoi', 'Bugti', 'Malik', 'Abbasi', 'Ghaznavi'];

    const targetProvs = [];
    if (document.getElementById('sdSnd')?.checked) targetProvs.push('SND');
    if (document.getElementById('sdPnj')?.checked) targetProvs.push('PNJ');
    if (document.getElementById('sdBal')?.checked) targetProvs.push('BAL');
    if (document.getElementById('sdKpk')?.checked) targetProvs.push('KPK');
    if (!targetProvs.length) targetProvs.push('SND', 'PNJ', 'BAL', 'KPK');

    const lowUnits = (state.units || []).filter(u => targetProvs.includes(u.province));
    const activeProjects = (state.projects || []).filter(p => targetProvs.includes(p.province));

    if (activeProjects.length && lowUnits.length) {
      const extraSurveys = [];
      const extraOwners = [];
      const extraLeases = [];
      const extraPayments = [];

      for (let i = 0; i < 20 * multiplier; i++) {
        const pj = activeProjects[i % activeProjects.length];
        const u = lowUnits[i % lowUnits.length];
        const sId = 'esv_' + uid();
        const sCode = 'AREA-' + String(10000 + (state.surveys ? state.surveys.length : 0) + i);
        const area = +(1.5 + (i * 3.7) % 25).toFixed(2);
        const s = {
          id: sId,
          province: pj.province,
          code: sCode,
          unitId: u.id,
          surveyNo: String(2000 + i * 3),
          blockNo: pj.province === 'SND' ? String(1 + (i % 5)) : '',
          totalArea: area,
          landClass: i % 8 === 0 ? 'Government' : 'Private',
          status: ['Leased', 'Under Acquisition', 'Acquired', 'Proposed'][i % 4],
          projectIds: [pj.id],
          lat: +(pj.lat + (((i * 17) % 100) - 50) / 5000).toFixed(5),
          lng: +(pj.lng + (((i * 29) % 100) - 50) / 5000).toFixed(5),
          createdAt: fNowStr(),
          createdBy: 'admin',
          history: []
        };
        extraSurveys.push(s);

        // Landowner
        const fn = FIRST_NAMES[i % FIRST_NAMES.length];
        const ln = LAST_NAMES[(i * 3) % LAST_NAMES.length];
        const loId = 'elo_' + uid();
        const loCode = pj.province + '-' + String(20000 + (state.landowners ? state.landowners.length : 0) + i);
        const cnic = String(10000 + (i * 137) % 40000).slice(0, 5) + '-' + String(1000000 + i * 9187).slice(0, 7) + '-' + (1 + (i % 9));
        const lo = {
          id: loId,
          province: pj.province,
          code: loCode,
          name: fn + ' ' + ln,
          father: FIRST_NAMES[(i + 4) % FIRST_NAMES.length] + ' ' + ln,
          cnic,
          ownerType: 'O',
          status: 'Active',
          filer: i % 3 === 0 ? 'Non-Filer' : 'Filer',
          phone: '+92 3' + String(10 + (i % 40)) + ' ' + String(1000000 + i * 7621).slice(0, 7),
          bank: ['HBL', 'Meezan Bank', 'MCB', 'UBL', 'National Bank of Pakistan', 'Bank Alfalah'][i % 6],
          iban: 'PK' + String(20 + (i % 70)) + 'MEZN' + String(1e15 + i * 3721).slice(0, 16),
          address: u.name + ', ' + (typeof provName === 'function' ? provName(pj.province) : pj.province),
          shares: [{ surveyId: sId, share: 100, ref: 'Form VII-B / Aks Shajra' }],
          createdAt: fNowStr(),
          createdBy: 'admin',
          history: []
        };
        extraOwners.push(lo);

        // Leases
        if (i % 2 === 0) {
          const lseId = 'else_' + uid();
          const rate = 45000 + (i % 20) * 2000;
          extraLeases.push({
            id: lseId,
            province: pj.province,
            code: 'LSE-' + String(10000 + (state.leases ? state.leases.length : 0) + i),
            projectId: pj.id,
            kind: 'Private Land',
            registrationNo: 'REG/' + pj.projCode + '/' + (100 + i),
            landownerIds: [loId],
            surveyIds: [sId],
            initialArea: area,
            subsequentArea: area,
            startDate: safeDOff(-(10 + i * 15)),
            termYears: 3 + (i % 5),
            ratePerAcre: rate,
            escalation: 10,
            stage: 'Approved',
            autoExtend: 'Yes — extends unless terminated',
            createdAt: fNowStr(),
            createdBy: 'sradmin',
            history: []
          });

          // Payment voucher
          const gross = Math.round(area * rate);
          const whtPct = lo.filer === 'Non-Filer' ? 20 : 10;
          const wht = Math.round(gross * (whtPct / 100));
          extraPayments.push({
            id: 'epy_' + uid(),
            province: pj.province,
            code: 'VCH-' + new Date().getFullYear() + '-' + String(3000 + (state.payments ? state.payments.length : 0) + i),
            projectId: pj.id,
            landownerId: loId,
            category: 'Lease Rent',
            payType: 'Yearly Lease',
            landClass: 'Private',
            mode: 'Cross Cheque',
            periodFrom: safeDOff(-(30 + i * 10)),
            periodTo: safeDOff(335 - i * 10),
            gross,
            whtPct,
            wht,
            net: gross - wht,
            stage: ['Requested', 'Verified', 'Released'][i % 3],
            chequeNo: i % 3 === 2 ? 'SIM-' + (26000000 + i * 17) : '',
            chequeDate: i % 3 === 2 ? safeDOff(-i) : '',
            sapDoc: i % 3 === 2 ? 'SIM-5100' + (400000 + i * 13) : '',
            remarks: 'Annual lease rental payment for Khasra ' + s.surveyNo,
            createdAt: fNowStr(),
            createdBy: 'finance',
            history: []
          });
        }
      }

      state.surveys.push(...extraSurveys);
      state.landowners.push(...extraOwners);
      state.leases.push(...extraLeases);
      state.payments.push(...extraPayments);
      addedCount += extraSurveys.length + extraOwners.length + extraLeases.length + extraPayments.length;
    }
  }

  // 3. Follow-up Reminders
  if (genReminders) {
    const sampleReminders = [
      { id: 'rem_' + uid(), title: 'Lease Renewal Due: Dharki Well Location 01 Khasra 579', recordType: 'leases', recordId: 'ls_001', recordCode: 'LSE-000001', dueDate: safeDOff(3), dueTime: '10:00', priority: 'Critical', assigneeRole: 'Land Manager', status: 'Pending', notes: 'Prepare escalation calculation (10%) and coordinate with Mukhtiarkar.', createdAt: fNowStr() },
      { id: 'rem_' + uid(), title: 'DBPFC State Land Rate Fixation Meeting with DC Ghotki', recordType: 'dbpfc', recordId: 'db_001', recordCode: 'DBP-000001', dueDate: safeDOff(6), dueTime: '11:30', priority: 'High', assigneeRole: 'Land Manager', status: 'Pending', notes: 'Present Mari Gas pipeline corridor valuation benchmarks.', createdAt: fNowStr() },
      { id: 'rem_' + uid(), title: 'Disburse Compensation Cheques for Pipeline ROW Khanpur', recordType: 'payments', recordId: 'pay_001', recordCode: 'PAY-000001', dueDate: safeDOff(10), dueTime: '14:00', priority: 'High', assigneeRole: 'Accounts Officer', status: 'Pending', notes: 'Verified cross-cheques ready at Daharki field office.', createdAt: fNowStr() },
      { id: 'rem_' + uid(), title: 'Survey Verification: Kiriri-02 Access Road widening', recordType: 'surveys', recordId: 'srv_001', recordCode: 'SRV-000001', dueDate: safeDOff(14), dueTime: '09:00', priority: 'Medium', assigneeRole: 'Field Officer', status: 'Pending', notes: 'Field surveyor to confirm khasra boundary markers.', createdAt: fNowStr() },
      { id: 'rem_' + uid(), title: 'Quarterly Audit Review of Land Lease Register & WHT Filings', recordType: 'leases', recordId: 'ls_002', recordCode: 'LSE-000002', dueDate: safeDOff(21), dueTime: '15:00', priority: 'Low', assigneeRole: 'Compliance Officer', status: 'Pending', notes: 'Verify FBR WHT challans against SAP payment entries.', createdAt: fNowStr() }
    ];
    saveCustomFollowUps(sampleReminders);
  }

  // 4. Field Sticky Notes
  if (genNotes) {
    const sampleNotes = [
      {
        id: 'sn_' + uid(),
        title: 'Field Inspection Checklist · Daharki-01',
        content: 'Field surveyor observation for wellhead perimeter fence.',
        color: 'yellow',
        tag: 'Verification',
        screen: 'dashboard',
        recordType: null,
        recordId: null,
        recordCode: null,
        pinned: true,
        checklist: [
          { text: 'Verify khasra pillar boundaries', done: true },
          { text: 'Inspect standing crop damage assessment', done: true },
          { text: 'Obtain signature on Form VII-B from Landowner', done: false },
          { text: 'Submit verified compensation case to Head Office', done: false }
        ],
        createdAt: fNowStr(),
        createdBy: 'Field Officer'
      },
      {
        id: 'sn_' + uid(),
        title: 'Sindh Board of Revenue DBPFC Protocol',
        content: 'DBPFC meeting quorum requires DC (Chair), District Revenue Officer, Mari Manager Land, AC relevant Taluka.',
        color: 'mint',
        tag: 'General',
        screen: 'dbpfc',
        recordType: null,
        recordId: null,
        recordCode: null,
        pinned: false,
        checklist: [],
        createdAt: fNowStr(),
        createdBy: 'Land Manager'
      },
      {
        id: 'sn_' + uid(),
        title: 'Heir Succession: Haji Allah Dino Mallah',
        content: 'Deceased owner legal heir succession decree in civil court Badin. Hold rental voucher release until succession certificate verified.',
        color: 'lavender',
        tag: 'Legal',
        screen: 'landowners',
        recordType: null,
        recordId: null,
        recordCode: null,
        pinned: false,
        checklist: [],
        createdAt: fNowStr(),
        createdBy: 'Legal Counsel'
      }
    ];
    saveStickyNotes(sampleNotes);
  }

  if (typeof clearCache === 'function') clearCache();
  if (typeof persist === 'function') persist();
  if (typeof audit === 'function') audit('system', { code: 'SAMPLE-DATA' }, 'Sample data generator executed (' + preset + ' dataset)');

  closeSampleDataModal();
  if (typeof toast === 'function') toast('Sample dataset generated successfully (' + addedCount + ' operational records ready).', 'success');
  if (typeof render === 'function') render();
}

/* Keyboard shortcuts listener */
document.addEventListener('keydown', e => {
  const tag = (e.target && e.target.tagName) || '';
  const isInput = /^(INPUT|TEXTAREA|SELECT)$/.test(tag) || (e.target && e.target.isContentEditable);
  const searchModal = document.getElementById('globalSearchModal');
  const searchOpen = searchModal && !searchModal.classList.contains('hidden');

  // Handle keys while global search palette is active
  if (searchOpen) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveSearchSelection(1);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveSearchSelection(-1);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      activateSearchSelection();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closeGlobalSearch();
      return;
    }
  }

  // Hotkey /: open search if not typing
  if (!isInput && e.key === '/') {
    e.preventDefault();
    openGlobalSearch();
    return;
  }

  // Hotkey Ctrl+K / Cmd+K
  if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
    e.preventDefault();
    openGlobalSearch();
    return;
  }

  if (!isInput && e.key === '?') {
    e.preventDefault();
    openShortcutsModal();
    return;
  }

  if (e.altKey) {
    if (e.key === 'n' || e.key === 'N') {
      e.preventDefault();
      toggleStickyDock();
    } else if (e.key === 'r' || e.key === 'R') {
      e.preventDefault();
      openFollowUps('pending');
    } else if (e.key === 'c' || e.key === 'C') {
      e.preventDefault();
      if (typeof pageUrl === 'function') location.href = pageUrl('calendar');
    } else if (e.key === 'a' || e.key === 'A') {
      e.preventDefault();
      openA11yModal();
    } else if (e.key === 'u' || e.key === 'U') {
      e.preventDefault();
      if (typeof openConverter === 'function') openConverter();
    } else if (e.key === 't' || e.key === 'T') {
      e.preventDefault();
      if (typeof toggleTheme === 'function') toggleTheme();
    }
  }

  if (e.key === 'Escape') {
    if (searchOpen) {
      closeGlobalSearch();
      return;
    }
    const dock = document.getElementById('stickyDock');
    if (dock && dock.classList.contains('open')) {
      toggleStickyDock();
      return;
    }
    ['a11yModal', 'shortcutsModal', 'remindersModal', 'addReminderModal', 'addStickyModal', 'sampleDataModal'].forEach(id => {
      const m = document.getElementById(id);
      if (m && !m.classList.contains('hidden')) closeAppModal(id);
    });
  }
});

/* Search input live handler */
document.addEventListener('input', e => {
  if (e.target && e.target.id === 'globalSearchInput') {
    renderGlobalSearchResults(e.target.value.trim());
  }
});

/* Search modal backdrop click handler */
document.addEventListener('click', e => {
  const m = document.getElementById('globalSearchModal');
  if (m && !m.classList.contains('hidden') && e.target === m) {
    closeGlobalSearch();
  }
});

/* Initialize on script load */
function initFeatures() {
  applyA11yPrefs();
  ensureStickyDock();
  ensureTopbarButtons();
  updateStickyBadge();
  updateReminderBadge();
  renderFloatingNotes();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initFeatures);
} else {
  initFeatures();
}

// Hook render to refresh badges and topbar buttons
if (typeof render === 'function') {
  const _origRender = render;
  window.render = function () {
    const out = _origRender.apply(this, arguments);
    ensureTopbarButtons();
    updateStickyBadge();
    updateReminderBadge();
    renderFloatingNotes();
    return out;
  };
}
