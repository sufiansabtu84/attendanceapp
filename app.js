// ---------- state ----------

let UI = {
  view: 'loading',
  publicEvents: [],       // [{id,name}] - no attendee data, ever, for non-admins
  currentEventId: null,
  currentEventName: '',
  lastAttendeeId: null,
  qrSaved: false,

  adminToken: localStorage.getItem('admin_token') || null,
  loginError: '',
  adminEvents: [],        // [{id,name,createdAt,registeredCount,arrivedCount}]
  adminManagingEventId: null,
  guests: [],
  admins: [],
  scanMsg: '',
  scanOk: false,
  adminMsg: '',
  confirmDeleteEventId: null,
  viewingQrForId: null
};

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
  });
}

function fmtTime(ts) {
  if (!ts) return '';
  try { return new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
  catch (e) { return ''; }
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(showToast._h);
  showToast._h = setTimeout(function () { t.classList.remove('show'); }, 2400);
}

function getUrlEventId() {
  try { return new URLSearchParams(window.location.search).get('event'); } catch (e) { return null; }
}

function eventUrl(id) {
  const u = new URL(window.location.href);
  u.search = '?event=' + encodeURIComponent(id);
  return u.toString();
}

// ---------- tiny fetch helpers ----------

async function api(path, opts) {
  opts = opts || {};
  const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  if (UI.adminToken) headers['Authorization'] = 'Bearer ' + UI.adminToken;
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const data = isJson ? await res.json().catch(function () { return {}; }) : null;
  if (!res.ok) {
    const err = new Error((data && data.error) || ('Request failed (' + res.status + ')'));
    err.status = res.status;
    throw err;
  }
  return data;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
}

// ---------- rendering ----------

function render() {
  const root = document.getElementById('root');
  let html = '';
  if (UI.view === 'noEvents') html = renderNoEvents();
  else if (UI.view === 'picker') html = renderPicker();
  else if (UI.view === 'register') html = renderRegister();
  else if (UI.view === 'qrConfirm') html = renderQrConfirm();
  else if (UI.view === 'adminLogin') html = renderAdminLogin();
  else if (UI.view === 'adminDashboard') html = renderAdminDashboard();
  else html = '<div class="card"><div class="band"><p class="title-lg">Loading…</p></div></div>';

  html += '<p class="footer-admin"><button class="link-btn" id="adminToggleBtn">' +
    (UI.view === 'adminDashboard' || UI.view === 'adminLogin' ? 'Back to check-in' : 'Admin') + '</button></p>';

  root.innerHTML = html;
  attachCommonHandlers();
  if (UI.view === 'register') attachRegisterHandlers();
  if (UI.view === 'picker') attachPickerHandlers();
  if (UI.view === 'qrConfirm') attachQrHandlers();
  if (UI.view === 'adminLogin') attachAdminLoginHandlers();
  if (UI.view === 'adminDashboard') attachAdminDashboardHandlers();
}

function renderNoEvents() {
  return '<div class="card"><div class="band"><p class="eyebrow">Event check-in</p>' +
    '<p class="title-lg">No event set up yet</p></div>' +
    '<div class="section"><p class="empty">Ask the organizer to create an event, or log in as admin below to create one.</p></div></div>';
}

function renderPicker() {
  const items = UI.publicEvents.map(function (ev) {
    return '<button class="event-pick" data-id="' + escapeHtml(ev.id) + '">' + escapeHtml(ev.name) + '</button>';
  }).join('');
  return '<div class="card"><div class="band"><p class="eyebrow">Event check-in</p>' +
    '<p class="title-lg">Which event are you checking in to?</p></div>' +
    '<div class="section">' + (items || '<p class="empty">No events yet.</p>') + '</div></div>';
}

function renderRegister() {
  return '<div class="card">' +
    '<div class="band"><p class="eyebrow">Event check-in</p><p class="title-lg">' + escapeHtml(UI.currentEventName) + '</p></div>' +
    '<div class="perf"></div>' +
    '<div class="section">' +
    '<h2>Register</h2>' +
    '<label>Parent\u2019s name</label>' +
    '<input type="text" id="fParent" placeholder="e.g. Alex Tan">' +
    '<label>Child\u2019s name</label>' +
    '<input type="text" id="fChild" placeholder="e.g. Mia Tan">' +
    '<label>Email <span class="req">*required</span></label>' +
    '<input type="email" id="fEmail" placeholder="you@example.com">' +
    '<div class="field-msg" id="fEmailMsg"></div>' +
    '<label>Phone number <span class="req">*required</span></label>' +
    '<input type="tel" id="fPhone" placeholder="e.g. 012-3456789">' +
    '<div class="field-msg" id="fPhoneMsg"></div>' +
    '<button class="btn-primary" id="submitRegBtn">Check in</button>' +
    '</div></div>';
}

function renderQrConfirm() {
  return '<div class="card">' +
    '<div class="band"><p class="eyebrow">You\u2019re registered</p><p class="title-lg">' + escapeHtml(UI.currentEventName) + '</p></div>' +
    '<div class="perf"></div>' +
    '<div class="qr-wrap">' +
    '<div class="qr-box" id="qrBox"></div>' +
    '<p class="qr-caption">Show this QR code at the door \u2014 the organizer will scan it to mark you arrived.</p>' +
    (UI.qrSaved
      ? '<p class="saved-note">\u2713 Saved to your device</p>'
      : '<p class="save-note">You must save this QR before finishing</p>') +
    '<button class="btn-gold" id="saveQrBtn">' + (UI.qrSaved ? 'Save again' : 'Save QR to my device') + '</button>' +
    '<button class="btn-primary" id="finishBtn" ' + (UI.qrSaved ? '' : 'disabled') + '>Finish</button>' +
    '</div></div>';
}

function renderAdminLogin() {
  return '<div class="card">' +
    '<div class="band"><p class="eyebrow">Organizer access</p><p class="title-lg">Admin login</p></div>' +
    '<div class="section">' +
    '<label>Username</label><input type="text" id="loginUser" autocomplete="username">' +
    '<label>Password</label><input type="password" id="loginPass" autocomplete="current-password">' +
    '<div class="field-msg">' + escapeHtml(UI.loginError) + '</div>' +
    '<button class="btn-primary" id="loginBtn">Log in</button>' +
    '</div></div>';
}

function renderQrViewer(attendeeId) {
  const att = UI.guests.find(function (a) { return a.id === attendeeId; });
  if (!att) return '';
  return '<div style="background:var(--paper-2);border-radius:10px;padding:16px;margin-bottom:14px;text-align:center;">' +
    '<p style="margin:0 0 10px;font-size:13px;">QR for <b>' + escapeHtml(att.childName || att.parentName || 'Guest') + '</b> \u2014 scan it into the box below to test.</p>' +
    '<div class="qr-box" id="viewerQrBox" style="display:inline-block;"></div>' +
    '<div style="display:flex;gap:10px;justify-content:center;margin-top:10px;">' +
    '<button class="btn-secondary" style="width:auto;padding:8px 14px;" id="saveViewerQrBtn">Save this QR</button>' +
    '<button class="link-btn" id="closeViewerBtn">Close</button>' +
    '</div></div>';
}

function renderAdminAccounts() {
  const rows = UI.admins.map(function (a) {
    return '<div class="roster-row">' +
      '<span style="font-weight:500;">' + escapeHtml(a.username) + '</span>' +
      (UI.admins.length > 1 ? '<button class="remove" data-removeadmin="' + escapeHtml(a.id) + '">Remove</button>' : '<span style="font-size:12px;color:#a3aca6;">only login</span>') +
      '</div>';
  }).join('');
  return '<h2>Admin logins</h2>' + rows +
    '<label style="margin-top:14px;">New admin username</label>' +
    '<input type="text" id="newAdminUser" autocomplete="off">' +
    '<label>New admin password</label>' +
    '<input type="password" id="newAdminPass" autocomplete="new-password">' +
    '<div class="field-msg" id="newAdminMsg">' + escapeHtml(UI.adminMsg) + '</div>' +
    '<button class="btn-secondary" id="addAdminBtn" style="margin-top:6px;">Add admin login</button>';
}

function renderAdminDashboard() {
  const ev = UI.adminEvents.find(function (e) { return e.id === UI.adminManagingEventId; }) || null;
  const options = UI.adminEvents.map(function (e) {
    return '<option value="' + escapeHtml(e.id) + '"' + (ev && e.id === ev.id ? ' selected' : '') + '>' + escapeHtml(e.name) + '</option>';
  }).join('');

  let body = '';
  if (!ev) {
    body = '<p class="empty">Create an event to get started.</p>';
  } else {
    const shareLink = eventUrl(ev.id);
    body =
      '<div class="count-row" style="margin-bottom:14px;">' +
        '<span class="count-num" style="font-size:26px;">' + ev.registeredCount + '</span><span class="count-label">registered</span>' +
        '<span style="margin-left:14px;" class="count-num" style="font-size:26px;">' + ev.arrivedCount + '</span><span class="count-label">arrived</span>' +
      '</div>' +
      '<div class="qr-wrap" style="padding:0 0 18px;">' +
        '<div class="qr-box" id="adminQrBox"></div>' +
        '<p class="qr-caption">Share this to let people register for <b>' + escapeHtml(ev.name) + '</b>.</p>' +
        '<button class="btn-secondary" id="copyEventLinkBtn" style="margin-top:10px;">Copy check-in link</button>' +
        '<button class="btn-secondary" id="saveEventQrBtn" style="margin-top:8px;">Save this QR</button>' +
      '</div>' +
      '<div class="perf"></div>' +
      '<div style="padding-top:16px;">' +
        '<label>Scan or type a guest\u2019s QR code to mark them arrived</label>' +
        '<div class="scan-row"><input type="text" id="scanInput" placeholder="Scan here or type code" autocomplete="off">' +
        '<button class="btn-secondary" style="width:auto;padding:0 14px;" id="cameraScanBtn">\ud83d\udcf7 Camera</button></div>' +
        '<div class="scan-msg ' + (UI.scanOk ? 'ok' : 'err') + '">' + escapeHtml(UI.scanMsg) + '</div>' +
      '</div>' +
      '<div class="perf"></div>' +
      '<div style="padding-top:16px;">' +
        '<div class="admin-topbar"><h2 style="margin:0;">Guest list</h2>' +
        '<button class="link-btn" id="exportBtn">Export CSV</button></div>' +
        (UI.viewingQrForId ? renderQrViewer(UI.viewingQrForId) : '') +
        '<div class="roster-wrap"><table class="roster"><thead><tr>' +
        '<th>Parent</th><th>Child</th><th>Email</th><th>Phone</th><th>Registered</th><th>Status</th><th></th><th></th>' +
        '</tr></thead><tbody>' +
        (UI.guests.length === 0
          ? '<tr><td colspan="8" class="empty">No one registered yet.</td></tr>'
          : UI.guests.slice().reverse().map(function (a) {
              return '<tr>' +
                '<td>' + escapeHtml(a.parentName || '\u2014') + '</td>' +
                '<td>' + escapeHtml(a.childName || '\u2014') + '</td>' +
                '<td>' + escapeHtml(a.email) + '</td>' +
                '<td>' + escapeHtml(a.phone) + '</td>' +
                '<td>' + fmtTime(a.registeredAt) + '</td>' +
                '<td>' + (a.arrivedAt
                    ? '<span class="status-chip status-arrived">Arrived</span>'
                    : '<span class="status-chip status-pending">Pending</span>') + '</td>' +
                '<td><button class="link-btn" data-viewqr="' + escapeHtml(a.id) + '">View QR</button></td>' +
                '<td><button class="link-btn danger" data-remove="' + escapeHtml(a.id) + '">Remove</button></td>' +
              '</tr>';
            }).join('')) +
        '</tbody></table></div>' +
      '</div>';
  }

  return '<div class="card">' +
    '<div class="band"><p class="eyebrow">Organizer</p><p class="title-lg">Admin dashboard</p></div>' +
    '<div class="section">' +
    '<div class="event-switch-row">' +
      '<select id="eventSwitchSelect">' + (options || '<option value="">No events</option>') + '</select>' +
      '<button class="btn-secondary" style="width:auto;padding:10px 14px;" id="logoutBtn">Log out</button>' +
    '</div>' +
    '<div class="new-event-row">' +
      '<input type="text" id="newEventInput" placeholder="New event name">' +
      '<button class="btn-secondary" style="width:auto;" id="createEventBtn">Create</button>' +
    '</div>' +
    (ev
      ? (UI.confirmDeleteEventId === ev.id
          ? '<div style="margin-top:10px;padding:10px;background:#F7E9E7;border-radius:8px;">' +
              '<p style="margin:0 0 8px;font-size:13px;">Delete \u201c' + escapeHtml(ev.name) + '\u201d and its whole guest list? This can\u2019t be undone.</p>' +
              '<div style="display:flex;gap:10px;">' +
              '<button class="link-btn danger" id="confirmDeleteBtn">Yes, delete it</button>' +
              '<button class="link-btn" id="cancelDeleteBtn">Cancel</button>' +
              '</div></div>'
          : '<button class="link-btn danger" id="deleteEventBtn" style="margin-top:10px;">Delete this event</button>')
      : '') +
    '</div>' +
    '<div class="perf"></div>' +
    '<div class="section">' + body + '</div>' +
    '<div class="perf"></div>' +
    '<div class="section">' + renderAdminAccounts() + '</div>' +
    '</div>';
}

// ---------- QR drawing ----------

function drawQr(boxId, text) {
  try {
    const box = document.getElementById(boxId);
    if (!box) return;
    box.innerHTML = '';
    if (window.QRCode) {
      new QRCode(box, { text: text, width: 160, height: 160, colorDark: '#1B2420', colorLight: '#ffffff' });
    } else {
      box.innerHTML = '<div style="width:160px;height:160px;display:flex;align-items:center;justify-content:center;font-size:11px;color:#999;text-align:center;padding:6px;">QR unavailable</div>';
    }
  } catch (e) {}
}

function getQrBlob(boxId) {
  return new Promise(function (resolve, reject) {
    try {
      const box = document.getElementById(boxId);
      const canvas = box ? box.querySelector('canvas') : null;
      if (!canvas) { reject(new Error('no canvas')); return; }
      canvas.toBlob(function (blob) {
        if (blob) resolve(blob); else reject(new Error('toBlob failed'));
      }, 'image/png');
    } catch (e) { reject(e); }
  });
}

// ---------- common handlers ----------

function attachCommonHandlers() {
  const adminToggle = document.getElementById('adminToggleBtn');
  if (adminToggle) adminToggle.addEventListener('click', async function () {
    if (UI.view === 'adminDashboard' || UI.view === 'adminLogin') {
      UI.view = await pickDefaultView();
      render();
      return;
    }
    if (UI.adminToken) {
      try {
        await loadAdminEvents();
        UI.view = 'adminDashboard';
      } catch (e) {
        UI.adminToken = null;
        localStorage.removeItem('admin_token');
        UI.loginError = '';
        UI.view = 'adminLogin';
      }
    } else {
      UI.loginError = '';
      UI.view = 'adminLogin';
    }
    render();
  });
}

async function pickDefaultView() {
  if (UI.publicEvents.length === 0) return 'noEvents';
  const urlId = getUrlEventId();
  if (urlId && UI.publicEvents.some(function (e) { return e.id === urlId; })) {
    UI.currentEventId = urlId;
    UI.currentEventName = UI.publicEvents.find(function (e) { return e.id === urlId; }).name;
    return 'register';
  }
  if (UI.publicEvents.length === 1) {
    UI.currentEventId = UI.publicEvents[0].id;
    UI.currentEventName = UI.publicEvents[0].name;
    return 'register';
  }
  if (UI.currentEventId && UI.publicEvents.some(function (e) { return e.id === UI.currentEventId; })) return 'register';
  return 'picker';
}

// ---------- picker ----------

function attachPickerHandlers() {
  document.querySelectorAll('.event-pick').forEach(function (btn) {
    btn.addEventListener('click', function () {
      const id = btn.getAttribute('data-id');
      const ev = UI.publicEvents.find(function (e) { return e.id === id; });
      UI.currentEventId = id;
      UI.currentEventName = ev ? ev.name : '';
      UI.view = 'register';
      render();
    });
  });
}

// ---------- register ----------

function attachRegisterHandlers() {
  const btn = document.getElementById('submitRegBtn');
  if (btn) btn.addEventListener('click', doRegister);
}

function isValidEmail(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }

async function doRegister() {
  const parentName = (document.getElementById('fParent').value || '').trim();
  const childName = (document.getElementById('fChild').value || '').trim();
  const email = (document.getElementById('fEmail').value || '').trim();
  const phone = (document.getElementById('fPhone').value || '').trim();

  let ok = true;
  const emailInput = document.getElementById('fEmail');
  const phoneInput = document.getElementById('fPhone');
  const emailMsg = document.getElementById('fEmailMsg');
  const phoneMsg = document.getElementById('fPhoneMsg');
  emailInput.classList.remove('field-error');
  phoneInput.classList.remove('field-error');
  emailMsg.textContent = '';
  phoneMsg.textContent = '';

  if (!email || !isValidEmail(email)) {
    ok = false; emailInput.classList.add('field-error'); emailMsg.textContent = 'Enter a valid email address.';
  }
  if (!phone || phone.replace(/[^0-9]/g, '').length < 6) {
    ok = false; phoneInput.classList.add('field-error'); phoneMsg.textContent = 'Enter a valid phone number.';
  }
  if (!ok) return;

  const submitBtn = document.getElementById('submitRegBtn');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Saving…';
  try {
    const result = await api('/api/events/' + UI.currentEventId + '/register', {
      method: 'POST',
      body: { parentName: parentName, childName: childName, email: email, phone: phone }
    });
    UI.lastAttendeeId = result.id;
    UI.qrSaved = false;
    UI.view = 'qrConfirm';
    render();
  } catch (e) {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Check in';
    showToast(e.message || 'Could not register — try again');
  }
}

// ---------- qr confirm ----------

function attachQrHandlers() {
  drawQr('qrBox', UI.lastAttendeeId);
  const saveBtn = document.getElementById('saveQrBtn');
  if (saveBtn) saveBtn.addEventListener('click', function () { doSaveQr('qrBox'); });
  const finishBtn = document.getElementById('finishBtn');
  if (finishBtn) finishBtn.addEventListener('click', function () {
    UI.lastAttendeeId = null;
    UI.qrSaved = false;
    UI.view = 'register';
    render();
    showToast('All set \u2014 see you there!');
  });
}

async function doSaveQr(boxId) {
  try {
    const blob = await getQrBlob(boxId);
    downloadBlob(blob, 'checkin-qr-' + UI.lastAttendeeId + '.png');
    UI.qrSaved = true;
    showToast('QR saved');
    render();
  } catch (e) {
    showToast('Couldn\u2019t save \u2014 try a screenshot instead');
  }
}

// ---------- admin login ----------

function attachAdminLoginHandlers() {
  const btn = document.getElementById('loginBtn');
  const pass = document.getElementById('loginPass');
  async function tryLogin() {
    const u = (document.getElementById('loginUser').value || '').trim();
    const p = (document.getElementById('loginPass').value || '');
    try {
      const result = await api('/api/admin/login', { method: 'POST', body: { username: u, password: p } });
      UI.adminToken = result.token;
      localStorage.setItem('admin_token', result.token);
      UI.loginError = '';
      await loadAdminEvents();
      UI.view = 'adminDashboard';
      render();
    } catch (e) {
      UI.loginError = e.message || 'Incorrect username or password.';
      render();
    }
  }
  if (btn) btn.addEventListener('click', tryLogin);
  if (pass) pass.addEventListener('keydown', function (e) { if (e.key === 'Enter') tryLogin(); });
}

async function loadAdminEvents() {
  UI.adminEvents = await api('/api/admin/events');
  UI.admins = await api('/api/admin/admins');
  if (!UI.adminManagingEventId || !UI.adminEvents.some(function (e) { return e.id === UI.adminManagingEventId; })) {
    UI.adminManagingEventId = UI.currentEventId && UI.adminEvents.some(function (e) { return e.id === UI.currentEventId; })
      ? UI.currentEventId
      : (UI.adminEvents[0] ? UI.adminEvents[0].id : null);
  }
  if (UI.adminManagingEventId) {
    UI.guests = await api('/api/admin/events/' + UI.adminManagingEventId + '/guests');
  } else {
    UI.guests = [];
  }
}

// ---------- admin dashboard ----------

function attachAdminDashboardHandlers() {
  const ev = UI.adminEvents.find(function (e) { return e.id === UI.adminManagingEventId; });

  if (ev) {
    drawQr('adminQrBox', eventUrl(ev.id));
    const copyBtn = document.getElementById('copyEventLinkBtn');
    if (copyBtn) copyBtn.addEventListener('click', async function () {
      try { await navigator.clipboard.writeText(eventUrl(ev.id)); showToast('Link copied'); }
      catch (e) { showToast('Could not copy link'); }
    });
    const saveQrBtn = document.getElementById('saveEventQrBtn');
    if (saveQrBtn) saveQrBtn.addEventListener('click', async function () {
      try {
        const blob = await getQrBlob('adminQrBox');
        downloadBlob(blob, (ev.name.replace(/[^a-z0-9]+/gi, '_') || 'event') + '-checkin-qr.png');
        showToast('QR saved');
      } catch (e) { showToast('Could not save QR'); }
    });

    const scanInput = document.getElementById('scanInput');
    if (scanInput) {
      scanInput.focus();
      scanInput.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter') return;
        const code = (scanInput.value || '').trim();
        scanInput.value = '';
        processScanCode(ev.id, code);
      });
    }

    const cameraScanBtn = document.getElementById('cameraScanBtn');
    if (cameraScanBtn) cameraScanBtn.addEventListener('click', function () { openCameraScanner(ev.id); });

    document.querySelectorAll('[data-viewqr]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        UI.viewingQrForId = btn.getAttribute('data-viewqr');
        render();
      });
    });

    if (UI.viewingQrForId) {
      drawQr('viewerQrBox', UI.viewingQrForId);
      const closeBtn = document.getElementById('closeViewerBtn');
      if (closeBtn) closeBtn.addEventListener('click', function () { UI.viewingQrForId = null; render(); });
      const saveViewerBtn = document.getElementById('saveViewerQrBtn');
      if (saveViewerBtn) saveViewerBtn.addEventListener('click', async function () {
        try {
          const blob = await getQrBlob('viewerQrBox');
          downloadBlob(blob, 'checkin-qr-' + UI.viewingQrForId + '.png');
          showToast('QR saved');
        } catch (e) { showToast('Could not save QR'); }
      });
    }

    document.querySelectorAll('[data-remove]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        const id = btn.getAttribute('data-remove');
        try {
          await api('/api/admin/events/' + ev.id + '/guests/' + id, { method: 'DELETE' });
          await loadAdminEvents();
          render();
        } catch (e) { showToast(e.message || 'Could not remove guest'); }
      });
    });

    const exportBtn = document.getElementById('exportBtn');
    if (exportBtn) exportBtn.addEventListener('click', async function () {
      try {
        const res = await fetch('/api/admin/events/' + ev.id + '/export.csv', {
          headers: { Authorization: 'Bearer ' + UI.adminToken }
        });
        if (!res.ok) throw new Error('Export failed');
        const blob = await res.blob();
        downloadBlob(blob, (ev.name.replace(/[^a-z0-9]+/gi, '_') || 'event') + '_guests.csv');
        showToast('Export ready');
      } catch (e) { showToast('Could not export'); }
    });

    const deleteEventBtn = document.getElementById('deleteEventBtn');
    if (deleteEventBtn) deleteEventBtn.addEventListener('click', function () {
      UI.confirmDeleteEventId = ev.id;
      render();
    });
    const confirmDeleteBtn = document.getElementById('confirmDeleteBtn');
    if (confirmDeleteBtn) confirmDeleteBtn.addEventListener('click', async function () {
      try {
        await api('/api/admin/events/' + ev.id, { method: 'DELETE' });
        UI.confirmDeleteEventId = null;
        UI.adminManagingEventId = null;
        await loadAdminEvents();
        render();
      } catch (e) { showToast(e.message || 'Could not delete event'); }
    });
    const cancelDeleteBtn = document.getElementById('cancelDeleteBtn');
    if (cancelDeleteBtn) cancelDeleteBtn.addEventListener('click', function () { UI.confirmDeleteEventId = null; render(); });
  }

  const select = document.getElementById('eventSwitchSelect');
  if (select) select.addEventListener('change', async function () {
    UI.adminManagingEventId = select.value;
    UI.scanMsg = '';
    UI.confirmDeleteEventId = null;
    UI.viewingQrForId = null;
    UI.guests = await api('/api/admin/events/' + UI.adminManagingEventId + '/guests');
    render();
  });

  const createBtn = document.getElementById('createEventBtn');
  if (createBtn) createBtn.addEventListener('click', async function () {
    const input = document.getElementById('newEventInput');
    const name = (input.value || '').trim();
    if (!name) { input.focus(); return; }
    try {
      const newEv = await api('/api/admin/events', { method: 'POST', body: { name: name } });
      UI.adminManagingEventId = newEv.id;
      await loadAdminEvents();
      render();
    } catch (e) { showToast(e.message || 'Could not create event'); }
  });

  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) logoutBtn.addEventListener('click', async function () {
    try { await api('/api/admin/logout', { method: 'POST' }); } catch (e) {}
    UI.adminToken = null;
    localStorage.removeItem('admin_token');
    UI.view = await pickDefaultView();
    render();
  });

  const addAdminBtn = document.getElementById('addAdminBtn');
  if (addAdminBtn) addAdminBtn.addEventListener('click', async function () {
    const uInput = document.getElementById('newAdminUser');
    const pInput = document.getElementById('newAdminPass');
    const u = (uInput.value || '').trim();
    const p = pInput.value || '';
    try {
      await api('/api/admin/admins', { method: 'POST', body: { username: u, password: p } });
      UI.adminMsg = '';
      showToast('Admin login added');
      await loadAdminEvents();
      render();
    } catch (e) {
      UI.adminMsg = e.message || 'Could not add admin login.';
      render();
    }
  });

  document.querySelectorAll('[data-removeadmin]').forEach(function (btn) {
    btn.addEventListener('click', async function () {
      try {
        await api('/api/admin/admins/' + btn.getAttribute('data-removeadmin'), { method: 'DELETE' });
        await loadAdminEvents();
        render();
      } catch (e) { showToast(e.message || 'Could not remove admin'); }
    });
  });
}

