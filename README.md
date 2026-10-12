# Event Check-In

Self-hosted event check-in app: multi-event registration (parent's name, child's
name, email, phone), a personal QR code each guest must save before finishing,
a password-gated admin dashboard, camera or manual QR scanning to mark guests
arrived, CSV export, and multiple admin logins.

Events, attendees, and admin accounts are stored in PostgreSQL. Docker Compose
persists the database in the `postgres_data` volume. On first startup against an
empty database, the app imports records from `data/db.json` if that legacy file
exists.

## 1. Run it locally (to test before deploying)

Requires [Node.js](https://nodejs.org) 18 or newer and a PostgreSQL database.
Copy `.env.example` to `.env`, then set `DB_HOST`, `DB_PORT`, `DB_NAME`,
`DB_USER`, and `DB_PASSWORD` to match your PostgreSQL server, or set
`DATABASE_URL` to your hosted PostgreSQL connection string.

```bash
npm install
npm start
```

Then open http://localhost:3000. The admin login is seeded from `ADMIN_USER` and
`ADMIN_PASS` in `.env` when the database has no admin accounts.

## 2. Push this to your GitHub repo

If you already have an empty repo created on GitHub, run this from inside this
folder:

```bash
git init
git add .
git commit -m "Initial commit: event check-in app"
git branch -M main
git remote add origin https://github.com/<your-username>/<your-repo>.git
git push -u origin main
```

If you don't have a repo yet: go to github.com → **New repository** → give it
a name → **do not** check "Add a README" (to avoid a merge conflict with this
one) → Create repository. Then use the commands above, replacing the URL with
the one GitHub shows you.

If you're prompted for a password and it's rejected, GitHub no longer accepts
account passwords over HTTPS git pushes — you'll need a
[Personal Access Token](https://github.com/settings/tokens) (used in place of
the password) or to push over SSH instead.

## 3. Build the Docker image for ARM

This app has no native/compiled dependencies (just Node, Express, and the
PostgreSQL client), so the same `Dockerfile` builds for ARM without any special
code changes — you're just telling Docker which CPU architecture to target.

**On a Mac (Apple Silicon) or any machine with Docker Buildx:**

```bash
# One-time setup of a multi-platform builder
docker buildx create --use

# Build for ARM64 (e.g. Raspberry Pi 4/5, AWS Graviton, ARM VPS) and load it locally
docker buildx build --platform linux/arm64 -t attendance-checkin:arm64 --load .

# Or build+push directly to a registry (Docker Hub, GHCR, etc.) so an ARM
# device can pull it without needing to build anything itself:
docker buildx build --platform linux/arm64 -t <your-dockerhub-username>/attendance-checkin:latest --push .
```

For a Raspberry Pi running 32-bit Raspberry Pi OS, use `linux/arm/v7` instead
of `linux/arm64`.

**Building directly on the ARM device itself** (simplest option — no
cross-compilation needed at all):

```bash
git clone https://github.com/<your-username>/<your-repo>.git
cd <your-repo>
docker compose up -d --build
```

Before the first start, copy `.env.example` to `.env` if you do not already have
one. Set a strong `POSTGRES_PASSWORD` and `ADMIN_PASS`; if `.env` already exists,
add the PostgreSQL settings from `.env.example` without overwriting your current
admin credentials. Compose starts PostgreSQL and the app; the database is
reachable from the host on `127.0.0.1:${POSTGRES_PORT:-5432}`.

## 4. Run it

```bash
docker compose up -d
```

This starts the app on port 3000 with `./data` mounted into the container, so
guest data persists across restarts and upgrades. Visit
`http://<device-ip>:3000` from any device on the same network.

To update after pulling new code:

```bash
git pull
docker compose up -d --build
```

## Changing the admin login

Edit the `ADMIN_USER` / `ADMIN_PASS` values in `.env` **before the first run** — they only seed the
very first admin account. After that, add or remove admin logins from inside
the app itself (Admin → "Admin logins"), which is the safer way to manage
multiple staff accounts going forward.

## A note on security

The admin login is checked by the server and sessions are short-lived tokens
(not stored in the page itself, unlike the earlier prototype version) — this
is real, reasonable protection for a small club/event tool. It is not
hardened for public internet exposure (no rate-limiting, no HTTPS built in).
If you're deploying this somewhere reachable from the open internet rather
than a home/local network, put it behind a reverse proxy with HTTPS (e.g.
[Caddy](https://caddyserver.com/) or [nginx](https://nginx.org/) with
Let's Encrypt) and consider adding login rate-limiting.

## Project structure

```
attendance-checkin/
├── server.js           Express backend (events, registration, admin API)
├── package.json
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── data/                Legacy JSON import source (git-ignored)
└── public/
    ├── index.html
    ├── style.css
    └── app.js           Frontend: registration, QR display, admin dashboard, camera scanning
```
