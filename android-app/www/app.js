/* ══════════════════════════════════════════════════════════════════
   ZenCalendar Mobile — app.js
   Fully offline, localStorage-based calendar for Android (Capacitor)
   No external dependencies. All logic self-contained.
   ══════════════════════════════════════════════════════════════════ */

// ── Capacitor Plugin References ──────────────────────────────────
const hasCapacitor = typeof window.Capacitor !== 'undefined';
const Plugins = hasCapacitor ? window.Capacitor.Plugins : {};
const Filesystem = Plugins.Filesystem;
const LocalNotifications = Plugins.LocalNotifications;
const Share = Plugins.Share;

// ── Constants ────────────────────────────────────────────────────
const COLORS = [
  '#ef4444','#f97316','#eab308','#22c55e',
  '#06b6d4','#7c3aed','#ec4899','#64748b'
];
const MONTHS    = ['January','February','March','April','May','June',
                   'July','August','September','October','November','December'];
const DAYS_FULL = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

// ── Tracker Configuration (extensible) ───────────────────────────
// To add a new tracker: push a new object into TRACKER_CONFIG.trackers
// Supported types: 'counter' (numeric reps) | 'checklist' (checkbox list)
const TRACKER_CONFIG = {
  defaultMode: 'normal', // 'normal' | 'tracking'
  trackers: [
    {
      id: 'exercises',
      name: 'Exercises',
      icon: '💪',
      type: 'counter',
      unit: 'reps',
      target: 20,
      defaultValue: 0
    },
    {
      id: 'minimum_daily',
      name: 'Minimum Daily',
      icon: '✅',
      type: 'checklist',
      defaultItems: [
        'Drink water',
        'Eat a meal',
        '10-minute stretch',
        'Get some fresh air'
      ]
    }
  ]
};

// ── Helpers ──────────────────────────────────────────────────────
const pad      = n => String(n).padStart(2,'0');
const isSameDay = (a,b) =>
  a.getFullYear()===b.getFullYear() &&
  a.getMonth()===b.getMonth() &&
  a.getDate()===b.getDate();

function toLocalDT(d) {
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fmtTime(d) {
  let h=d.getHours(), m=pad(d.getMinutes()), ap=h>=12?'PM':'AM';
  h = h%12 || 12;
  return `${h}:${m} ${ap}`;
}
function uid() { return Math.random().toString(36).slice(2,11)+Date.now().toString(36); }
function esc(s) { const d=document.createElement('div'); d.textContent=s; return d.innerHTML; }

/** Consistent 32-bit positive integer hash of alphanumeric string for local notifications */
function stringToHash32(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return Math.abs(hash & 0x7FFFFFFF);
}

/** Return 42 Date objects covering the month grid (6×7) */
function getMonthDays(date) {
  const y=date.getFullYear(), m=date.getMonth();
  const startDay = new Date(y,m,1).getDay();
  const days=[];
  for(let i=0;i<42;i++) days.push(new Date(y,m,1-startDay+i));
  return days;
}

function getWeekDays(date) {
  const d = new Date(date);
  d.setDate(d.getDate() - d.getDay());
  const days = [];
  for (let i = 0; i < 7; i++) {
    days.push(new Date(d));
    d.setDate(d.getDate() + 1);
  }
  return days;
}

// ── LocalStorage Persistence ──────────────────────────────────────
const STORAGE_KEY = 'zencalendar_v2';
const DEFAULT_SETTINGS = {
  activeTab: 'calendar',
  theme: 'dark',
  remindersEnabled: true,
  reminderOffset: '15',
  calendarView: 'month',
  dailyReminderEnabled: false
};
const DEFAULT_DATA = { events:[], tasks:[], notes:[], tracking:{}, settings: { ...DEFAULT_SETTINGS } };

function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : { ...DEFAULT_DATA };
    parsed.settings = { ...DEFAULT_SETTINGS, ...parsed.settings };
    parsed.notes    = parsed.notes    || [];
    parsed.tracking = parsed.tracking || {};
    return parsed;
  } catch { return { ...DEFAULT_DATA }; }
}

function saveData() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    events:   state.events,
    tasks:    state.tasks,
    notes:    state.notes,
    tracking: state.tracking,
    settings: state.settings
  }));
}

// ── Application State ─────────────────────────────────────────────
const state = {
  events:       [],
  tasks:        [],
  notes:        [],
  tracking:     {},   // keyed by 'YYYY-MM-DD'
  mode:         'normal', // 'normal' | 'tracking'
  currentDate:  new Date(),
  activeTab:    'calendar',
  selectedDay:  null,
  selectedEvent: null,
  settings:     { ...DEFAULT_SETTINGS }
};

// ── DOM Shorthand ─────────────────────────────────────────────────
const $  = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

// ══════════════════════════════════════════════════════════════════
//  INITIALISATION
// ══════════════════════════════════════════════════════════════════
async function init() {
  const data = loadData();
  state.events   = (data.events   || []);
  state.tasks    = (data.tasks    || []);
  state.notes    = (data.notes    || []);
  state.tracking = (data.tracking || {});
  state.settings = data.settings;
  state.activeTab = state.settings.activeTab;

  applyActiveTab();
  applyTheme();
  initSettingsUI();
  bindEvents();
  bindTrackingEvents();
  bindNoteEvents();
  bindNotesTabEvents();

  // Listen to system theme preference changes
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (state.settings.theme === 'system') applyTheme();
  });

  // Query permissions on startup
  updatePermissionStatus();

  render();
}

// ══════════════════════════════════════════════════════════════════
//  EVENT BINDINGS
// ══════════════════════════════════════════════════════════════════
function bindEvents() {
  // Header navigation
  $('#btn-prev').onclick  = () => nav(-1);
  $('#btn-next').onclick  = () => nav(1);
  $('#btn-today').onclick = () => { state.currentDate = new Date(); render(); };
  $('#btn-settings').onclick = openSettings;

  // Mode toggle (Normal ↔ Tracking)
  $('#btn-mode-toggle').onclick = toggleMode;

  // Bottom navigation tabs
  $$('.nav-tab').forEach(btn => {
    btn.onclick = () => switchTab(btn.dataset.tab);
  });

  // FAB — opens type picker
  $('#fab-add').onclick = openTypePicker;

  // Month / Week View Toggle
  $('#btn-toggle-month').onclick = () => {
    if (state.mode === 'tracking') return; // ignore when in tracking mode
    state.settings.calendarView = 'month';
    $$('.view-toggle-btn').forEach(btn => btn.classList.remove('active'));
    $('#btn-toggle-month').classList.add('active');
    render();
  };
  $('#btn-toggle-week').onclick = () => {
    if (state.mode === 'tracking') return;
    state.settings.calendarView = 'week';
    $$('.view-toggle-btn').forEach(btn => btn.classList.remove('active'));
    $('#btn-toggle-week').classList.add('active');
    render();
  };

  // ── Tracker Modal Bottom Sheet ─────────────────────────────────
  const mTracker = $('#modal-tracker-overlay');
  if (mTracker) {
    $('#modal-tracker-backdrop').onclick = closeTrackerModal;
    $('#modal-tracker-close').onclick    = closeTrackerModal;
    $('#btn-tracker-discard').onclick    = closeTrackerModal;
    $('#tracker-config-form').onsubmit   = handleSaveTracker;
    $('#btn-delete-tracker').onclick     = handleDeleteTracker;
    $('#tracker-type-select').onchange   = () => {
      $('#tracker-counter-fields').classList.toggle('hidden', $('#tracker-type-select').value !== 'counter');
    };
  }

  // ── Rest Day Toggle ────────────────────────────────────────────
  const btnRest = $('#btn-toggle-rest');
  if (btnRest) {
    btnRest.onclick = toggleRestDay;
  }

  // ── Day panel ──────────────────────────────────────────────────
  $('#day-panel-backdrop').onclick = closeDayPanel;
  $('#day-panel-close').onclick    = closeDayPanel;
  $('#day-panel-add').onclick = () => {
    closeDayPanel();
    openEventModal(null, state.selectedDay);
  };
  $('#btn-day-notes-add').onclick = () => {
    closeDayPanel();
    openNoteModal(null, state.selectedDay);
  };

  // ── Type picker ────────────────────────────────────────────────
  $('#type-picker-backdrop').onclick = closeTypePicker;
  $('#btn-pick-close').onclick        = closeTypePicker;
  $('#pick-event-btn').onclick = () => { closeTypePicker(); openEventModal(null); };
  $('#pick-task-btn').onclick  = () => { closeTypePicker(); openTaskModal();      };
  $('#pick-note-btn').onclick  = () => { closeTypePicker(); openNoteModal(null);  };

  // ── Event modal ────────────────────────────────────────────────
  $('#event-modal-backdrop').onclick = closeEventModal;
  $('#btn-event-close').onclick      = closeEventModal;
  $('#btn-event-discard').onclick    = closeEventModal;
  $('#event-form').onsubmit          = handleSaveEvent;
  $('#btn-event-delete').onclick     = handleDeleteEvent;

  // ── Task modal ─────────────────────────────────────────────────
  $('#task-modal-backdrop').onclick = closeTaskModal;
  $('#btn-task-close').onclick      = closeTaskModal;
  $('#btn-task-discard').onclick    = closeTaskModal;
  $('#task-form').onsubmit          = handleSaveTask;

  // ── Event detail sheet ─────────────────────────────────────────
  $('#detail-backdrop').onclick    = closeDetailSheet;
  $('#detail-close-btn').onclick   = closeDetailSheet;
  $('#detail-edit-btn').onclick    = () => {
    closeDetailSheet();
    openEventModal(state.selectedEvent);
  };
  $('#detail-delete-btn').onclick  = () => {
    if (!state.selectedEvent) return;
    state.events = state.events.filter(e => e.id !== state.selectedEvent.id);
    state.selectedEvent = null;
    closeDetailSheet();
    render();
  };

  // ── Quick add task (inline input) ──────────────────────────────
  const qi = $('#quick-add-input');
  const doQuickAdd = () => {
    const val = qi.value.trim();
    if (!val) return;
    state.tasks.push({ id:uid(), title:val, completed:false, dueDate:null });
    qi.value = '';
    render();
  };
  qi.addEventListener('keydown', e => { if (e.key==='Enter') doQuickAdd(); });
  $('#quick-add-btn').onclick = doQuickAdd;
}