// ---------- camera scanning ----------

function processScanCode(eventId, rawCode) {
  const code = (rawCode || '').trim();
  if (!code) return;
  api('/api/admin/events/' + eventId + '/scan', { method: 'POST', body: { code: code } })
    .then(function (result) {
      UI.scanOk = true;
      const a = result.attendee;
      UI.scanMsg = '\u2713 Marked arrived: ' + (a.childName || a.parentName || 'Guest');
      return loadAdminEvents();
    })
    .catch(function (e) {
      UI.scanOk = false;
      UI.scanMsg = e.message || 'Code not recognized for this event.';
    })
    .finally(function () {
      render();
      const si = document.getElementById('scanInput');
      if (si) si.focus();
    });
}

function openCameraScanner(eventId) {
  if (!window.jsQR) { showToast('Camera scanning library failed to load \u2014 use manual entry instead'); return; }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showToast('Camera isn\u2019t available in this browser \u2014 use manual entry instead');
    return;
  }

  const overlay = document.createElement('div');
  overlay.id = 'cameraOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(15,20,18,0.92);z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;';
  overlay.innerHTML =
    '<video id="camVideo" playsinline muted style="width:100%;max-width:340px;border-radius:14px;background:#000;"></video>' +
    '<p id="camStatus" style="color:#F3F1E6;font-size:13.5px;margin-top:14px;text-align:center;max-width:320px;">Point the camera at the guest\u2019s QR code</p>' +
    '<button id="camStopBtn" style="margin-top:16px;padding:11px 20px;border-radius:10px;border:none;background:#F3F1E6;color:#1B2420;font-family:inherit;font-size:14px;cursor:pointer;">Cancel</button>';
  document.body.appendChild(overlay);

  const video = document.getElementById('camVideo');
  const statusEl = document.getElementById('camStatus');
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let stream = null;
  let stopped = false;

  function cleanup() {
    if (stopped) return;
    stopped = true;
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
  }
  document.getElementById('camStopBtn').addEventListener('click', cleanup);

  function tick() {
    if (stopped) return;
    if (video.readyState === video.HAVE_ENOUGH_DATA) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      try {
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const result = window.jsQR(imageData.data, imageData.width, imageData.height);
        if (result && result.data) {
          const code = result.data;
          cleanup();
          processScanCode(eventId, code);
          return;
        }
      } catch (e) {}
    }
    requestAnimationFrame(tick);
  }

  navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
    .then(function (s) {
      if (stopped) { s.getTracks().forEach(function (t) { t.stop(); }); return; }
      stream = s;
      video.srcObject = s;
      video.play().catch(function () {});
      requestAnimationFrame(tick);
    })
    .catch(function (err) {
      statusEl.textContent = 'Couldn\u2019t access the camera (' + (err && err.name ? err.name : 'unknown error') +
        '). Check camera permission, or use manual entry instead.';
    });
}

// ---------- init ----------

async function init() {
  try {
    UI.publicEvents = await api('/api/events');
    UI.view = await pickDefaultView();
    render();
  } catch (e) {
    const root = document.getElementById('root');
    root.innerHTML = '<div class="card"><div class="section" style="padding-top:22px;">' +
      '<p class="title-lg" style="font-size:18px;">Something went wrong loading this page.</p>' +
      '<p class="empty">Check that the server is running, then reload.</p></div></div>';
  }
}

init();
