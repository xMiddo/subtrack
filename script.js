const STORAGE_KEYS = {
  accounts: 'subtrack_accounts',
  session: 'subtrack_session',
  subscriptions: 'subtrack_subscriptions',
  settings: 'subtrack_settings',
  history: 'subtrack_history',
  audit: 'subtrack_audit',
  reminderSent: 'subtrack_reminder_sent'
};

const DEFAULT_ADMIN = { username: 'admin', password: 'admin123', role: 'admin', disabled: false, createdAt: new Date().toISOString(), lastLoginAt: '' };
const HIGH_COST_THRESHOLD = 30;
const SUBSCRIPTION_TEMPLATES = [
  { name: 'Netflix', category: 'Streaming', cost: 15.49, billingCycle: '1', url: 'https://www.netflix.com/cancelplan' },
  { name: 'Spotify', category: 'Music', cost: 10.99, billingCycle: '1', url: 'https://www.spotify.com/account/subscription/' },
  { name: 'Adobe Creative Cloud', category: 'Software', cost: 59.99, billingCycle: '1', url: 'https://account.adobe.com/plans' },
  { name: 'Microsoft 365', category: 'Software', cost: 69.99, billingCycle: '12', url: 'https://account.microsoft.com/services' },
  { name: 'iCloud+', category: 'Cloud', cost: 2.99, billingCycle: '1', url: 'https://support.apple.com/billing' },
  { name: 'Xbox Game Pass', category: 'Gaming', cost: 16.99, billingCycle: '1', url: 'https://account.microsoft.com/services' }
];
const CURRENCY_SYMBOLS = { USD: '$', GBP: '£', EUR: '€', AUD: 'A$' };
const BACKEND_CONFIG = {
  enabled: location.protocol === 'http:' || location.protocol === 'https:',
  apiBaseUrl: '/api'
};
const today = new Date();
let visibleCalendarYear = today.getFullYear();
let visibleCalendarMonth = today.getMonth();
let backendState = null;
let appReady = false;
let backendError = '';
let serverSession = null;

function emptyBackendState() {
  return {
    accounts: [],
    subscriptions: {},
    settings: {},
    history: {},
    audit: [],
    reminderSent: [],
    emailQueue: [],
    adminNotes: {},
    publicSignup: false
  };
}

function usingBackend() {
  return Boolean(BACKEND_CONFIG.enabled && backendState);
}

async function loadBackendState() {
  if (!BACKEND_CONFIG.enabled) return;
  const stateUrl = `${BACKEND_CONFIG.apiBaseUrl}/state`;
  try {
    const response = await fetch(stateUrl, { cache: 'no-store' });
    if (!response.ok) {
      let detail = '';
      try {
        const errorBody = await response.json();
        detail = errorBody.error ? `: ${errorBody.error}` : '';
      } catch (parseError) {}
      throw new Error(`${stateUrl} returned ${response.status}${detail}`);
    }
    backendState = { ...emptyBackendState(), ...await response.json() };
    backendError = '';
  } catch (error) {
    backendState = null;
    backendError = error.message || `${stateUrl} could not be reached`;
  }
}

async function loadSession() {
  if (!BACKEND_CONFIG.enabled) return;
  try {
    const response = await fetch(`${BACKEND_CONFIG.apiBaseUrl}/session`, { cache: 'no-store' });
    if (!response.ok) throw new Error('Session unavailable');
    const session = await response.json();
    serverSession = session.authenticated ? { username: session.username, role: session.role } : null;
  } catch (error) {
    serverSession = null;
  }
}

function requireReadyMessage(element) {
  if (appReady) return false;
  if (element) {
    element.textContent = 'Still connecting. Try again in a moment.';
    element.classList.remove('hidden');
  }
  return true;
}

function requireSharedStorage(element) {
  if (!BACKEND_CONFIG.enabled || usingBackend()) return false;
  const message = 'Shared database is not connected. Data would only save on this device, so login is paused until the backend is fixed.';
  if (element) {
    element.textContent = backendError ? `${message} (${backendError})` : message;
    element.classList.remove('hidden');
  }
  return true;
}

async function persistBackendState() {
  if (!usingBackend()) return true;
  const response = await fetch(`${BACKEND_CONFIG.apiBaseUrl}/state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(backendState)
  });
  if (!response.ok) throw new Error('Shared database save failed');
  return true;
}

function getAccounts() {
  const saved = (usingBackend() ? backendState.accounts : JSON.parse(localStorage.getItem(STORAGE_KEYS.accounts) || '[]')).map(ensureAccountShape);
  const hasAdmin = saved.some(account => account.username === DEFAULT_ADMIN.username);
  if (!hasAdmin) {
    saved.unshift(DEFAULT_ADMIN);
    if (usingBackend()) {
      backendState.accounts = saved;
      persistBackendState().catch(error => {
        backendError = error.message;
      });
    } else {
      localStorage.setItem(STORAGE_KEYS.accounts, JSON.stringify(saved));
    }
  }
  return saved;
}

function ensureAccountShape(account) {
  return {
    username: account.username,
    email: account.email || '',
    password: account.password,
    role: account.username === 'admin' ? 'owner' : (account.role === 'owner' ? 'owner' : (account.role === 'admin' ? 'admin' : 'user')),
    disabled: Boolean(account.disabled),
    createdAt: account.createdAt || new Date().toISOString(),
    lastLoginAt: account.lastLoginAt || '',
    lastFailedLoginAt: account.lastFailedLoginAt || ''
  };
}

function saveAccounts(accounts) {
  if (usingBackend()) {
    backendState.accounts = accounts;
    return persistBackendState();
  }
  localStorage.setItem(STORAGE_KEYS.accounts, JSON.stringify(accounts));
  return Promise.resolve(true);
}

function getSession() {
  if (BACKEND_CONFIG.enabled) return serverSession;
  return JSON.parse(localStorage.getItem(STORAGE_KEYS.session) || 'null');
}

function setSession(account) {
  serverSession = { username: account.username, role: account.role };
  localStorage.setItem(STORAGE_KEYS.session, JSON.stringify({ username: account.username, role: account.role }));
}

async function logout() {
  if (BACKEND_CONFIG.enabled) {
    await fetch(`${BACKEND_CONFIG.apiBaseUrl}/logout`, { method: 'POST' }).catch(() => {});
    serverSession = null;
  }
  localStorage.removeItem(STORAGE_KEYS.session);
  window.location.href = 'login.html';
}

async function login(event) {
  event.preventDefault();
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
  const error = document.getElementById('loginError');
  if (requireReadyMessage(error)) return;
  if (requireSharedStorage(error)) return;

  if (BACKEND_CONFIG.enabled) {
    const response = await fetch(`${BACKEND_CONFIG.apiBaseUrl}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      error.textContent = result.error || 'Login failed.';
      error.classList.remove('hidden');
      return;
    }
    setSession(result.account);
    window.location.href = ['owner', 'admin'].includes(result.account.role) ? 'admin.html' : 'dashboard.html';
    return;
  }

  const account = getAccounts().find(item => item.username === username && item.password === password);
  if (!account || account.disabled) {
    error.textContent = account?.disabled ? 'This account is disabled. Contact an admin.' : 'Incorrect username or password.';
    error.classList.remove('hidden');
    return;
  }

  const accounts = getAccounts();
  const savedAccount = accounts.find(item => item.username === account.username);
  try {
    if (savedAccount) {
      savedAccount.lastLoginAt = new Date().toISOString();
      await saveAccounts(accounts);
    }
    await writeAudit('login', account.username, 'User logged in.');
  } catch (saveError) {
    error.textContent = 'Login found your account, but the shared database could not save the session update. Try again.';
    error.classList.remove('hidden');
    return;
  }
  setSession(account);
  window.location.href = ['owner', 'admin'].includes(account.role) ? 'admin.html' : 'dashboard.html';
}

async function goToAdmin(event) {
  event.preventDefault();
  const error = document.getElementById('loginError');
  if (requireReadyMessage(error)) return;

  await loadSession();
  if (['owner', 'admin'].includes(serverSession?.role)) {
    window.location.href = 'admin.html';
    return;
  }

  if (error) {
    error.textContent = 'Admin access required. Log in with an admin account first.';
    error.classList.remove('hidden');
  } else {
    alert('Admin access required. Log in with an admin account first.');
  }
}

async function goToAdminFromLogin(event) {
  return goToAdmin(event);
}

function requireLogin(allowedRoles = ['user', 'admin']) {
  const session = getSession();
  if (!session || !allowedRoles.includes(session.role)) {
    window.location.href = 'login.html';
    return null;
  }

  document.querySelectorAll('[data-current-user]').forEach(label => {
    label.textContent = session.username;
  });

  const adminLink = document.getElementById('adminLink');
  if (adminLink) {
    adminLink.classList.toggle('hidden', !['owner', 'admin'].includes(session.role));
  }

  document.body.classList.remove('auth-pending');
  return session;
}

async function addAccount(event) {
  event.preventDefault();
  const username = document.getElementById('newUsername').value.trim();
  const email = document.getElementById('newEmail').value.trim();
  const password = document.getElementById('newPassword').value;
  const role = document.getElementById('newRole').value;
  const message = document.getElementById('accountMessage');
  if (requireSharedStorage(message)) return;
  const accounts = getAccounts();

  if (username.length < 3 || password.length < 8) {
    showMessage(message, 'Username must be 3+ characters and password must be 8+ characters.', true);
    return;
  }

  if (!email.includes('@')) {
    showMessage(message, 'Enter a valid account email.', true);
    return;
  }

  if (accounts.some(account => account.username.toLowerCase() === username.toLowerCase())) {
    showMessage(message, 'That username already exists.', true);
    return;
  }

  accounts.push({ username, email, password, role, disabled: false, createdAt: new Date().toISOString(), lastLoginAt: '' });
  try {
    if (usingBackend()) {
      backendState.accounts = accounts;
      backendState.subscriptions[username] = [];
      backendState.settings[username] = defaultSettings();
      backendState.history[username] = [];
      await persistBackendState();
    } else {
      await saveAccounts(accounts);
      localStorage.setItem(subscriptionKeyFor(username), JSON.stringify([]));
      localStorage.setItem(settingsKeyFor(username), JSON.stringify(defaultSettings()));
      localStorage.setItem(historyKeyFor(username), JSON.stringify([]));
    }
    await writeAudit('create_account', username, `Created ${role} account.`);
  } catch (saveError) {
    showMessage(message, 'Account could not be saved to the shared database. Try again.', true);
    return;
  }
  event.target.reset();
  showMessage(message, `Account created for ${username}.`, false);
  renderAccounts();
}

function deleteAccount(username) {
  const session = getSession();
  if (username === 'admin') {
    alert('The default admin account cannot be deleted.');
    return;
  }
  if (session && session.username === username) {
    alert('You cannot delete the account you are currently using.');
    return;
  }
  const accounts = getAccounts().filter(account => account.username !== username);
  saveAccounts(accounts);
  if (usingBackend()) {
    delete backendState.subscriptions[username];
    delete backendState.settings[username];
    delete backendState.history[username];
    persistBackendState();
  } else {
    localStorage.removeItem(subscriptionKeyFor(username));
    localStorage.removeItem(settingsKeyFor(username));
    localStorage.removeItem(historyKeyFor(username));
  }
  writeAudit('delete_account', username, 'Deleted account and local user data.');
  renderAccounts();
}

