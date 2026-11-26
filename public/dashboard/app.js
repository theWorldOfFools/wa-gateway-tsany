/* global window, document, fetch, FormData, Headers, URLSearchParams */

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) =>
  Array.from(root.querySelectorAll(selector));

const VIEW_NAMES = new Set([
  'overview',
  'sessions',
  'send',
  'history',
  'analytics',
  'webhook',
  'keys',
  'account'
]);

const STATUS_LABELS = {
  pending: 'Menunggu',
  qr: 'Scan QR',
  connected: 'Terhubung',
  disconnected: 'Terputus',
  logged_out: 'Logout',
  error: 'Error'
};

const MESSAGE_STATUS_LABELS = {
  queued: 'Antrean',
  sending: 'Mengirim',
  sent: 'Terkirim',
  delivered: 'Diterima',
  read: 'Dibaca',
  failed: 'Gagal',
  received: 'Masuk'
};

const KIND_LABELS = {
  text: 'Teks',
  image: 'Gambar',
  video: 'Video',
  interactive: 'Interaktif',
  interactive_reply: 'Balasan interaktif',
  other: 'Lainnya'
};

const WEBHOOK_EVENTS = {
  'session.qr': 'QR sesi baru',
  'session.connected': 'Sesi terhubung',
  'session.disconnected': 'Sesi terputus',
  'session.logged_out': 'Sesi logout',
  'message.received': 'Pesan masuk',
  'message.status': 'Status pesan',
  'analysis.completed': 'Analisa selesai',
  'analysis.failed': 'Analisa gagal'
};

const DEFAULT_SECTIONS = JSON.stringify(
  [
    {
      title: 'Layanan',
      rows: [
        { id: 'basic', title: 'Paket Basic', description: '1 nomor' },
        { id: 'pro', title: 'Paket Pro', description: '5 nomor' }
      ]
    }
  ],
  null,
  2
);

const state = {
  user: null,
  tenant: null,
  sessions: [],
  sessionsSignature: null,
  selectedSessionId: null,
  view: 'overview',
  history: [],
  historyHasMore: false,
  historyLoading: false,
  analysisEnabled: true,
  analysisResults: new Map(),
  groups: [],
  filteredGroups: [],
  qrTimer: null,
  pairingTimer: null
};

const dateTimeFormatter = new Intl.DateTimeFormat('id-ID', {
  dateStyle: 'medium',
  timeStyle: 'short'
});

const timeFormatter = new Intl.DateTimeFormat('id-ID', {
  hour: '2-digit',
  minute: '2-digit'
});

/* ---------- Utilities ---------- */

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : dateTimeFormatter.format(date);
}

function formatTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : timeFormatter.format(date);
}

function statusLabel(status) {
  return STATUS_LABELS[status] ?? 'Tidak diketahui';
}

function statusClass(status) {
  return Object.prototype.hasOwnProperty.call(STATUS_LABELS, status)
    ? status
    : 'pending';
}

function messageStatusClass(status) {
  return Object.prototype.hasOwnProperty.call(MESSAGE_STATUS_LABELS, status)
    ? status
    : 'pending';
}

function kindLabel(kind) {
  return KIND_LABELS[kind] ?? 'Lainnya';
}

function toast(message, type = 'info') {
  const root = $('#toast-root');
  const element = document.createElement('div');
  element.className = `toast is-${type}`;
  element.textContent = message;
  root.appendChild(element);
  window.setTimeout(() => element.remove(), 4_800);
}

function showFormError(element, message) {
  element.textContent = message;
  element.hidden = false;
}

function clearFormError(element) {
  element.textContent = '';
  element.hidden = true;
}

function setBusy(element, busy, label = 'Memproses...') {
  if (!element) return;
  if (busy) {
    if (!element.dataset.idleLabel) {
      element.dataset.idleLabel = element.textContent;
    }
    element.disabled = true;
    element.textContent = label;
  } else {
    element.disabled = false;
    if (element.dataset.idleLabel) {
      element.textContent = element.dataset.idleLabel;
      delete element.dataset.idleLabel;
    }
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Disalin ke clipboard', 'success');
    return;
  } catch {
    // Fall back to a hidden textarea for non-secure contexts.
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.className = 'copy-helper';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    document.execCommand('copy');
    toast('Disalin ke clipboard', 'success');
  } catch {
    toast('Gagal menyalin. Salin manual dari kotak teks.', 'error');
  } finally {
    textarea.remove();
  }
}

async function api(path, options = {}) {
  const method = (options.method ?? 'GET').toUpperCase();
  const headers = new Headers(options.headers ?? {});

  if (
    options.body !== undefined &&
    !(options.body instanceof FormData) &&
    !headers.has('content-type')
  ) {
    headers.set('content-type', 'application/json');
  }
  if (method !== 'GET' && method !== 'HEAD') {
    headers.set('x-dashboard-request', '1');
  }

  const response = await fetch(path, {
    ...options,
    method,
    headers,
    credentials: 'same-origin'
  });

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }

  if (!response.ok) {
    const error = new Error(
      data?.error?.message || `Permintaan gagal (HTTP ${response.status})`
    );
    error.status = response.status;
    error.code = data?.error?.code;
    error.details = data?.error?.details;

    if (response.status === 401 && state.user) {
      handleExpiredSession();
    }
    throw error;
  }

  return data;
}

function formatError(error) {
  if (!error) return 'Terjadi kesalahan';
  if (Array.isArray(error.details)) {
    const details = error.details
      .map((item) => `${item.path ? `${item.path}: ` : ''}${item.message}`)
      .join('; ');
    if (details) return `${error.message} (${details})`;
  }
  return error.message || 'Terjadi kesalahan';
}

function handleExpiredSession() {
  if ($('#app-view').hidden) return;
  showAuth();
  toast('Sesi login berakhir. Silakan masuk kembali.', 'error');
}

function emptyState(title, message) {
  return `<div class="empty-state"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(message)}</span></div>`;
}

/* ---------- Modal ---------- */

function stopQrPolling() {
  if (state.qrTimer) {
    window.clearInterval(state.qrTimer);
    state.qrTimer = null;
  }
}

function stopPairingPolling() {
  if (state.pairingTimer) {
    window.clearInterval(state.pairingTimer);
    state.pairingTimer = null;
  }
}

function openModal(title, html) {
  stopQrPolling();
  stopPairingPolling();

  $('#modal-title').textContent = title;
  const body = $('#modal-body');
  body.innerHTML = html;
  $('#modal-root').hidden = false;
  document.body.classList.add('modal-open');

  const firstField = body.querySelector('input, select, textarea, button');
  if (firstField instanceof HTMLElement) {
    window.setTimeout(() => firstField.focus(), 30);
  }
}

function closeModal() {
  stopQrPolling();
  stopPairingPolling();
  $('#modal-root').hidden = true;
  $('#modal-body').innerHTML = '';
  document.body.classList.remove('modal-open');
}

/* ---------- Authentication ---------- */

function switchAuthTab(tabName) {
  $$('.tab[data-auth-tab]').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.authTab === tabName);
  });

  $('#login-form').hidden = tabName !== 'login';
  $('#register-form').hidden = tabName !== 'register';
  $('#setup-form').hidden = tabName !== 'setup';

  const activeForm = {
    login: '#login-email',
    register: '#register-tenant',
    setup: '#setup-key'
  }[tabName];

  if (activeForm) window.setTimeout(() => $(activeForm)?.focus(), 20);
}

function showAuth() {
  stopQrPolling();
  stopPairingPolling();
  closeModal();

  state.user = null;
  state.tenant = null;
  state.sessions = [];
  state.sessionsSignature = null;
  state.selectedSessionId = null;
  state.history = [];
  state.historyHasMore = false;

  $('#app-view').hidden = true;
  $('#auth-view').hidden = false;
  document.title = 'Masuk — WhatsApp Gateway';
  switchAuthTab('login');
}

function showApp() {
  $('#auth-view').hidden = true;
  $('#app-view').hidden = false;
  document.title = 'Dashboard — WhatsApp Gateway';
  renderUser();
}

function renderUser() {
  const name = state.user?.name || state.user?.email || 'Pengguna';
  $('#user-name').textContent = name;
  $('#user-email').textContent = state.user?.email || '';
  $('#user-initial').textContent = name.trim().charAt(0).toUpperCase() || 'U';
  $('#tenant-name').textContent = state.tenant?.name || 'Tenant';
}

async function enterApp() {
  showApp();
  await loadSessions();

  const requestedView = window.location.hash.replace('#', '');
  setView(VIEW_NAMES.has(requestedView) ? requestedView : 'overview', {
    updateHash: false
  });
}

