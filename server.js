const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(ROOT, 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');
const DATABASE_URL = process.env.DATABASE_URL || '';
const DATABASE_SSL = process.env.DATABASE_SSL || process.env.PGSSLMODE || '';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const REMINDER_FROM_EMAIL = process.env.REMINDER_FROM_EMAIL || '';
const CRON_SECRET = process.env.CRON_SECRET || '';
const SESSION_SECRET = process.env.SESSION_SECRET || 'subtrack-dev-session-secret';
const SESSION_COOKIE = 'subtrack_session_id';
const PASSWORD_ITERATIONS = 120000;
let sql = null;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml'
};

function defaultState() {
  return {
    accounts: [
      {
        username: 'admin',
        email: '',
        passwordHash: '4b84237520795f4b00d7096101ced3d31b177f61e15d1a2e223da5017b8f521fcbbb7c63a9ef6f9011456091a30578c0fcc4c19e2cfdfe511aecc18fbe40ba17',
        passwordSalt: 'fde93753e68f4867596eae54e4389c5e',
        role: 'owner',
        disabled: false,
        createdAt: new Date().toISOString(),
        lastLoginAt: ''
      }
    ],
    subscriptions: {},
    settings: {},
    history: {},
    audit: [],
    reminderSent: [],
    invites: [],
    passwordResets: [],
    publicSignup: false,
    emailQueue: []
  };
}

function ensureDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify(defaultState(), null, 2));
  }
}

function readDb() {
  ensureDb();
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}

function writeDb(state) {
  ensureDb();
  fs.writeFileSync(DB_PATH, JSON.stringify({ ...defaultState(), ...state }, null, 2));
}

function getSql() {
  if (!DATABASE_URL) return null;
  const databaseUrl = parseDatabaseUrl();
  if (!databaseUrl) {
    throw new Error('DATABASE_URL must be a valid Postgres URL that starts with postgres:// or postgresql://');
  }

  if (!sql) {
    const postgres = require('postgres');
    sql = postgres(databaseUrl.toString(), {
      max: 3,
      ssl: getDatabaseSslMode()
    });
  }
  return sql;
}