function renderAccounts() {
  const tbody = document.getElementById('accountsTable');
  if (!tbody) return;
  renderSignupAccess();
  renderEmailStatus();
  renderUserPreviewSelector();
  renderSystemHealth();
  renderRiskReview();
  renderInviteManagement();
  renderAnnouncementEditor();
  const search = (document.getElementById('userSearch')?.value || '').trim().toLowerCase();
  const accounts = getAccounts().filter(account => {
    if (!search) return true;
    return [account.username, account.email, account.role, account.disabled ? 'disabled' : 'enabled'].some(value => String(value).toLowerCase().includes(search));
  });
  tbody.innerHTML = accounts.map(account => `
    <tr>
      <td data-label="Username">${escapeHtml(account.username)}</td>
      <td data-label="Email">${escapeHtml(account.email || 'Not set')}</td>
      <td data-label="Role">
        <select class="inline-select" onchange="changeUserRole('${escapeJs(account.username)}', this.value)" ${account.username === 'admin' ? 'disabled' : ''}>
          <option value="user" ${account.role === 'user' ? 'selected' : ''}>user</option>
          <option value="admin" ${account.role === 'admin' ? 'selected' : ''}>admin</option>
          <option value="owner" ${account.role === 'owner' ? 'selected' : ''}>owner</option>
        </select>
      </td>
      <td data-label="Status"><span class="pill ${account.disabled ? 'danger-pill' : ''}">${account.disabled ? 'Disabled' : 'Enabled'}</span></td>
      <td data-label="Created">${new Date(account.createdAt).toLocaleDateString()}</td>
      <td data-label="Last Login">${account.lastLoginAt ? new Date(account.lastLoginAt).toLocaleString() : 'Never'}</td>
      <td data-label="Actions" class="actions-cell">
        <button class="btn ghost small-btn" onclick="preparePasswordReset('${escapeJs(account.username)}')">Reset</button>
        <button class="btn ghost small-btn" onclick="unlockAccount('${escapeJs(account.username)}')" ${!account.lockedUntil && !Number(account.failedLoginCount || 0) ? 'disabled' : ''}>Unlock</button>
        <button class="btn ghost small-btn" onclick="toggleAccountDisabled('${escapeJs(account.username)}')" ${account.username === 'admin' ? 'disabled' : ''}>${account.disabled ? 'Enable' : 'Disable'}</button>
        <button class="btn danger small-btn" onclick="deleteAccount('${escapeJs(account.username)}')">Delete</button>
      </td>
    </tr>
  `).join('') || '<tr><td colspan="7">No users match your search.</td></tr>';
  renderAuditLog();
}