/* ---------- Navigation ---------- */

function setView(viewName, options = {}) {
  const name = VIEW_NAMES.has(viewName) ? viewName : 'overview';
  state.view = name;

  $$('.view').forEach((view) => {
    view.hidden = view.id !== `view-${name}`;
  });
  $$('.nav-item').forEach((item) => {
    item.classList.toggle('active', item.dataset.view === name);
  });

  if (options.updateHash !== false) {
    window.history.replaceState(null, '', `#${name}`);
  }

  if (name === 'overview' || name === 'sessions') {
    renderOverview();
    renderSessionList();
  } else if (name === 'send') {
    syncSendForm();
  } else if (name === 'history') {
    loadHistory({ reset: true });
  } else if (name === 'analytics') {
    loadAnalytics();
  } else if (name === 'webhook') {
    loadWebhookConfig();
  } else if (name === 'keys') {
    loadApiKeys();
  } else if (name === 'account') {
    renderAccount();
  }
}

/* ---------- Sessions ---------- */

function selectedSession() {
  return (
    state.sessions.find((session) => session.id === state.selectedSessionId) ??
    null
  );
}

function setSelectedSession(sessionId) {
  state.selectedSessionId = sessionId || null;
  const sessionSelectors =
    '#send-session, #history-session, #webhook-session, #analytics-session, #analysis-text-session';
  $$(sessionSelectors).forEach((select) => {
    if (
      sessionId &&
      Array.from(select.options).some((option) => option.value === sessionId)
    ) {
      select.value = sessionId;
    }
  });
}

function renderSessionSelectors() {
  const options = state.sessions.length
    ? state.sessions
        .map(
          (session) =>
            `<option value="${escapeHtml(session.id)}">${escapeHtml(
              session.name
            )} — ${escapeHtml(statusLabel(session.status))}</option>`
        )
        .join('')
    : '<option value="">Belum ada sesi</option>';

  const sessionSelectors =
    '#send-session, #history-session, #webhook-session, #analytics-session, #analysis-text-session';
  $$(sessionSelectors).forEach((select) => {
    const preferred = state.selectedSessionId;
    select.innerHTML = options;
    select.disabled = state.sessions.length === 0;

    if (
      preferred &&
      Array.from(select.options).some((option) => option.value === preferred)
    ) {
      select.value = preferred;
    }
  });
}

async function loadSessions(options = {}) {
  const quiet = options.quiet === true;
  try {
    const data = await api('/v1/sessions');
    const sessions = Array.isArray(data.data) ? data.data : [];
    const signature = sessions
      .map(
        (session) =>
          `${session.id}:${session.name}:${session.status}:${
            session.phoneNumber ?? ''
          }:${session.qrAvailable ? '1' : '0'}:${
            session.webhook?.url ?? ''
          }:${session.lastError ?? ''}`
      )
      .join('|');

    state.sessions = sessions;

    if (
      !state.selectedSessionId ||
      !sessions.some((session) => session.id === state.selectedSessionId)
    ) {
      const preferred =
        sessions.find((session) => session.status === 'connected') ??
        sessions[0] ??
        null;
      state.selectedSessionId = preferred?.id ?? null;
    }

    if (signature !== state.sessionsSignature) {
      state.sessionsSignature = signature;
      renderOverview();
      renderSessionList();
      renderSessionSelectors();
    }

    return sessions;
  } catch (error) {
    if (!quiet) toast(formatError(error), 'error');
    return state.sessions;
  }
}

function renderOverview() {
  const sessions = state.sessions;
  const connected = sessions.filter(
    (session) => session.status === 'connected'
  ).length;
  const errors = sessions.filter((session) => session.status === 'error').length;
  const attention = sessions.filter((session) =>
    ['qr', 'pending', 'disconnected', 'logged_out'].includes(session.status)
  ).length;

  $('#stat-total').textContent = String(sessions.length);
  $('#stat-connected').textContent = String(connected);
  $('#stat-attention').textContent = String(attention);
  $('#stat-errors').textContent = String(errors);

  const pill = $('#connection-pill');
  if (sessions.length === 0) {
    pill.textContent = 'Belum ada sesi';
    pill.classList.remove('online');
  } else if (connected > 0) {
    pill.textContent = `${connected}/${sessions.length} terhubung`;
    pill.classList.add('online');
  } else {
    pill.textContent = `${sessions.length} sesi, belum terhubung`;
    pill.classList.remove('online');
  }

  const root = $('#overview-sessions');
  if (sessions.length === 0) {
    root.innerHTML = emptyState(
      'Belum ada sesi',
      'Tambahkan nomor WhatsApp pertama dari menu Sesi.'
    );
    return;
  }

  root.innerHTML = sessions
    .slice(0, 5)
    .map((session) => {
      const status = statusClass(session.status);
      const subtitle =
        session.phoneNumber ||
        session.jid ||
        (session.qrAvailable ? 'QR siap dipindai' : 'Belum terhubung');
      return `
        <div class="mini-item">
          <div>
            <strong>${escapeHtml(session.name)}</strong>
            <small>${escapeHtml(subtitle)}</small>
          </div>
          <span class="badge badge-${status}">${escapeHtml(
            statusLabel(session.status)
          )}</span>
        </div>`;
    })
    .join('');
}

function renderSessionList() {
  const root = $('#session-list');
  if (!state.sessions.length) {
    root.innerHTML = emptyState(
      'Belum ada sesi',
      'Buat sesi baru di formulir atas untuk mulai menautkan nomor WhatsApp.'
    );
    return;
  }

  root.innerHTML = state.sessions
    .map((session) => {
      const status = statusClass(session.status);
      const isConnected = session.status === 'connected';
      const subtitle =
        session.phoneNumber ||
        session.jid ||
        (session.status === 'qr' ? 'Menunggu scan QR' : 'Belum terhubung');

      const actions = [];
      if (isConnected) {
        actions.push(
          `<button type="button" class="btn btn-primary btn-sm" data-action="send" data-id="${escapeHtml(
            session.id
          )}">Kirim pesan</button>`
        );
      } else {
        actions.push(
          `<button type="button" class="btn btn-primary btn-sm" data-action="qr" data-id="${escapeHtml(
            session.id
          )}">Scan QR</button>`
        );
        actions.push(
          `<button type="button" class="btn btn-ghost btn-sm" data-action="pairing" data-id="${escapeHtml(
            session.id
          )}">Pairing code</button>`
        );
        actions.push(
          `<button type="button" class="btn btn-ghost btn-sm" data-action="reconnect" data-id="${escapeHtml(
            session.id
          )}">Reconnect</button>`
        );
      }
      actions.push(
        `<button type="button" class="btn btn-ghost btn-sm" data-action="webhook" data-id="${escapeHtml(
          session.id
        )}">Webhook</button>`
      );
      if (isConnected) {
        actions.push(
          `<button type="button" class="btn btn-ghost btn-sm" data-action="logout" data-id="${escapeHtml(
            session.id
          )}">Logout</button>`
        );
      }
      actions.push(
        `<button type="button" class="btn btn-danger btn-sm" data-action="delete" data-id="${escapeHtml(
          session.id
        )}">Hapus</button>`
      );

      return `
        <article class="session-card is-${status}">
          <div class="session-card-head">
            <div>
              <h3>${escapeHtml(session.name)}</h3>
              <p>${escapeHtml(subtitle)}</p>
            </div>
            <span class="badge badge-${status}">${escapeHtml(
              statusLabel(session.status)
            )}</span>
          </div>
          <div class="session-meta">
            <span><span class="activity-dot ${
              isConnected ? 'on' : ''
            }"></span>${isConnected ? 'Koneksi aktif' : 'Koneksi tidak aktif'}</span>
            <span>Dibuat ${escapeHtml(formatDateTime(session.createdAt))}</span>
            ${
              session.webhook?.url
                ? '<span>Webhook aktif</span>'
                : '<span>Tanpa webhook</span>'
            }
          </div>
          ${
            session.lastError
              ? `<p class="session-error">${escapeHtml(session.lastError)}</p>`
              : ''
          }
          <div class="session-actions">${actions.join('')}</div>
        </article>`;
    })
    .join('');
}

async function runButtonAction(button, action) {
  setBusy(button, true, 'Memproses...');
  try {
    await action();
  } catch (error) {
    toast(formatError(error), 'error');
  } finally {
    setBusy(button, false);
  }
}