function getDatabaseSslMode() {
  if (/^(require|true)$/i.test(DATABASE_SSL)) return 'require';
  if (/^(disable|false)$/i.test(DATABASE_SSL)) return false;

  const databaseUrl = parseDatabaseUrl();
  if (!databaseUrl) return false;
  const host = databaseUrl.hostname;

  if (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.railway.internal')) return false;
  return 'require';
}

function parseDatabaseUrl() {
  try {
    const databaseUrl = new URL(DATABASE_URL);
    if (!['postgres:', 'postgresql:'].includes(databaseUrl.protocol)) return null;
    return databaseUrl;
  } catch (error) {
    return null;
  }
}

function getDatabaseStatus() {
  if (!DATABASE_URL) return { configured: false };

  const databaseUrl = parseDatabaseUrl();
  if (!databaseUrl) {
    return {
      configured: true,
      valid: false,
      message: 'DATABASE_URL must start with postgres:// or postgresql://'
    };
  }

  return {
    configured: true,
    valid: true,
    host: databaseUrl.hostname,
    ssl: getDatabaseSslMode()
  };
}

async function ensurePostgresDb(client) {
  await client`
    create table if not exists app_state (
      id text primary key,
      data jsonb not null,
      updated_at timestamptz not null default now()
    )
  `;

  await client`
    insert into app_state (id, data)
    values ('main', ${client.json(defaultState())})
    on conflict (id) do nothing
  `;
}

async function readState() {
  const client = getSql();
  if (!client) return readDb();

  await ensurePostgresDb(client);
  const rows = await client`select data from app_state where id = 'main'`;
  return { ...defaultState(), ...(rows[0]?.data || {}) };
}

async function writeState(state) {
  const currentState = await readState();
  const normalizedState = await normalizeStateForStorage(state, currentState);
  const client = getSql();
  if (!client) {
    writeDb(normalizedState);
    return;
  }

  await ensurePostgresDb(client);
  await client`
    insert into app_state (id, data, updated_at)
    values ('main', ${client.json(normalizedState)}, now())
    on conflict (id)
    do update set data = excluded.data, updated_at = now()
  `;
}

function sanitizeStateForClient(state, session = null) {
  const cleanState = { ...defaultState(), ...state };
  cleanState.accounts = (cleanState.accounts || []).map(account => {
    const { password, passwordHash, passwordSalt, ...safeAccount } = account;
    return safeAccount;
  });
  cleanState.invites = session?.role === 'admin'
    ? (cleanState.invites || []).map(({ token, ...invite }) => invite)
    : [];
  cleanState.emailQueue = session?.role === 'admin' ? (cleanState.emailQueue || []) : [];
  return cleanState;
}

function stateForSessionWrite(incomingState, currentState, session) {
  const incoming = { ...defaultState(), ...incomingState };
  const current = { ...defaultState(), ...currentState };
  if (!['owner', 'admin'].includes(session.role)) {
    return {
      ...current,
      subscriptions: {
        ...current.subscriptions,
        [session.username]: incoming.subscriptions?.[session.username] || current.subscriptions?.[session.username] || []
      },
      settings: {
        ...current.settings,
        [session.username]: incoming.settings?.[session.username] || current.settings?.[session.username] || {}
      },
      history: {
        ...current.history,
        [session.username]: incoming.history?.[session.username] || current.history?.[session.username] || []
      },
      reminderSent: incoming.reminderSent || current.reminderSent || [],
      audit: incoming.audit || current.audit || []
    };
  }

  if (session.role === 'admin') {
    const currentAccounts = new Map((current.accounts || []).map(account => [account.username, account]));
    incoming.accounts = (incoming.accounts || []).map(account => {
      const existing = currentAccounts.get(account.username);
      if (existing?.role === 'owner') return existing;
      return account.role === 'owner' ? { ...account, role: 'admin' } : account;
    });
  }

  return incoming;
}

async function normalizeStateForStorage(state, currentState = defaultState()) {
  const mergedState = { ...defaultState(), ...state };
  const currentAccounts = new Map((currentState.accounts || []).map(account => [account.username, account]));
  mergedState.accounts = await Promise.all((mergedState.accounts || []).map(async account => {
    const currentAccount = currentAccounts.get(account.username) || {};
    const normalized = {
      ...currentAccount,
      ...account,
      email: account.email || '',
      role: account.role || 'user',
      disabled: Boolean(account.disabled),
      createdAt: account.createdAt || currentAccount.createdAt || new Date().toISOString(),
      lastLoginAt: account.lastLoginAt || currentAccount.lastLoginAt || ''
    };

    if (account.password) {
      const passwordData = await hashPassword(account.password);
      normalized.passwordHash = passwordData.hash;
      normalized.passwordSalt = passwordData.salt;
    } else if (!normalized.passwordHash && currentAccount.password) {
      const passwordData = await hashPassword(currentAccount.password);
      normalized.passwordHash = passwordData.hash;
      normalized.passwordSalt = passwordData.salt;
    }

    delete normalized.password;
    return normalized;
  }));
  return mergedState;
}

function parseCookies(req) {
  return String(req.headers.cookie || '').split(';').reduce((cookies, item) => {
    const index = item.indexOf('=');
    if (index < 0) return cookies;
    cookies[item.slice(0, index).trim()] = decodeURIComponent(item.slice(index + 1));
    return cookies;
  }, {});
}

function getSession(req) {
  const raw = parseCookies(req)[SESSION_COOKIE];
  if (!raw) return null;
  try {
    const [encoded, signature] = raw.split('.');
    const expected = signValue(encoded);
    if (!signature || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
    const session = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!session.expiresAt || new Date(session.expiresAt) < new Date()) return null;
    return { username: session.username, role: session.role };
  } catch (error) {
    return null;
  }
}

function setSessionCookie(req, res, session) {
  const payload = {
    ...session,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sessionId = `${encoded}.${signValue(encoded)}`;
  const secure = isSecureRequest(req) ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${secure}`);
}

function clearSessionCookie(req, res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

function signValue(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(password, salt, PASSWORD_ITERATIONS, 64, 'sha512', (error, derivedKey) => {
      if (error) reject(error);
      else resolve({ salt, hash: derivedKey.toString('hex') });
    });
  });
}

async function verifyPassword(account, password) {
  if (account.passwordHash && account.passwordSalt) {
    const passwordData = await hashPassword(password, account.passwordSalt);
    const expected = Buffer.from(account.passwordHash, 'hex');
    const actual = Buffer.from(passwordData.hash, 'hex');
    return expected.length === actual.length && crypto.timingSafeEqual(actual, expected);
  }
  return account.password === password;
}

async function migrateAccountPassword(state, account) {
  if (!account.password || account.passwordHash) return false;
  const passwordData = await hashPassword(account.password);
  account.passwordHash = passwordData.hash;
  account.passwordSalt = passwordData.salt;
  delete account.password;
  await writeState(state);
  return true;
}

function makeId() {
  return crypto.randomBytes(12).toString('hex');
}

function requireAdmin(req, res) {
  const session = getSession(req);
  if (!session || !['owner', 'admin'].includes(session.role)) {
    sendJson(res, 401, { ok: false, error: 'Admin access required' });
    return null;
  }
  return session;
}

function accountSession(account) {
  return { username: account.username, role: account.role || 'user' };
}

function isOwner(session) {
  return session?.role === 'owner';
}

function appendAudit(state, action, target, detail, actor = 'system') {
  state.audit = state.audit || [];
  state.audit.push({
    action,
    target,
    detail,
    actor,
    createdAt: new Date().toISOString()
  });
  state.audit = state.audit.slice(-250);
}

function isSecureRequest(req) {
  return req.headers['x-forwarded-proto'] === 'https' || String(req.headers.host || '').endsWith('.up.railway.app');
}

async function sendReminderEmail(message) {
  return sendEmail({
    to: message.email,
    subject: `${message.subscription} renews ${message.nextBillDate}`,
    html: `
      <p>Hi ${escapeHtml(message.username)},</p>
      <p>Your subscription <strong>${escapeHtml(message.subscription)}</strong> renews on <strong>${escapeHtml(message.nextBillDate)}</strong>.</p>
      <p>Amount: <strong>$${Number(message.amount).toFixed(2)}</strong></p>
    `
  });
}

async function sendEmail({ to, subject, html }) {
  if (!RESEND_API_KEY || !REMINDER_FROM_EMAIL) {
    throw new Error('Email provider is not configured');
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: REMINDER_FROM_EMAIL,
      to,
      subject,
      html
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Resend returned ${response.status}`);
  }
}

