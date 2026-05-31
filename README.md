# SubTracked

SubTracked is a small subscription tracker with a built-in Node.js backend.

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

## Shared Database

For shared data that survives redeploys, create a Postgres database and copy the connection string.

On your host, add this environment variable:

```text
DATABASE_URL=your_supabase_postgres_connection_string
```

When `DATABASE_URL` is set, SubTracked stores data in Postgres. When it is not set, SubTracked falls back to `data/db.json` for local testing.

For Railway Postgres with an internal `.railway.internal` host, SSL is disabled automatically. For proxy hosts such as `zephyr.proxy.rlwy.net`, SSL is required automatically. You can override this with:

```text
DATABASE_SSL=false
```

or:

```text
PGSSLMODE=disable
```

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

## Email Reminders

SubTracked queues reminder emails automatically when a user has an email address and a subscription reminder is due. To actually send those emails through Resend, add:

```text
RESEND_API_KEY=your_resend_api_key
REMINDER_FROM_EMAIL=SubTracked <reminders@yourdomain.com>
CRON_SECRET=long_random_secret
SESSION_SECRET=another_long_random_secret
```

Without those variables, reminder attempts are stored in the app state's `emailQueue`.

To send scheduled reminders and monthly summaries, configure a Railway scheduled job to call:

```text
POST https://your-app.up.railway.app/api/jobs/daily?secret=your_CRON_SECRET
```

Run it once per day. The endpoint sends due renewal reminders and first-of-month summary emails for users who enabled monthly summaries.

## Important

Passwords are hashed with PBKDF2 before storage. Existing plain-text passwords are migrated the next time the account logs in or is saved. Before using it with real private data, keep HTTPS-only hosting enabled and change the default admin password.