async function openQrModal(session) {
  openModal(
    `Scan QR — ${session.name}`,
    `<div class="qr-area">
       <div id="qr-loading" class="spinner"></div>
       <img id="qr-image" alt="QR WhatsApp" hidden />
       <p id="qr-status" class="qr-help">Menyiapkan QR...</p>
     </div>
     <p class="field-hint">
       Buka WhatsApp di ponsel &gt; Perangkat tertaut &gt; Tautkan perangkat,
       lalu pindai QR ini. QR berganti otomatis.
     </p>
     <div class="modal-actions">
       <button id="qr-refresh" type="button" class="btn btn-ghost btn-sm">Muat ulang QR</button>
       <button type="button" class="btn btn-ghost btn-sm" data-close-modal>Tutup</button>
     </div>`
  );

  const image = $('#qr-image');
  const loading = $('#qr-loading');
  const status = $('#qr-status');
  const refresh = $('#qr-refresh');
  const sessionId = session.id;
  let finished = false;

  const tick = async () => {
    if ($('#modal-root').hidden) return;
    try {
      const detail = await api(`/v1/sessions/${encodeURIComponent(sessionId)}`);
      const current = detail.session;

      if (current.status === 'connected') {
        finished = true;
        stopQrPolling();
        image.hidden = true;
        loading.hidden = true;
        status.textContent = 'Berhasil terhubung ke WhatsApp.';
        toast('Sesi WhatsApp terhubung', 'success');
        await loadSessions({ quiet: true });
        return;
      }

      if (current.status === 'logged_out') {
        finished = true;
        stopQrPolling();
        image.hidden = true;
        loading.hidden = true;
        status.textContent =
          'Sesi sudah logout. Tutup dialog lalu gunakan Reconnect untuk menautkan ulang.';
        return;
      }

      try {
        const qr = await api(
          `/v1/sessions/${encodeURIComponent(sessionId)}/qr`
        );
        image.src = qr.dataUrl;
        image.hidden = false;
        loading.hidden = true;
        status.textContent = `QR diperbarui ${formatTime(
          qr.updatedAt
        )}. Status sesi: ${statusLabel(qr.status)}.`;
      } catch (error) {
        image.hidden = true;
        loading.hidden = true;
        if (error.code === 'qr_unavailable') {
          const currentStatus = error.details?.status || current.status;
          status.textContent = `Menunggu QR tersedia. Status sesi: ${statusLabel(
            currentStatus
          )}.`;
        } else {
          status.textContent = formatError(error);
        }
      }
    } catch (error) {
      loading.hidden = true;
      image.hidden = true;
      status.textContent = formatError(error);
    }
  };

  refresh.addEventListener('click', () => {
    setBusy(refresh, true, 'Memuat...');
    void tick().finally(() => setBusy(refresh, false));
  });

  await tick();
  if (!finished && !$('#modal-root').hidden) {
    state.qrTimer = window.setInterval(tick, 4_000);
  }
}

function openPairingModal(session) {
  openModal(
    `Pairing code — ${session.name}`,
    `<label class="field">
       <span>Nomor WhatsApp</span>
       <input id="pairing-phone" type="tel" inputmode="numeric" placeholder="6281234567890" autocomplete="tel" />
       <small class="field-hint">Gunakan kode negara tanpa tanda +. Contoh: 6281234567890.</small>
     </label>
     <div class="modal-actions">
       <button id="pairing-submit" type="button" class="btn btn-primary">Minta kode</button>
       <button type="button" class="btn btn-ghost" data-close-modal>Tutup</button>
     </div>
     <div id="pairing-result" class="qr-area" hidden></div>`
  );

  const phone = $('#pairing-phone');
  const submit = $('#pairing-submit');
  const result = $('#pairing-result');
  const sessionId = session.id;

  submit.addEventListener('click', async () => {
    const phoneNumber = phone.value.trim();
    if (!/^\d{7,15}$/.test(phoneNumber.replace(/\D/g, ''))) {
      toast('Masukkan 7-15 digit nomor WhatsApp', 'error');
      return;
    }

    setBusy(submit, true, 'Meminta...');
    try {
      const data = await api(
        `/v1/sessions/${encodeURIComponent(sessionId)}/pairing-code`,
        {
          method: 'POST',
          body: JSON.stringify({ phoneNumber })
        }
      );

      result.hidden = false;
      result.innerHTML = `
        <p class="field-hint">Masukkan kode ini di WhatsApp ponsel:</p>
        <div class="pairing-code">${escapeHtml(data.pairingCode)}</div>
        <p class="field-hint">${escapeHtml(data.instructions || '')}</p>
        <button type="button" class="btn btn-ghost btn-sm" data-copy="${escapeHtml(
          data.pairingCode
        )}">Salin kode</button>
        <p id="pairing-poll" class="field-hint">Menunggu koneksi...</p>`;

      stopPairingPolling();
      state.pairingTimer = window.setInterval(async () => {
        if ($('#modal-root').hidden) {
          stopPairingPolling();
          return;
        }
        try {
          const detail = await api(
            `/v1/sessions/${encodeURIComponent(sessionId)}`
          );
          if (detail.session.status === 'connected') {
            stopPairingPolling();
            const poll = $('#pairing-poll');
            if (poll) poll.textContent = 'Berhasil terhubung ke WhatsApp.';
            toast('Sesi WhatsApp terhubung', 'success');
            await loadSessions({ quiet: true });
          }
        } catch {
          // Keep the pairing dialog usable; next tick may succeed.
        }
      }, 4_000);
    } catch (error) {
      toast(formatError(error), 'error');
    } finally {
      setBusy(submit, false);
    }
  });
}

async function openGroupsModal(button) {
  const sessionId = state.selectedSessionId;
  if (!sessionId) {
    toast('Pilih sesi terlebih dahulu', 'error');
    return;
  }

  setBusy(button, true, 'Memuat...');
  try {
    const data = await api(
      `/v1/sessions/${encodeURIComponent(sessionId)}/groups`
    );
    state.groups = Array.isArray(data.data) ? data.data : [];
    state.filteredGroups = state.groups;

    openModal(
      'Pilih grup',
      `<input id="group-search" class="group-search" type="text" placeholder="Cari nama grup..." />
       <ul id="group-list" class="group-list"></ul>
       <p id="group-empty" class="field-hint" hidden>Tidak ada grup yang cocok.</p>`
    );

    const search = $('#group-search');
    const list = $('#group-list');
    const empty = $('#group-empty');

    const render = (query) => {
      const normalized = query.trim().toLowerCase();
      state.filteredGroups = state.groups.filter((group) =>
        (group.subject || '').toLowerCase().includes(normalized)
      );

      if (!state.filteredGroups.length) {
        list.innerHTML = '';
        empty.hidden = false;
        return;
      }

      empty.hidden = true;
      list.innerHTML = state.filteredGroups
        .map(
          (group, index) => `
            <li>
              <button type="button" class="group-item" data-group-index="${index}">
                <span>
                  <strong>${escapeHtml(group.subject || 'Tanpa nama')}</strong>
                  <small>${escapeHtml(group.id)}</small>
                </span>
                <span>${Number(group.participantCount || 0)} anggota</span>
              </button>
            </li>`
        )
        .join('');
    };

    search.addEventListener('input', () => render(search.value));
    list.addEventListener('click', (event) => {
      const item = event.target.closest('[data-group-index]');
      if (!item) return;
      const group = state.filteredGroups[Number(item.dataset.groupIndex)];
      if (!group) return;
      $('#send-to').value = group.id;
      closeModal();
      toast(`Grup dipilih: ${group.subject || group.id}`, 'success');
    });

    render('');
    search.focus();
  } catch (error) {
    toast(formatError(error), 'error');
  } finally {
    setBusy(button, false);
  }
}

/* ---------- Send message ---------- */

function updateMediaFields() {
  const kind = $('#send-kind').value;
  const source = $('#media-source').value;
  const isMedia = kind === 'image' || kind === 'video';
  const useUrl = source === 'url';

  $('#media-url-field').hidden = !isMedia || !useUrl;
  $('#media-file-field').hidden = !isMedia || useUrl;
  $('#media-file').accept = kind === 'image' ? 'image/*' : 'video/*';
}

function updateInteractiveFields() {
  const type = $('#interactive-type').value;
  $('#interactive-buttons').hidden = type !== 'buttons';
  $('#interactive-list').hidden = type !== 'list';
}

function addButtonRow(id = '', text = '') {
  const row = document.createElement('div');
  row.className = 'button-row';
  row.innerHTML = `
    <input class="button-id" type="text" maxlength="256" placeholder="ID tombol" value="${escapeHtml(
      id
    )}" />
    <input class="button-text" type="text" maxlength="100" placeholder="Teks tombol" value="${escapeHtml(
      text
    )}" />
    <button type="button" class="btn btn-danger btn-sm" data-remove-button>Hapus</button>`;
  $('#button-rows').appendChild(row);
}