async function postAdminAction(url, payload = {}) {
  const response = await fetch(`${BACKEND_CONFIG.apiBaseUrl}${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'Admin action failed');
  await loadBackendState();
  return result;
}

async function renderSystemHealth() {
  const container = document.getElementById('systemHealth');
  if (!container) return;
  const health = await fetch(`${BACKEND_CONFIG.apiBaseUrl}/health`).then(response => response.json()).catch(() => null);
  const lastJob = [...getAuditLog()].reverse().find(entry => entry.action.startsWith('scheduled_') || entry.action.startsWith('monthly_summary'));
  container.innerHTML = health ? `
    <div class="status-strip">
      <span><strong>${escapeHtml(health.storage)}</strong> storage</span>
      <span><strong>${health.email?.configured ? 'Ready' : 'Queue'}</strong> email</span>
      <span><strong>${health.email?.scheduledJobsConfigured ? 'Set' : 'Missing'}</strong> cron</span>
    </div>
    <div class="history-item"><div><strong>Database</strong><span>${escapeHtml(health.database?.host || 'local json file')}</span></div><div><strong>${health.database?.valid === false ? 'Invalid' : 'OK'}</strong><span>${escapeHtml(String(health.database?.ssl ?? 'n/a'))}</span></div></div>
    <div class="history-item"><div><strong>Last Scheduled Job</strong><span>${lastJob ? escapeHtml(lastJob.detail) : 'No scheduled job recorded'}</span></div><div><strong>${lastJob ? new Date(lastJob.createdAt).toLocaleString() : 'Never'}</strong><span>${escapeHtml(lastJob?.actor || 'system')}</span></div></div>
  ` : '<p class="muted compact">Health check unavailable.</p>';
}

function renderRiskReview() {
  const container = document.getElementById('riskReview');
  if (!container) return;
  const risks = [];
  getAccounts().forEach(account => {
    if (!account.email) risks.push({ title: account.username, detail: 'No email address set', action: 'Profile risk' });
    if (account.disabled) risks.push({ title: account.username, detail: 'Account is disabled', action: 'Disabled' });
    if (Number(account.failedLoginCount || 0) > 0) risks.push({ title: account.username, detail: `${account.failedLoginCount} failed login attempts`, action: account.lockedUntil ? 'Locked' : 'Watch' });
  });
  (backendState.emailQueue || []).filter(item => item.status === 'failed').slice(-8).forEach(item => {
    risks.push({ title: item.email || item.username, detail: item.error || 'Email failed', action: 'Email' });
  });
  getAccounts().forEach(account => {
    getSubscriptionsForUser(account.username).filter(sub => sub.status === 'Cancel Soon').forEach(sub => {
      risks.push({ title: `${account.username}: ${sub.name}`, detail: 'Subscription marked Cancel Soon', action: 'Billing' });
    });
  });
  container.innerHTML = risks.map(item => `
    <div class="history-item">
      <div><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.detail)}</span></div>
      <div><strong>${escapeHtml(item.action)}</strong><span>review</span></div>
    </div>
  `).join('') || '<p class="muted compact">No current risks flagged.</p>';
}

function renderInviteManagement() {
  const container = document.getElementById('inviteManagement');
  if (!container) return;
  const invites = (backendState.invites || []).slice(-20).reverse();
  container.innerHTML = invites.map(invite => `
    <div class="history-item">
      <div>
        <strong>${escapeHtml(invite.username)}</strong>
        <span>${escapeHtml(invite.email)} - ${escapeHtml(invite.role)} - ${invite.revokedAt ? 'revoked' : invite.usedAt ? 'used' : 'pending'}</span>
      </div>
      <div class="actions-cell">
        <button class="btn ghost small-btn" onclick="resendInvite('${escapeJs(invite.token || '')}')" ${invite.usedAt || invite.revokedAt ? 'disabled' : ''}>Resend</button>
        <button class="btn danger small-btn" onclick="revokeInvite('${escapeJs(invite.token || '')}')" ${invite.usedAt || invite.revokedAt ? 'disabled' : ''}>Revoke</button>
      </div>
    </div>
  `).join('') || '<p class="muted compact">No invites yet.</p>';
}

async function resendInvite(token) {
  try {
    await postAdminAction('/admin/resend-invite', { token });
    renderInviteManagement();
  } catch (error) {
    alert(error.message);
  }
}

async function revokeInvite(token) {
  try {
    await postAdminAction('/admin/revoke-invite', { token });
    renderInviteManagement();
  } catch (error) {
    alert(error.message);
  }
}

async function unlockAccount(username) {
  try {
    await postAdminAction('/admin/unlock-account', { username });
    renderAccounts();
  } catch (error) {
    alert(error.message);
  }
}

async function renderEmailStatus() {
  const container = document.getElementById('emailStatus');
  if (!container || !usingBackend()) return;

  const health = await fetch(`${BACKEND_CONFIG.apiBaseUrl}/health`).then(response => response.json()).catch(() => null);
  const emailReady = Boolean(health?.email?.configured);
  const jobsReady = Boolean(health?.email?.scheduledJobsConfigured);
  const queue = (backendState.emailQueue || []).slice(-20).reverse();
  const counts = queue.reduce((totals, item) => {
    totals[item.status || 'queued'] = (totals[item.status || 'queued'] || 0) + 1;
    return totals;
  }, {});

  container.innerHTML = `
    <p class="message ${emailReady ? 'success' : 'error'}">${emailReady ? 'Reminder email sending is configured.' : 'Reminder emails are queued only. Add RESEND_API_KEY and REMINDER_FROM_EMAIL to send.'}</p>
    <p class="message ${jobsReady ? 'success' : 'error'}">${jobsReady ? 'Scheduled job endpoint is protected with CRON_SECRET.' : 'Set CRON_SECRET before wiring Railway scheduled jobs.'}</p>
    <div class="status-strip">
      <span><strong>${counts.sent || 0}</strong> sent</span>
      <span><strong>${counts.queued || 0}</strong> queued</span>
      <span><strong>${counts.failed || 0}</strong> failed</span>
    </div>
    ${queue.map(item => `
      <div class="history-item">
        <div>
          <strong>${escapeHtml(item.subscription || 'Reminder')}</strong>
          <span>${escapeHtml(item.email || 'No email')} - ${escapeHtml(item.nextBillDate || 'No date')}</span>
        </div>
        <div>
          <strong>${escapeHtml(item.status || 'queued')}</strong>
          <span>${escapeHtml(item.error || new Date(item.createdAt).toLocaleString())}</span>
          ${item.status === 'failed' ? `<button class="btn ghost small-btn" type="button" onclick="retryEmail('${escapeJs(item.id)}')">Retry</button>` : ''}
        </div>
      </div>
    `).join('') || '<p class="muted compact">No reminder emails have been queued yet.</p>'}
  `;
}

async function retryEmail(id) {
  try {
    await postAdminAction('/admin/retry-email', { id });
    renderEmailStatus();
    renderAuditLog();
  } catch (error) {
    alert(error.message);
  }
}

async function runDailyEmailJob() {
  const response = await fetch(`${BACKEND_CONFIG.apiBaseUrl}/jobs/daily`, { method: 'POST' });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    alert(result.error || 'Daily job could not run.');
    return;
  }
  await loadBackendState();
  renderEmailStatus();
  renderAuditLog();
}

function renderUserPreviewSelector() {
  const select = document.getElementById('previewUserSelect');
  if (!select) return;

  const selected = select.value || getAccounts().find(account => account.role === 'user')?.username || getAccounts()[0]?.username || '';
  select.innerHTML = getAccounts().map(account => `<option value="${escapeHtml(account.username)}">${escapeHtml(account.username)}</option>`).join('');
  select.value = getAccounts().some(account => account.username === selected) ? selected : (getAccounts()[0]?.username || '');
  renderUserPreview();
}

function renderUserPreview() {
  const container = document.getElementById('userPreview');
  const select = document.getElementById('previewUserSelect');
  if (!container || !select) return;

  const username = select.value;
  const account = getAccounts().find(item => item.username === username);
  const subscriptions = getSubscriptionsForUser(username);
  const settings = getSettingsForUser(username);
  const billable = subscriptions.filter(isBillable);
  const monthly = billable.reduce((sum, sub) => sum + monthlyEquivalent(sub), 0);
  const dueSoon = getUpcomingBills(subscriptions, 30).slice(0, 5);
  const categories = Object.entries(billable.reduce((groups, sub) => {
    groups[sub.category] = (groups[sub.category] || 0) + monthlyEquivalent(sub);
    return groups;
  }, {})).sort((a, b) => b[1] - a[1]).slice(0, 4);
  const flagged = getSavingsCandidates(billable).slice(0, 4);

  container.innerHTML = account ? `
    <div class="preview-stats">
      <div><span>Monthly</span><strong>${escapeHtml(formatCurrency(monthly, settings))}</strong></div>
      <div><span>Subscriptions</span><strong>${subscriptions.length}</strong></div>
      <div><span>Budget</span><strong>${escapeHtml(formatCurrency(settings.monthlyBudget || 0, settings))}</strong></div>
    </div>
    <div class="history-list">
      <h3>Top Categories</h3>
      ${categories.map(([category, total]) => `
        <div class="history-item">
          <div><strong>${escapeHtml(category)}</strong><span>Monthly equivalent</span></div>
          <div><strong>${escapeHtml(formatCurrency(total, settings))}</strong><span>category spend</span></div>
        </div>
      `).join('') || '<p class="muted compact">No category spend yet.</p>'}
      <h3>Flagged Items</h3>
      ${flagged.map(sub => `
        <div class="history-item">
          <div><strong>${escapeHtml(sub.name)}</strong><span>${escapeHtml(sub.reason)}</span></div>
          <div><strong>${escapeHtml(formatCurrency(monthlyEquivalent(sub), settings))}</strong><span>monthly</span></div>
        </div>
      `).join('') || '<p class="muted compact">No savings flags for this user.</p>'}
      <h3>Upcoming Bills</h3>
      ${dueSoon.map(sub => `
        <div class="history-item">
          <div>
            <strong>${escapeHtml(sub.name)}</strong>
            <span>${escapeHtml(sub.category)} - ${escapeHtml(formatDate(sub.nextBillDate))}</span>
          </div>
          <div>
            <strong>${escapeHtml(formatCurrency(sub.cost, settings))}</strong>
            <span>${escapeHtml(sub.status)}</span>
          </div>
        </div>
      `).join('') || '<p class="muted compact">No upcoming bills for this user.</p>'}
    </div>
  ` : '<p class="muted compact">Choose a user to preview their dashboard.</p>';
  renderAdminNote();
}

function renderAdminNote() {
  const input = document.getElementById('adminNoteText');
  const select = document.getElementById('previewUserSelect');
  if (!input || !select || !usingBackend()) return;
  input.value = backendState.adminNotes?.[select.value]?.text || '';
}

function saveAdminNote(event) {
  event.preventDefault();
  const select = document.getElementById('previewUserSelect');
  const input = document.getElementById('adminNoteText');
  const message = document.getElementById('adminNoteMessage');
  if (!select || !input || !usingBackend()) return;
  postAdminAction('/admin/note', { username: select.value, text: input.value.trim() })
    .then(() => {
      showMessage(message, 'Admin note saved.', false);
      renderAdminNote();
      renderAuditLog();
    })
    .catch(() => showMessage(message, 'Admin note could not be saved.', true));
}

function runAdminQuickAction(event) {
  event.preventDefault();
  const input = document.getElementById('adminQuickAction');
  const message = document.getElementById('adminQuickActionMessage');
  const text = (input?.value || '').trim();
  const [command, username, ...rest] = text.split(/\s+/);
  if (!command || !username) {
    showMessage(message, 'Enter a command and username.', true);
    return;
  }

  if (command === 'disable' || command === 'enable') {
    const account = getAccounts().find(item => item.username === username);
    if (!account) return showMessage(message, 'Account not found.', true);
    if ((command === 'disable') !== account.disabled) toggleAccountDisabled(username);
    showMessage(message, `${username} is ${command === 'disable' ? 'disabled' : 'enabled'}.`, false);
  } else if (command === 'reset') {
    preparePasswordReset(username);
    const password = rest.join(' ');
    if (password) {
      document.getElementById('resetPassword').value = password;
      resetUserPassword({ preventDefault() {}, target: document.querySelector('#resetPassword')?.form });
    }
    showMessage(message, password ? `Password reset for ${username}.` : `Ready to reset ${username}.`, false);
  } else if (command === 'invite') {
    document.getElementById('inviteUsername').value = username;
    document.getElementById('inviteEmail').value = rest[0] || '';
    showMessage(message, `Invite form filled for ${username}.`, false);
  } else if (command === 'note') {
    const select = document.getElementById('previewUserSelect');
    if (select) select.value = username;
    renderUserPreview();
    const note = rest.join(' ');
    if (note) document.getElementById('adminNoteText').value = note;
    showMessage(message, `Note ready for ${username}.`, false);
  } else {
    showMessage(message, 'Unknown command. Try disable, enable, reset, invite, or note.', true);
    return;
  }
  if (input) input.value = '';
}

function changeUserRole(username, role) {
  const session = getSession();
  if (username === 'admin') return;
  if (session && session.username === username && !['owner', 'admin'].includes(role)) {
    alert('You cannot remove your own admin access while logged in.');
    renderAccounts();
    return;
  }

  const accounts = getAccounts();
  const account = accounts.find(item => item.username === username);
  if (!account) return;
  account.role = role;
  saveAccounts(accounts);
  writeAudit('change_role', username, `Changed role to ${role}.`);
  renderAccounts();
}

function toggleAccountDisabled(username) {
  const session = getSession();
  if (username === 'admin') return;
  if (session && session.username === username) {
    alert('You cannot disable the account you are currently using.');
    return;
  }

  const accounts = getAccounts();
  const account = accounts.find(item => item.username === username);
  if (!account) return;
  account.disabled = !account.disabled;
  saveAccounts(accounts);
  writeAudit(account.disabled ? 'disable_account' : 'enable_account', username, `${account.disabled ? 'Disabled' : 'Enabled'} account.`);
  renderAccounts();
}

function preparePasswordReset(username) {
  const usernameInput = document.getElementById('resetUsername');
  const labelInput = document.getElementById('resetUsernameLabel');
  const passwordInput = document.getElementById('resetPassword');
  const message = document.getElementById('resetMessage');
  if (!usernameInput || !labelInput || !passwordInput) return;
  usernameInput.value = username;
  labelInput.value = username;
  passwordInput.value = '';
  message.classList.add('hidden');
  passwordInput.focus();
}

function resetUserPassword(event) {
  event.preventDefault();
  const username = document.getElementById('resetUsername').value;
  const password = document.getElementById('resetPassword').value;
  const message = document.getElementById('resetMessage');
  const accounts = getAccounts();
  const account = accounts.find(item => item.username === username);

  if (!account) {
    showMessage(message, 'Choose an account to reset first.', true);
    return;
  }

  if (password.length < 8) {
    showMessage(message, 'Password must be at least 8 characters.', true);
    return;
  }

  account.password = password;
  saveAccounts(accounts);
  writeAudit('reset_password', username, 'Reset user password.');
  event.target.reset();
  document.getElementById('resetUsernameLabel').value = '';
  showMessage(message, `Password reset for ${username}.`, false);
}

async function createInvite(event) {
  event.preventDefault();
  const username = document.getElementById('inviteUsername').value.trim();
  const email = document.getElementById('inviteEmail').value.trim();
  const role = document.getElementById('inviteRole').value;
  const message = document.getElementById('inviteMessage');
  const linkInput = document.getElementById('inviteLink');

  const response = await fetch(`${BACKEND_CONFIG.apiBaseUrl}/invites`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, email, role })
  });
  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    showMessage(message, result.error || 'Invite could not be created.', true);
    return;
  }

  const inviteUrl = `${location.origin}${location.pathname.replace(/admin\.html$/, 'signup.html')}?token=${encodeURIComponent(result.invite.token)}`;
  linkInput.value = inviteUrl;
  linkInput.classList.remove('hidden');
  await navigator.clipboard?.writeText(inviteUrl).catch(() => {});
  event.target.reset();
  showMessage(message, 'Invite link created and copied.', false);
  await loadBackendState();
  renderAccounts();
}

function saveSignupAccess(event) {
  event.preventDefault();
  const message = document.getElementById('signupAccessMessage');
  backendState.publicSignup = Boolean(document.getElementById('publicSignupEnabled').checked);
  persistBackendState()
    .then(() => {
      renderSignupAccess();
      renderLoginSignupPrompt();
      writeAudit('signup_access', 'public_signup', backendState.publicSignup ? 'Enabled public signup.' : 'Disabled public signup.');
      showMessage(message, backendState.publicSignup ? 'Public signup enabled.' : 'Public signup disabled.', false);
    })
    .catch(() => showMessage(message, 'Signup access could not be saved.', true));
}

function renderSignupAccess() {
  const checkbox = document.getElementById('publicSignupEnabled');
  if (!checkbox || !usingBackend()) return;
  const enabled = Boolean(backendState.publicSignup);
  const status = document.getElementById('signupAccessStatus');
  checkbox.checked = enabled;
  if (status) status.textContent = enabled ? 'Open to new users' : 'Invite-only';
}

function previewSignupAccess() {
  const checkbox = document.getElementById('publicSignupEnabled');
  const status = document.getElementById('signupAccessStatus');
  if (!checkbox || !status) return;
  status.textContent = checkbox.checked ? 'Open to new users' : 'Invite-only';
}

function renderLoginSignupPrompt() {
  const prompt = document.getElementById('signupPrompt');
  if (!prompt) return;
  prompt.classList.toggle('hidden', !usingBackend() || !backendState.publicSignup);
}

async function signup(event) {
  event.preventDefault();
  const message = document.getElementById('signupMessage');
  const payload = {
    token: document.getElementById('signupToken').value,
    username: document.getElementById('signupUsername').value.trim(),
    email: document.getElementById('signupEmail').value.trim(),
    password: document.getElementById('signupPassword').value
  };

  const response = await fetch(`${BACKEND_CONFIG.apiBaseUrl}/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    showMessage(message, result.error || 'Account could not be created.', true);
    return;
  }

  setSession(result.account);
  window.location.href = ['owner', 'admin'].includes(result.account.role) ? 'admin.html' : 'dashboard.html';
}

async function renderSignupForm() {
  const tokenInput = document.getElementById('signupToken');
  if (!tokenInput || !usingBackend()) return;

  const token = new URLSearchParams(location.search).get('token') || '';
  tokenInput.value = token;
  if (!token) return;

  const response = await fetch(`${BACKEND_CONFIG.apiBaseUrl}/invite?token=${encodeURIComponent(token)}`);
  const result = await response.json().catch(() => ({}));
  const invite = response.ok ? result.invite : null;
  if (invite) {
    document.getElementById('signupUsername').value = invite.username;
    document.getElementById('signupEmail').value = invite.email;
    document.getElementById('signupUsername').readOnly = true;
    document.getElementById('signupEmail').readOnly = true;
  }
}

function renderLoginPageMessage() {
  const error = document.getElementById('loginError');
  if (!error) return;

  const errorCode = new URLSearchParams(location.search).get('error');
  if (errorCode === 'admin') {
    error.textContent = 'Admin access required. Log in with an admin account first.';
    error.classList.remove('hidden');
  }
}

async function requestPasswordReset(event) {
  event.preventDefault();
  const email = document.getElementById('resetEmail').value.trim();
  const message = document.getElementById('forgotMessage');

  try {
    await fetch(`${BACKEND_CONFIG.apiBaseUrl}/password-reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    showMessage(message, 'If that email exists, a reset link has been sent.', false);
  } catch (error) {
    showMessage(message, 'The reset email could not be sent. Try again later.', true);
  }
}

function renderResetPasswordForm() {
  const tokenInput = document.getElementById('resetToken');
  if (!tokenInput) return;
  tokenInput.value = new URLSearchParams(location.search).get('token') || '';
}

async function resetPasswordWithToken(event) {
  event.preventDefault();
  const message = document.getElementById('resetTokenMessage');
  const token = document.getElementById('resetToken').value;
  const password = document.getElementById('resetTokenPassword').value;
  const response = await fetch(`${BACKEND_CONFIG.apiBaseUrl}/reset-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, password })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    showMessage(message, result.error || 'Password could not be reset.', true);
    return;
  }
  event.target.reset();
  showMessage(message, 'Password updated. You can log in now.', false);
}