function parseLocalDate(value) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function addMonthsClamped(date, monthsToAdd) {
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + monthsToAdd, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(date.getUTCDate(), lastDay));
  return target;
}

function getNextOccurrence(sub, fromDate = new Date()) {
  const start = parseLocalDate(sub.nextBillDate);
  if (!start) return null;
  const from = new Date(Date.UTC(fromDate.getUTCFullYear(), fromDate.getUTCMonth(), fromDate.getUTCDate()));
  if (start >= from) return start;

  if ((sub.billingIntervalUnit || 'months') === 'weeks') {
    const intervalDays = Math.max(1, Number(sub.billingIntervalCount) || 1) * 7;
    const cycles = Math.ceil((from - start) / (intervalDays * 24 * 60 * 60 * 1000));
    const next = new Date(start);
    next.setUTCDate(start.getUTCDate() + cycles * intervalDays);
    return next;
  }

  const interval = Math.max(1, Number(sub.billingIntervalCount || sub.billingIntervalMonths) || 1);
  const roughMonths = (from.getUTCFullYear() - start.getUTCFullYear()) * 12 + (from.getUTCMonth() - start.getUTCMonth());
  let cycles = Math.max(0, Math.floor(roughMonths / interval));
  let next = addMonthsClamped(start, cycles * interval);
  while (next < from) {
    cycles++;
    next = addMonthsClamped(start, cycles * interval);
  }
  return next;
}

function daysBetween(start, end) {
  if (!end) return Number.POSITIVE_INFINITY;
  const startDay = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  return Math.round((end - startDay) / (24 * 60 * 60 * 1000));
}

function monthlyEquivalent(sub) {
  const count = Math.max(1, Number(sub.billingIntervalCount || sub.billingIntervalMonths) || 1);
  if ((sub.billingIntervalUnit || 'months') === 'weeks') return Number(sub.cost) * (52 / 12) / count;
  return Number(sub.cost) / count;
}