function syncSendForm() {
  const kind = $('#send-kind').value;
  $('#send-text-fields').hidden = kind !== 'text';
  $('#send-media-fields').hidden = kind !== 'image' && kind !== 'video';
  $('#send-interactive-fields').hidden = kind !== 'interactive';

  updateMediaFields();
  updateInteractiveFields();

  if (!$('#button-rows').children.length) {
    addButtonRow('yes', 'Ya');
    addButtonRow('no', 'Tidak');
  }
  if (!$('#list-sections').value.trim()) {
    $('#list-sections').value = DEFAULT_SECTIONS;
  }
}

function showSendResult(message, error = null) {
  const box = $('#send-result');
  box.hidden = false;
  box.classList.toggle('is-error', Boolean(error));

  if (error) {
    box.innerHTML = `<h3>Pesan gagal dikirim</h3><p>${escapeHtml(
      formatError(error)
    )}</p>`;
    return;
  }

  box.innerHTML = `<h3>Pesan masuk antrean</h3>
    <p>ID: <code>${escapeHtml(message.id)}</code></p>
    <p>Status: <span class="badge badge-${messageStatusClass(
      message.status
    )}">${escapeHtml(
      MESSAGE_STATUS_LABELS[message.status] || message.status
    )}</span> · ${escapeHtml(kindLabel(message.kind))} · ${escapeHtml(
      message.remoteJid
    )}</p>`;
}

function parseSections() {
  let sections;
  try {
    sections = JSON.parse($('#list-sections').value);
  } catch {
    throw new Error('Sections bukan JSON yang valid');
  }

  if (!Array.isArray(sections) || sections.length === 0) {
    throw new Error('Sections harus berupa array dan tidak boleh kosong');
  }
  if (sections.length > 10) {
    throw new Error('Maksimal 10 section');
  }

  for (const section of sections) {
    if (!section || typeof section !== 'object') {
      throw new Error('Format section tidak valid');
    }
    if (!Array.isArray(section.rows) || section.rows.length === 0) {
      throw new Error('Setiap section harus memiliki minimal satu row');
    }
    for (const row of section.rows) {
      if (!row?.id || !row?.title) {
        throw new Error('Setiap row harus memiliki id dan title');
      }
    }
  }

  return sections;
}

async function handleSendSubmit(event) {
  event.preventDefault();

  const sessionId = $('#send-session').value || state.selectedSessionId;
  const session = state.sessions.find((item) => item.id === sessionId);
  if (!sessionId || !session) {
    toast('Pilih sesi terlebih dahulu', 'error');
    return;
  }
  if (session.status !== 'connected') {
    toast(
      `Sesi "${session.name}" belum terhubung (${statusLabel(
        session.status
      )})`,
      'error'
    );
    return;
  }

  const to = $('#send-to').value.trim();
  if (!to) {
    toast('Isi nomor atau JID penerima', 'error');
    return;
  }

  const kind = $('#send-kind').value;
  const idempotencyKey = $('#send-idempotency').value.trim() || undefined;
  const submit = $('#send-form button[type="submit"]');
  const endpoint = `/v1/sessions/${encodeURIComponent(
    sessionId
  )}/messages/${kind === 'interactive' ? 'interactive' : kind}`;

  setBusy(submit, true, 'Mengirim...');
  try {
    let data;

    if (kind === 'text') {
      const text = $('#send-text').value.trim();
      if (!text) throw new Error('Teks pesan tidak boleh kosong');

      data = await api(endpoint, {
        method: 'POST',
        body: JSON.stringify({
          to,
          text,
          ...(idempotencyKey ? { idempotencyKey } : {})
        })
      });
    } else if (kind === 'image' || kind === 'video') {
      const source = $('#media-source').value;
      const caption = $('#media-caption').value.trim();

      if (source === 'url') {
        const mediaUrl = $('#media-url').value.trim();
        if (!/^https?:\/\//i.test(mediaUrl)) {
          throw new Error('URL media harus diawali http:// atau https://');
        }

        data = await api(endpoint, {
          method: 'POST',
          body: JSON.stringify({
            to,
            mediaUrl,
            ...(caption ? { caption } : {}),
            ...(idempotencyKey ? { idempotencyKey } : {})
          })
        });
      } else {
        const file = $('#media-file').files?.[0];
        if (!file) throw new Error('Pilih file media yang akan dikirim');

        const form = new FormData();
        form.append('file', file);
        form.append('to', to);
        if (caption) form.append('caption', caption);
        if (idempotencyKey) form.append('idempotencyKey', idempotencyKey);
        data = await api(endpoint, { method: 'POST', body: form });
      }
    } else {
      const type = $('#interactive-type').value;
      const text = $('#interactive-text').value.trim();
      if (!text) throw new Error('Teks utama pesan interaktif wajib diisi');

      const body = { type, to, text };
      const header = $('#interactive-header').value.trim();
      const footer = $('#interactive-footer').value.trim();
      const fallbackText = $('#interactive-fallback').value.trim();
      if (header) body.header = header;
      if (footer) body.footer = footer;
      if (fallbackText) body.fallbackText = fallbackText;
      if (idempotencyKey) body.idempotencyKey = idempotencyKey;

      if (type === 'buttons') {
        const buttons = $$('#button-rows .button-row')
          .map((row) => ({
            id: row.querySelector('.button-id').value.trim(),
            text: row.querySelector('.button-text').value.trim()
          }))
          .filter((button) => button.id || button.text);

        if (!buttons.length) throw new Error('Tambahkan minimal satu tombol');
        if (buttons.length > 10) throw new Error('Maksimal 10 tombol');
        if (buttons.some((button) => !button.id || !button.text)) {
          throw new Error('Setiap tombol harus memiliki ID dan teks');
        }
        body.buttons = buttons;
      } else {
        const buttonText = $('#list-button-text').value.trim();
        if (!buttonText) throw new Error('Teks tombol daftar wajib diisi');
        body.buttonText = buttonText;
        body.sections = parseSections();
      }

      data = await api(endpoint, {
        method: 'POST',
        body: JSON.stringify(body)
      });
    }

    showSendResult(data.message);
    toast('Pesan berhasil masuk antrean', 'success');

    $('#send-idempotency').value = '';
    $('#media-file').value = '';

    if (state.view === 'history') {
      await loadHistory({ reset: true });
    }
  } catch (error) {
    showSendResult(null, error);
    toast(formatError(error), 'error');
  } finally {
    setBusy(submit, false);
  }
}

/* ---------- History ---------- */

function analysisBadge(analysis) {
  if (!analysis) return '';
  if (analysis.status === 'failed') {
    return '<span class="badge badge-analysis-failed">Analisa gagal</span>';
  }
  if (analysis.status !== 'completed' || !analysis.result) return '';

  const label = analysis.result.label;
  const labels = {
    positive: 'Positif',
    negative: 'Negatif',
    neutral: 'Netral'
  };
  return `<span class="badge badge-analysis-${escapeHtml(
    label
  )}">Analisa: ${escapeHtml(labels[label] ?? label)}</span>`;
}

function renderMessage(message, analysis = null) {
  const direction = message.direction === 'in' ? 'in' : 'out';
  const status = messageStatusClass(message.status);
  const content = message.content
    ? escapeHtml(message.content)
    : '<span class="field-hint">(tanpa teks)</span>';

  let media = '';
  if (message.mediaId) {
    const mediaUrl = `/v1/media/${encodeURIComponent(message.mediaId)}`;
    if (message.kind === 'image') {
      media = `<div class="message-media"><a href="${mediaUrl}" target="_blank" rel="noopener"><img src="${mediaUrl}" alt="Media pesan" loading="lazy" /></a></div>`;
    } else {
      media = `<p class="message-media"><a href="${mediaUrl}" target="_blank" rel="noopener">Buka media (${escapeHtml(
        kindLabel(message.kind)
      )})</a></p>`;
    }
  }

  let payload = '';
  if (message.payload && typeof message.payload === 'object') {
    try {
      const json = JSON.stringify(message.payload, null, 2);
      if (json && json !== '{}') {
        payload = `<details><summary>Payload</summary><pre>${escapeHtml(
          json
        )}</pre></details>`;
      }
    } catch {
      // Ignore payload that cannot be serialized.
    }
  }

  return `<article class="message is-${direction}">
    <div class="message-head">
      <span class="badge badge-${direction}">${
        direction === 'in' ? 'Masuk' : 'Keluar'
      }</span>
      <span class="badge badge-${status}">${escapeHtml(
        MESSAGE_STATUS_LABELS[message.status] || message.status
      )}</span>
      ${analysisBadge(analysis)}
      <span>${escapeHtml(kindLabel(message.kind))}</span>
      <time datetime="${escapeHtml(message.createdAt)}">${escapeHtml(
        formatDateTime(message.createdAt)
      )}</time>
    </div>
    <div class="message-content">${content}</div>
    ${media}
    <div class="message-meta">
      <span>${escapeHtml(message.remoteJid)}</span>
      ${message.senderJid ? `<span>Pengirim: ${escapeHtml(message.senderJid)}</span>` : ''}
      ${message.isGroup ? '<span>Grup</span>' : ''}
      ${message.error ? `<span>Error: ${escapeHtml(message.error)}</span>` : ''}
    </div>
    ${payload}
  </article>`;
}

