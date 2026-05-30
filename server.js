const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(ROOT, 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');
const DATABASE_URL = process.env.DATABASE_URL || '';
const DATABASE_SSL = process.env.DATABASE_SSL || process.env.PGSSLMODE || '';
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
        password: 'admin123',
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
    reminderSent: []
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
  if (!sql) {
    const postgres = require('postgres');
    sql = postgres(DATABASE_URL, {
      max: 3,
      ssl: getDatabaseSslMode()
    });
  }
  return sql;
}

function getDatabaseSslMode() {
  if (/^(require|true)$/i.test(DATABASE_SSL)) return 'require';
  if (/^(disable|false)$/i.test(DATABASE_SSL)) return false;

  let host = '';
  try {
    host = new URL(DATABASE_URL).hostname;
  } catch (error) {
    return false;
  }

  if (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.railway.internal')) return false;
  return 'require';
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
  const client = getSql();
  if (!client) {
    writeDb(state);
    return;
  }

  await ensurePostgresDb(client);
  await client`
    insert into app_state (id, data, updated_at)
    values ('main', ${client.json({ ...defaultState(), ...state })}, now())
    on conflict (id)
    do update set data = excluded.data, updated_at = now()
  `;
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
    if (req.url === '/api/health') {
      sendJson(res, 200, {
        ok: true,
        storage: DATABASE_URL ? 'postgres' : 'json-file',
        postgresSsl: DATABASE_URL ? getDatabaseSslMode() : null,
        dataDir: DATABASE_URL ? null : DATA_DIR
      });
      return;
    }

    if (req.url === '/api/state' && req.method === 'GET') {
      sendJson(res, 200, await readState());
      return;
    }

    if (req.url === '/api/state' && req.method === 'PUT') {
      const body = await readBody(req);
      await writeState(JSON.parse(body || '{}'));
      sendJson(res, 200, { ok: true });
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
