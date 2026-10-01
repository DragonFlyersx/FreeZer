# FreeZer

A small self-hosted webapp for keeping track of what's in your freezer — and how
fresh it still is. Flask + SQLite, no build step, no dependencies beyond Flask.

## Run it

```bash
./run.sh              # http://127.0.0.1:5177
./run.sh --port 8080  # different port
```

If Flask isn't installed system-wide:

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
./run.sh              # run.sh picks up .venv automatically
```

The database is created on first run at `./freezer.db` (override with the
`FREEZER_DB` environment variable). It's a single file — back it up by copying it.

### On a server (Docker)

Pre-built images are published to GitHub Container Registry on every push to
`main`, for both x86-64 and ARM (Raspberry Pi etc.). On the server:

```bash
mkdir freezer && cd freezer
curl -O https://raw.githubusercontent.com/DragonFlyersx/FreeZer/main/docker-compose.yml
docker compose up -d
```

That pulls `ghcr.io/dragonflyersx/freezer:latest`, exposes port 5177 and keeps
the database in a named volume (`freezer-data`) so it survives updates. To
update later: `docker compose pull && docker compose up -d`.

To build from source instead of pulling: clone the repo and run
`docker compose up -d --build` in it.

The container runs gunicorn as an unprivileged user and has a health check on
`/api/meta`. If you'd rather keep the database in a folder on the host, replace
the volume line with `- ./data:/data` and `chown 999:999 ./data` once.

There's still no authentication. On a home network that's fine; if you expose it
to the internet, put it behind a reverse proxy that handles TLS and login.

### From your phone

```bash
./run.sh --host 0.0.0.0
```

then open `http://<this machine's LAN IP>:5177` on the phone (`hostname -I`
shows the IP). The layout adapts to phone screens, and "Add to Home Screen" in
Safari/Chrome gives you an app-style icon. There's no authentication, so only
bind to `0.0.0.0` on a network you trust.

### Theme

Light and dark are both built in. The switch in the top-right picks
**Auto** (follow the system), **light** or **dark**; the choice is remembered
per browser.

## What it does

- **Inventory** — name, category, amount + unit, location, notes. Grouped by
  freezer drawer/shelf, searchable, filterable.
- **Spoilage tracking** — pick a category and the best-before date is pre-filled
  from a freezer shelf-life table (ground meat 4 months, vegetables 12, bread 3,
  and so on). Always overridable per item. Items are colour-coded green
  (fine) / amber (use within 21 days) / red (past best before), and the list is
  sorted so the most urgent thing is at the top.
- **Partial use** — take 1 of 4 portions out and the remaining 3 stay logged.
  When it hits zero the item moves to history automatically.
- **History** — used-up and thrown-out items are kept, with a per-item event log.
  "Put back" undoes a mistake.
- **Locations** — manage your drawers/shelves in the Locations dialog. Deleting a
  location leaves its items in place, just unassigned.

## Layout

| File | What's in it |
| --- | --- |
| `app.py` | Flask app, SQLite schema, REST API, shelf-life table |
| `templates/index.html` | The single page |
| `static/app.js` | Frontend logic (vanilla JS, no framework) |
| `static/style.css` | Styling ("Glacier": frosted glass on an icy gradient), light + dark |
| `static/fonts/` | Atkinson Hyperlegible Next, self-hosted so nothing is fetched from the internet |
| `static/icons/`, `static/manifest.webmanifest` | Home-screen icon and PWA manifest (regenerate icons with `scripts/make_icons.py`) |
| `freezer.db` | Your data (git-ignored) |
| `Dockerfile`, `docker-compose.yml` | Container image (gunicorn) and one-command server setup |
| `.github/workflows/docker.yml` | Builds and publishes the image to GHCR on push to `main` |

## API

All JSON, all under `/api`:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/meta` | categories, units, locations, today's date |
| GET | `/api/items?status=active\|used\|discarded\|all` | list items with spoilage state |
| POST | `/api/items` | add an item |
| PATCH | `/api/items/<id>` | edit any field |
| POST | `/api/items/<id>/take` | take an amount out (omit amount = take all) |
| POST | `/api/items/<id>/discard` | throw it out |
| POST | `/api/items/<id>/restore` | undo — put it back in the freezer |
| DELETE | `/api/items/<id>` | delete permanently, including history |
| GET | `/api/items/<id>/history` | event log for one item |
| GET | `/api/stats` | counts, oldest item, per-location breakdown |
| GET/POST/PATCH/DELETE | `/api/locations[/<id>]` | manage locations |

## Tuning

Both live at the top of `app.py`:

- `CATEGORIES` — the shelf-life table. Change the months, or add your own categories.
- `SOON_DAYS` — how far ahead the amber "use soon" warning starts (default 21 days).