async function loadHistory(options = {}) {
  const reset = options.reset !== false;
  const sessionId = $('#history-session').value || state.selectedSessionId;

  if (!sessionId) {
    state.history = [];
    state.historyHasMore = false;
    $('#history-list').innerHTML = emptyState(
      'Belum ada sesi',
      'Buat sesi terlebih dahulu untuk melihat riwayat pesan.'
    );
    $('#history-more').hidden = true;
    return;
  }

  if (state.historyLoading) return;

  const previous =
    !reset && state.history.length
      ? state.history[state.history.length - 1]?.createdAt
      : null;
  const params = new URLSearchParams({ limit: '30' });
  const direction = $('#history-direction').value;
  const kind = $('#history-kind').value;
  if (direction) params.set('direction', direction);
  if (kind) params.set('kind', kind);
  if (previous) params.set('before', previous);

  state.historyLoading = true;
  const refresh = $('#history-refresh');
  setBusy(refresh, true, 'Memuat...');

  try {
    const data = await api(
      `/v1/sessions/${encodeURIComponent(
        sessionId
      )}/messages?${params.toString()}`
    );
    const rows = Array.isArray(data.data) ? data.data : [];
    state.history = reset ? rows : [...state.history, ...rows];
    state.historyHasMore = Boolean(data.hasMore);
    $('#history-more').hidden = !state.historyHasMore;

    const analysisParams = new URLSearchParams({
      sessionId,
      from: new Date(Date.now() - 30 * 86_400_000).toISOString(),
      to: new Date().toISOString(),
      limit: '200'
    });
    const analysisData = await api(`/v1/analysis?${analysisParams}`).catch(() => ({
      data: []
    }));
    state.analysisResults = new Map(
      (Array.isArray(analysisData.data) ? analysisData.data : [])
        .filter((item) => item.status === 'completed' || item.status === 'failed')
        .map((item) => [item.messageId, item])
    );

    if (!state.history.length) {
      $('#history-list').innerHTML = emptyState(
        'Belum ada pesan',
        'Pesan keluar dan masuk untuk sesi ini akan tampil di sini.'
      );
    } else {
      $('#history-list').innerHTML = state.history
        .map((message) =>
          renderMessage(message, state.analysisResults.get(message.id))
        )
        .join('');
    }
  } catch (error) {
    if (reset) {
      $('#history-list').innerHTML = emptyState(
        'Gagal memuat riwayat',
        formatError(error)
      );
    }
    toast(formatError(error), 'error');
  } finally {
    state.historyLoading = false;
    setBusy(refresh, false);
  }
}

/* ---------- Analysis ---------- */

const ANALYSIS_LABELS = {
  positive: 'Positif',
  negative: 'Negatif',
  neutral: 'Netral'
};

function analyticsQuery() {
  const params = new URLSearchParams();
  const sessionId = $('#analytics-session').value || '';
  if (sessionId) params.set('sessionId', sessionId);

  const days = { '24h': 1, '7d': 7, '30d': 30 }[
    $('#analytics-range').value
  ] ?? 7;
  params.set('from', new Date(Date.now() - days * 86_400_000).toISOString());
  params.set('to', new Date().toISOString());
  return params.toString();
}

function renderBarList(element, rows, emptyTitle, emptyMessage) {
  if (!rows.length) {
    element.innerHTML = emptyState(emptyTitle, emptyMessage);
    return;
  }

  const max = Math.max(
    ...rows.map((row) => row.count ?? row.inbound + row.outbound + row.failed),
    1
  );
  element.innerHTML = rows
    .map((row) => {
      const width = Math.max(
        2,
        Math.round(((row.count ?? 0) / max) * 100)
      );
      const label = escapeHtml(row.label);
      const meta = escapeHtml(row.meta ?? String(row.count ?? 0));
      return `<div class="bar-row">
        <div class="bar-label"><span>${label}</span><span>${meta}</span></div>
        <div class="bar-track"><div class="bar-fill ${escapeHtml(
          row.className ?? ''
        )}" style="width:${width}%"></div></div>
      </div>`;
    })
    .join('');
}

function renderTimeseries(element, rows) {
  if (!rows.length) {
    element.innerHTML = emptyState(
      'Belum ada aktivitas',
      'Pesan pada rentang ini akan tampil di grafik.'
    );
    return;
  }

  const recent = rows.slice(-12);
  const max = Math.max(
    ...recent.map((row) => row.inbound + row.outbound + row.failed),
    1
  );
  element.innerHTML = recent
    .map((row) => {
      const width = (value) => Math.max(2, Math.round((value / max) * 100));
      const label = formatDateTime(row.bucket);
      return `<div class="bar-row">
        <div class="bar-label">
          <span>${escapeHtml(label)}</span>
          <span>${row.inbound} masuk · ${row.outbound} keluar${
            row.failed ? ` · ${row.failed} gagal` : ''
          }</span>
        </div>
        <div class="bar-track">
          <div class="bar-fill" style="width:${width(row.inbound)}%"></div>
          <div class="bar-fill is-out" style="width:${width(row.outbound)}%"></div>
          <div class="bar-fill is-failed" style="width:${width(row.failed)}%"></div>
        </div>
      </div>`;
    })
    .join('');
}

function renderAnalysisConfig(config) {
  if (!config) return;
  $('#analysis-enabled').checked = Boolean(config.enabled);
  $('#analysis-mode').value = config.mode || 'internal';
  $('#analysis-endpoint').value = config.endpoint || '';
  $('#analysis-auth-mode').value = config.authMode || 'signature';
  $('#analysis-redact').checked = Boolean(config.redact);
  $('#analysis-max-chars').value = String(config.maxChars ?? 4096);
  $('#analysis-timeout').value = String(config.timeoutMs ?? 10000);
  $('#analysis-secret').value = '';
  $('#analysis-rotate').checked = false;
  $('#analysis-secret-hint').textContent =
    config.secretHint || 'Belum ada secret';
}

function renderAnalysisTextResult(data, error = null) {
  const box = $('#analysis-text-result');
  box.hidden = false;
  box.classList.toggle('is-error', Boolean(error));

  if (error) {
    box.innerHTML = `<h3>Analisa gagal</h3><p>${escapeHtml(error)}</p>`;
    return;
  }

  const result = data.result ?? {};
  const label = ANALYSIS_LABELS[result.label] ?? result.label ?? '—';
  const keywords = Array.isArray(result.keywords) && result.keywords.length
    ? result.keywords.map((word) => escapeHtml(word)).join(', ')
    : '—';
  box.innerHTML = `<h3>${escapeHtml(label)} · ${escapeHtml(
    result.intent || 'other'
  )}</h3>
    <p>Skor: ${escapeHtml(String(result.score ?? 0))} · Sumber: ${escapeHtml(
      data.source
    )} · Versi: ${escapeHtml(data.version || '—')}</p>
    <p>Kata kunci: ${keywords}</p>
    <p>Ringkasan: ${escapeHtml(result.summary || '—')}</p>`;
}

function renderRecentAnalysis(rows) {
  const element = $('#analysis-recent');
  if (!rows.length) {
    element.innerHTML = emptyState(
      'Belum ada analisa',
      'Hasil analisa pesan akan tampil di sini.'
    );
    return;
  }

  element.innerHTML = rows
    .slice(0, 20)
    .map((item) => {
      const label = ANALYSIS_LABELS[item.result?.label] ?? 'Gagal';
      const className = item.status === 'completed'
        ? `badge-analysis-${escapeHtml(item.result?.label ?? 'neutral')}`
        : 'badge-analysis-failed';
      return `<div class="mini-item">
        <div>
          <strong><span class="badge ${className}">${escapeHtml(
            label
          )}</span> ${escapeHtml(item.source)}</strong>
          <small>${escapeHtml(
            item.result?.summary || item.error || 'Tanpa ringkasan'
          )}</small>
        </div>
        <small>${escapeHtml(formatDateTime(item.createdAt))}</small>
      </div>`;
    })
    .join('');
}