function getMonthlyDue(subscriptions, year, monthIndex) {
  return subscriptions.filter(isBillable).reduce((sum, sub) => {
    const next = getNextOccurrence(sub, new Date(Date.UTC(year, monthIndex, 1)));
    return next && next.getUTCFullYear() === year && next.getUTCMonth() === monthIndex ? sum + Number(sub.cost) : sum;
  }, 0);
}

function isBillable(sub) {
  return sub.status !== 'Paused' && sub.status !== 'Cancelled';
}

async function runDailyJobs(actor = 'system') {
  const state = await readState();
  const now = new Date();
  const todayKey = now.toISOString().slice(0, 10);
  const monthKey = todayKey.slice(0, 7);
  const accounts = state.accounts || [];

  for (const account of accounts) {
    if (account.disabled || !account.email) continue;
    const settings = { emailRemindersEnabled: true, defaultReminderDays: 7, monthlySummaryEmail: false, ...(state.settings?.[account.username] || {}) };
    const subscriptions = (state.subscriptions?.[account.username] || []).filter(isBillable);

    if (settings.emailRemindersEnabled !== false) {
      for (const sub of subscriptions) {
        const reminderDays = Number(sub.reminderDays || settings.defaultReminderDays || 0);
        if (!reminderDays) continue;
        const nextBill = getNextOccurrence(sub, now);
        const billDate = nextBill ? nextBill.toISOString().slice(0, 10) : '';
        const sentKey = `${account.username}:${sub.id}:${billDate}:${reminderDays}`;
        if (daysBetween(now, nextBill) === reminderDays && !(state.reminderSent || []).includes(sentKey)) {
          const message = {
            id: makeId(),
            username: account.username,
            email: account.email,
            subscription: sub.name,
            amount: Number(sub.cost) || 0,
            nextBillDate: billDate,
            createdAt: new Date().toISOString(),
            status: 'queued',
            error: ''
          };
          try {
            await sendReminderEmail(message);
            message.status = 'sent';
            message.sentAt = new Date().toISOString();
          } catch (error) {
            message.status = RESEND_API_KEY && REMINDER_FROM_EMAIL ? 'failed' : 'queued';
            message.error = error.message;
          }
          state.emailQueue = [...(state.emailQueue || []), message].slice(-250);
          state.reminderSent = [...(state.reminderSent || []), sentKey].slice(-500);
          appendAudit(state, `scheduled_reminder_${message.status}`, account.username, `${sub.name} reminder ${message.status}.`, actor);
        }
      }
    }

    if (settings.monthlySummaryEmail && todayKey.endsWith('-01')) {
      const summaryKey = `${account.username}:summary:${monthKey}`;
      if (!(state.reminderSent || []).includes(summaryKey)) {
        const monthly = subscriptions.reduce((sum, sub) => sum + monthlyEquivalent(sub), 0);
        const due = getMonthlyDue(subscriptions, now.getUTCFullYear(), now.getUTCMonth());
        try {
          await sendEmail({
            to: account.email,
            subject: `SubTracked monthly summary for ${monthKey}`,
            html: `<p>Hi ${escapeHtml(account.username)},</p><p>Your subscription average is <strong>$${monthly.toFixed(2)}/mo</strong>.</p><p>Bills due this month: <strong>$${due.toFixed(2)}</strong>.</p><p>Active subscriptions: <strong>${subscriptions.length}</strong>.</p>`
          });
          state.emailQueue = [...(state.emailQueue || []), { id: makeId(), username: account.username, email: account.email, subscription: 'Monthly summary', amount: due, nextBillDate: monthKey, createdAt: new Date().toISOString(), status: 'sent', sentAt: new Date().toISOString(), error: '' }].slice(-250);
          appendAudit(state, 'monthly_summary_sent', account.username, `Monthly summary sent for ${monthKey}.`, actor);
        } catch (error) {
          state.emailQueue = [...(state.emailQueue || []), { id: makeId(), username: account.username, email: account.email, subscription: 'Monthly summary', amount: due, nextBillDate: monthKey, createdAt: new Date().toISOString(), status: RESEND_API_KEY && REMINDER_FROM_EMAIL ? 'failed' : 'queued', error: error.message }].slice(-250);
        }
        state.reminderSent = [...(state.reminderSent || []), summaryKey].slice(-500);
      }
    }
  }

  await writeState(state);
  return { ok: true, queued: (state.emailQueue || []).length };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 5_000_000) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requestedPath = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const filePath = path.normalize(path.join(ROOT, requestedPath));

  if (requestedPath === '/admin.html') {
    const session = getSession(req);
    if (!session || !['owner', 'admin'].includes(session.role)) {
      res.writeHead(302, { Location: '/login.html?error=admin' });
      res.end();
      return;
    }
  }

  if (!filePath.startsWith(ROOT) || filePath.includes(`${path.sep}data${path.sep}`)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(filePath)] || 'application/octet-stream'
    });
    res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);
    if (req.url === '/api/health') {
      sendJson(res, 200, {
        ok: true,
        storage: DATABASE_URL ? 'postgres' : 'json-file',
        database: getDatabaseStatus(),
        email: {
          provider: 'resend',
          configured: Boolean(RESEND_API_KEY && REMINDER_FROM_EMAIL),
          scheduledJobsConfigured: Boolean(CRON_SECRET)
        },
        dataDir: DATABASE_URL ? null : DATA_DIR
      });
      return;
    }

    if (requestUrl.pathname === '/api/invite' && req.method === 'GET') {
      const token = requestUrl.searchParams.get('token') || '';
      const state = await readState();
      const invite = (state.invites || []).find(item => item.token === token && !item.usedAt);
      if (!invite) {
        sendJson(res, 404, { ok: false, error: 'Invite not found or already used.' });
        return;
      }
      sendJson(res, 200, { ok: true, invite: { username: invite.username, email: invite.email, role: invite.role } });
      return;
    }

    if (req.url === '/api/session' && req.method === 'GET') {
      const session = getSession(req);
      sendJson(res, 200, session ? { ok: true, authenticated: true, ...session } : { ok: true, authenticated: false });
      return;
    }

    if (req.url === '/api/login' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      const state = await readState();
      const account = (state.accounts || []).find(item => item.username === String(body.username || '').trim());

      if (!account || !(await verifyPassword(account, String(body.password || '')))) {
        appendAudit(state, 'failed_login', String(body.username || '').trim() || 'unknown', 'Failed login attempt.', String(body.username || '').trim() || 'unknown');
        await writeState(state);
        sendJson(res, 401, { ok: false, error: 'Incorrect username or password.' });
        return;
      }

      if (account.disabled) {
        sendJson(res, 403, { ok: false, error: 'This account is disabled. Contact an admin.' });
        return;
      }

      account.lastLoginAt = new Date().toISOString();
      appendAudit(state, 'login', account.username, 'User logged in.', account.username);
      await migrateAccountPassword(state, account);
      if (!account.password) await writeState(state);
      setSessionCookie(req, res, accountSession(account));
      sendJson(res, 200, { ok: true, account: accountSession(account) });
      return;
    }

    if (req.url === '/api/logout' && req.method === 'POST') {
      clearSessionCookie(req, res);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.url === '/api/password-reset' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      const email = String(body.email || '').trim().toLowerCase();
      const state = await readState();
      const account = (state.accounts || []).find(item => item.email && item.email.toLowerCase() === email);
      if (account) {
        const token = makeId();
        state.passwordResets = [...(state.passwordResets || []).filter(item => !item.usedAt), {
          token,
          username: account.username,
          email: account.email,
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          usedAt: ''
        }].slice(-50);
        const resetUrl = `${isSecureRequest(req) ? 'https' : 'http'}://${req.headers.host}/reset.html?token=${encodeURIComponent(token)}`;
        try {
          await sendEmail({
            to: account.email,
            subject: 'Reset your SubTracked password',
            html: `<p>Hi ${escapeHtml(account.username)},</p><p>Use this link to reset your SubTracked password. It expires in one hour:</p><p><a href="${escapeHtml(resetUrl)}">${escapeHtml(resetUrl)}</a></p>`
          });
          appendAudit(state, 'password_reset_email', account.username, 'Sent password reset email.', 'system');
        } catch (error) {
          appendAudit(state, 'password_reset_queued', account.username, `Password reset link created: ${resetUrl}`, 'system');
        }
        await writeState(state);
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.url === '/api/reset-password' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      const token = String(body.token || '').trim();
      const password = String(body.password || '');
      const state = await readState();
      const reset = (state.passwordResets || []).find(item => item.token === token && !item.usedAt && new Date(item.expiresAt) > new Date());
      if (!reset) {
        sendJson(res, 400, { ok: false, error: 'Reset link is invalid or expired.' });
        return;
      }
      if (password.length < 8) {
        sendJson(res, 400, { ok: false, error: 'Password must be at least 8 characters.' });
        return;
      }
      const account = (state.accounts || []).find(item => item.username === reset.username);
      if (!account) {
        sendJson(res, 404, { ok: false, error: 'Account not found.' });
        return;
      }
      account.password = password;
      reset.usedAt = new Date().toISOString();
      appendAudit(state, 'password_reset', account.username, 'Password reset completed.', account.username);
      await writeState(state);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.url === '/api/change-password' && req.method === 'POST') {
      const session = getSession(req);
      if (!session) {
        sendJson(res, 401, { ok: false, error: 'Login required' });
        return;
      }

      const body = JSON.parse(await readBody(req) || '{}');
      const currentPassword = String(body.currentPassword || '');
      const updatedPassword = String(body.updatedPassword || '');
      const state = await readState();
      const account = (state.accounts || []).find(item => item.username === session.username);

      if (!account || !(await verifyPassword(account, currentPassword))) {
        sendJson(res, 400, { ok: false, error: 'Current password is incorrect.' });
        return;
      }

      if (updatedPassword.length < 8) {
        sendJson(res, 400, { ok: false, error: 'New password must be at least 8 characters.' });
        return;
      }

      account.password = updatedPassword;
      await writeState(state);
      appendAudit(state, 'password_change', session.username, 'Changed account password.', session.username);
      await writeState(state);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.url === '/api/invites' && req.method === 'POST') {
      const session = requireAdmin(req, res);
      if (!session) return;
      const body = JSON.parse(await readBody(req) || '{}');
      const state = await readState();
      const username = String(body.username || '').trim();
      const email = String(body.email || '').trim();
      const requestedRole = ['owner', 'admin', 'user'].includes(body.role) ? body.role : 'user';
      const role = requestedRole === 'owner' && !isOwner(session) ? 'admin' : requestedRole;

      if (username.length < 3 || !email.includes('@')) {
        sendJson(res, 400, { ok: false, error: 'Invite needs a username and valid email.' });
        return;
      }

      if ((state.accounts || []).some(account => account.username.toLowerCase() === username.toLowerCase())) {
        sendJson(res, 409, { ok: false, error: 'That username already exists.' });
        return;
      }

      const invite = {
        token: makeId(),
        username,
        email,
        role,
        createdAt: new Date().toISOString(),
        createdBy: session.username,
        usedAt: ''
      };
      state.invites = [...(state.invites || []).filter(item => !item.usedAt), invite].slice(-50);
      appendAudit(state, 'create_invite', username, `Created ${role} invite for ${email}.`, session.username);
      const inviteUrl = `${isSecureRequest(req) ? 'https' : 'http'}://${req.headers.host}/signup.html?token=${encodeURIComponent(invite.token)}`;
      try {
        await sendEmail({
          to: email,
          subject: 'You have been invited to SubTracked',
          html: `<p>You have been invited to SubTracked as <strong>${escapeHtml(role)}</strong>.</p><p><a href="${escapeHtml(inviteUrl)}">Create your account</a></p><p>${escapeHtml(inviteUrl)}</p>`
        });
        invite.emailStatus = 'sent';
      } catch (error) {
        invite.emailStatus = RESEND_API_KEY && REMINDER_FROM_EMAIL ? 'failed' : 'queued';
        invite.emailError = error.message;
      }
      await writeState(state);
      sendJson(res, 200, { ok: true, invite });
      return;
    }

    if (req.url === '/api/signup' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      const state = await readState();
      const token = String(body.token || '').trim();
      const invite = (state.invites || []).find(item => item.token === token && !item.usedAt);
      const allowPublicSignup = Boolean(state.publicSignup);
      const username = invite ? invite.username : String(body.username || '').trim();
      const email = invite ? invite.email : String(body.email || '').trim();
      const role = invite ? invite.role : 'user';
      const password = String(body.password || '');

      if (!invite && !allowPublicSignup) {
        sendJson(res, 403, { ok: false, error: 'Signup is currently invite-only.' });
        return;
      }

      if (username.length < 3 || password.length < 8 || !email.includes('@')) {
        sendJson(res, 400, { ok: false, error: 'Username, valid email, and 8+ character password are required.' });
        return;
      }

      if ((state.accounts || []).some(account => account.username.toLowerCase() === username.toLowerCase())) {
        sendJson(res, 409, { ok: false, error: 'That username already exists.' });
        return;
      }

      state.accounts.push({ username, email, password, role, disabled: false, createdAt: new Date().toISOString(), lastLoginAt: '' });
      state.subscriptions[username] = [];
      state.settings[username] = { monthlyBudget: 0, darkMode: false, emailRemindersEnabled: true, defaultReminderDays: 7, highCostWarnings: true, highCostLimit: 30, monthlySummaryEmail: false };
      state.history[username] = [];
      if (invite) invite.usedAt = new Date().toISOString();
      appendAudit(state, invite ? 'accept_invite' : 'public_signup', username, 'Created account through signup.', username);
      await writeState(state);
      const account = (await readState()).accounts.find(item => item.username === username);
      setSessionCookie(req, res, accountSession(account));
      sendJson(res, 200, { ok: true, account: accountSession(account) });
      return;
    }

    if (req.url === '/api/state' && req.method === 'GET') {
      sendJson(res, 200, sanitizeStateForClient(await readState(), getSession(req)));
      return;
    }

    if (req.url === '/api/state' && req.method === 'PUT') {
      const session = getSession(req);
      if (!session) {
        sendJson(res, 401, { ok: false, error: 'Login required' });
        return;
      }
      const body = await readBody(req);
      const currentState = await readState();
      await writeState(stateForSessionWrite(JSON.parse(body || '{}'), currentState, session));
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.url === '/api/reminders' && req.method === 'POST') {
      const session = getSession(req);
      if (!session) {
        sendJson(res, 401, { ok: false, error: 'Login required' });
        return;
      }

      const body = JSON.parse(await readBody(req) || '{}');
      const state = await readState();
      const message = {
        id: makeId(),
        username: session.username,
        email: String(body.email || ''),
        subscription: String(body.subscription || ''),
        amount: Number(body.amount) || 0,
        nextBillDate: String(body.nextBillDate || ''),
        createdAt: new Date().toISOString(),
        status: 'queued',
        error: ''
      };

      if (RESEND_API_KEY && REMINDER_FROM_EMAIL && message.email) {
        try {
          await sendReminderEmail(message);
          message.status = 'sent';
          message.sentAt = new Date().toISOString();
        } catch (error) {
          message.status = 'failed';
          message.error = error.message;
        }
      }

      state.emailQueue = [...(state.emailQueue || []), message].slice(-250);
      appendAudit(state, `reminder_${message.status}`, session.username, `${message.subscription} reminder ${message.status}.`, session.username);
      await writeState(state);
      sendJson(res, 200, { ok: true, status: message.status });
      return;
    }

    if (requestUrl.pathname === '/api/jobs/daily' && req.method === 'POST') {
      const providedSecret = req.headers['x-cron-secret'] || requestUrl.searchParams.get('secret') || '';
      const session = getSession(req);
      if (CRON_SECRET && providedSecret !== CRON_SECRET && !isOwner(session)) {
        sendJson(res, 401, { ok: false, error: 'Cron secret required' });
        return;
      }
      if (!CRON_SECRET && !isOwner(session)) {
        sendJson(res, 401, { ok: false, error: 'Owner access required when CRON_SECRET is not set' });
        return;
      }
      sendJson(res, 200, await runDailyJobs(session?.username || 'cron'));
      return;
    }

    serveStatic(req, res);
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { ok: false, error: error.message });
  }
});

server.listen(PORT, () => {
  console.log(`SubTracked running at http://localhost:${PORT}`);
});