// ══════════════════════════════════════════════════════════════════
//  NAVIGATION & TAB SWITCHING
// ══════════════════════════════════════════════════════════════════
function nav(dir) {
  const d = state.currentDate;
  if (state.mode === 'tracking') {
    state.currentDate = new Date(d.getFullYear(), d.getMonth(), d.getDate() + dir);
  } else if (state.settings.calendarView === 'week') {
    state.currentDate = new Date(d.getFullYear(), d.getMonth(), d.getDate() + dir * 7);
  } else {
    state.currentDate = new Date(d.getFullYear(), d.getMonth()+dir, 1);
  }
  render();
}

function switchTab(tab) {
  state.activeTab = tab;
  applyActiveTab();
  render();
}

function applyActiveTab() {
  $$('.tab-panel').forEach(p => p.classList.toggle('active', p.id===`tab-${state.activeTab}`));
  $$('.nav-tab').forEach(b  => b.classList.toggle('active', b.dataset.tab===state.activeTab));
}

// ══════════════════════════════════════════════════════════════════
//  RENDER
// ══════════════════════════════════════════════════════════════════
function render() {
  renderHeader();

  const isTracking = state.mode === 'tracking';
  const isWeek = state.settings.calendarView === 'week';

  // Toggle tracking button appearance
  $('#btn-mode-toggle').classList.toggle('active', isTracking);

  // Show/hide calendar views vs tracking view
  if (isTracking) {
    $('#month-view-container').classList.add('hidden');
    $('#week-view').classList.add('hidden');
    $('#tracking-view').style.display = 'flex';
    $('#tracking-view').classList.remove('hidden');
    $('.view-toggle-row') && ($('.view-toggle-row').style.display = 'none');
    renderTrackingView();
  } else {
    $('#tracking-view').style.display = 'none';
    $('#tracking-view').classList.add('hidden');
    if ($('.view-toggle-row')) $('.view-toggle-row').style.display = '';

    $('#btn-toggle-month').classList.toggle('active', !isWeek);
    $('#btn-toggle-week').classList.toggle('active', isWeek);

    if (isWeek) {
      $('#month-view-container').classList.add('hidden');
      $('#week-view').classList.remove('hidden');
      renderWeekGrid();
    } else {
      $('#month-view-container').classList.remove('hidden');
      $('#week-view').classList.add('hidden');
      renderMonthGrid();
    }
  }

  renderTasks();
  renderFocus();
  renderNotes();
  renderNotesCount();
  saveData();
}

/** Header: month + year label */
function renderHeader() {
  if (state.mode === 'tracking') {
    $('#date-label').textContent = 'Daily Tracker';
    return;
  }
  if (state.settings.calendarView === 'week') {
    const days = getWeekDays(state.currentDate);
    const startOfWeek = days[0];
    const endOfWeek = days[6];
    if (startOfWeek.getMonth() === endOfWeek.getMonth()) {
      $('#date-label').textContent = `${MONTHS[startOfWeek.getMonth()]} ${startOfWeek.getFullYear()}`;
    } else {
      $('#date-label').textContent = `${MONTHS[startOfWeek.getMonth()].slice(0,3)} – ${MONTHS[endOfWeek.getMonth()].slice(0,3)} ${endOfWeek.getFullYear()}`;
    }
  } else {
    $('#date-label').textContent =
      `${MONTHS[state.currentDate.getMonth()]} ${state.currentDate.getFullYear()}`;
  }
}

/** Month calendar grid with event dots */
function renderMonthGrid() {
  const grid  = $('#month-grid');
  grid.innerHTML = '';
  const days  = getMonthDays(state.currentDate);
  const today = new Date();
  const m     = state.currentDate.getMonth();

  days.forEach(day => {
    const cell = document.createElement('div');
    cell.className = 'month-cell';
    if (day.getMonth() !== m) cell.classList.add('other-month');

    // ── Day number ──
    const numWrap = document.createElement('div');
    numWrap.className = 'cell-num-wrap';
    const num = document.createElement('span');
    num.className = 'cell-num';
    num.textContent = day.getDate();
    if (isSameDay(day, today)) num.classList.add('today');
    else if (state.selectedDay && isSameDay(day, state.selectedDay)) num.classList.add('selected');
    numWrap.appendChild(num);
    cell.appendChild(numWrap);

    // ── Event dots ──
    const evs  = state.events.filter(e => isSameDay(new Date(e.start), day));
    const tsks = state.tasks.filter(t => t.dueDate && !t.completed && isSameDay(new Date(t.dueDate), day));
    const all  = [...evs, ...tsks.map(t => ({ color:'#64748b' }))];

    if (all.length > 0) {
      const dots = document.createElement('div');
      dots.className = 'event-dots';
      all.slice(0,3).forEach(item => {
        const dot = document.createElement('span');
        dot.className = 'event-dot';
        dot.style.background = item.color || COLORS[5];
        dots.appendChild(dot);
      });
      if (all.length > 3) {
        const extra = document.createElement('span');
        extra.className = 'event-dot more';
        dots.appendChild(extra);
      }
      cell.appendChild(dots);
    }

    cell.onclick = () => {
      state.selectedDay = day;
      renderMonthGrid();   // update selected highlight
      openDayPanel(day);
    };

    grid.appendChild(cell);
  });
}

/** Week calendar view time-grid with scroll and events positioning */
function renderWeekGrid() {
  const days = getWeekDays(state.currentDate);
  const today = new Date();

  // 1. Render Day Header Labels
  const header = $('#week-day-header');
  header.innerHTML = '<div class="wk-gutter-spacer"></div>';
  days.forEach(day => {
    const colLbl = document.createElement('div');
    colLbl.className = 'week-day-col-label' + (isSameDay(day, today) ? ' is-today' : '');
    colLbl.innerHTML = `
      <span class="wk-dow">${DAYS_FULL[day.getDay()].slice(0,3)}</span>
      <span class="wk-date">${day.getDate()}</span>
    `;
    colLbl.onclick = () => {
      state.selectedDay = day;
      openDayPanel(day);
    };
    header.appendChild(colLbl);
  });

  // 2. Render Hour labels in gutter
  const gutter = $('#week-time-gutter');
  gutter.innerHTML = '';
  for (let h = 0; h < 24; h++) {
    const lbl = document.createElement('div');
    lbl.className = 'wk-hour-label';
    let hr = h % 12 || 12;
    let ap = h >= 12 ? 'PM' : 'AM';
    lbl.textContent = `${hr} ${ap}`;
    gutter.appendChild(lbl);
  }

  // 3. Render Columns
  const colsWrap = $('#week-columns-wrap');
  colsWrap.innerHTML = '';
  days.forEach(day => {
    const col = document.createElement('div');
    col.className = 'week-col';
    for (let h = 0; h < 24; h++) {
      const slot = document.createElement('div');
      slot.className = 'week-hour-slot';
      col.appendChild(slot);
    }

    // Filter events for this day
    const dayEvts = state.events.filter(e => isSameDay(new Date(e.start), day));
    dayEvts.forEach(ev => {
      const s = new Date(ev.start);
      const e = new Date(ev.end);
      const top = s.getHours() * 56 + (s.getMinutes() / 60) * 56;
      const height = Math.max(20, ((e - s) / 60000) / 60 * 56);

      const block = document.createElement('div');
      block.className = 'week-event-block';
      block.style.top = `${top}px`;
      block.style.height = `${height}px`;
      block.style.background = ev.color || COLORS[5];
      block.innerHTML = `
        <div class="week-event-title">${esc(ev.title)}</div>
        <div class="week-event-time">${fmtTime(s)}</div>
      `;
      block.onclick = (event) => {
        event.stopPropagation();
        state.selectedEvent = ev;
        openDetailSheet(ev);
      };
      col.appendChild(block);
    });

    // Now indicator line
    if (isSameDay(day, today)) {
      const line = document.createElement('div');
      line.className = 'week-now-line';
      const mins = today.getHours() * 60 + today.getMinutes();
      line.style.top = `${(mins / 60) * 56}px`;
      col.appendChild(line);
    }

    // Tap column background -> open Day Panel
    col.onclick = () => {
      state.selectedDay = day;
      openDayPanel(day);
    };

    colsWrap.appendChild(col);
  });

  // 4. Scroll to current hour (once on layout)
  const scroller = $('.week-time-scroll');
  if (scroller) {
    scroller.scrollTop = Math.max(0, (today.getHours() - 1) * 56);
  }
}