async function loadAnalytics() {
  const notice = $('#analytics-disabled');
  if (!state.analysisEnabled) {
    notice.textContent =
      'Analisa dinonaktifkan pada konfigurasi server. Aktifkan ANALYSIS_ENABLED untuk memakai fitur ini.';
    notice.hidden = false;
    return;
  }

  const query = analyticsQuery();
  const [summary, series, webhook, apiStats, configResult, recent] =
    await Promise.all([
      api(`/v1/analytics/summary?${query}`).catch(() => null),
      api(`/v1/analytics/timeseries?${query}`).catch(() => ({ data: [] })),
      api(`/v1/analytics/webhook?${query}`).catch(() => null),
      api(`/v1/analytics/api?${query}`).catch(() => null),
      api('/v1/analysis/config').catch((error) => {
        if (error.status === 410) {
          state.analysisEnabled = false;
          return null;
        }
        return null;
      }),
      api(`/v1/analysis?${query}&limit=20`).catch(() => ({ data: [] }))
    ]);

  if (!state.analysisEnabled || !configResult) {
    notice.textContent =
      'Analisa tidak tersedia untuk tenant ini. Periksa konfigurasi server.';
    notice.hidden = false;
    return;
  }
  notice.hidden = true;

  const stats = summary?.analysis ?? {};
  $('#analytics-total-messages').textContent = String(summary?.total ?? 0);
  $('#analytics-message-breakdown').textContent = summary
    ? `${summary.inbound} masuk · ${summary.outbound} keluar`
    : '—';
  $('#analytics-delivery-rate').textContent = `${Math.round(
    (summary?.deliveryRate ?? 0) * 100
  )}%`;
  $('#analytics-completed').textContent = String(stats.completed ?? 0);
  $('#analytics-analysis-breakdown').textContent = stats.total
    ? `${stats.total} total · ${stats.failed ?? 0} gagal`
    : '—';
  $('#analytics-webhook-rate').textContent = `${Math.round(
    (webhook?.successRate ?? 0) * 100
  )}%`;
  $('#analytics-webhook-breakdown').textContent = webhook?.attempts
    ? `${webhook.successful}/${webhook.attempts} sukses · ${webhook.avgDurationMs} ms`
    : 'Belum ada pengiriman';

  renderTimeseries(
    $('#analytics-timeseries'),
    Array.isArray(series?.data) ? series.data : []
  );
  renderBarList(
    $('#analytics-labels'),
    (stats.byLabel ?? []).map((item) => ({
      label: ANALYSIS_LABELS[item.label] ?? item.label,
      count: item.count,
      meta: `${item.count} hasil`,
      className:
        item.label === 'positive'
          ? ''
          : `is-${escapeHtml(item.label)}`
    })),
    'Belum ada label',
    'Jalankan analisa untuk melihat distribusi label.'
  );
  renderBarList(
    $('#analytics-webhook'),
    (webhook?.byEvent ?? []).map((item) => ({
      label: WEBHOOK_EVENTS[item.event] ?? item.event,
      count: item.attempts,
      meta: `${item.successful}/${item.attempts} sukses`
    })),
    'Belum ada webhook',
    'Event webhook yang terkirim akan tampil di sini.'
  );
  renderBarList(
    $('#analytics-api'),
    (apiStats?.byRoute ?? []).map((item) => ({
      label: `${item.method} ${item.route}`,
      count: item.requests,
      meta: `${item.requests} req · ${item.avgDurationMs} ms${
        item.errors ? ` · ${item.errors} error` : ''
      }`
    })),
    'Belum ada metrik API',
    'Permintaan API akan dicatat setiap menit.'
  );

  renderAnalysisConfig(configResult.config);
  renderRecentAnalysis(Array.isArray(recent?.data) ? recent.data : []);
}

async function handleAnalysisConfigSubmit(event) {
  event.preventDefault();
  const submit = $('#analysis-config-form button[type="submit"]');
  const endpoint = $('#analysis-endpoint').value.trim() || null;
  const mode = $('#analysis-mode').value;
  const secret = $('#analysis-secret').value.trim();
  const rotateSecret = $('#analysis-rotate').checked;

  if (mode !== 'internal' && !endpoint) {
    toast('Endpoint analyzer wajib diisi untuk mode eksternal', 'error');
    return;
  }

  const body = {
    enabled: $('#analysis-enabled').checked,
    mode,
    endpoint,
    authMode: $('#analysis-auth-mode').value,
    redact: $('#analysis-redact').checked,
    maxChars: Number($('#analysis-max-chars').value),
    timeoutMs: Number($('#analysis-timeout').value)
  };
  if (secret) body.secret = secret;
  if (rotateSecret) body.rotateSecret = true;

  setBusy(submit, true, 'Menyimpan...');
  try {
    const data = await api('/v1/analysis/config', {
      method: 'PUT',
      body: JSON.stringify(body)
    });
    $('#analysis-secret').value = '';
    $('#analysis-rotate').checked = false;
    renderAnalysisConfig(data.config);

    if (data.secret) {
      const box = $('#analysis-secret-box');
      box.hidden = false;
      box.innerHTML = `<h3>Simpan secret analyzer sekarang</h3>
        <p>${escapeHtml(data.warning || 'Secret hanya ditampilkan sekali.')}</p>
        <div class="secret-line"><code>${escapeHtml(
          data.secret
        )}</code><button type="button" class="btn btn-ghost btn-sm" data-copy="${escapeHtml(
          data.secret
        )}">Salin</button></div>`;
    }
    toast('Konfigurasi analisa disimpan', 'success');
    await loadAnalytics();
  } catch (error) {
    toast(formatError(error), 'error');
  } finally {
    setBusy(submit, false);
  }
}

async function handleAnalysisTextSubmit(event) {
  event.preventDefault();
  const text = $('#analysis-text').value.trim();
  if (!text) {
    toast('Teks wajib diisi', 'error');
    return;
  }

  const submit = $('#analysis-text-form button[type="submit"]');
  const body = {
    text,
    source: $('#analysis-text-source').value
  };
  const sessionId = $('#analysis-text-session').value;
  if (sessionId) body.sessionId = sessionId;

  setBusy(submit, true, 'Menganalisa...');
  try {
    const data = await api('/v1/analysis/text', {
      method: 'POST',
      body: JSON.stringify(body)
    });
    renderAnalysisTextResult(data);
  } catch (error) {
    renderAnalysisTextResult(null, formatError(error));
    toast(formatError(error), 'error');
  } finally {
    setBusy(submit, false);
  }
}

/* ---------- Webhook ---------- */

function renderWebhookEventOptions() {
  $('#webhook-events').innerHTML = Object.entries(WEBHOOK_EVENTS)
    .map(
      ([event, label]) => `
        <label class="checkbox-row">
          <input type="checkbox" value="${escapeHtml(event)}" />
          <span>
            <strong>${escapeHtml(label)}</strong>
            <small>${escapeHtml(event)}</small>
          </span>
        </label>`
    )
    .join('');
}

async function loadWebhookConfig() {
  const sessionId = $('#webhook-session').value || state.selectedSessionId;
  const box = $('#webhook-secret');
  box.hidden = true;

  if (!sessionId) {
    $('#webhook-url').value = '';
    $$('#webhook-events input[type="checkbox"]').forEach((input) => {
      input.checked = false;
    });
    $('#webhook-fallback').checked = false;
    $('#webhook-rotate').checked = false;
    return;
  }

  try {
    const data = await api(
      `/v1/sessions/${encodeURIComponent(sessionId)}/webhook`
    );
    const webhook = data.webhook;
    $('#webhook-url').value = webhook.url || '';
    $('#webhook-fallback').checked = Boolean(webhook.interactiveFallback);
    $('#webhook-rotate').checked = false;

    $$('#webhook-events input[type="checkbox"]').forEach((input) => {
      input.checked = Array.isArray(webhook.events)
        ? webhook.events.includes(input.value)
        : false;
    });
  } catch (error) {
    toast(formatError(error), 'error');
  }
}

