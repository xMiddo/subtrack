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
    reminderSent: []
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
    role: account.role || 'user',
    disabled: Boolean(account.disabled),
    createdAt: account.createdAt || new Date().toISOString(),
    lastLoginAt: account.lastLoginAt || ''
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
    window.location.href = result.account.role === 'admin' ? 'admin.html' : 'dashboard.html';
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
  window.location.href = account.role === 'admin' ? 'admin.html' : 'dashboard.html';
}

async function goToAdmin(event) {
  event.preventDefault();
  const error = document.getElementById('loginError');
  if (requireReadyMessage(error)) return;

  await loadSession();
  if (serverSession?.role === 'admin') {
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
    adminLink.classList.toggle('hidden', session.role !== 'admin');
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
      backendState.settings[username] = { monthlyBudget: 0, darkMode: false };
      backendState.history[username] = [];
      await persistBackendState();
    } else {
      await saveAccounts(accounts);
      localStorage.setItem(subscriptionKeyFor(username), JSON.stringify([]));
      localStorage.setItem(settingsKeyFor(username), JSON.stringify({ monthlyBudget: 0 }));
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
        </select>
      </td>
      <td data-label="Status"><span class="pill ${account.disabled ? 'danger-pill' : ''}">${account.disabled ? 'Disabled' : 'Enabled'}</span></td>
      <td data-label="Created">${new Date(account.createdAt).toLocaleDateString()}</td>
      <td data-label="Last Login">${account.lastLoginAt ? new Date(account.lastLoginAt).toLocaleString() : 'Never'}</td>
      <td data-label="Actions" class="actions-cell">
        <button class="btn ghost small-btn" onclick="preparePasswordReset('${escapeJs(account.username)}')">Reset</button>
        <button class="btn ghost small-btn" onclick="toggleAccountDisabled('${escapeJs(account.username)}')" ${account.username === 'admin' ? 'disabled' : ''}>${account.disabled ? 'Enable' : 'Disable'}</button>
        <button class="btn danger small-btn" onclick="deleteAccount('${escapeJs(account.username)}')">Delete</button>
      </td>
    </tr>
  `).join('') || '<tr><td colspan="7">No users match your search.</td></tr>';
  renderAuditLog();
}

function changeUserRole(username, role) {
  const session = getSession();
  if (username === 'admin') return;
  if (session && session.username === username && role !== 'admin') {
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
  window.location.href = result.account.role === 'admin' ? 'admin.html' : 'dashboard.html';
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
  const account = getAccounts().find(item => item.email && item.email.toLowerCase() === email.toLowerCase());

  if (!account) {
    showMessage(message, 'No account uses that email.', true);
    return;
  }

  if (!BACKEND_CONFIG.enabled || !BACKEND_CONFIG.apiBaseUrl) {
    showMessage(message, 'Email reset is ready for backend setup, but no email service is connected yet. Ask an admin to reset your password.', true);
    writeAudit('password_reset_requested', account.username, 'Password reset requested before backend email setup.');
    return;
  }

  try {
    await fetch(`${BACKEND_CONFIG.apiBaseUrl}/password-reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    showMessage(message, 'If that email exists, a reset link has been sent.', false);
    writeAudit('password_reset_email', account.username, 'Password reset email requested.');
  } catch (error) {
    showMessage(message, 'The reset email could not be sent. Try again later.', true);
  }
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

  const entries = getAuditLog().slice(-12).reverse();
  container.innerHTML = entries.map(entry => `
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

function getSettings() {
  if (usingBackend()) {
    const session = getSession();
    return { monthlyBudget: 0, darkMode: false, ...(backendState.settings[session?.username || 'guest'] || {}) };
  }
  return { monthlyBudget: 0, darkMode: false, ...JSON.parse(localStorage.getItem(getCurrentSettingsKey()) || '{}') };
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
    return { monthlyBudget: 0, darkMode: false, ...(backendState.settings[username] || {}) };
  }
  return { monthlyBudget: 0, darkMode: false, ...JSON.parse(localStorage.getItem(settingsKeyFor(username)) || '{}') };
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

function dateKeyForSort(sub) {
  return normalizeDate(sub.nextBillDate || sub.nextBill || '9999-12-31') || '9999-12-31';
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
      subscriptions[index] = { ...existing, name, category, cost, ...billingSchedule, nextBillDate, status, reminderDays, paymentMethod, notes, priceHistory };
    }
  } else {
    subscriptions.push({ id: makeId(), name, category, cost, ...billingSchedule, nextBillDate, status, reminderDays, paymentMethod, notes });
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

  document.getElementById('monthlySpend').textContent = `$${monthly.toFixed(2)}`;
  document.getElementById('annualSpend').textContent = `$${(monthly * 12).toFixed(2)}`;
  document.getElementById('subCount').textContent = subscriptions.length;
  document.getElementById('potentialSavings').textContent = `$${getAnnualSavings(savings).toFixed(0)}/yr`;
  document.getElementById('budgetLabel').textContent = budget && remainingBudget < 0 ? 'Over Budget' : 'Spending Budget';
  document.getElementById('budgetStatus').textContent = budget ? `$${Math.abs(remainingBudget).toFixed(2)}` : '$0.00';
  document.getElementById('dueThisMonth').textContent = `$${dueThisMonth.toFixed(2)}`;

  const emptyTableHtml = subscriptions.length
    ? 'No matching subscriptions yet.'
    : '<div class="empty-state"><strong>Add your first subscription</strong><span>Track its cost, renewal date, payment method, reminders, and notes.</span><button class="btn small-btn" onclick="showSection(&quot;subscriptions&quot;)">Add Subscription</button></div>';

  tbody.innerHTML = visibleSubscriptions.map(sub => `
    <tr>
      <td data-label="Name">${escapeHtml(sub.name)}</td>
      <td data-label="Category">${escapeHtml(sub.category)}</td>
      <td data-label="Cost">$${Number(sub.cost).toFixed(2)}<span class="cell-note">${escapeHtml(formatBillingCycle(sub))}</span></td>
      <td data-label="Next Bill">${escapeHtml(formatDate(sub.nextBillDate))}</td>
      <td data-label="Payment">${escapeHtml(sub.paymentMethod || 'Not set')}</td>
      <td data-label="Status"><span class="pill ${statusClass(sub.status)}">${escapeHtml(sub.status)}</span></td>
      <td data-label="Actions" class="actions-cell">
        <button class="btn ghost small-btn" onclick="editSubscription('${escapeJs(sub.id)}')">Edit</button>
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
  processReminderEmails(subscriptions);
  renderCalendar();
  renderSettings();
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
      <strong>${sub.daysUntil === 0 ? 'Today' : `${sub.daysUntil}d`} - $${Number(sub.cost).toFixed(2)}</strong>
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
                <strong>$${Number(sub.cost).toFixed(2)}</strong>
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
  subscriptions.forEach(sub => {
    if (sub.status === 'Review' || sub.status === 'Cancel Soon') {
      candidates.set(sub.id, { ...sub, reason: `${sub.status} status` });
    } else if (monthlyEquivalent(sub) >= HIGH_COST_THRESHOLD) {
      candidates.set(sub.id, { ...sub, reason: `High monthly cost over $${HIGH_COST_THRESHOLD}` });
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
        <span>$${total.toFixed(2)}/mo</span>
      </div>
      <div class="chart-track"><span style="width: ${(total / max) * 100}%"></span></div>
    </div>
  `).join('');
}

function renderSpendingHistory() {
  const container = document.getElementById('spendingHistory');
  if (!container) return;

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
          <strong>$${Number(item.actualDue).toFixed(2)}</strong>
          <span>$${Number(item.monthlyAverage).toFixed(2)} avg</span>
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
  if (!budgetInput && !emailInput) return;

  const settings = getSettings();
  if (budgetInput && document.activeElement !== budgetInput) {
    budgetInput.value = settings.monthlyBudget ? Number(settings.monthlyBudget).toFixed(2) : '';
  }
  if (emailInput && document.activeElement !== emailInput) {
    const session = getSession();
    const account = getAccounts().find(item => item.username === session?.username);
    emailInput.value = account?.email || '';
  }
}

function saveBudget(event) {
  event.preventDefault();
  const monthlyBudget = Number(document.getElementById('monthlyBudget').value) || 0;
  const message = document.getElementById('budgetMessage');
  saveSettings({ ...getSettings(), monthlyBudget });
  showMessage(message, 'Budget saved.', false);
  renderDashboard();
}

function saveReminderEmail(event) {
  event.preventDefault();
  const email = document.getElementById('accountEmail').value.trim();
  const message = document.getElementById('emailMessage');
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
  showMessage(message, email ? 'Reminder email saved.' : 'Reminder email cleared.', false);
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
    requireLogin(['admin']);
    applyTheme();
    renderAccounts();
  }
  if (document.body.dataset.page === 'signup') {
    renderSignupForm();
  }
  renderLoginPageMessage();
  renderLoginSignupPrompt();
});