async function queueReminderEmail(account, subscription, nextBillDate) {
  if (!BACKEND_CONFIG.enabled || !BACKEND_CONFIG.apiBaseUrl || !account.email) return;
  await fetch(`${BACKEND_CONFIG.apiBaseUrl}/reminders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: account.email,
      username: account.username,
      subscription: subscription.name,
      amount: subscription.cost,
      nextBillDate
    })
  });
}

function processReminderEmails(subscriptions) {
  if (!BACKEND_CONFIG.enabled || !BACKEND_CONFIG.apiBaseUrl) return;
  const session = getSession();
  const account = getAccounts().find(item => item.username === session?.username);
  const settings = getSettings();
  if (settings.emailRemindersEnabled === false) return;
  if (!account?.email) return;

  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const sent = getSentReminders();

  subscriptions.filter(isBillable).forEach(sub => {
    const reminderDays = Number(sub.reminderDays) || 0;
    if (!reminderDays) return;
    const nextBill = getNextOccurrence(sub, now);
    const daysUntil = daysBetween(now, nextBill);
    const dateKey = nextBill ? nextBill.toISOString().slice(0, 10) : '';
    const sentKey = `${account.username}:${sub.id}:${dateKey}:${reminderDays}`;
    if (daysUntil === reminderDays && !sent.includes(sentKey)) {
      queueReminderEmail(account, sub, dateKey);
      sent.push(sentKey);
    }
  });

  saveSentReminders(sent);
}

function renderAuditLog() {
  const container = document.getElementById('auditLog');
  if (!container) return;

  renderAuditFilters();
  const search = (document.getElementById('auditSearch')?.value || '').trim().toLowerCase();
  const action = document.getElementById('auditActionFilter')?.value || 'all';
  const user = document.getElementById('auditUserFilter')?.value || 'all';
  const dateRange = document.getElementById('auditDateFilter')?.value || 'all';
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const entries = getAuditLog().filter(entry => {
    const matchesAction = action === 'all' || entry.action === action;
    const matchesUser = user === 'all' || entry.actor === user || entry.target === user;
    const createdAt = new Date(entry.createdAt);
    const matchesDate = dateRange === 'all'
      || (dateRange === 'today' && createdAt >= startOfToday)
      || (!Number.isNaN(Number(dateRange)) && createdAt >= new Date(now.getTime() - Number(dateRange) * 24 * 60 * 60 * 1000));
    const haystack = [entry.action, entry.detail, entry.actor, entry.target, entry.createdAt].join(' ').toLowerCase();
    return matchesAction && matchesUser && matchesDate && (!search || haystack.includes(search));
  });
  const visibleEntries = entries.slice(-40).reverse();
  const summary = document.getElementById('auditSummary');
  if (summary) {
    const total = getAuditLog().length;
    const limited = entries.length > visibleEntries.length ? ` Showing latest ${visibleEntries.length}.` : '';
    summary.textContent = `${entries.length} of ${total} events match the current filters.${limited}`;
  }

  container.innerHTML = visibleEntries.map(entry => `
    <div class="history-item">
      <div>
        <strong>${escapeHtml(entry.action.replace(/_/g, ' '))}</strong>
        <span>${escapeHtml(entry.detail)} Target: ${escapeHtml(entry.target || 'n/a')}</span>
      </div>
      <div>
        <strong>${escapeHtml(entry.actor || 'system')}</strong>
        <span>${new Date(entry.createdAt).toLocaleString()}</span>
      </div>
    </div>
  `).join('') || '<p class="muted compact">No admin activity yet.</p>';
}

function resetAuditFilters() {
  const search = document.getElementById('auditSearch');
  const action = document.getElementById('auditActionFilter');
  const user = document.getElementById('auditUserFilter');
  const date = document.getElementById('auditDateFilter');
  if (search) search.value = '';
  if (action) action.value = 'all';
  if (user) user.value = 'all';
  if (date) date.value = 'all';
  renderAuditLog();
}

function toggleAdminSection(sectionId) {
  const section = document.getElementById(sectionId);
  if (!section) return;
  const isCollapsed = section.classList.toggle('collapsed');
  const button = section.querySelector('.collapse-btn');
  if (button) {
    button.textContent = isCollapsed ? 'Expand' : 'Collapse';
    button.setAttribute('aria-expanded', String(!isCollapsed));
  }
}

function renderAuditFilters() {
  const actionSelect = document.getElementById('auditActionFilter');
  const userSelect = document.getElementById('auditUserFilter');
  if (!actionSelect || !userSelect) return;

  const entries = getAuditLog();
  const selectedAction = actionSelect.value || 'all';
  const selectedUser = userSelect.value || 'all';
  const actions = [...new Set(entries.map(entry => entry.action).filter(Boolean))].sort();
  const users = [...new Set(entries.flatMap(entry => [entry.actor, entry.target]).filter(Boolean))].sort();

  actionSelect.innerHTML = '<option value="all">All actions</option>' + actions.map(item => `<option value="${escapeHtml(item)}">${escapeHtml(item.replace(/_/g, ' '))}</option>`).join('');
  userSelect.innerHTML = '<option value="all">All users</option>' + users.map(item => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join('');
  actionSelect.value = actions.includes(selectedAction) ? selectedAction : 'all';
  userSelect.value = users.includes(selectedUser) ? selectedUser : 'all';
}

function exportUsers() {
  const headers = ['Username', 'Email', 'Role', 'Status', 'Created', 'Last Login', 'Subscriptions', 'Monthly Average', 'Due This Month', 'Budget'];
  const now = new Date();
  const rows = getAccounts().map(account => {
    const subscriptions = getSubscriptionsForUser(account.username);
    const monthlyAverage = subscriptions.filter(isBillable).reduce((sum, sub) => sum + monthlyEquivalent(sub), 0);
    const dueThisMonth = getMonthlyDue(subscriptions, now.getFullYear(), now.getMonth());
    const settings = getSettingsForUser(account.username);
    return [
      account.username,
      account.email || '',
      account.role,
      account.disabled ? 'disabled' : 'enabled',
      account.createdAt,
      account.lastLoginAt || '',
      subscriptions.length,
      monthlyAverage.toFixed(2),
      dueThisMonth.toFixed(2),
      Number(settings.monthlyBudget || 0).toFixed(2)
    ];
  });
  const csv = [headers, ...rows].map(row => row.map(csvEscape).join(',')).join('\n');
  downloadCsv(csv, 'subtrack-users.csv');
  writeAudit('export_users', 'all_users', 'Exported user summary CSV.');
  renderAuditLog();
}

function exportAuditLog() {
  const headers = ['Action', 'Target', 'Actor', 'Detail', 'Created'];
  const rows = getAuditLog().map(entry => [entry.action, entry.target || '', entry.actor || '', entry.detail || '', entry.createdAt]);
  const csv = [headers, ...rows].map(row => row.map(csvEscape).join(',')).join('\n');
  downloadCsv(csv, 'subtracked-audit.csv');
}

function exportSelectedUserData() {
  const username = document.getElementById('previewUserSelect')?.value;
  if (!username) return;
  const payload = {
    account: getAccounts().find(account => account.username === username),
    subscriptions: getSubscriptionsForUser(username),
    settings: getSettingsForUser(username),
    history: usingBackend() ? (backendState.history[username] || []) : JSON.parse(localStorage.getItem(historyKeyFor(username)) || '[]')
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `subtracked-${username}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

async function sendTestEmail(event) {
  event.preventDefault();
  const message = document.getElementById('testEmailMessage');
  try {
    const result = await postAdminAction('/admin/test-email', { email: document.getElementById('testEmailAddress').value.trim() });
    showMessage(message, `Test email ${result.status}.`, result.status === 'failed');
    renderEmailStatus();
  } catch (error) {
    showMessage(message, error.message, true);
  }
}

function renderAnnouncementEditor() {
  const input = document.getElementById('announcementText');
  const enabledInput = document.getElementById('announcementEnabled');
  if (!input || !usingBackend()) return;
  const active = (backendState.announcements || []).find(item => !item.expiresAt || new Date(item.expiresAt) > new Date());
  input.value = active?.message || '';
  if (enabledInput) enabledInput.checked = Boolean(active?.message && active.enabled !== false);
  previewAnnouncementToggle();
}

function previewAnnouncementToggle() {
  const enabled = Boolean(document.getElementById('announcementEnabled')?.checked);
  const status = document.getElementById('announcementStatus');
  if (status) status.textContent = enabled ? 'Visible on dashboard' : 'Hidden from dashboard';
}

function saveAnnouncement(event) {
  event.preventDefault();
  const message = document.getElementById('announcementMessage');
  const text = document.getElementById('announcementText').value.trim();
  const enabled = Boolean(document.getElementById('announcementEnabled')?.checked);
  backendState.announcements = text ? [{
    message: text,
    enabled,
    createdAt: new Date().toISOString(),
    createdBy: getSession()?.username || 'admin'
  }] : [];
  persistBackendState()
    .then(() => {
      writeAudit('announcement_update', 'all_users', text ? `${enabled ? 'Enabled' : 'Saved hidden'} announcement.` : 'Cleared announcement.');
      showMessage(message, text ? `Announcement ${enabled ? 'shown' : 'saved hidden'}.` : 'Announcement cleared.', false);
      previewAnnouncementToggle();
    })
    .catch(() => showMessage(message, 'Announcement could not be saved.', true));
}

function clearAnnouncement() {
  const input = document.getElementById('announcementText');
  const enabled = document.getElementById('announcementEnabled');
  if (input) input.value = '';
  if (enabled) enabled.checked = false;
  saveAnnouncement({ preventDefault() {} });
}

function subscriptionKeyFor(username) {
  return `${STORAGE_KEYS.subscriptions}_${username}`;
}

function settingsKeyFor(username) {
  return `${STORAGE_KEYS.settings}_${username}`;
}

function historyKeyFor(username) {
  return `${STORAGE_KEYS.history}_${username}`;
}

function getCurrentSubscriptionKey() {
  const session = getSession();
  return subscriptionKeyFor(session ? session.username : 'guest');
}

function getCurrentSettingsKey() {
  const session = getSession();
  return settingsKeyFor(session ? session.username : 'guest');
}

function getCurrentHistoryKey() {
  const session = getSession();
  return historyKeyFor(session ? session.username : 'guest');
}

function defaultSettings() {
  return {
    monthlyBudget: 0,
    darkMode: false,
    currencyCode: 'USD',
    emailRemindersEnabled: true,
    defaultReminderDays: 7,
    highCostWarnings: true,
    highCostLimit: HIGH_COST_THRESHOLD,
    monthlySummaryEmail: false
  };
}

function getSettings() {
  if (usingBackend()) {
    const session = getSession();
    return { ...defaultSettings(), ...(backendState.settings[session?.username || 'guest'] || {}) };
  }
  return { ...defaultSettings(), ...JSON.parse(localStorage.getItem(getCurrentSettingsKey()) || '{}') };
}

function saveSettings(settings) {
  if (usingBackend()) {
    const session = getSession();
    backendState.settings[session?.username || 'guest'] = settings;
    return persistBackendState();
  }
  localStorage.setItem(getCurrentSettingsKey(), JSON.stringify(settings));
  return Promise.resolve(true);
}

function applyTheme() {
  const settings = getSettings();
  const isDark = Boolean(settings.darkMode);
  document.body.classList.toggle('dark-mode', isDark);
  updateThemeButton(isDark);
}

function updateThemeButton(isDark) {
  const button = document.getElementById('themeToggleButton');
  if (!button) return;
  button.textContent = isDark ? '☀' : '☾';
  button.setAttribute('aria-label', isDark ? 'Switch to light mode' : 'Switch to dark mode');
  button.title = isDark ? 'Switch to light mode' : 'Switch to dark mode';
}

function toggleTheme() {
  const settings = getSettings();
  saveSettings({ ...settings, darkMode: !settings.darkMode });
  applyTheme();
}

function getHistory() {
  if (usingBackend()) {
    const session = getSession();
    return backendState.history[session?.username || 'guest'] || [];
  }
  return JSON.parse(localStorage.getItem(getCurrentHistoryKey()) || '[]');
}

function saveHistory(history) {
  if (usingBackend()) {
    const session = getSession();
    backendState.history[session?.username || 'guest'] = history;
    return persistBackendState();
  }
  localStorage.setItem(getCurrentHistoryKey(), JSON.stringify(history));
  return Promise.resolve(true);
}

function getAuditLog() {
  if (usingBackend()) return backendState.audit || [];
  return JSON.parse(localStorage.getItem(STORAGE_KEYS.audit) || '[]');
}

function saveAuditLog(entries) {
  if (usingBackend()) {
    backendState.audit = entries.slice(-100);
    return persistBackendState();
  }
  localStorage.setItem(STORAGE_KEYS.audit, JSON.stringify(entries.slice(-100)));
  return Promise.resolve(true);
}

function getSentReminders() {
  if (usingBackend()) return backendState.reminderSent || [];
  return JSON.parse(localStorage.getItem(STORAGE_KEYS.reminderSent) || '[]');
}

function saveSentReminders(entries) {
  if (usingBackend()) {
    backendState.reminderSent = entries.slice(-250);
    return persistBackendState();
  }
  localStorage.setItem(STORAGE_KEYS.reminderSent, JSON.stringify(entries.slice(-250)));
  return Promise.resolve(true);
}

async function writeAudit(action, target, detail) {
  const session = getSession();
  const entries = getAuditLog();
  entries.push({
    action,
    target,
    detail,
    actor: session?.username || target || 'system',
    createdAt: new Date().toISOString()
  });
  return saveAuditLog(entries);
}

function getSubscriptions() {
  if (usingBackend()) {
    const session = getSession();
    const username = session?.username || 'guest';
    const subscriptions = (backendState.subscriptions[username] || []).map(ensureSubscriptionShape);
    backendState.subscriptions[username] = subscriptions;
    return subscriptions;
  }
  const key = getCurrentSubscriptionKey();
  const raw = localStorage.getItem(key);

  if (!raw) {
    saveSubscriptions([]);
    return [];
  }

  const parsed = JSON.parse(raw).map(ensureSubscriptionShape);
  if (raw !== JSON.stringify(parsed)) {
    saveSubscriptions(parsed);
  }
  return parsed;
}

function saveSubscriptions(subscriptions) {
  if (usingBackend()) {
    const session = getSession();
    backendState.subscriptions[session?.username || 'guest'] = subscriptions;
    return persistBackendState();
  }
  localStorage.setItem(getCurrentSubscriptionKey(), JSON.stringify(subscriptions));
  return Promise.resolve(true);
}

function getSubscriptionsForUser(username) {
  if (usingBackend()) {
    return (backendState.subscriptions[username] || []).map(ensureSubscriptionShape);
  }
  const raw = localStorage.getItem(subscriptionKeyFor(username));
  if (!raw) return [];
  return JSON.parse(raw).map(ensureSubscriptionShape);
}

function getSettingsForUser(username) {
  if (usingBackend()) {
    return { ...defaultSettings(), ...(backendState.settings[username] || {}) };
  }
  return { ...defaultSettings(), ...JSON.parse(localStorage.getItem(settingsKeyFor(username)) || '{}') };
}

function ensureSubscriptionShape(sub) {
  return {
    id: sub.id || makeId(),
    name: sub.name || 'Untitled',
    category: sub.category || inferCategory(sub.name),
    cost: Number(sub.cost) || 0,
    nextBillDate: sub.nextBillDate || normalizeDate(sub.nextBill),
    billingIntervalUnit: sub.billingIntervalUnit || 'months',
    billingIntervalCount: Math.max(1, Number(sub.billingIntervalCount || sub.billingIntervalMonths) || 1),
    billingIntervalMonths: Math.max(1, Number(sub.billingIntervalMonths) || 1),
    status: sub.status || 'Active',
    reminderDays: Number(sub.reminderDays) || 0,
    paymentMethod: sub.paymentMethod || '',
    accountEmail: sub.accountEmail || '',
    cancelUrl: sub.cancelUrl || '',
    supportUrl: sub.supportUrl || '',
    notes: sub.notes || '',
    priceHistory: Array.isArray(sub.priceHistory) ? sub.priceHistory : []
  };
}

function inferCategory(name = '') {
  const lower = name.toLowerCase();
  if (['netflix', 'disney', 'hulu', 'stan', 'prime'].some(item => lower.includes(item))) return 'Streaming';
  if (['spotify', 'apple music', 'tidal'].some(item => lower.includes(item))) return 'Music';
  if (['adobe', 'canva', 'chatgpt', 'github', 'figma'].some(item => lower.includes(item))) return 'Software';
  if (['xbox', 'playstation', 'nintendo'].some(item => lower.includes(item))) return 'Gaming';
  if (['icloud', 'dropbox', 'google one'].some(item => lower.includes(item))) return 'Cloud';
  return 'Other';
}

function makeId() {
  return `sub_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function normalizeDate(value) {
  if (!value) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;

  const currentYear = new Date().getFullYear();
  const parsed = new Date(`${value} ${currentYear}`);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toISOString().slice(0, 10);
}

function parseLocalDate(value) {
  const iso = normalizeDate(value);
  if (!iso) return null;
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function formatDate(value) {
  const date = parseLocalDate(value);
  if (!date) return value || 'No date';
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });
}

function formatCurrency(value, settings = getSettings()) {
  const code = settings.currencyCode || 'USD';
  const symbol = CURRENCY_SYMBOLS[code] || '$';
  return `${symbol}${Number(value || 0).toFixed(2)}`;
}

function dateKeyForSort(sub) {
  return normalizeDate(sub.nextBillDate || sub.nextBill || '9999-12-31') || '9999-12-31';
}

function renderSubscriptionTemplates() {
  const select = document.getElementById('subscriptionTemplate');
  if (!select || select.dataset.ready) return;
  select.innerHTML = '<option value="">Start blank</option>' + SUBSCRIPTION_TEMPLATES.map(template => (
    `<option value="${escapeHtml(template.name)}">${escapeHtml(template.name)} - ${escapeHtml(template.category)}</option>`
  )).join('');
  select.dataset.ready = 'true';
}

function applySubscriptionTemplate() {
  const selected = document.getElementById('subscriptionTemplate')?.value;
  const template = SUBSCRIPTION_TEMPLATES.find(item => item.name === selected);
  if (!template) return;
  document.getElementById('subName').value = template.name;
  document.getElementById('subCategory').value = template.category;
  document.getElementById('subCost').value = Number(template.cost).toFixed(2);
  document.getElementById('subBillingCycle').value = template.billingCycle;
  document.getElementById('subCancelUrl').value = template.url;
  document.getElementById('subSupportUrl').value = template.url;
  toggleCustomBillingCycle();
}

function addSubscription(event) {
  event.preventDefault();
  const editingSubId = document.getElementById('editingSubId').value;
  const name = document.getElementById('subName').value.trim();
  const category = document.getElementById('subCategory').value;
  const cost = Number(document.getElementById('subCost').value);
  const billingSchedule = getBillingIntervalFromForm();
  const nextBillDate = document.getElementById('subDate').value;
  const status = document.getElementById('subStatus').value;
  const reminderDays = Number(document.getElementById('subReminder').value);
  const paymentMethod = document.getElementById('subPayment').value.trim();
  const accountEmail = document.getElementById('subAccountEmail').value.trim();
  const cancelUrl = document.getElementById('subCancelUrl').value.trim();
  const supportUrl = document.getElementById('subSupportUrl').value.trim();
  const notes = document.getElementById('subNotes').value.trim();

  if (!nextBillDate) {
    alert('Please choose a billing date from the calendar picker.');
    return;
  }

  const subscriptions = getSubscriptions();
  if (editingSubId) {
    const index = subscriptions.findIndex(sub => sub.id === editingSubId);
    if (index >= 0) {
      const existing = subscriptions[index];
      const oldCost = Number(existing.cost);
      const newCost = Number(cost);
      const priceHistory = [...(existing.priceHistory || [])];
      if (oldCost !== newCost) {
        priceHistory.push({
          changedAt: new Date().toISOString(),
          oldCost,
          newCost,
          oldCycle: formatBillingCycle(existing),
          newCycle: formatBillingCycle({ ...existing, ...billingSchedule })
        });
      }
      subscriptions[index] = { ...existing, name, category, cost, ...billingSchedule, nextBillDate, status, reminderDays, paymentMethod, accountEmail, cancelUrl, supportUrl, notes, priceHistory };
    }
  } else {
    subscriptions.push({ id: makeId(), name, category, cost, ...billingSchedule, nextBillDate, status, reminderDays, paymentMethod, accountEmail, cancelUrl, supportUrl, notes });
  }

  saveSubscriptions(subscriptions);
  resetSubscriptionForm();
  renderDashboard();
  showSection(editingSubId ? 'overview' : 'calendar');
}

function editSubscription(id) {
  const sub = getSubscriptions().find(item => item.id === id);
  if (!sub) return;

  document.getElementById('editingSubId').value = sub.id;
  document.getElementById('subName').value = sub.name;
  document.getElementById('subCategory').value = sub.category;
  document.getElementById('subCost').value = Number(sub.cost).toFixed(2);
  setBillingIntervalForm(sub);
  document.getElementById('subDate').value = normalizeDate(sub.nextBillDate);
  document.getElementById('subStatus').value = sub.status;
  document.getElementById('subReminder').value = String(sub.reminderDays || 0);
  document.getElementById('subPayment').value = sub.paymentMethod || '';
  document.getElementById('subAccountEmail').value = sub.accountEmail || '';
  document.getElementById('subCancelUrl').value = sub.cancelUrl || '';
  document.getElementById('subSupportUrl').value = sub.supportUrl || '';
  document.getElementById('subNotes').value = sub.notes || '';
  document.getElementById('subscriptionFormTitle').textContent = 'Edit Subscription';
  document.getElementById('saveSubButton').textContent = 'Update Subscription';
  document.getElementById('cancelEditButton').classList.remove('hidden');
  showSection('subscriptions');
}

function getBillingIntervalFromForm() {
  const cycle = document.getElementById('subBillingCycle').value;
  const custom = Number(document.getElementById('subBillingInterval').value);
  if (cycle === 'weekly') {
    return { billingIntervalUnit: 'weeks', billingIntervalCount: 1, billingIntervalMonths: 1 };
  }
  if (cycle === 'biweekly') {
    return { billingIntervalUnit: 'weeks', billingIntervalCount: 2, billingIntervalMonths: 1 };
  }
  const months = cycle === 'custom' ? Math.max(1, Math.floor(custom || 1)) : Number(cycle);
  return { billingIntervalUnit: 'months', billingIntervalCount: months, billingIntervalMonths: months };
}

function setBillingIntervalForm(sub) {
  const cycle = document.getElementById('subBillingCycle');
  const customInput = document.getElementById('subBillingInterval');
  if ((sub.billingIntervalUnit || 'months') === 'weeks') {
    cycle.value = Number(sub.billingIntervalCount) === 2 ? 'biweekly' : 'weekly';
    customInput.value = '';
    toggleCustomBillingCycle();
    return;
  }
  const value = Math.max(1, Number(sub.billingIntervalCount || sub.billingIntervalMonths) || 1);
  const preset = ['1', '2', '3', '6', '12'].includes(String(value));
  cycle.value = preset ? String(value) : 'custom';
  customInput.value = preset ? '' : String(value);
  toggleCustomBillingCycle();
}

function toggleCustomBillingCycle() {
  const cycle = document.getElementById('subBillingCycle');
  const wrap = document.getElementById('customBillingWrap');
  if (!cycle || !wrap) return;
  wrap.classList.toggle('hidden', cycle.value !== 'custom');
}

function resetSubscriptionForm() {
  const form = document.querySelector('#subscriptions form');
  if (form) form.reset();
  document.getElementById('editingSubId').value = '';
  const template = document.getElementById('subscriptionTemplate');
  if (template) template.value = '';
  document.getElementById('subscriptionFormTitle').textContent = 'Add Subscription';
  document.getElementById('saveSubButton').textContent = 'Save Subscription';
  document.getElementById('cancelEditButton').classList.add('hidden');
}

function deleteSubscription(id) {
  const subscriptions = getSubscriptions().filter(sub => sub.id !== id);
  saveSubscriptions(subscriptions);
  renderDashboard();
}

function isBillable(sub) {
  return sub.status !== 'Paused' && sub.status !== 'Cancelled';
}

function monthlyEquivalent(sub) {
  const count = Math.max(1, Number(sub.billingIntervalCount || sub.billingIntervalMonths) || 1);
  if ((sub.billingIntervalUnit || 'months') === 'weeks') {
    return Number(sub.cost) * (52 / 12) / count;
  }
  return Number(sub.cost) / count;
}

function annualEquivalent(sub) {
  const count = Math.max(1, Number(sub.billingIntervalCount || sub.billingIntervalMonths) || 1);
  if ((sub.billingIntervalUnit || 'months') === 'weeks') {
    return Number(sub.cost) * 52 / count;
  }
  return monthlyEquivalent(sub) * 12;
}

function formatBillingCycle(sub) {
  const interval = Math.max(1, Number(sub.billingIntervalCount || sub.billingIntervalMonths) || 1);
  if ((sub.billingIntervalUnit || 'months') === 'weeks') {
    if (interval === 2) return 'Bi-weekly';
    return interval === 1 ? 'Weekly' : `Every ${interval} weeks`;
  }
  if (interval === 1) return 'Monthly';
  if (interval === 2) return 'Every 2 months';
  if (interval === 3) return 'Every 3 months';
  if (interval === 6) return 'Every 6 months';
  if (interval === 12) return 'Annually';
  return `Every ${interval} months`;
}

function getFilteredSubscriptions(subscriptions) {
  const search = (document.getElementById('subSearch')?.value || '').trim().toLowerCase();
  const category = document.getElementById('categoryFilter')?.value || 'all';
  const sort = document.getElementById('sortSubs')?.value || 'date';

  const filtered = subscriptions.filter(sub => {
    const searchableValues = [sub.name, sub.category, sub.status, sub.paymentMethod, sub.notes];
    const matchesSearch = !search || searchableValues.some(value => String(value).toLowerCase().includes(search));
    const matchesCategory = category === 'all' || sub.category === category;
    return matchesSearch && matchesCategory;
  });

  return filtered.sort((a, b) => {
    if (sort === 'cost-desc') return Number(b.cost) - Number(a.cost);
    if (sort === 'cost-asc') return Number(a.cost) - Number(b.cost);
    if (sort === 'name') return a.name.localeCompare(b.name);
    if (sort === 'category') return a.category.localeCompare(b.category) || a.name.localeCompare(b.name);
    return dateKeyForSort(a).localeCompare(dateKeyForSort(b));
  });
}

function renderDashboard() {
  const tbody = document.getElementById('subsTable');
  if (!tbody) return;

  const subscriptions = getSubscriptions();
  const billableSubscriptions = subscriptions.filter(isBillable);
  const settings = getSettings();
  saveMonthlySnapshot(subscriptions);
  renderCategoryFilter(subscriptions);
  const visibleSubscriptions = getFilteredSubscriptions([...subscriptions]);
  const monthly = billableSubscriptions.reduce((sum, sub) => sum + monthlyEquivalent(sub), 0);
  const savings = getSavingsCandidates(billableSubscriptions);
  const budget = Number(settings.monthlyBudget) || 0;
  const remainingBudget = budget - monthly;
  const dueThisMonth = getMonthlyDue(subscriptions, today.getFullYear(), today.getMonth());
  renderAnnouncementBanner();

  document.getElementById('monthlySpend').textContent = formatCurrency(monthly, settings);
  document.getElementById('annualSpend').textContent = formatCurrency(monthly * 12, settings);
  document.getElementById('subCount').textContent = subscriptions.length;
  document.getElementById('potentialSavings').textContent = `${formatCurrency(getAnnualSavings(savings), settings).replace(/\.00$/, '')}/yr`;
  document.getElementById('budgetLabel').textContent = budget && remainingBudget < 0 ? 'Over Budget' : 'Spending Budget';
  document.getElementById('budgetStatus').textContent = budget ? formatCurrency(Math.abs(remainingBudget), settings) : formatCurrency(0, settings);
  document.getElementById('dueThisMonth').textContent = formatCurrency(dueThisMonth, settings);

  const emptyTableHtml = subscriptions.length
    ? 'No matching subscriptions yet.'
    : '<div class="empty-state"><strong>Add your first subscription</strong><span>Track its cost, renewal date, payment method, reminders, and notes.</span><button class="btn small-btn" onclick="showSection(&quot;subscriptions&quot;)">Add Subscription</button></div>';

  tbody.innerHTML = visibleSubscriptions.map(sub => `
    <tr>
      <td data-label="Name">${escapeHtml(sub.name)}</td>
      <td data-label="Category">${escapeHtml(sub.category)}</td>
      <td data-label="Cost">${escapeHtml(formatCurrency(sub.cost, settings))}<span class="cell-note">${escapeHtml(formatBillingCycle(sub))}</span></td>
      <td data-label="Next Bill">${escapeHtml(formatDate(sub.nextBillDate))}</td>
      <td data-label="Payment">${escapeHtml(sub.paymentMethod || 'Not set')}</td>
      <td data-label="Status"><span class="pill ${statusClass(sub.status)}">${escapeHtml(sub.status)}</span></td>
      <td data-label="Actions" class="actions-cell">
        <button class="btn ghost small-btn" onclick="editSubscription('${escapeJs(sub.id)}')">Edit</button>
        ${sub.cancelUrl ? `<a class="btn ghost small-btn" href="${escapeHtml(safeUrl(sub.cancelUrl))}" target="_blank" rel="noopener">Cancel</a>` : ''}
        ${sub.supportUrl ? `<a class="btn ghost small-btn" href="${escapeHtml(safeUrl(sub.supportUrl))}" target="_blank" rel="noopener">Support</a>` : ''}
        <button class="btn danger small-btn" onclick="deleteSubscription('${escapeJs(sub.id)}')">Delete</button>
      </td>
    </tr>
  `).join('') || `<tr><td colspan="7">${emptyTableHtml}</td></tr>`;

  renderDueSoon(subscriptions);
  renderUpcomingBills(subscriptions);
  renderSavings(savings, billableSubscriptions);
  renderCategoryChart(billableSubscriptions);
  renderSpendingHistory();
  renderPriceChangeLog(subscriptions);
  renderOnboardingChecklist(subscriptions);
  renderSubscriptionTemplates();
  processReminderEmails(subscriptions);
  renderCalendar();
  renderSettings();
}

function renderAnnouncementBanner() {
  const banner = document.getElementById('announcementBanner');
  if (!banner || !usingBackend()) return;
  const active = (backendState.announcements || []).find(item => item.message && item.enabled !== false && (!item.expiresAt || new Date(item.expiresAt) > new Date()));
  banner.innerHTML = active?.message ? `
    <div>
      <strong>Announcement</strong>
      <span>${escapeHtml(active.message)}</span>
    </div>
  ` : '';
  banner.classList.toggle('hidden', !active?.message);
}

function renderCategoryFilter(subscriptions) {
  const filter = document.getElementById('categoryFilter');
  if (!filter) return;

  const selected = filter.value || 'all';
  const categories = [...new Set(subscriptions.map(sub => sub.category).filter(Boolean))].sort();
  filter.innerHTML = '<option value="all">All categories</option>' + categories.map(category => (
    `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`
  )).join('');
  filter.value = categories.includes(selected) ? selected : 'all';
}

function statusClass(status) {
  if (status === 'Review' || status === 'Cancel Soon') return 'warn';
  if (status === 'Paused') return 'neutral';
  if (status === 'Cancelled') return 'danger-pill';
  return '';
}

function renderDueSoon(subscriptions) {
  const container = document.getElementById('dueSoonList');
  if (!container) return;
  const settings = getSettings();

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dueSoon = subscriptions
    .filter(isBillable)
    .map(sub => ({ ...sub, daysUntil: daysBetween(today, getNextOccurrence(sub, today)) }))
    .filter(sub => sub.daysUntil >= 0 && sub.daysUntil <= Math.max(7, Number(sub.reminderDays) || 0))
    .sort((a, b) => a.daysUntil - b.daysUntil);

  container.innerHTML = dueSoon.map(sub => `
    <div class="mini-item">
      <span>${escapeHtml(sub.name)}</span>
      <strong>${sub.daysUntil === 0 ? 'Today' : `${sub.daysUntil}d`} - ${escapeHtml(formatCurrency(sub.cost, settings))}</strong>
    </div>
  `).join('') || '<p class="muted compact">No bills due in the next 7 days.</p>';
}

function getUpcomingBills(subscriptions, days) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + days);

  return subscriptions
    .filter(isBillable)
    .map(sub => {
      const nextDate = getNextOccurrence(sub, start);
      return { ...sub, nextDate, daysUntil: daysBetween(start, nextDate) };
    })
    .filter(sub => sub.nextDate && sub.nextDate <= end && sub.daysUntil >= 0)
    .sort((a, b) => a.nextDate - b.nextDate || Number(b.cost) - Number(a.cost));
}

function renderUpcomingBills(subscriptions) {
  const container = document.getElementById('upcomingBills');
  if (!container) return;
  const settings = getSettings();

  const windows = [7, 14, 30];
  container.innerHTML = windows.map(days => {
    const bills = getUpcomingBills(subscriptions, days);
    return `
      <section class="upcoming-window">
        <h3>Next ${days} days</h3>
        <div class="history-list">
          ${bills.map(sub => `
            <div class="history-item">
              <div>
                <strong>${escapeHtml(sub.name)}</strong>
                <span>${escapeHtml(sub.category)} - ${escapeHtml(formatBillingCycle(sub))}</span>
              </div>
              <div>
                <strong>${escapeHtml(formatCurrency(sub.cost, settings))}</strong>
                <span>${sub.daysUntil === 0 ? 'Today' : `${sub.daysUntil} days`} - ${escapeHtml(formatDate(sub.nextDate.toISOString().slice(0, 10)))}</span>
              </div>
            </div>
          `).join('') || '<p class="muted compact">No bills in this window.</p>'}
        </div>
      </section>
    `;
  }).join('');
}

function daysBetween(start, end) {
  if (!end) return Number.POSITIVE_INFINITY;
  const dayMs = 24 * 60 * 60 * 1000;
  return Math.round((end - start) / dayMs);
}

function addMonthsClamped(date, monthsToAdd) {
  const day = date.getDate();
  const target = new Date(date.getFullYear(), date.getMonth() + monthsToAdd, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(day, lastDay));
  return target;
}

function getOccurrenceInMonth(sub, year, monthIndex) {
  const occurrences = getOccurrencesInMonth(sub, year, monthIndex);
  return occurrences[0] || null;
}

function getOccurrencesInMonth(sub, year, monthIndex) {
  const start = parseLocalDate(sub.nextBillDate);
  if (!start) return [];

  if ((sub.billingIntervalUnit || 'months') === 'weeks') {
    const intervalDays = Math.max(1, Number(sub.billingIntervalCount) || 1) * 7;
    const monthStart = new Date(year, monthIndex, 1);
    const monthEnd = new Date(year, monthIndex + 1, 0);
    const occurrences = [];
    let occurrence = new Date(start);

    while (occurrence < monthStart) {
      occurrence = new Date(occurrence.getFullYear(), occurrence.getMonth(), occurrence.getDate() + intervalDays);
    }

    while (occurrence <= monthEnd) {
      occurrences.push(new Date(occurrence));
      occurrence = new Date(occurrence.getFullYear(), occurrence.getMonth(), occurrence.getDate() + intervalDays);
    }

    return occurrences;
  }

  const interval = Math.max(1, Number(sub.billingIntervalCount || sub.billingIntervalMonths) || 1);
  const monthDiff = (year - start.getFullYear()) * 12 + (monthIndex - start.getMonth());
  if (monthDiff < 0 || monthDiff % interval !== 0) return [];

  return [addMonthsClamped(start, monthDiff)];
}

function getNextOccurrence(sub, fromDate = new Date()) {
  const start = parseLocalDate(sub.nextBillDate);
  if (!start) return null;

  const from = new Date(fromDate);
  from.setHours(0, 0, 0, 0);
  if (start >= from) return start;

  if ((sub.billingIntervalUnit || 'months') === 'weeks') {
    const intervalDays = Math.max(1, Number(sub.billingIntervalCount) || 1) * 7;
    const dayMs = 24 * 60 * 60 * 1000;
    const cycles = Math.ceil((from - start) / (intervalDays * dayMs));
    return new Date(start.getFullYear(), start.getMonth(), start.getDate() + cycles * intervalDays);
  }

  const interval = Math.max(1, Number(sub.billingIntervalCount || sub.billingIntervalMonths) || 1);
  const roughMonths = (from.getFullYear() - start.getFullYear()) * 12 + (from.getMonth() - start.getMonth());
  let cycles = Math.max(0, Math.floor(roughMonths / interval));
  let next = addMonthsClamped(start, cycles * interval);

  while (next < from) {
    cycles++;
    next = addMonthsClamped(start, cycles * interval);
  }

  return next;
}

function getMonthlyDue(subscriptions, year, monthIndex) {
  return subscriptions
    .filter(isBillable)
    .reduce((sum, sub) => {
      const occurrences = getOccurrencesInMonth(sub, year, monthIndex);
      return sum + occurrences.length * Number(sub.cost);
    }, 0);
}

function monthKeyFor(year, monthIndex) {
  return `${year}-${String(monthIndex + 1).padStart(2, '0')}`;
}

function saveMonthlySnapshot(subscriptions) {
  const now = new Date();
  const key = monthKeyFor(now.getFullYear(), now.getMonth());
  const monthlyAverage = subscriptions.filter(isBillable).reduce((sum, sub) => sum + monthlyEquivalent(sub), 0);
  const actualDue = getMonthlyDue(subscriptions, now.getFullYear(), now.getMonth());
  const history = getHistory();
  const snapshot = {
    month: key,
    monthlyAverage,
    actualDue,
    count: subscriptions.length,
    savedAt: new Date().toISOString()
  };
  const existingIndex = history.findIndex(item => item.month === key);
  if (existingIndex >= 0) {
    history[existingIndex] = snapshot;
  } else {
    history.push(snapshot);
  }
  saveHistory(history.slice(-18));
}

function getSavingsCandidates(subscriptions) {
  const candidates = new Map();
  const settings = getSettings();
  const highCostLimit = Number(settings.highCostLimit || HIGH_COST_THRESHOLD);
  subscriptions.forEach(sub => {
    if (sub.status === 'Review' || sub.status === 'Cancel Soon') {
      candidates.set(sub.id, { ...sub, reason: `${sub.status} status` });
    } else if (settings.highCostWarnings !== false && monthlyEquivalent(sub) >= highCostLimit) {
      candidates.set(sub.id, { ...sub, reason: `High monthly cost over $${highCostLimit}` });
    }
  });

  const byCategory = subscriptions.reduce((groups, sub) => {
    groups[sub.category] = groups[sub.category] || [];
    groups[sub.category].push(sub);
    return groups;
  }, {});

  Object.values(byCategory).forEach(group => {
    if (group.length < 2) return;
    const sorted = [...group].sort((a, b) => Number(a.cost) - Number(b.cost));
    sorted.slice(1).forEach(sub => {
      if (!candidates.has(sub.id)) candidates.set(sub.id, { ...sub, reason: `Duplicate ${sub.category} subscription` });
    });
  });

  return [...candidates.values()].sort((a, b) => Number(b.cost) - Number(a.cost));
}

function getAnnualSavings(candidates) {
  return candidates.reduce((sum, sub) => sum + annualEquivalent(sub), 0);
}

function renderCategoryChart(subscriptions) {
  const chart = document.getElementById('categoryChart');
  if (!chart) return;
  const settings = getSettings();

  if (!subscriptions.length) {
    chart.innerHTML = '<p class="muted compact">Add subscriptions to see a category breakdown.</p>';
    return;
  }

  const totals = subscriptions.reduce((groups, sub) => {
    groups[sub.category] = (groups[sub.category] || 0) + monthlyEquivalent(sub);
    return groups;
  }, {});
  const entries = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  const max = Math.max(...entries.map(([, total]) => total), 1);

  chart.innerHTML = entries.map(([category, total]) => `
    <div class="chart-row">
      <div class="chart-meta">
        <strong>${escapeHtml(category)}</strong>
        <span>${escapeHtml(formatCurrency(total, settings))}/mo</span>
      </div>
      <div class="chart-track"><span style="width: ${(total / max) * 100}%"></span></div>
    </div>
  `).join('');
}

function renderSpendingHistory() {
  const container = document.getElementById('spendingHistory');
  if (!container) return;
  const settings = getSettings();

  const history = getHistory().slice(-6).reverse();
  if (!history.length) {
    container.innerHTML = '<p class="muted compact">History starts once your dashboard has subscription data.</p>';
    return;
  }

  container.innerHTML = history.map(item => {
    const [year, month] = item.month.split('-').map(Number);
    const label = new Date(year, month - 1, 1).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
    return `
      <div class="history-item">
        <div>
          <strong>${escapeHtml(label)}</strong>
          <span>${Number(item.count) || 0} subscriptions</span>
        </div>
        <div>
          <strong>${escapeHtml(formatCurrency(item.actualDue, settings))}</strong>
          <span>${escapeHtml(formatCurrency(item.monthlyAverage, settings))} avg</span>
        </div>
      </div>
    `;
  }).join('');
}

function renderPriceChangeLog(subscriptions) {
  const container = document.getElementById('priceChangeLog');
  if (!container) return;

  const changes = subscriptions.flatMap(sub => (
    (sub.priceHistory || []).map(change => ({ ...change, name: sub.name }))
  )).sort((a, b) => new Date(b.changedAt) - new Date(a.changedAt));

  if (!changes.length) {
    container.innerHTML = '<p class="muted compact">Price changes will appear here after you edit a subscription amount.</p>';
    return;
  }

  container.innerHTML = changes.slice(0, 8).map(change => {
    const difference = Number(change.newCost) - Number(change.oldCost);
    const direction = difference >= 0 ? 'up' : 'down';
    return `
      <div class="history-item">
        <div>
          <strong>${escapeHtml(change.name)}</strong>
          <span>${escapeHtml(new Date(change.changedAt).toLocaleString())}</span>
        </div>
        <div>
          <strong>$${Number(change.oldCost).toFixed(2)} to $${Number(change.newCost).toFixed(2)}</strong>
          <span>${direction} $${Math.abs(difference).toFixed(2)} per bill</span>
        </div>
      </div>
    `;
  }).join('');
}

function renderOnboardingChecklist(subscriptions) {
  const container = document.getElementById('onboardingChecklist');
  if (!container) return;
  const settings = getSettings();
  const session = getSession();
  const account = getAccounts().find(item => item.username === session?.username);
  const items = [
    { done: Boolean(account?.email), label: 'Add account email', action: 'showSection("settings")' },
    { done: subscriptions.length > 0, label: 'Add first subscription', action: 'showSection("subscriptions")' },
    { done: Number(settings.monthlyBudget || 0) > 0, label: 'Set monthly budget', action: 'showSection("settings")' },
    { done: subscriptions.some(sub => Number(sub.reminderDays || 0) > 0) || settings.emailRemindersEnabled === false, label: 'Choose reminder preference', action: 'showSection("settings")' },
    { done: subscriptions.some(sub => sub.cancelUrl || sub.supportUrl), label: 'Add cancellation/support link', action: 'showSection("subscriptions")' }
  ];
  container.innerHTML = items.map(item => `
    <button class="checklist-item ${item.done ? 'done' : ''}" type="button" onclick="${item.action}">
      <span>${item.done ? '✓' : '○'}</span>
      <strong>${escapeHtml(item.label)}</strong>
    </button>
  `).join('');
}

function renderSavings(candidates, subscriptions) {
  const insight = document.getElementById('savingsInsight');
  const plan = document.getElementById('savingsPlan');
  if (!insight || !plan) return;

  if (!subscriptions.length) {
    insight.textContent = 'Add subscriptions to see where you could save.';
    plan.innerHTML = '<p class="muted">No subscriptions yet. Add a few services to generate a savings plan.</p>';
    return;
  }

  if (!candidates.length) {
    insight.textContent = 'Your current list looks lean. No high-cost or duplicate subscriptions are flagged.';
    plan.innerHTML = '<p class="muted">No savings opportunities are flagged right now. Mark a subscription as Review or add categories to improve recommendations.</p>';
    return;
  }

  const annualSavings = getAnnualSavings(candidates);
  const top = candidates[0];
  insight.innerHTML = `Review <strong>${escapeHtml(top.name)}</strong> first. Cancelling flagged items could save about <strong>$${annualSavings.toFixed(0)}/year</strong>.`;
  plan.innerHTML = `
    <p class="muted">Start with high-cost, duplicate, or manually flagged subscriptions.</p>
    <div class="savings-list">
      ${candidates.map(sub => `
        <div class="savings-item">
          <div>
            <strong>${escapeHtml(sub.name)}</strong>
            <span>${escapeHtml(sub.reason)} - ${escapeHtml(sub.category)}</span>
          </div>
          <strong>$${annualEquivalent(sub).toFixed(0)}/yr</strong>
        </div>
      `).join('')}
    </div>
  `;
}

function renderCalendar() {
  const grid = document.getElementById('calendarGrid');
  const table = document.getElementById('calendarTable');
  const title = document.getElementById('calendarMonthTitle');
  if (!grid || !table || !title) return;

  const subscriptions = getSubscriptions().sort((a, b) => {
    const nextA = getNextOccurrence(a);
    const nextB = getNextOccurrence(b);
    return (nextA ? nextA.toISOString() : '9999').localeCompare(nextB ? nextB.toISOString() : '9999');
  });
  const datedSubscriptions = subscriptions.filter(sub => isBillable(sub) && normalizeDate(sub.nextBillDate || sub.nextBill));
  const baseYear = visibleCalendarYear;
  const baseMonth = visibleCalendarMonth + 1;
  const monthStart = new Date(visibleCalendarYear, visibleCalendarMonth, 1);
  const daysInMonth = new Date(visibleCalendarYear, visibleCalendarMonth + 1, 0).getDate();
  const firstDay = monthStart.getDay();

  title.textContent = monthStart.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  const byDay = {};
  datedSubscriptions.forEach(sub => {
    getOccurrencesInMonth(sub, visibleCalendarYear, visibleCalendarMonth).forEach(occurrence => {
      const day = occurrence.getDate();
      byDay[day] = byDay[day] || [];
      byDay[day].push(sub);
    });
  });

  const weekDays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  let html = weekDays.map(day => `<div class="calendar-weekday">${day}</div>`).join('');
  for (let i = 0; i < firstDay; i++) html += '<div class="calendar-day empty"></div>';
  for (let day = 1; day <= daysInMonth; day++) {
    const bills = byDay[day] || [];
    html += `
      <div class="calendar-day ${bills.length ? 'has-bill' : ''}">
        <strong>${day}</strong>
        ${bills.map(bill => `<span>${escapeHtml(bill.name)} &middot; $${Number(bill.cost).toFixed(2)}</span>`).join('')}
      </div>
    `;
  }
  grid.innerHTML = html;

  table.innerHTML = subscriptions.map(sub => {
    const nextOccurrence = getNextOccurrence(sub);
    return `
    <tr>
      <td data-label="Date">${escapeHtml(nextOccurrence ? formatDate(nextOccurrence.toISOString().slice(0, 10)) : 'No date')}</td>
      <td data-label="Subscription">${escapeHtml(sub.name)}</td>
      <td data-label="Cost">$${Number(sub.cost).toFixed(2)}<span class="cell-note">${escapeHtml(formatBillingCycle(sub))}</span></td>
      <td data-label="Status"><span class="pill ${statusClass(sub.status)}">${escapeHtml(sub.status)}</span></td>
    </tr>
  `;
  }).join('') || '<tr><td colspan="4">No subscriptions yet. Add one to fill your calendar.</td></tr>';
}

function changeCalendarMonth(offset) {
  const nextMonth = new Date(visibleCalendarYear, visibleCalendarMonth + offset, 1);
  visibleCalendarYear = nextMonth.getFullYear();
  visibleCalendarMonth = nextMonth.getMonth();
  renderCalendar();
}

function goToCurrentMonth() {
  const current = new Date();
  visibleCalendarYear = current.getFullYear();
  visibleCalendarMonth = current.getMonth();
  renderCalendar();
}

function renderSettings() {
  const budgetInput = document.getElementById('monthlyBudget');
  const emailInput = document.getElementById('accountEmail');
  const currencyInput = document.getElementById('currencyCode');
  if (!budgetInput && !emailInput && !currencyInput) return;

  const settings = getSettings();
  if (currencyInput) currencyInput.value = settings.currencyCode || 'USD';
  if (budgetInput && document.activeElement !== budgetInput) {
    budgetInput.value = settings.monthlyBudget ? Number(settings.monthlyBudget).toFixed(2) : '';
  }
  if (emailInput && document.activeElement !== emailInput) {
    const session = getSession();
    const account = getAccounts().find(item => item.username === session?.username);
    emailInput.value = account?.email || '';
  }
  const emailReminders = document.getElementById('emailRemindersEnabled');
  const defaultReminder = document.getElementById('defaultReminderDays');
  const highCostWarnings = document.getElementById('highCostWarnings');
  const highCostLimit = document.getElementById('highCostLimit');
  const monthlySummary = document.getElementById('monthlySummaryEmail');
  if (emailReminders) emailReminders.checked = settings.emailRemindersEnabled !== false;
  if (defaultReminder) defaultReminder.value = String(settings.defaultReminderDays ?? 7);
  if (highCostWarnings) highCostWarnings.checked = settings.highCostWarnings !== false;
  if (highCostLimit && document.activeElement !== highCostLimit) highCostLimit.value = Number(settings.highCostLimit || HIGH_COST_THRESHOLD);
  if (monthlySummary) monthlySummary.checked = Boolean(settings.monthlySummaryEmail);
}

function saveBudget(event) {
  event.preventDefault();
  const monthlyBudget = Number(document.getElementById('monthlyBudget').value) || 0;
  const currencyCode = document.getElementById('currencyCode')?.value || 'USD';
  const message = document.getElementById('budgetMessage');
  saveSettings({ ...getSettings(), monthlyBudget, currencyCode });
  showMessage(message, 'Budget saved.', false);
  renderDashboard();
}

function saveProfile(event) {
  event.preventDefault();
  const email = document.getElementById('accountEmail').value.trim();
  const message = document.getElementById('profileMessage');
  const session = getSession();
  const accounts = getAccounts();
  const account = accounts.find(item => item.username === session?.username);

  if (!account) {
    showMessage(message, 'Could not find your account.', true);
    return;
  }

  if (email && !email.includes('@')) {
    showMessage(message, 'Enter a valid email address.', true);
    return;
  }

  account.email = email;
  saveAccounts(accounts);
  writeAudit('profile_update', account.username, 'Updated profile email.');
  showMessage(message, email ? 'Profile email saved.' : 'Profile email cleared.', false);
}

function saveReminderEmail(event) {
  return saveProfile(event);
}

function saveNotificationPreferences(event) {
  event.preventDefault();
  const message = document.getElementById('notificationMessage');
  const settings = getSettings();
  const updated = {
    ...settings,
    emailRemindersEnabled: Boolean(document.getElementById('emailRemindersEnabled').checked),
    defaultReminderDays: Number(document.getElementById('defaultReminderDays').value) || 0,
    highCostWarnings: Boolean(document.getElementById('highCostWarnings').checked),
    highCostLimit: Number(document.getElementById('highCostLimit').value) || HIGH_COST_THRESHOLD,
    monthlySummaryEmail: Boolean(document.getElementById('monthlySummaryEmail').checked)
  };
  saveSettings(updated)
    .then(() => {
      writeAudit('notification_preferences', getSession()?.username, 'Updated notification preferences.');
      showMessage(message, 'Notification preferences saved.', false);
      renderDashboard();
    })
    .catch(() => showMessage(message, 'Notification preferences could not be saved.', true));
}

async function changePassword(event) {
  event.preventDefault();
  const currentPassword = document.getElementById('currentPassword').value;
  const updatedPassword = document.getElementById('updatedPassword').value;
  const message = document.getElementById('passwordMessage');

  if (BACKEND_CONFIG.enabled) {
    const response = await fetch(`${BACKEND_CONFIG.apiBaseUrl}/change-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword, updatedPassword })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      showMessage(message, result.error || 'Password could not be updated.', true);
      return;
    }
    event.target.reset();
    showMessage(message, 'Password updated.', false);
    return;
  }

  const session = getSession();
  const accounts = getAccounts();
  const account = accounts.find(item => item.username === session?.username);

  if (!account || account.password !== currentPassword) {
    showMessage(message, 'Current password is incorrect.', true);
    return;
  }

  if (updatedPassword.length < 8) {
    showMessage(message, 'New password must be at least 8 characters.', true);
    return;
  }

  account.password = updatedPassword;
  saveAccounts(accounts);
  event.target.reset();
  showMessage(message, 'Password updated.', false);
}