async function handleWebhookSubmit(event) {
  event.preventDefault();

  const sessionId = $('#webhook-session').value || state.selectedSessionId;
  if (!sessionId) {
    toast('Pilih sesi terlebih dahulu', 'error');
    return;
  }

  const url = $('#webhook-url').value.trim();
  const events = $$('#webhook-events input[type="checkbox"]:checked').map(
    (input) => input.value
  );
  const submit = $('#webhook-form button[type="submit"]');
  const box = $('#webhook-secret');

  setBusy(submit, true, 'Menyimpan...');
  try {
    const data = await api(
      `/v1/sessions/${encodeURIComponent(sessionId)}/webhook`,
      {
        method: 'PUT',
        body: JSON.stringify({
          url: url || null,
          events: url ? events : [],
          interactiveFallback: $('#webhook-fallback').checked,
          rotateSecret: $('#webhook-rotate').checked
        })
      }
    );

    if (data.secret) {
      box.hidden = false;
      box.innerHTML = `<h3>Secret webhook baru</h3>
        <p>Simpan sekarang. Nilai ini hanya ditampilkan sekali.</p>
        <div class="secret-line">
          <code>${escapeHtml(data.secret)}</code>
          <button type="button" class="btn btn-ghost btn-sm" data-copy="${escapeHtml(
            data.secret
          )}">Salin</button>
        </div>
        <p class="warning-text">${escapeHtml(data.warning || '')}</p>`;
    } else {
      box.hidden = true;
    }

    $('#webhook-rotate').checked = false;
    toast('Pengaturan webhook disimpan', 'success');
    await loadSessions({ quiet: true });
  } catch (error) {
    toast(formatError(error), 'error');
  } finally {
    setBusy(submit, false);
  }
}

/* ---------- API keys ---------- */