/** Task list with completion toggle and delete */
function renderTasks() {
  const list = $('#task-list');
  list.innerHTML = '';
  const pending = state.tasks.filter(t => !t.completed).length;
  $('#task-count-badge').textContent = pending;

  if (state.tasks.length === 0) {
    list.innerHTML = `<div class="empty-tasks">
      <div class="empty-icon">✓</div>
      <p>No tasks yet.<br>Tap <strong>+</strong> to add one!</p>
    </div>`;
    return;
  }

  // Sort: incomplete → by due date; completed last
  const sorted = [...state.tasks].sort((a,b) => {
    if (a.completed !== b.completed) return a.completed ? 1 : -1;
    if (a.dueDate && b.dueDate) return new Date(a.dueDate)-new Date(b.dueDate);
    if (a.dueDate) return -1;
    if (b.dueDate) return 1;
    return 0;
  });

  sorted.forEach(task => {
    const item = document.createElement('div');
    item.className = 'task-item' + (task.completed ? ' completed' : '');

    // Checkbox button
    const cb = document.createElement('button');
    cb.className = 'task-check' + (task.completed ? ' checked' : '');
    cb.setAttribute('aria-label', task.completed ? 'Mark incomplete' : 'Mark complete');
    cb.innerHTML = task.completed
      ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`
      : '';
    cb.onclick = () => { task.completed = !task.completed; render(); };

    // Content
    const content = document.createElement('div');
    content.className = 'task-content';
    const titleEl = document.createElement('span');
    titleEl.className = 'task-title';
    titleEl.textContent = task.title;
    content.appendChild(titleEl);
    if (task.dueDate && !task.completed) {
      const due = document.createElement('span');
      due.className = 'task-due';
      const dd = new Date(task.dueDate);
      due.textContent = `${MONTHS[dd.getMonth()].slice(0,3)} ${dd.getDate()} · ${fmtTime(dd)}`;
      content.appendChild(due);
    }

    // Delete button
    const del = document.createElement('button');
    del.className = 'task-delete';
    del.setAttribute('aria-label', 'Delete task');
    del.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
    del.onclick = e => {
      e.stopPropagation();
      state.tasks = state.tasks.filter(t => t.id !== task.id);
      render();
    };

    item.append(cb, content, del);
    list.appendChild(item);
  });
}

/** Circular SVG focus ring + stats */
function renderFocus() {
  const total = state.tasks.length;
  const done  = state.tasks.filter(t => t.completed).length;
  const pct   = total ? Math.round(done/total*100) : 0;

  $('#focus-pct').textContent  = pct + '%';
  $('#stat-done').textContent  = done;
  $('#stat-left').textContent  = total - done;

  const circumference = 2 * Math.PI * 50;            // r=50 → 314.16
  const offset = circumference - (pct/100) * circumference;
  const ring = $('#focus-ring-fill');
  if (ring) ring.style.strokeDashoffset = offset;
}

// ══════════════════════════════════════════════════════════════════
//  DAY PANEL
// ══════════════════════════════════════════════════════════════════
function openDayPanel(day) {
  state.selectedDay = day;
  $('#day-panel-weekday').textContent = DAYS_FULL[day.getDay()];
  $('#day-panel-date').textContent =
    `${MONTHS[day.getMonth()]} ${day.getDate()}, ${day.getFullYear()}`;
  renderDayEvents(day);
  renderDayTasks(day);
  renderDayNotes(day);
  showOverlay('#day-panel-overlay');
}

function closeDayPanel() {
  hideOverlay('#day-panel-overlay');
}

function renderDayEvents(day) {
  const list    = $('#day-events-list');
  list.innerHTML = '';

  const dayEvts = state.events
    .filter(e => isSameDay(new Date(e.start), day))
    .sort((a,b) => new Date(a.start)-new Date(b.start));

  if (!dayEvts.length) {
    list.innerHTML = `<div class="day-empty">
      <p>Nothing scheduled.</p>
      <p class="day-empty-hint">Tap <strong>+</strong> to add an event.</p>
    </div>`;
    return;
  }

  const h = document.createElement('div');
  h.className = 'day-section-header';
  h.textContent = 'Events';
  list.appendChild(h);

  dayEvts.forEach(ev => {
    const item = document.createElement('div');
    item.className = 'day-event-item';
    item.innerHTML = `
      <div class="day-event-color" style="background:${ev.color||COLORS[5]}"></div>
      <div class="day-event-info">
        <div class="day-event-title">${esc(ev.title)}</div>
        <div class="day-event-time">${fmtTime(new Date(ev.start))} – ${fmtTime(new Date(ev.end))}</div>
        ${ev.description ? `<div class="day-event-desc">${esc(ev.description)}</div>` : ''}
      </div>
      <button class="day-event-edit" aria-label="Edit event">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
        </svg>
      </button>`;

    // Edit button
    item.querySelector('.day-event-edit').onclick = e => {
      e.stopPropagation();
      closeDayPanel();
      openEventModal(ev);
    };
    // Tap whole row → detail sheet
    item.onclick = () => {
      closeDayPanel();
      state.selectedEvent = ev;
      openDetailSheet(ev);
    };
    list.appendChild(item);
  });
}

function renderDayTasks(day) {
  const tasksList = $('#day-tasks-list');
  tasksList.innerHTML = '';
  const dayTasks = state.tasks.filter(t => t.dueDate && isSameDay(new Date(t.dueDate), day));
  if (dayTasks.length === 0) {
    tasksList.innerHTML = '<div style="font-size:12px;color:var(--text-3);padding:4px 0;">No tasks for this day.</div>';
    return;
  }
  dayTasks.forEach(task => {
    const item = document.createElement('div');
    item.className = 'day-task-check-item';
    
    const cb = document.createElement('button');
    cb.className = 'day-task-check-btn' + (task.completed ? ' done' : '');
    cb.innerHTML = task.completed
      ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`
      : '';
    cb.onclick = () => {
      task.completed = !task.completed;
      cb.classList.toggle('done', task.completed);
      cb.innerHTML = task.completed
        ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`
        : '';
      lbl.classList.toggle('done', task.completed);
      render();
    };

    const lbl = document.createElement('span');
    lbl.className = 'day-task-check-label' + (task.completed ? ' done' : '');
    lbl.textContent = task.title;

    item.append(cb, lbl);
    tasksList.appendChild(item);
  });
}

function renderDayNotes(day) {
  const notesList = $('#day-notes-list');
  notesList.innerHTML = '';
  const dayNotes = state.notes
    .filter(n => n.linkedDate && isSameDay(new Date(n.linkedDate), day))
    .sort((a,b) => (b.pinned?1:0)-(a.pinned?1:0));

  if (dayNotes.length === 0) {
    notesList.innerHTML = '<div class="day-notes-empty">No notes for this day.</div>';
    return;
  }

  dayNotes.forEach(note => {
    const item = document.createElement('div');
    item.className = 'day-note-item' + (note.pinned ? ' pinned' : '');
    const preview = note.type === 'checklist'
      ? `${(note.checklistItems||[]).length} checklist items`
      : (note.content || '').slice(0, 60);
    const progress = note.type !== 'text' && (note.checklistItems||[]).length > 0
      ? `<div class="day-note-item-progress">${(note.checklistItems||[]).filter(i=>i.done).length}/${(note.checklistItems||[]).length} done</div>`
      : '';
    item.innerHTML = `
      <div class="day-note-item-title">${note.pinned?'📌 ':''}${esc(note.title)}</div>
      ${preview ? `<div class="day-note-item-preview">${esc(preview)}</div>` : ''}
      ${progress}
    `;
    item.onclick = () => {
      closeDayPanel();
      openNoteModal(note);
    };
    notesList.appendChild(item);
  });
}

// ══════════════════════════════════════════════════════════════════
//  TYPE PICKER
// ══════════════════════════════════════════════════════════════════
function openTypePicker()  { showOverlay('#type-picker-overlay'); }
function closeTypePicker() { hideOverlay('#type-picker-overlay'); }

// ══════════════════════════════════════════════════════════════════
//  EVENT MODAL
// ══════════════════════════════════════════════════════════════════
function openEventModal(ev, prefillDay) {
  state.selectedEvent = ev;

  $('#event-modal-heading').textContent = ev ? 'Edit Event' : 'New Event';
  $('#event-id').value           = ev ? ev.id  : '';
  $('#event-title-input').value  = ev ? ev.title : '';
  $('#event-notes').value        = ev ? (ev.description || '') : '';
  $('#event-recurrence').value   = ev ? (ev.recurrence || 'none') : 'none';

  // Default date = prefill or selected day or today
  const ref = prefillDay || state.selectedDay || state.currentDate;
  const refDay = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate());

  $('#event-start').value = ev
    ? toLocalDT(new Date(ev.start))
    : toLocalDT(new Date(refDay.getTime() + 9*3600000));   // 09:00
  $('#event-end').value = ev
    ? toLocalDT(new Date(ev.end))
    : toLocalDT(new Date(refDay.getTime() + 10*3600000));  // 10:00

  // Colour swatches
  const cp = $('#color-picker');
  cp.innerHTML = '';
  const sel = ev ? ev.color : COLORS[5];
  COLORS.forEach(c => {
    const sw = document.createElement('button');
    sw.type = 'button';
    sw.className = 'color-swatch' + (c===sel ? ' active' : '');
    sw.style.backgroundColor = c;
    sw.dataset.color = c;
    sw.onclick = () => { $$('.color-swatch').forEach(s => s.classList.remove('active')); sw.classList.add('active'); };
    cp.appendChild(sw);
  });

  $('#btn-event-delete').classList.toggle('hidden', !ev);

  showOverlay('#event-modal-overlay');
  setTimeout(() => $('#event-title-input').focus(), 380);
}

function closeEventModal() { hideOverlay('#event-modal-overlay'); }

async function handleSaveEvent(e) {
  e.preventDefault();
  const id         = $('#event-id').value;
  const title      = $('#event-title-input').value.trim();
  if (!title) return;

  const color      = $('.color-swatch.active')?.dataset.color || COLORS[5];
  const recurrence = $('#event-recurrence').value || 'none';
  const startVal   = $('#event-start').value;
  const endVal     = $('#event-end').value;

  if (!startVal || !endVal) return;

  const baseEvent = {
    id:          id || uid(),
    title,
    description: $('#event-notes').value.trim(),
    start:       new Date(startVal).toISOString(),
    end:         new Date(endVal).toISOString(),
    color,
    recurrence,
  };

  if (id) {
    // Update existing event
    state.events = state.events.map(ev => ev.id === id ? baseEvent : ev);
    await scheduleAlarmForEvent(baseEvent);
  } else {
    // Create new with recurrence expansion
    const limitMap = { none:1, daily:365, weekly:52, monthly:12, yearly:5 };
    const limit    = limitMap[recurrence] || 1;
    const startDt  = new Date(baseEvent.start);
    const duration = new Date(baseEvent.end).getTime() - startDt.getTime();
    const recId    = recurrence !== 'none' ? uid() : null;

    for (let i=0; i<limit; i++) {
      const instStart = new Date(startDt);
      if      (recurrence==='daily')   instStart.setDate(startDt.getDate() + i);
      else if (recurrence==='weekly')  instStart.setDate(startDt.getDate() + i*7);
      else if (recurrence==='monthly') instStart.setMonth(startDt.getMonth() + i);
      else if (recurrence==='yearly')  instStart.setFullYear(startDt.getFullYear() + i);

      const instEvent = {
        ...baseEvent,
        id:    uid(),
        start: instStart.toISOString(),
        end:   new Date(instStart.getTime() + duration).toISOString(),
        ...(recId ? { recurrenceId: recId } : {}),
      };
      state.events.push(instEvent);
      await scheduleAlarmForEvent(instEvent);
    }
  }

  state.selectedEvent = null;
  closeEventModal();
  render();
}

async function handleDeleteEvent() {
  const id = $('#event-id').value;
  if (!id) return;
  
  // Find event and cancel alarm
  const ev = state.events.find(e => e.id === id);
  if (ev) await cancelAlarmForEvent(ev);

  state.events = state.events.filter(e => e.id !== id);
  state.selectedEvent = null;
  closeEventModal();
  render();
}

// ══════════════════════════════════════════════════════════════════
//  TASK MODAL
// ══════════════════════════════════════════════════════════════════
function openTaskModal(prefillDay) {
  $('#task-id').value          = '';
  $('#task-title-input').value = '';
  if (prefillDay) {
    $('#task-due').value = toLocalDT(new Date(
      prefillDay.getFullYear(), prefillDay.getMonth(), prefillDay.getDate(), 9, 0));
  } else {
    $('#task-due').value = '';
  }
  showOverlay('#task-modal-overlay');
  setTimeout(() => $('#task-title-input').focus(), 380);
}

function closeTaskModal() { hideOverlay('#task-modal-overlay'); }

function handleSaveTask(e) {
  e.preventDefault();
  const title = $('#task-title-input').value.trim();
  if (!title) return;
  const dt = $('#task-due').value;
  const task = {
    id:        $('#task-id').value || uid(),
    title,
    completed: false,
    dueDate:   dt ? new Date(dt).toISOString() : null,
  };
  const existing = $('#task-id').value;
  if (existing) {
    state.tasks = state.tasks.map(t => t.id===existing ? task : t);
  } else {
    state.tasks.push(task);
  }
  closeTaskModal();
  render();
}

// ══════════════════════════════════════════════════════════════════
//  EVENT DETAIL SHEET
// ══════════════════════════════════════════════════════════════════
function openDetailSheet(ev) {
  state.selectedEvent = ev;
  const s = new Date(ev.start);
  const content = $('#detail-content');
  content.innerHTML = `
    <div class="detail-color-bar" style="background:${ev.color||COLORS[5]}"></div>
    <div class="detail-body">
      <h2 class="detail-title">${esc(ev.title)}</h2>
      <div class="detail-time">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
        </svg>
        ${fmtTime(new Date(ev.start))} – ${fmtTime(new Date(ev.end))}
      </div>
      <div class="detail-date">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="4" width="18" height="18" rx="2"/>
          <line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/>
          <line x1="3" y1="10" x2="21" y2="10"/>
        </svg>
        ${MONTHS[s.getMonth()]} ${s.getDate()}, ${s.getFullYear()}
      </div>
      ${ev.description ? `<p class="detail-desc">${esc(ev.description)}</p>` : ''}
      ${ev.recurrence && ev.recurrence!=='none'
        ? `<div class="detail-recurrence">🔁 Repeats ${ev.recurrence}</div>` : ''}
    </div>`;
  showOverlay('#detail-overlay');
}

function closeDetailSheet() { hideOverlay('#detail-overlay'); }

// ══════════════════════════════════════════════════════════════════
//  SETTINGS SHEET MANAGEMENT
// ══════════════════════════════════════════════════════════════════
function openSettings() {
  // Clear any status messages
  const msg = $('#backup-status-msg');
  msg.textContent = '';
  msg.className = 'backup-status-msg';

  updatePermissionStatus();
  showOverlay('#settings-overlay');
}

function closeSettings() {
  hideOverlay('#settings-overlay');
}

function initSettingsUI() {
  // Pre-fill theme
  $('#settings-theme').value = state.settings.theme || 'dark';
  $('#settings-theme').onchange = (e) => {
    state.settings.theme = e.target.value;
    applyTheme();
    saveData();
  };

  // Pre-fill reminders status
  $('#settings-reminders-enabled').checked = state.settings.remindersEnabled;
  $('#settings-reminders-enabled').onchange = async (e) => {
    state.settings.remindersEnabled = e.target.checked;
    saveData();
    if (state.settings.remindersEnabled) {
      const granted = await requestNotificationPermission();
      if (!granted) {
        e.target.checked = false;
        state.settings.remindersEnabled = false;
        saveData();
        alert('Notification permission is required to enable reminders.');
      } else {
        await rescheduleAllAlarms();
      }
    } else {
      // Cancel all scheduled notifications
      if (LocalNotifications) {
        try {
          const pending = await LocalNotifications.getPending();
          if (pending.notifications && pending.notifications.length > 0) {
            await LocalNotifications.cancel(pending);
          }
        } catch (err) {}
      }
    }
  };

  // Pre-fill daily tracker reminder switch
  $('#settings-tracker-reminder-enabled').checked = !!state.settings.dailyReminderEnabled;
  $('#settings-tracker-reminder-enabled').onchange = async (e) => {
    state.settings.dailyReminderEnabled = e.target.checked;
    saveData();
    if (state.settings.dailyReminderEnabled) {
      const granted = await requestNotificationPermission();
      if (!granted) {
        e.target.checked = false;
        state.settings.dailyReminderEnabled = false;
        saveData();
        alert('Notification permission is required to enable daily reminders.');
      } else {
        await scheduleDailyTrackerReminder();
      }
    } else {
      await scheduleDailyTrackerReminder();
    }
  };

  // Pre-fill offset
  $('#settings-reminder-offset').value = state.settings.reminderOffset || '15';
  $('#settings-reminder-offset').onchange = async (e) => {
    state.settings.reminderOffset = e.target.value;
    saveData();
    if (state.settings.remindersEnabled) {
      await rescheduleAllAlarms();
    }
  };

  // Bind settings sheets buttons
  $('#settings-backdrop').onclick = closeSettings;
  $('#settings-close-btn').onclick   = closeSettings;

  // Permissions buttons
  $('#btn-request-perm-notification').onclick = async () => {
    await requestNotificationPermission();
    updatePermissionStatus();
  };
  $('#btn-request-perm-storage').onclick = async () => {
    await requestStoragePermission();
    updatePermissionStatus();
  };

  // Backup & Import buttons
  $('#btn-backup-export').onclick = exportBackup;
  $('#btn-backup-import').onclick = () => $('#backup-file-input').click();
  $('#backup-file-input').onchange = handleImportBackup;
}

// ── App Theme application ──
function applyTheme() {
  const body = document.body;
  const theme = state.settings.theme;

  body.classList.remove('light-theme');

  if (theme === 'light') {
    body.classList.add('light-theme');
  } else if (theme === 'system') {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (!prefersDark) {
      body.classList.add('light-theme');
    }
  }
}

// ── Permission Status checkers ──
async function updatePermissionStatus() {
  const notifStatus = $('#perm-notification-status');
  const storageStatus = $('#perm-storage-status');

  // Check notification permission
  if (LocalNotifications) {
    try {
      const status = await LocalNotifications.checkPermissions();
      const st = status.display;
      notifStatus.textContent = st;
      notifStatus.className = 'permission-status ' + (st === 'granted' ? 'granted' : 'denied');
      $('#btn-request-perm-notification').style.display = st === 'granted' ? 'none' : 'block';
    } catch {
      notifStatus.textContent = 'Prompt';
      notifStatus.className = 'permission-status';
    }
  } else {
    notifStatus.textContent = 'Supported (Browser)';
    notifStatus.className = 'permission-status granted';
    $('#btn-request-perm-notification').style.display = 'none';
  }

  // Check storage status
  if (Filesystem) {
    try {
      const status = await Filesystem.checkPermissions();
      const st = status.publicStorage;
      storageStatus.textContent = st;
      storageStatus.className = 'permission-status ' + (st === 'granted' ? 'granted' : 'denied');
      $('#btn-request-perm-storage').style.display = st === 'granted' ? 'none' : 'block';
    } catch {
      storageStatus.textContent = 'Granted';
      storageStatus.className = 'permission-status granted';
      $('#btn-request-perm-storage').style.display = 'none';
    }
  } else {
    storageStatus.textContent = 'Supported (Browser)';
    storageStatus.className = 'permission-status granted';
    $('#btn-request-perm-storage').style.display = 'none';
  }
}

async function requestNotificationPermission() {
  if (!LocalNotifications) return true;
  try {
    const status = await LocalNotifications.requestPermissions();
    return status.display === 'granted';
  } catch { return false; }
}

async function requestStoragePermission() {
  if (!Filesystem) return true;
  try {
    const status = await Filesystem.requestPermissions();
    return status.publicStorage === 'granted';
  } catch { return false; }
}

// ── Export / Backup data ──
async function exportBackup() {
  const data = {
    events: state.events,
    tasks: state.tasks,
    notes: state.notes,
    settings: {
      viewMode: 'month',
      theme: state.settings.theme
    }
  };
  const jsonStr = JSON.stringify(data, null, 2);

  const statusMsg = $('#backup-status-msg');
  if (statusMsg) {
    statusMsg.className = 'backup-status-msg';
    statusMsg.textContent = 'Backing up...';
  }

  const hasCapacitorNative = typeof window.Capacitor !== 'undefined' && window.Capacitor.isNativePlatform();

  if (hasCapacitorNative && Filesystem && Share) {
    try {
      const filename = 'zencalendar_backup.json';
      
      // 1. Write file to Capacitor's CACHE directory
      const fileResult = await Filesystem.writeFile({
        path: filename,
        data: jsonStr,
        directory: 'CACHE',
        encoding: 'utf8'
      });

      // 2. Open the native Share dialog to let the user save or send the file
      await Share.share({
        title: 'ZenCalendar Backup',
        text: 'Here is your exported ZenCalendar backup data.',
        url: fileResult.uri,
        dialogTitle: 'Share or Save Backup'
      });

      if (statusMsg) {
        statusMsg.className = 'backup-status-msg success';
        statusMsg.textContent = 'Backup shared/saved successfully';
      }
    } catch (err) {
      if (statusMsg) {
        statusMsg.className = 'backup-status-msg error';
        statusMsg.textContent = 'Backup failed: ' + err.message;
      }
    }
  } else {
    // Web browser fallback download
    try {
      const blob = new Blob([jsonStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'zencalendar_data.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      if (statusMsg) {
        statusMsg.className = 'backup-status-msg success';
        statusMsg.textContent = 'Backup downloaded as zencalendar_data.json';
      }
    } catch (err) {
      if (statusMsg) {
        statusMsg.className = 'backup-status-msg error';
        statusMsg.textContent = 'Backup failed: ' + err.message;
      }
    }
  }
}

// ── Restore / Import data ──
async function handleImportBackup(e) {
  const file = e.target.files[0];
  if (!file) return;

  const statusMsg = $('#backup-status-msg');
  statusMsg.className = 'backup-status-msg';
  statusMsg.textContent = 'Importing...';

  const reader = new FileReader();
  reader.onload = async (evt) => {
    try {
      const parsed = JSON.parse(evt.target.result);
      if (!parsed.events || !parsed.tasks) {
        throw new Error('Invalid schema. Make sure file contains events and tasks.');
      }

      // Overwrite local calendar data
      state.events = parsed.events;
      state.tasks  = parsed.tasks;
      state.notes  = parsed.notes || [];
      if (parsed.settings?.theme) {
        state.settings.theme = parsed.settings.theme;
        $('#settings-theme').value = state.settings.theme;
        applyTheme();
      }

      // Save to localStorage
      saveData();

      // Reset alarms for new events
      await rescheduleAllAlarms();

      statusMsg.className = 'backup-status-msg success';
      statusMsg.textContent = `Imported successfully! Loaded ${state.events.length} events, ${state.tasks.length} tasks, and ${state.notes.length} notes.`;
      
      // Clear file input selection
      e.target.value = '';

      render();
    } catch (err) {
      statusMsg.className = 'backup-status-msg error';
      statusMsg.textContent = 'Import failed: ' + err.message;
    }
  };
  reader.readAsText(file);
}

// ── Reminders & Alarm Scheduling logic ──
async function scheduleAlarmForEvent(event) {
  if (!LocalNotifications) return;

  const notificationId = stringToHash32(event.id);
  
  // Cancel previous alarm
  try {
    await LocalNotifications.cancel({ notifications: [{ id: notificationId }] });
  } catch (err) {}

  if (!state.settings.remindersEnabled) return;

  const eventStart = new Date(event.start);
  const offsetMins = parseInt(state.settings.reminderOffset, 10);
  const alarmTime = new Date(eventStart.getTime() - offsetMins * 60000);

  // If reminder is scheduled in the past, skip it
  if (alarmTime <= new Date()) return;

  try {
    await LocalNotifications.schedule({
      notifications: [
        {
          title: 'ZenCalendar Alarm',
          body: `Upcoming: ${event.title}${event.description ? ' - ' : ''}${event.description || ''}`,
          id: notificationId,
          schedule: { at: alarmTime },
          sound: 'default',
          actionTypeId: 'OPEN_APP',
          extra: { eventId: event.id }
        }
      ]
    });
  } catch (err) {
    console.error('Failed to schedule alarm:', err);
  }
}

async function cancelAlarmForEvent(event) {
  if (!LocalNotifications) return;
  const notificationId = stringToHash32(event.id);
  try {
    await LocalNotifications.cancel({ notifications: [{ id: notificationId }] });
  } catch (err) {}
}

async function rescheduleAllAlarms() {
  if (!LocalNotifications) return;

  // Clear all pending notifications
  try {
    const pending = await LocalNotifications.getPending();
    if (pending.notifications && pending.notifications.length > 0) {
      await LocalNotifications.cancel(pending);
    }
  } catch (err) {}

  if (!state.settings.remindersEnabled) return;

  // Schedule alarms for all events
  for (const event of state.events) {
    await scheduleAlarmForEvent(event);
  }
}

// ══════════════════════════════════════════════════════════════════
//  NOTES SYSTEM
// ══════════════════════════════════════════════════════════════════
let _noteLinkedDate = null;
let _noteType = 'text';
let _noteOpenedFromDayPanel = false; // tracks whether note was opened from day panel

function bindNoteEvents() {
  $('#note-modal-backdrop').onclick = closeNoteModal;
  $('#btn-note-close').onclick      = closeNoteModal;
  $('#btn-note-discard').onclick    = closeNoteModal;
  $('#note-form').onsubmit          = handleSaveNote;
  $('#btn-note-delete').onclick     = handleDeleteNote;

  $('#btn-note-pin').onclick = () => {
    const pinned = $('#btn-note-pin').dataset.pinned === 'true';
    const nextVal = !pinned;
    $('#btn-note-pin').dataset.pinned = nextVal.toString();
    $('#btn-note-pin').classList.toggle('pinned', nextVal);
  };

  $$('.note-type-btn').forEach(btn => {
    btn.onclick = () => switchNoteType(btn.dataset.type);
  });

  $('#btn-note-add-item').onclick = addNoteChecklistItem;
  $('#note-new-item-input').onkeydown = e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addNoteChecklistItem();
    }
  };
}

function switchNoteType(type) {
  _noteType = type;
  $$('.note-type-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.type === type);
  });
  updateNoteTypeUI();
}

function updateNoteTypeUI() {
  // 'text' → show text only; 'checklist' → show checklist only; 'both' → show both
  $('#note-text-section').classList.toggle('hidden',      _noteType === 'checklist');
  $('#note-checklist-section').classList.toggle('hidden', _noteType === 'text');
}

function addNoteChecklistItem() {
  const inp = $('#note-new-item-input');
  const val = inp.value.trim();
  if (!val) return;

  const itemsCont = $('#note-checklist-items');
  const row = document.createElement('div');
  row.className = 'note-check-row';
  
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  
  const lbl = document.createElement('span');
  lbl.className = 'note-check-label';
  lbl.textContent = val;
  
  cb.onchange = () => {
    lbl.classList.toggle('done', cb.checked);
  };

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'note-check-del';
  del.innerHTML = '&times;';
  del.onclick = () => row.remove();

  row.append(cb, lbl, del);
  itemsCont.appendChild(row);

  inp.value = '';
  inp.focus();
}

function openNoteModal(note, linkedDate) {
  // Track whether this was opened from the day panel (to decide on close behaviour)
  _noteOpenedFromDayPanel = !!(linkedDate || (note && note.linkedDate && state.selectedDay &&
    isSameDay(new Date(note.linkedDate), state.selectedDay)));

  _noteLinkedDate = linkedDate || (note && note.linkedDate ? new Date(note.linkedDate) : null);
  $('#note-id').value = note ? note.id : '';
  $('#note-title-input').value = note ? note.title : '';
  
  const type = note ? (note.type || 'text') : 'text';
  switchNoteType(type);

  $('#note-modal-heading').textContent = note ? 'Edit Note' : 'New Note';

  const pinned = note ? !!note.pinned : false;
  $('#btn-note-pin').dataset.pinned = pinned.toString();
  $('#btn-note-pin').classList.toggle('pinned', pinned);

  $('#note-content').value = note ? (note.content || '') : '';

  const itemsCont = $('#note-checklist-items');
  itemsCont.innerHTML = '';
  const items = note ? (note.checklistItems || []) : [];
  items.forEach(item => {
    const row = document.createElement('div');
    row.className = 'note-check-row';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = item.done || false;

    const lbl = document.createElement('span');
    lbl.className = 'note-check-label' + (item.done ? ' done' : '');
    lbl.textContent = item.text;

    cb.onchange = () => {
      lbl.classList.toggle('done', cb.checked);
    };

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'note-check-del';
    del.innerHTML = '&times;';
    del.onclick = () => row.remove();

    row.append(cb, lbl, del);
    itemsCont.appendChild(row);
  });

  $('#btn-note-delete').classList.toggle('hidden', !note);

  showOverlay('#note-modal-overlay');
  setTimeout(() => $('#note-title-input').focus(), 380);
}

function closeNoteModal() {
  hideOverlay('#note-modal-overlay');
  _noteLinkedDate = null;
  // Only reopen the day panel if the note was opened from it and a day is still selected
  if (_noteOpenedFromDayPanel && state.selectedDay) {
    _noteOpenedFromDayPanel = false;
    setTimeout(() => {
      openDayPanel(state.selectedDay);
    }, 350);
  } else {
    _noteOpenedFromDayPanel = false;
  }
}

async function handleSaveNote(e) {
  e.preventDefault();
  const title = $('#note-title-input').value.trim();
  if (!title) return;

  const id = $('#note-id').value;
  const pinned = $('#btn-note-pin').dataset.pinned === 'true';

  const rows = $$('#note-checklist-items .note-check-row');
  const checklistItems = Array.from(rows).map(row => ({
    text: row.querySelector('.note-check-label').textContent,
    done: row.querySelector('input[type=checkbox]').checked
  }));

  const note = {
    id: id || uid(),
    title,
    type: _noteType,
    content: $('#note-content').value.trim(),
    checklistItems,
    pinned,
    linkedDate: _noteLinkedDate ? _noteLinkedDate.toISOString() : null,
    updatedAt: new Date().toISOString()
  };

  if (id) {
    state.notes = state.notes.map(n => n.id === id ? note : n);
  } else {
    state.notes.push(note);
  }

  saveData();
  renderNotes();
  renderNotesCount();
  closeNoteModal();
}

async function handleDeleteNote() {
  const id = $('#note-id').value;
  if (!id) return;
  state.notes = state.notes.filter(n => n.id !== id);
  saveData();
  renderNotes();
  renderNotesCount();
  closeNoteModal();
}

// ══════════════════════════════════════════════════════════════
//  NOTES TAB RENDER
// ══════════════════════════════════════════════════════════════
function renderNotes() {
  const list = $('#notes-list');
  if (!list) return;
  list.innerHTML = '';

  const sorted = [...state.notes]
    .sort((a, b) =>
      (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) ||
      new Date(b.updatedAt) - new Date(a.updatedAt)
    );

  if (sorted.length === 0) {
    list.innerHTML = `
      <div class="notes-empty">
        <div class="notes-empty-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
            <line x1="16" y1="13" x2="8" y2="13"/>
            <line x1="16" y1="17" x2="8" y2="17"/>
          </svg>
        </div>
        <p>No notes yet.<br>Tap <strong>+</strong> to add one.</p>
      </div>`;
    return;
  }

  sorted.forEach(note => {
    const item = document.createElement('div');
    item.className = 'note-card' + (note.pinned ? ' pinned' : '');

    const preview = note.type === 'checklist' || note.type === 'both'
      ? `${(note.checklistItems || []).filter(i => !i.done).length} remaining / ${(note.checklistItems || []).length} total`
      : (note.content || '').slice(0, 80);

    const progress = (note.type === 'checklist' || note.type === 'both') && (note.checklistItems || []).length > 0
      ? `<div class="note-card-progress">${(note.checklistItems || []).filter(i => i.done).length}/${(note.checklistItems || []).length} done</div>`
      : '';

    const dateStr = note.updatedAt
      ? new Date(note.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      : '';

    const typeBadge = note.type === 'checklist'
      ? '<span class="note-type-badge checklist">Checklist</span>'
      : note.type === 'both'
      ? '<span class="note-type-badge both">Text + List</span>'
      : '';

    item.innerHTML = `
      <div class="note-card-header">
        <span class="note-card-title">${note.pinned ? '📌 ' : ''}${esc(note.title)}</span>
        <div class="note-card-meta">
          ${typeBadge}
          ${note.linkedDate ? '<span title="Linked to date" class="note-linked-badge">📅</span>' : ''}
          ${dateStr ? `<span class="note-card-date">${dateStr}</span>` : ''}
        </div>
      </div>
      ${preview ? `<div class="note-card-preview">${esc(preview)}</div>` : ''}
      ${progress}
    `;
    item.onclick = () => openNoteModal(note);
    list.appendChild(item);
  });
}

// Bind standalone Notes tab 'New Note' button
function bindNotesTabEvents() {
  const btn = $('#btn-new-note');
  if (btn) btn.onclick = () => openNoteModal(null);
}

/** Update the Notes tab badge with the total number of notes */
function renderNotesCount() {
  const badge = $('#notes-count-badge');
  if (!badge) return;
  const count = state.notes.length;
  if (count > 0) {
    badge.textContent = count > 99 ? '99+' : count;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

// ══════════════════════════════════════════════════════════════════
//  OVERLAY HELPERS (slide-up animation)
// ══════════════════════════════════════════════════════════════════
function showOverlay(selector) {
  const el = $(selector);
  el.classList.remove('hidden');
  requestAnimationFrame(() => {
    requestAnimationFrame(() => el.classList.add('open'));
  });
}

function hideOverlay(selector) {
  const el = $(selector);
  el.classList.remove('open');
  setTimeout(() => el.classList.add('hidden'), 330);
}

// ══════════════════════════════════════════════════════════════════
//  TRACKING MODE
// ══════════════════════════════════════════════════════════════════

/** Toggle between 'normal' and 'tracking' modes */
function toggleMode() {
  state.mode = state.mode === 'normal' ? 'tracking' : 'normal';
  render();
}

/** Return today's local date string in 'YYYY-MM-DD' format */
function todayKey() {
  const d = state.currentDate || new Date();
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}

function getTrackersList() {
  if (!state.settings.customTrackers) {
    state.settings.customTrackers = [
      {
        id: "exercises",
        name: "Exercises",
        type: "counter",
        unit: "reps",
        target: 20,
        defaultValue: 0,
        icon: "💪",
        color: "indigo"
      },
      {
        id: "minimum_daily",
        name: "Minimum Daily",
        type: "checklist",
        defaultItems: [
          'Drink water',
          'Eat a meal',
          '10-minute stretch',
          'Get some fresh air'
        ],
        icon: "✅",
        color: "green"
      }
    ];
  }

  if (state.settings.trackerOrder) {
    const orderMap = {};
    state.settings.trackerOrder.forEach((id, idx) => { orderMap[id] = idx; });
    return [...state.settings.customTrackers].sort((a, b) => {
      const idxA = orderMap[a.id] !== undefined ? orderMap[a.id] : 999;
      const idxB = orderMap[b.id] !== undefined ? orderMap[b.id] : 999;
      return idxA - idxB;
    });
  }

  return state.settings.customTrackers;
}

/** Get or create the tracking entry for a given date key */
function getTrackingDay(dateKey) {
  if (!state.tracking[dateKey]) {
    state.tracking[dateKey] = {};
  }
  const dayData = state.tracking[dateKey];
  const trackers = getTrackersList();
  
  trackers.forEach(cfg => {
    if (dayData[cfg.id] === undefined) {
      if (cfg.type === 'counter') {
        dayData[cfg.id] = { value: cfg.defaultValue || 0, sets: [] };
      } else if (cfg.type === 'checklist') {
        dayData[cfg.id] = {};
        (cfg.defaultItems || []).forEach(text => {
          dayData[cfg.id][text] = false;
        });
      }
    } else if (cfg.type === 'counter' && typeof dayData[cfg.id] === 'number') {
      // Migrate legacy number counter value to sets schema
      dayData[cfg.id] = { value: dayData[cfg.id], sets: [] };
    }
  });
  return dayData;
}

/** Calculate overall daily progress percentage across all trackers */
function calcTrackingProgress(dayData) {
  if (dayData.restDay) return 100;
  
  const trackers = getTrackersList();
  let total = 0, done = 0;
  
  trackers.forEach(cfg => {
    const entry = dayData[cfg.id];
    if (!entry) return;
    if (cfg.type === 'counter') {
      total += cfg.target || 1;
      done  += Math.min(entry.value || 0, cfg.target || 1);
    } else if (cfg.type === 'checklist') {
      const items = entry;
      const keys = Object.keys(items);
      total += keys.length;
      done  += keys.filter(k => items[k]).length;
    }
  });
  return total === 0 ? 0 : Math.round((done / total) * 100);
}

function calculateStreak() {
  const sortedKeys = Object.keys(state.tracking)
    .filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k))
    .sort();
  
  if (sortedKeys.length === 0) return 0;
  
  const today = new Date();
  const dateKeyStr = (d) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  const todayStr = dateKeyStr(today);
  
  const isCompleted = (key) => {
    const dayData = state.tracking[key];
    if (!dayData) return false;
    if (dayData.restDay) return true;
    
    const trackers = getTrackersList();
    if (trackers.length === 0) return false;
    
    let complete = true;
    trackers.forEach(t => {
      if (t.type === 'counter') {
        let val = 0;
        if (typeof dayData[t.id] === 'number') val = dayData[t.id];
        else if (dayData[t.id] && typeof dayData[t.id] === 'object') val = dayData[t.id].value || 0;
        if (val < (t.target || 1)) complete = false;
      } else if (t.type === 'checklist') {
        const items = dayData[t.id] || {};
        const keys = Object.keys(items);
        if (keys.length === 0) return;
        if (keys.some(k => !items[k])) complete = false;
      }
    });
    return complete;
  };

  let streak = 0;
  let curr = new Date(today);
  curr.setDate(curr.getDate() - 1);
  
  while (true) {
    const key = dateKeyStr(curr);
    if (isCompleted(key)) {
      streak++;
      curr.setDate(curr.getDate() - 1);
    } else {
      break;
    }
  }
  
  if (isCompleted(todayStr)) {
    streak++;
  }
  
  return streak;
}

function renderWeeklyChart() {
  const container = $('#weekly-chart-bars');
  if (!container) return;
  container.innerHTML = '';
  
  const trackers = getTrackersList();
  const today = new Date();
  const dateKeyStr = (d) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  const daysShort = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const key = dateKeyStr(d);
    const dayData = state.tracking[key] || {};
    
    const wrap = document.createElement('div');
    wrap.className = 'weekly-chart-bar-wrap';
    
    const bar = document.createElement('div');
    bar.className = 'weekly-chart-bar';
    
    let pct = 0;
    if (dayData.restDay) {
      pct = 100;
      bar.classList.add('rest');
    } else {
      let totalSum = 0;
      trackers.forEach(t => {
        if (t.type === 'counter') {
          let val = 0;
          if (typeof dayData[t.id] === 'number') val = dayData[t.id];
          else if (dayData[t.id] && typeof dayData[t.id] === 'object') val = dayData[t.id].value || 0;
          totalSum += Math.min(100, Math.round((val / (t.target || 1)) * 100));
        } else if (t.type === 'checklist') {
          const items = dayData[t.id] || {};
          const keys = Object.keys(items);
          if (keys.length === 0) {
            totalSum += 100;
          } else {
            const done = keys.filter(k => items[k]).length;
            totalSum += Math.round((done / keys.length) * 100);
          }
        }
      });
      pct = trackers.length > 0 ? Math.round(totalSum / trackers.length) : 0;
      if (pct > 0) bar.classList.add('filled');
    }
    
    bar.style.height = `${pct}%`;
    bar.onclick = () => {
      state.currentDate = new Date(d);
      render();
    };
    
    const label = document.createElement('span');
    label.className = 'weekly-chart-day-label';
    label.textContent = daysShort[d.getDay()];
    
    wrap.append(bar, label);
    container.appendChild(wrap);
  }
}

let _isCelebrated = false;

/** Render the full tracking view */
function renderTrackingView() {
  const d = state.currentDate || new Date();
  const dateKey = todayKey();
  const dayData = getTrackingDay(dateKey);

  // Update the date header
  const dayLabel = `${DAYS_FULL[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
  const dateLabelEl = $('#tracking-date-label');
  if (dateLabelEl) dateLabelEl.textContent = dayLabel;

  // Rest day configuration toggle button
  const btnRest = $('#btn-toggle-rest');
  if (btnRest) {
    btnRest.classList.toggle('active', !!dayData.restDay);
    btnRest.textContent = dayData.restDay ? '🛌 Rest Day' : '🛌 Rest';
  }

  // Daily Journal Note Textarea
  const journalTextarea = $('#tracking-journal');
  if (journalTextarea) {
    journalTextarea.value = dayData.journal || '';
    journalTextarea.onchange = async (e) => {
      dayData.journal = e.target.value;
      saveData();
    };
  }

  // Streak calculations
  const streak = calculateStreak();
  const streakBadge = $('#tracking-streak');
  if (streakBadge) {
    streakBadge.textContent = `🔥 ${streak}`;
  }

  // Weekly Summary chart
  renderWeeklyChart();

  // Update circular progress ring
  const pct = calcTrackingProgress(dayData);
  const circumference = 2 * Math.PI * 50;
  const offset = circumference - (pct / 100) * circumference;
  const ring = $('#tracking-ring-fill');
  if (ring) ring.style.strokeDashoffset = offset;
  const pctEl = $('#tracking-pct');
  if (pctEl) pctEl.textContent = pct + '%';

  const ringWrap = $('#tracking-view .focus-ring-wrap');
  if (ringWrap) {
    if (pct === 100) {
      ringWrap.classList.add('celebrate-glow');
      if (!_isCelebrated) {
        triggerCelebration();
        _isCelebrated = true;
      }
    } else {
      ringWrap.classList.remove('celebrate-glow');
      _isCelebrated = false;
    }
  }

  // Render tracker cards
  const list = $('#trackers-list');
  if (!list) return;
  list.innerHTML = '';

  const trackers = getTrackersList();

  trackers.forEach((cfg, trackerIdx) => {
    const entry = dayData[cfg.id];
    const card = document.createElement('div');
    card.className = `mobile-tracker-card accent-${cfg.color || 'indigo'}`;

    if (cfg.type === 'counter') {
      renderCounterCard(card, cfg, entry, dateKey, trackerIdx, trackers.length);
    } else if (cfg.type === 'checklist') {
      renderChecklistCard(card, cfg, entry, dateKey, trackerIdx, trackers.length);
    }

    list.appendChild(card);
  });

  // "Add Tracker" button at the bottom
  const addBtn = document.createElement('button');
  addBtn.className = 'tracking-add-tracker-btn';
  addBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> Add Tracker`;
  addBtn.onclick = () => openTrackerModal(null);
  list.appendChild(addBtn);
}

/** Render a counter tracker card */
function renderCounterCard(card, cfg, entry, dateKey, trackerIdx, trackersCount) {
  const val = entry ? (entry.value || 0) : 0;
  const pct = cfg.target ? Math.min(100, Math.round((val / cfg.target) * 100)) : 0;
  const sets = entry ? (entry.sets || []) : [];

  card.innerHTML = `
    <div class="mobile-tracker-card-header">
      <div style="display:flex;align-items:center;gap:8px;">
        <span class="tracker-icon">${cfg.icon || '🏃'}</span>
        <span class="mobile-tracker-card-title">${esc(cfg.name)}</span>
      </div>
      <div class="tracker-card-actions">
        <button class="tracker-action-btn btn-up-order" ${trackerIdx === 0 ? 'disabled' : ''}>▲</button>
        <button class="tracker-action-btn btn-down-order" ${trackerIdx === trackersCount - 1 ? 'disabled' : ''}>▼</button>
        <button class="tracker-action-btn btn-edit-tracker">⚙️</button>
      </div>
    </div>
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
      <span class="mobile-counter-unit" style="font-size:12px; font-weight:700;">Progress: ${pct}%</span>
      <span class="mobile-tracker-card-progress" style="font-size:11px;">${val} / ${cfg.target} ${esc(cfg.unit || '')}</span>
    </div>
    <div class="mobile-counter-widget">
      <button class="mobile-counter-btn" data-action="dec" aria-label="Decrease">−</button>
      <input class="mobile-counter-input" type="number" min="0" value="${val}" aria-label="${esc(cfg.name)} count" />
      <button class="mobile-counter-btn" data-action="inc" aria-label="Increase">+</button>
      <span class="mobile-counter-unit">${esc(cfg.unit || '')}</span>
    </div>
    
    <div class="sets-list"></div>
    
    <div class="mobile-checklist-add-row" style="margin-top:8px;">
      <input type="number" class="mobile-checklist-add-input set-reps-input" placeholder="Set Reps..." style="max-width:100px;" />
      <button class="mobile-checklist-add-btn btn-add-set-reps">+ Set</button>
    </div>

    <div class="tracker-mini-progress-bar" style="margin-top:12px;">
      <div class="tracker-mini-progress-fill" style="width:${pct}%"></div>
    </div>
  `;

  // Bind Reordering & Editing
  card.querySelector('.btn-up-order').onclick = () => reorderTracker(trackerIdx, -1);
  card.querySelector('.btn-down-order').onclick = () => reorderTracker(trackerIdx, 1);
  card.querySelector('.btn-edit-tracker').onclick = () => openTrackerModal(cfg);

  const input = card.querySelector('.mobile-counter-input');
  const progressBadge = card.querySelector('.mobile-tracker-card-progress');
  const fill = card.querySelector('.tracker-mini-progress-fill');
  const setsCont = card.querySelector('.sets-list');

  function refreshSetsUI() {
    setsCont.innerHTML = '';
    sets.forEach((setVal, setIdx) => {
      const setItem = document.createElement('div');
      setItem.className = 'set-item';
      setItem.textContent = `Set ${setIdx + 1}: ${setVal} ${cfg.unit}`;
      
      const setDel = document.createElement('button');
      setDel.className = 'set-item-delete';
      setDel.innerHTML = '&times;';
      setDel.onclick = () => {
        sets.splice(setIdx, 1);
        updateCounter(sets.reduce((sum, v) => sum + v, 0));
        refreshSetsUI();
      };
      setItem.appendChild(setDel);
      setsCont.appendChild(setItem);
    });
  }
  
  refreshSetsUI();

  // Add Set Reps
  const setRepsInp = card.querySelector('.set-reps-input');
  card.querySelector('.btn-add-set-reps').onclick = () => {
    const rVal = parseInt(setRepsInp.value, 10);
    if (isNaN(rVal) || rVal <= 0) return;
    entry.sets = entry.sets || [];
    entry.sets.push(rVal);
    updateCounter(entry.sets.reduce((sum, v) => sum + v, 0));
    setRepsInp.value = '';
    refreshSetsUI();
  };

  function updateCounter(newVal) {
    newVal = Math.max(0, newVal);
    entry.value = newVal;
    input.value = newVal;
    const newPct = cfg.target ? Math.min(100, Math.round((newVal / cfg.target) * 100)) : 0;
    progressBadge.textContent = `${newVal} / ${cfg.target} ${cfg.unit || ''}`;
    fill.style.width = newPct + '%';
    saveData();
    // Refresh overall ring
    const overallPct = calcTrackingProgress(getTrackingDay(dateKey));
    const circumference = 2 * Math.PI * 50;
    const offset = circumference - (overallPct / 100) * circumference;
    const ring = $('#tracking-ring-fill');
    if (ring) ring.style.strokeDashoffset = offset;
    const pctEl = $('#tracking-pct');
    if (pctEl) pctEl.textContent = overallPct + '%';
  }

  card.querySelector('[data-action="dec"]').onclick = () => updateCounter((entry.value || 0) - 1);
  card.querySelector('[data-action="inc"]').onclick = () => updateCounter((entry.value || 0) + 1);
  input.addEventListener('change', () => updateCounter(parseInt(input.value) || 0));
}

/** Render a checklist tracker card */
function renderChecklistCard(card, cfg, entry, dateKey, trackerIdx, trackersCount) {
  const items = entry ? entry : {};
  const itemKeys = Object.keys(items);
  const doneCount = itemKeys.filter(k => items[k]).length;

  card.innerHTML = `
    <div class="mobile-tracker-card-header">
      <div style="display:flex;align-items:center;gap:8px;">
        <span class="tracker-icon">${cfg.icon || '📋'}</span>
        <span class="mobile-tracker-card-title">${esc(cfg.name)}</span>
      </div>
      <div class="tracker-card-actions">
        <button class="tracker-action-btn btn-up-order" ${trackerIdx === 0 ? 'disabled' : ''}>▲</button>
        <button class="tracker-action-btn btn-down-order" ${trackerIdx === trackersCount - 1 ? 'disabled' : ''}>▼</button>
        <button class="tracker-action-btn btn-edit-tracker">⚙️</button>
      </div>
    </div>
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
      <span class="mobile-counter-unit" style="font-size:12px; font-weight:700;">Progress</span>
      <span class="mobile-tracker-card-progress">${doneCount}/${itemKeys.length} done</span>
    </div>
    <div class="mobile-checklist-widget" id="checklist-${cfg.id}"></div>
    <div class="mobile-checklist-add-row">
      <input type="text" class="mobile-checklist-add-input" placeholder="Add item…" aria-label="New checklist item" />
      <button class="mobile-checklist-add-btn">Add</button>
    </div>
  `;

  // Bind Reordering & Editing
  card.querySelector('.btn-up-order').onclick = () => reorderTracker(trackerIdx, -1);
  card.querySelector('.btn-down-order').onclick = () => reorderTracker(trackerIdx, 1);
  card.querySelector('.btn-edit-tracker').onclick = () => openTrackerModal(cfg);

  const listEl = card.querySelector(`#checklist-${cfg.id}`);
  const badge  = card.querySelector('.mobile-tracker-card-progress');

  function refreshBadge() {
    const keys = Object.keys(entry);
    const d = keys.filter(k => entry[k]).length;
    badge.textContent = `${d}/${keys.length} done`;
    saveData();
    const overallPct = calcTrackingProgress(getTrackingDay(dateKey));
    const circumference = 2 * Math.PI * 50;
    const offset = circumference - (overallPct / 100) * circumference;
    const ring = $('#tracking-ring-fill');
    if (ring) ring.style.strokeDashoffset = offset;
    const pctEl = $('#tracking-pct');
    if (pctEl) pctEl.textContent = overallPct + '%';
  }

  function renderItems() {
    listEl.innerHTML = '';
    const keys = Object.keys(entry);
    keys.forEach(itemKey => {
      const row = document.createElement('div');
      row.className = 'mobile-checklist-item';
      row.innerHTML = `
        <input type="checkbox" ${entry[itemKey] ? 'checked' : ''} aria-label="${esc(itemKey)}" />
        <span class="mobile-checklist-text ${entry[itemKey] ? 'done' : ''}">${esc(itemKey)}</span>
        <button class="checklist-item-delete" aria-label="Remove item" style="margin-left:auto;background:none;border:none;color:var(--text-3);font-size:16px;cursor:pointer;padding:0 2px;">×</button>
      `;
      const cb  = row.querySelector('input[type=checkbox]');
      const lbl = row.querySelector('.mobile-checklist-text');
      const del = row.querySelector('.checklist-item-delete');

      cb.onchange = () => {
        entry[itemKey] = cb.checked;
        lbl.classList.toggle('done', cb.checked);
        refreshBadge();
      };
      del.onclick = () => {
        delete entry[itemKey];
        renderItems();
        refreshBadge();
      };
      listEl.appendChild(row);
    });
  }

  renderItems();

  // Add item
  const addInput = card.querySelector('.mobile-checklist-add-input');
  const addBtn   = card.querySelector('.mobile-checklist-add-btn');
  function doAddItem() {
    const text = addInput.value.trim();
    if (!text) return;
    entry[text] = false;
    addInput.value = '';
    renderItems();
    refreshBadge();
  }
  addBtn.onclick = doAddItem;
  addInput.addEventListener('keydown', e => { if (e.key === 'Enter') doAddItem(); });
}

/** Bind any tracking-specific events that only need binding once */
function bindTrackingEvents() {
  // Setup notifications, rest day binds, etc.
}

async function reorderTracker(trackerIdx, dir) {
  const trackers = getTrackersList();
  const order = trackers.map(t => t.id);
  const targetIdx = trackerIdx + dir;
  if (targetIdx < 0 || targetIdx >= order.length) return;
  
  const temp = order[trackerIdx];
  order[trackerIdx] = order[targetIdx];
  order[targetIdx] = temp;
  
  state.settings.trackerOrder = order;
  saveData();
  render();
}

async function toggleRestDay() {
  const d = state.currentDate || new Date();
  const dateKey = todayKey();
  const dayData = getTrackingDay(dateKey);
  dayData.restDay = !dayData.restDay;
  saveData();
  render();
}

/* ── TRACKER CONFIGURATION MODAL CONTROLLER ── */

function initTrackerColorPicker(selectedColor) {
  const tcp = $('#tracker-color-picker');
  if (!tcp) return;
  tcp.innerHTML = '';
  const colors = ['indigo', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink'];
  colors.forEach(c => {
    const sw = document.createElement('button');
    sw.type = 'button';
    sw.className = 'color-swatch' + (c === selectedColor ? ' active' : '');
    sw.style.backgroundColor = c === 'indigo' ? '#7c3aed' : 
                              c === 'red' ? '#ef4444' :
                              c === 'orange' ? '#f97316' :
                              c === 'yellow' ? '#eab308' :
                              c === 'green' ? '#10b981' :
                              c === 'blue' ? '#06b6d4' :
                              c === 'purple' ? '#8b5cf6' : '#ec4899';
    sw.dataset.color = c;
    sw.onclick = () => {
      tcp.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
      sw.classList.add('active');
    };
    tcp.appendChild(sw);
  });
}

function openTrackerModal(tracker) {
  const overlay = $('#modal-tracker-overlay');
  showOverlay('#modal-tracker-overlay');
  
  if (tracker) {
    // Edit Mode
    $('#modal-tracker-heading').textContent = 'Edit Tracker';
    $('#modal-tracker-id').value = tracker.id;
    $('#tracker-name-input').value = tracker.name;
    $('#tracker-type-select').value = tracker.type;
    $('#tracker-target-input').value = tracker.target || 10;
    $('#tracker-unit-input').value = tracker.unit || 'reps';
    $('#tracker-icon-input').value = tracker.icon || '💪';
    $('#btn-delete-tracker').classList.remove('hidden');
    initTrackerColorPicker(tracker.color || 'indigo');
  } else {
    // Add Mode
    $('#modal-tracker-heading').textContent = 'Add Tracker';
    $('#modal-tracker-id').value = '';
    $('#tracker-name-input').value = '';
    $('#tracker-type-select').value = 'counter';
    $('#tracker-target-input').value = 10;
    $('#tracker-unit-input').value = 'reps';
    $('#tracker-icon-input').value = '💪';
    $('#btn-delete-tracker').classList.add('hidden');
    initTrackerColorPicker('indigo');
  }
  
  $('#tracker-counter-fields').classList.toggle('hidden', $('#tracker-type-select').value !== 'counter');
  $('#tracker-name-input').focus();
}

function closeTrackerModal() {
  hideOverlay('#modal-tracker-overlay');
}

async function handleSaveTracker(e) {
  e.preventDefault();
  const id = $('#modal-tracker-id').value;
  const name = $('#tracker-name-input').value.trim();
  const type = $('#tracker-type-select').value;
  const target = parseInt($('#tracker-target-input').value, 10) || 10;
  const unit = $('#tracker-unit-input').value.trim() || 'reps';
  const icon = $('#tracker-icon-input').value.trim() || '💪';
  const color = $('.color-swatch.active', $('#tracker-color-picker'))?.dataset.color || 'indigo';

  if (!name) return;

  const tracker = {
    id: id || uid(),
    name,
    type,
    icon,
    color
  };

  if (type === 'counter') {
    tracker.target = target;
    tracker.unit = unit;
    tracker.defaultValue = 0;
  } else {
    tracker.defaultItems = [];
  }

  if (!state.settings.customTrackers) {
    getTrackersList(); // initializes
  }

  if (id) {
    state.settings.customTrackers = state.settings.customTrackers.map(t => t.id === id ? tracker : t);
  } else {
    state.settings.customTrackers.push(tracker);
    if (!state.settings.trackerOrder) {
      state.settings.trackerOrder = state.settings.customTrackers.map(t => t.id);
    }
    state.settings.trackerOrder.push(tracker.id);
  }

  saveData();
  closeTrackerModal();
  render();
}

async function handleDeleteTracker() {
  const id = $('#modal-tracker-id').value;
  if (!id) return;
  
  if (confirm("Are you sure you want to delete this tracker?")) {
    state.settings.customTrackers = (state.settings.customTrackers || []).filter(t => t.id !== id);
    if (state.settings.trackerOrder) {
      state.settings.trackerOrder = state.settings.trackerOrder.filter(tid => tid !== id);
    }
    saveData();
    closeTrackerModal();
    render();
  }
}

// ── DAILY LOCAL NOTIFICATION ALERTS ──
async function scheduleDailyTrackerReminder() {
  if (!LocalNotifications) return;

  const notificationId = 99999;
  
  try {
    await LocalNotifications.cancel({ notifications: [{ id: notificationId }] });
  } catch (err) {}

  if (!state.settings.dailyReminderEnabled) return;

  try {
    await LocalNotifications.schedule({
      notifications: [
        {
          title: "Daily Habits Tracker",
          body: "Don't forget to check off your habits and complete your exercises! 🏃💪",
          id: notificationId,
          schedule: {
            on: {
              hour: 20,
              minute: 0
            },
            repeats: true
          }
        }
      ]
    });
  } catch (err) {
    console.error('Failed to schedule daily tracker reminder:', err);
  }
}

/* ── PREMIUM CELEBRATION EFFECT ── */
function triggerCelebration() {
  const body = document.body;
  const colors = ['#ef4444', '#f97316', '#eab308', '#10b981', '#06b6d4', '#7c3aed', '#8b5cf6', '#ec4899'];
  
  for (let i = 0; i < 40; i++) {
    const p = document.createElement('div');
    p.style.position = 'fixed';
    p.style.width = Math.random() * 6 + 4 + 'px';
    p.style.height = Math.random() * 10 + 4 + 'px';
    p.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
    p.style.left = '50%';
    p.style.top = '55%';
    p.style.borderRadius = '2px';
    p.style.zIndex = '9999';
    p.style.transform = 'translate(-50%, -50%)';
    p.style.pointerEvents = 'none';
    body.appendChild(p);

    const angle = Math.random() * Math.PI * 2;
    const distance = Math.random() * 140 + 70;
    const destX = Math.cos(angle) * distance;
    const destY = Math.sin(angle) * distance;
    
    p.animate([
      { transform: 'translate(-50%, -50%) scale(1) rotate(0deg)', opacity: 1 },
      { transform: `translate(calc(-50% + ${destX}px), calc(-50% + ${destY}px)) scale(0) rotate(${Math.random() * 720}deg)`, opacity: 0 }
    ], {
      duration: Math.random() * 1000 + 700,
      easing: 'cubic-bezier(0.1, 0.8, 0.25, 1)',
      fill: 'forwards'
    });

    setTimeout(() => p.remove(), 1700);
  }
}

// ══════════════════════════════════════════════════════════════════
//  BOOT
// ══════════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', init);

