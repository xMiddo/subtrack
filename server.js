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
const SESSION_COOKIE = 'subtrack_session_id';
const PASSWORD_ITERATIONS = 120000;
let sql = null;
const sessions = new Map();

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
        role: 'admin',
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
  return cleanState;
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
  const sessionId = parseCookies(req)[SESSION_COOKIE];
  if (!sessionId) return null;
  return sessions.get(sessionId) || null;
}

function setSessionCookie(req, res, session) {
  const sessionId = crypto.randomBytes(32).toString('hex');
  sessions.set(sessionId, session);
  const secure = isSecureRequest(req) ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${secure}`);
}

function clearSessionCookie(req, res) {
  const sessionId = parseCookies(req)[SESSION_COOKIE];
  if (sessionId) sessions.delete(sessionId);
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
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
  if (!session || session.role !== 'admin') {
    sendJson(res, 401, { ok: false, error: 'Admin access required' });
    return null;
  }
  return session;
}

function accountSession(account) {
  return { username: account.username, role: account.role || 'user' };
}

function isSecureRequest(req) {
  return req.headers['x-forwarded-proto'] === 'https' || String(req.headers.host || '').endsWith('.up.railway.app');
}

async function sendReminderEmail(message) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: REMINDER_FROM_EMAIL,
      to: message.email,
      subject: `${message.subscription} renews ${message.nextBillDate}`,
      html: `
        <p>Hi ${escapeHtml(message.username)},</p>
        <p>Your subscription <strong>${escapeHtml(message.subscription)}</strong> renews on <strong>${escapeHtml(message.nextBillDate)}</strong>.</p>
        <p>Amount: <strong>$${Number(message.amount).toFixed(2)}</strong></p>
      `
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Resend returned ${response.status}`);
  }
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
        sendJson(res, 401, { ok: false, error: 'Incorrect username or password.' });
        return;
      }

      if (account.disabled) {
        sendJson(res, 403, { ok: false, error: 'This account is disabled. Contact an admin.' });
        return;
      }

      account.lastLoginAt = new Date().toISOString();
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
      const role = body.role === 'admin' ? 'admin' : 'user';

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
      state.settings[username] = { monthlyBudget: 0, darkMode: false };
      state.history[username] = [];
      if (invite) invite.usedAt = new Date().toISOString();
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
      if (!getSession(req)) {
        sendJson(res, 401, { ok: false, error: 'Login required' });
        return;
      }
      const body = await readBody(req);
      await writeState(JSON.parse(body || '{}'));
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
      await writeState(state);
      sendJson(res, 200, { ok: true, status: message.status });
      return;
    }

    serveStatic(req, res);
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { ok: false, error: error.message });
  }
});

server.listen(PORT, () => {
  console.log(`SubTrack running at http://localhost:${PORT}`);
});