function renderApiKeys(keys) {
  const root = $('#key-list');
  if (!keys.length) {
    root.innerHTML = emptyState(
      'Belum ada API key',
      'Buat API key untuk menghubungkan aplikasi JavaScript atau PHP.'
    );
    return;
  }

  root.innerHTML = keys
    .map((key) => {
      const revoked = Boolean(key.revokedAt);
      return `<article class="key-item ${revoked ? 'is-revoked' : ''}">
        <div class="key-main">
          <strong>${escapeHtml(key.name)}</strong>
          <code>${escapeHtml(key.prefix)}…</code>
          <div class="key-meta">
            <span>${revoked ? 'Dicabut' : 'Aktif'}</span>
            <span>Dibuat ${escapeHtml(formatDateTime(key.createdAt))}</span>
            <span>Dipakai ${
              key.lastUsedAt
                ? escapeHtml(formatDateTime(key.lastUsedAt))
                : 'belum pernah'
            }</span>
            <span>Scope ${escapeHtml((key.scopes || []).join(', '))}</span>
          </div>
        </div>
        <div class="key-actions">
          ${
            revoked
              ? ''
              : `<button type="button" class="btn btn-danger btn-sm" data-revoke-key="${escapeHtml(
                  key.id
                )}">Revoke</button>`
          }
        </div>
      </article>`;
    })
    .join('');
}

async function loadApiKeys() {
  try {
    const data = await api('/v1/api-keys');
    renderApiKeys(Array.isArray(data.data) ? data.data : []);
  } catch (error) {
    toast(formatError(error), 'error');
  }
}

async function handleCreateKey(event) {
  event.preventDefault();
  const input = $('#new-key-name');
  const submit = $('#create-key-form button[type="submit"]');
  const name = input.value.trim();

  if (!name) {
    toast('Nama API key wajib diisi', 'error');
    return;
  }

  setBusy(submit, true, 'Membuat...');
  try {
    const data = await api('/v1/api-keys', {
      method: 'POST',
      body: JSON.stringify({ name })
    });

    const box = $('#new-key-box');
    box.hidden = false;
    box.innerHTML = `<h3>API key baru</h3>
      <p>Salin sekarang. Nilai penuh hanya ditampilkan sekali.</p>
      <div class="secret-line">
        <code>${escapeHtml(data.apiKey.key)}</code>
        <button type="button" class="btn btn-ghost btn-sm" data-copy="${escapeHtml(
          data.apiKey.key
        )}">Salin</button>
      </div>
      <p class="warning-text">${escapeHtml(data.warning || '')}</p>`;

    input.value = '';
    toast('API key dibuat', 'success');
    await loadApiKeys();
  } catch (error) {
    toast(formatError(error), 'error');
  } finally {
    setBusy(submit, false);
  }
}

async function revokeKey(button, keyId) {
  if (
    !window.confirm(
      'Revoke API key ini? Aplikasi yang memakainya tidak bisa mengakses API lagi.'
    )
  ) {
    return;
  }

  await runButtonAction(button, async () => {
    await api(`/v1/api-keys/${encodeURIComponent(keyId)}`, {
      method: 'DELETE'
    });
    toast('API key dicabut', 'success');
    await loadApiKeys();
  });
}

/* ---------- Account ---------- */

function renderAccount() {
  $('#account-name').textContent = state.user?.name || '—';
  $('#account-email').textContent = state.user?.email || '—';
  $('#account-tenant').textContent = state.tenant?.name || '—';
  $('#account-last-login').textContent = formatDateTime(
    state.user?.lastLoginAt
  );
}

async function handlePasswordChange(event) {
  event.preventDefault();
  const errorBox = $('#password-error');
  const submit = $('#password-form button[type="submit"]');
  clearFormError(errorBox);

  const currentPassword = $('#current-password').value;
  const newPassword = $('#new-password').value;
  if (!currentPassword) {
    showFormError(errorBox, 'Password saat ini wajib diisi');
    return;
  }
  if (newPassword.length < 8) {
    showFormError(errorBox, 'Password baru minimal 8 karakter');
    return;
  }

  setBusy(submit, true, 'Menyimpan...');
  try {
    await api('/v1/auth/password', {
      method: 'PUT',
      body: JSON.stringify({ currentPassword, newPassword })
    });
    $('#password-form').reset();
    toast('Password berhasil diubah', 'success');
  } catch (error) {
    showFormError(errorBox, formatError(error));
  } finally {
    setBusy(submit, false);
  }
}

async function logout() {
  try {
    await api('/v1/auth/logout', { method: 'POST' });
  } catch {
    // The local UI should still sign out if the server session is gone.
  }
  showAuth();
  toast('Anda telah keluar', 'success');
}

/* ---------- Events ---------- */

function bindEvents() {
  $$('.tab[data-auth-tab]').forEach((tab) => {
    tab.addEventListener('click', () => switchAuthTab(tab.dataset.authTab));
  });

  $('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const errorBox = $('#login-error');
    clearFormError(errorBox);

    const email = $('#login-email').value.trim();
    const password = $('#login-password').value;
    if (!email || !password) {
      showFormError(errorBox, 'Email dan password wajib diisi');
      return;
    }

    const submit = $('#login-form button[type="submit"]');
    setBusy(submit, true, 'Masuk...');
    try {
      const data = await api('/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password })
      });
      state.user = data.user;
      state.tenant = data.tenant;
      $('#login-form').reset();
      await enterApp();
      toast('Berhasil masuk', 'success');
    } catch (error) {
      showFormError(errorBox, formatError(error));
    } finally {
      setBusy(submit, false);
    }
  });

  $('#register-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const errorBox = $('#register-error');
    clearFormError(errorBox);

    const tenantName = $('#register-tenant').value.trim();
    const name = $('#register-name').value.trim();
    const email = $('#register-email').value.trim();
    const password = $('#register-password').value;

    if (!tenantName || !email || !password) {
      showFormError(errorBox, 'Nama tenant, email, dan password wajib diisi');
      return;
    }
    if (password.length < 8) {
      showFormError(errorBox, 'Password minimal 8 karakter');
      return;
    }

    const submit = $('#register-form button[type="submit"]');
    setBusy(submit, true, 'Mendaftar...');
    try {
      const data = await api('/v1/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          tenantName,
          ...(name ? { name } : {}),
          email,
          password
        })
      });
      state.user = data.user;
      state.tenant = data.tenant;
      $('#register-form').reset();
      await enterApp();
      toast('Tenant berhasil dibuat', 'success');

      openModal(
        'API key pertama',
        `<p>Simpan API key ini sekarang. Nilai penuh hanya ditampilkan sekali.</p>
         <div class="secret-line">
           <code>${escapeHtml(data.apiKey.key)}</code>
           <button type="button" class="btn btn-ghost btn-sm" data-copy="${escapeHtml(
             data.apiKey.key
           )}">Salin</button>
         </div>
         <p class="warning-text">${escapeHtml(data.warning || '')}</p>
         <div class="modal-actions">
           <button type="button" class="btn btn-ghost" data-close-modal>Tutup</button>
         </div>`
      );
    } catch (error) {
      showFormError(errorBox, formatError(error));
    } finally {
      setBusy(submit, false);
    }
  });

  $('#setup-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const errorBox = $('#setup-error');
    clearFormError(errorBox);

    const apiKey = $('#setup-key').value.trim();
    const name = $('#setup-name').value.trim();
    const email = $('#setup-email').value.trim();
    const password = $('#setup-password').value;

    if (!apiKey || !email || !password) {
      showFormError(errorBox, 'API key, email, dan password wajib diisi');
      return;
    }
    if (password.length < 8) {
      showFormError(errorBox, 'Password minimal 8 karakter');
      return;
    }

    const submit = $('#setup-form button[type="submit"]');
    setBusy(submit, true, 'Mengaktifkan...');
    try {
      const data = await api('/v1/auth/setup', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          ...(name ? { name } : {}),
          email,
          password
        })
      });
      state.user = data.user;
      state.tenant = data.tenant;
      $('#setup-form').reset();
      await enterApp();
      toast('Login dashboard diaktifkan', 'success');
    } catch (error) {
      showFormError(errorBox, formatError(error));
    } finally {
      setBusy(submit, false);
    }
  });

  $$('.nav-item').forEach((item) => {
    item.addEventListener('click', () => setView(item.dataset.view));
  });

  $$('[data-goto]').forEach((button) => {
    button.addEventListener('click', () => setView(button.dataset.goto));
  });

  $('#logout-button').addEventListener('click', () => void logout());

  $('#refresh-all').addEventListener('click', async () => {
    const button = $('#refresh-all');
    setBusy(button, true, 'Memuat...');
    try {
      await loadSessions();
      if (state.view === 'history') await loadHistory({ reset: true });
      if (state.view === 'analytics') await loadAnalytics();
      if (state.view === 'webhook') await loadWebhookConfig();
      if (state.view === 'keys') await loadApiKeys();
      toast('Data dimuat ulang', 'success');
    } finally {
      setBusy(button, false);
    }
  });

  $('#create-session-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = $('#new-session-name');
    const name = input.value.trim();
    if (!name) {
      toast('Nama sesi wajib diisi', 'error');
      return;
    }

    const submit = $('#create-session-form button[type="submit"]');
    setBusy(submit, true, 'Membuat...');
    try {
      const data = await api('/v1/sessions', {
        method: 'POST',
        body: JSON.stringify({ name })
      });
      input.value = '';
      state.selectedSessionId = data.session.id;
      await loadSessions();
      toast('Sesi dibuat. Pindai QR untuk menautkan nomor.', 'success');
      if (data.session.status !== 'connected') {
        openQrModal(data.session);
      }
    } catch (error) {
      toast(formatError(error), 'error');
    } finally {
      setBusy(submit, false);
    }
  });

  $('#session-list').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;

    const session = state.sessions.find(
      (item) => item.id === button.dataset.id
    );
    if (!session) return;

    const action = button.dataset.action;

    if (action === 'send') {
      setSelectedSession(session.id);
      setView('send');
      return;
    }
    if (action === 'webhook') {
      setSelectedSession(session.id);
      setView('webhook');
      return;
    }
    if (action === 'qr') {
      void openQrModal(session);
      return;
    }
    if (action === 'pairing') {
      openPairingModal(session);
      return;
    }
    if (action === 'reconnect') {
      void runButtonAction(button, async () => {
        await api(
          `/v1/sessions/${encodeURIComponent(session.id)}/reconnect`,
          { method: 'POST' }
        );
        toast('Sesi dihubungkan ulang', 'success');
        await loadSessions({ quiet: true });
      });
      return;
    }
    if (action === 'logout') {
      if (
        !window.confirm(
          `Logout sesi "${session.name}"? Anda perlu memindai QR lagi untuk menghubungkannya.`
        )
      ) {
        return;
      }
      void runButtonAction(button, async () => {
        await api(`/v1/sessions/${encodeURIComponent(session.id)}/logout`, {
          method: 'POST'
        });
        toast('Sesi dilogout', 'success');
        await loadSessions({ quiet: true });
      });
      return;
    }
    if (action === 'delete') {
      if (
        !window.confirm(
          `Hapus sesi "${session.name}"? Riwayat pesan, media, dan auth sesi ini akan dihapus.`
        )
      ) {
        return;
      }
      void runButtonAction(button, async () => {
        await api(`/v1/sessions/${encodeURIComponent(session.id)}`, {
          method: 'DELETE'
        });
        if (state.selectedSessionId === session.id) {
          state.selectedSessionId = null;
        }
        toast('Sesi dihapus', 'success');
        await loadSessions({ quiet: true });
      });
    }
  });

  $('#send-kind').addEventListener('change', syncSendForm);
  $('#media-source').addEventListener('change', updateMediaFields);
  $('#interactive-type').addEventListener('change', updateInteractiveFields);

  $('#add-button').addEventListener('click', () => addButtonRow());

  $('#button-rows').addEventListener('click', (event) => {
    const remove = event.target.closest('[data-remove-button]');
    if (!remove) return;
    const rows = $$('#button-rows .button-row');
    if (rows.length <= 1) {
      toast('Minimal satu tombol', 'error');
      return;
    }
    remove.closest('.button-row')?.remove();
  });

  $('#load-groups').addEventListener('click', (event) => {
    void openGroupsModal(event.currentTarget);
  });

  $('#send-session').addEventListener('change', (event) => {
    setSelectedSession(event.target.value);
  });

  $('#send-form').addEventListener('submit', handleSendSubmit);

  $('#history-session').addEventListener('change', (event) => {
    setSelectedSession(event.target.value);
    void loadHistory({ reset: true });
  });
  $('#history-direction').addEventListener('change', () =>
    loadHistory({ reset: true })
  );
  $('#history-kind').addEventListener('change', () =>
    loadHistory({ reset: true })
  );
  $('#history-refresh').addEventListener('click', () =>
    loadHistory({ reset: true })
  );
  $('#history-more').addEventListener('click', () =>
    loadHistory({ reset: false })
  );

  $('#analytics-session').addEventListener('change', (event) => {
    setSelectedSession(event.target.value);
    void loadAnalytics();
  });
  $('#analytics-range').addEventListener('change', () => loadAnalytics());
  $('#analytics-refresh').addEventListener('click', () => loadAnalytics());
  $('#analysis-config-form').addEventListener('submit', handleAnalysisConfigSubmit);
  $('#analysis-text-form').addEventListener('submit', handleAnalysisTextSubmit);

  $('#webhook-session').addEventListener('change', (event) => {
    setSelectedSession(event.target.value);
    void loadWebhookConfig();
  });
  $('#webhook-form').addEventListener('submit', handleWebhookSubmit);

  $('#create-key-form').addEventListener('submit', handleCreateKey);

  $('#key-list').addEventListener('click', (event) => {
    const button = event.target.closest('[data-revoke-key]');
    if (!button) return;
    void revokeKey(button, button.dataset.revokeKey);
  });

  $('#password-form').addEventListener('submit', handlePasswordChange);

  $('#modal-root').addEventListener('click', (event) => {
    if (event.target.closest('[data-close-modal]')) closeModal();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('#modal-root').hidden) {
      closeModal();
    }
  });

  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-copy]');
    if (!button) return;
    void copyText(button.dataset.copy);
  });

  window.addEventListener('hashchange', () => {
    if (!state.user) return;
    const view = window.location.hash.replace('#', '');
    if (VIEW_NAMES.has(view)) setView(view, { updateHash: false });
  });
}

async function applyPublicConfig() {
  try {
    const config = await api('/v1/config');

    if (config.interactiveMessagesEnabled === false) {
      const option = $('#send-kind option[value="interactive"]');
      if (option) {
        option.disabled = true;
        option.textContent = 'Interaktif (dinonaktifkan)';
        if ($('#send-kind').value === 'interactive') {
          $('#send-kind').value = 'text';
        }
      }
    }

    if (config.analysisEnabled === false) {
      state.analysisEnabled = false;
      const nav = $('.nav-item[data-view="analytics"]');
      if (nav) {
        nav.disabled = true;
        nav.title = 'Analisa dinonaktifkan pada konfigurasi server';
      }
    }
  } catch {
    // Jika config tidak tersedia, biarkan form apa adanya.
  }
}

/* ---------- Boot ---------- */

async function boot() {
  bindEvents();
  renderWebhookEventOptions();
  await applyPublicConfig();
  syncSendForm();

  try {
    const data = await api('/v1/auth/me');
    state.user = data.user;
    state.tenant = data.tenant;
    await enterApp();
  } catch {
    showAuth();
  }

  window.setInterval(() => {
    if (!state.user || document.hidden) return;
    void loadSessions({ quiet: true });
  }, 15_000);
}

void boot();