function exportSubscriptions() {
  const headers = ['Name', 'Category', 'Bill Amount', 'Billing Interval Unit', 'Billing Interval Count', 'Next Bill Date', 'Status', 'Reminder Days', 'Payment Method', 'Notes'];
  const rows = getSubscriptions().map(sub => [
    sub.name,
    sub.category,
    Number(sub.cost).toFixed(2),
    sub.billingIntervalUnit || 'months',
    sub.billingIntervalCount || sub.billingIntervalMonths || 1,
    sub.nextBillDate,
    sub.status,
    sub.reminderDays || 0,
    sub.paymentMethod || '',
    sub.notes || ''
  ]);
  const csv = [headers, ...rows].map(row => row.map(csvEscape).join(',')).join('\n');
  downloadCsv(csv, 'subtrack-subscriptions.csv');
}

function downloadCsv(csv, filename) {
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function importSubscriptions(event) {
  const file = event.target.files[0];
  const message = document.getElementById('importMessage');
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    try {
      const rows = parseCsv(String(reader.result || ''));
      const imported = rows.slice(1).filter(row => row.some(Boolean)).map(row => ensureSubscriptionShape({
        name: row[0],
        category: row[1],
        cost: row[2],
        billingIntervalUnit: row[3] || 'months',
        billingIntervalCount: row[4] || 1,
        billingIntervalMonths: row[3] === 'months' ? row[4] : 1,
        nextBillDate: row[5],
        status: row[6],
        reminderDays: row[7],
        paymentMethod: row[8],
        notes: row[9]
      }));
      saveSubscriptions([...getSubscriptions(), ...imported]);
      showMessage(message, `Imported ${imported.length} subscriptions.`, false);
      renderDashboard();
    } catch (error) {
      showMessage(message, 'Import failed. Please check the CSV format.', true);
    }
    event.target.value = '';
  };
  reader.readAsText(file);
}

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];
    if (char === '"' && inQuotes && next === '"') {
      value += '"';
      i++;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      row.push(value);
      value = '';
    } else if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') i++;
      row.push(value);
      rows.push(row);
      row = [];
      value = '';
    } else {
      value += char;
    }
  }

  if (value || row.length) {
    row.push(value);
    rows.push(row);
  }
  return rows;
}

