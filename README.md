# SubTrack

SubTrack is a small subscription tracker with a built-in Node.js backend.

## Run Locally

Install Node.js 18 or newer, then run:

```bash
npm start
```

Open:

```text
http://localhost:3000
```

The shared app data is stored in:

```text
data/db.json
```

## Default Admin

```text
username: admin
password: admin123
```

Change the admin password after your first login.

## Hosting

Use a Node-capable host such as Render, Railway, Fly.io, or a VPS.

Start command:

```bash
npm start
```

The app uses `process.env.PORT` automatically, which most hosting providers set for you.

## Supabase Database

For shared data that survives redeploys, create a Supabase project and copy the Postgres connection string.

On your host, add this environment variable:

```text
DATABASE_URL=your_supabase_postgres_connection_string
```

When `DATABASE_URL` is set, SubTrack stores data in Supabase/Postgres. When it is not set, SubTrack falls back to `data/db.json` for local testing.

You do not need to manually create tables. The server creates this table on first run:

```sql
create table if not exists app_state (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
```

Recommended Render settings:

```text
Build Command: npm install
Start Command: npm start
Environment Variable: DATABASE_URL=...
```

## Important

This backend stores passwords as plain text because it is intentionally simple and dependency-free. Before using it with real private data, add proper password hashing, HTTPS-only hosting, and environment-based admin credentials.