function showSection(sectionId) {
  document.querySelectorAll('.dash-section').forEach(section => section.classList.add('hidden'));
  document.getElementById(sectionId).classList.remove('hidden');
  document.querySelectorAll('[data-section-link]').forEach(link => link.classList.remove('active'));
  const activeLink = document.querySelector(`[data-section-link="${sectionId}"]`);
  if (activeLink) activeLink.classList.add('active');
}

function showMessage(element, text, isError) {
  element.textContent = text;
  element.className = isError ? 'message error' : 'message success';
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function escapeJs(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function safeUrl(value) {
  const text = String(value || '').trim();
  if (/^https?:\/\//i.test(text)) return text;
  return '#';
}

document.addEventListener('DOMContentLoaded', async () => {
  await loadBackendState();
  await loadSession();
  appReady = true;
  const backendMessageTarget = document.getElementById('loginError') || document.getElementById('accountMessage') || document.getElementById('forgotMessage');
  if (requireSharedStorage(backendMessageTarget)) return;
  getAccounts();
  if (getSession()) applyTheme();
  if (document.body.dataset.page === 'dashboard') {
    requireLogin(['user', 'admin']);
    applyTheme();
    renderDashboard();
  }
  if (document.body.dataset.page === 'admin') {
    requireLogin(['owner', 'admin']);
    applyTheme();
    renderAccounts();
  }
  if (document.body.dataset.page === 'signup') {
    renderSignupForm();
  }
  if (document.body.dataset.page === 'reset') {
    renderResetPasswordForm();
  }
  renderLoginPageMessage();
  renderLoginSignupPrompt();
});
