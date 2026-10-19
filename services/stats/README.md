<img src="../../.github/assets/flags/gb.svg" height="14" alt=""> English · <a href="README.de.md"><img src="../../.github/assets/flags/de.svg" height="14" alt=""> Deutsch</a>

# FORGE statistics (services/stats)

Small service at https://forge.vanturis.de. It shows the FORGE start page (`/`), receives the anonymous usage numbers of the FORGE desktop app and shows the totals of all installations publicly at `/stats` ("Live Stats", English and German).

In the app, usage statistics are off by default. After the setup assistant and the sync question, FORGE asks once whether to turn them on; without an answer they stay off. So only installations whose users turned them on send reports. They can be switched on or off at any time under Settings > About FORGE > Privacy; when they are switched off, FORGE deletes the data already sent at the service (`DELETE /api/v1/report/<installId>`).

The folder is not part of the FORGE pnpm workspace. It has its own `package.json` and its own `pnpm-lock.yaml`.

Stack: Next.js (App Router), TypeScript strict, `pg`, `zod`. Plain CSS without a framework.

The page uses the design of the desktop app: the color, font and radius tokens from `apps/desktop/src/styles.css` are CSS variables in `src/app/globals.css` (dark theme only, the app has no light theme). The page layout (top bar, footer, start page, statistics) is in `src/app/pages.css`, the building blocks in `src/components/blocks.tsx`. The charts in `src/components/charts.tsx` follow those of the daily report (`apps/desktop/src/components/report/usage-charts.tsx`): columns and bars in HTML without a chart library, tooltip on hover and focus. If the app changes its tokens, update them here. The font is Inter (package `@fontsource-variable/inter`, SIL Open Font License, bundled with the CSS), icons come from `lucide-react`. The logo mark and favicon are copies of `apps/desktop/src/assets/logo-mark.svg` and `logo.svg`.

## What is stored

One row per installation in the table `installs`: random installation ID, first and last report, FORGE version, operating system, the cumulative counters as JSON, the tokens and costs per Claude model (`models`, JSON) and the type of Claude subscription (`plan`). The app always sends the total since 2026-10-17 (start of the statistics, `USAGE_STATS_SINCE` in `packages/sidecar/src/persistence/db.ts`), and the service overwrites the last state. App versions before this cutoff date send the total since installation; with the update their counters drop once.

In addition, `install_days` holds the state of each installation at the end of each UTC day (one row per installation and day, each report overwrites the one for the current day). The history is derived from this: the increase for a day is the state minus the last earlier state of the same installation. The first state of an installation does not count as an increase, nor does a counter missing from the earlier state (a new app version that sends its total since installation). Negative differences (reinstallation with an empty database, update to the cutoff date) count as 0. Active installations on a day are those with a state on that day. Turning off the statistics deletes the installation together with its daily states (`ON DELETE CASCADE`).

No IP addresses in the database or in logs. For the limit on mass-created IDs, the process keeps salted hashes of the IP addresses in memory, only for the current day.

The service creates the tables itself on first access (`CREATE TABLE IF NOT EXISTS`, new columns with `ADD COLUMN IF NOT EXISTS`). No migration is needed.

## API

| Method and path | Purpose | Responses |
| --- | --- | --- |
| `POST /api/v1/report` | Report the state of an installation | 204; 400 invalid; 413 body over 4 KB; 429 too frequent; 503 DB down |
| `DELETE /api/v1/report/<installId>` | Delete the record (statistics turned off in FORGE) | 204, even if it did not exist; 400 not a UUID v4 |
| `GET /api/v1/totals` | Totals, models, versions and history as JSON (see below), `Cache-Control: public, max-age=300` | 200; 503 |
| `GET /api/v1/live` | Installations online right now, in total and per subscription (`{ onlineInstalls, plans: [{ plan, online }], updatedAt }`); the page polls every 30 seconds, cached for at most 15 seconds | 200; 503 |
| `GET /api/v1/downloads` | Downloads of the installer (`*-setup.exe`) across all releases, excluding updates, signatures and markers; for the README badge, fetched from GitHub at most every 30 minutes | 200; 503 |
| `GET /api/v1/donations` | Donated so far (`{ donations: { cents, count } }`, euro cents; `donations: null` without `STRIPE_SECRET_KEY`); for the heart in the app, fetched from Stripe at most every 10 minutes | 200; 503 |
| `GET /api/health` | Health check with a DB query | 200 `ok`; 503 |
| `GET /` | Public page | 200, on DB failure with a notice instead of numbers |

Body of the report:

```json
{
  "schema": 1,
  "installId": "<uuid v4>",
  "appVersion": "0.1.80",
  "os": "Windows 10.0.26200",
  "counters": {
    "tokensInput": 0, "tokensOutput": 0, "tokensCacheRead": 0, "tokensCacheWrite": 0,
    "claudeTurns": 0, "claudeWorkMs": 0, "sessions": 0, "projectsCreated": 0,
    "agentsStarted": 0, "agentsMerged": 0, "phoneCalls": 0,
    "userTurns": 0, "costUsdCents": 0
  },
  "models": {
    "claude-opus-4-7": { "tokens": 123, "costUsdCents": 45 }
  },
  "plan": "max_20x"
}
```

`userTurns` are the runs that users started themselves, `costUsdCents` the estimated API cost of all Claude calls in US cents. `models` contains, per model ID, all four token types combined and the estimated cost, cumulative since the cutoff date. `plan` is the subscription of the account logged in to Claude Code (`max_20x`, `max_5x`, `max`, `pro`, `team`, `enterprise` ...), read from `organizationType` and the rate limit tier in `.claude.json`; `null` without a claude.ai login. Older app versions do not send these fields; then 0, `{}` and `null` apply.

Rules (see `src/lib/report.ts`):

- Counters are integers from 0. Unknown keys are ignored, missing ones count as 0.
- Upper limits per installation: token fields 10^12, `claudeWorkMs` 10^11, `costUsdCents` 10^10, all others 10^7. Above that: 400.
- `models`: at most 20 entries, keys 1 to 64 characters from `[A-Za-z0-9._:[]-]`, values `tokens` (integer, 0 to 4·10^12) and `costUsdCents` (integer, 0 to 10^10), both required.
- `plan`: `null` or 1 to 24 characters from `[a-z0-9_]`.
- `appVersion` at most 32 characters from `[0-9A-Za-z.+-]`, `os` at most 64 characters without control characters.
- The app reports every 5 minutes. At most one report per installation every 4 minutes (429). The app treats 429 as sent.
- At most 20 new installation IDs per IP address and day (429). The counter lives only in memory and starts over after a restart.

Response of `GET /api/v1/totals`:

```json
{
  "installs": 7,
  "activeInstalls30d": 7,
  "onlineInstalls": 2,
  "counters": { "tokensInput": 0, "...": 0, "userTurns": 0, "costUsdCents": 0 },
  "updatedAt": "2026-10-18T00:00:00.000Z",
  "models": { "claude-opus-4-7": { "tokens": 803400000, "costUsdCents": 315000 } },
  "versions": [{ "version": "0.1.81", "installs": 3 }],
  "plans": [{ "plan": "max_20x", "installs": 4, "online": 1 }, { "plan": null, "installs": 3, "online": 1 }],
  "platforms": [{ "platform": "windows", "installs": 7 }],
  "history": [{ "day": "2026-10-17", "tokens": 64420000, "claudeTurns": 55, "sessions": 12, "claudeWorkMs": 5400000, "activeInstalls": 7 }]
}
```

- `onlineInstalls`: installations with a report in the last 10 minutes (`ONLINE_MINUTES`, the app reports every 5).
- `models`: total per model ID across all installations, the 50 with the most tokens. The page merges `claude-opus-5-5` and `claude-opus-5-5[1m]` (the same model with 1M context) into one row.
- `plans`: active installations of the last 30 days per subscription, of which `online` are online right now; `null` means unknown (older app or without a claude.ai login).
- `platforms`: active installations of the last 30 days per operating system (`windows`, `macos`, `linux`, `other`, from the `os` of the reports), most first.
- `versions`: active installations of the last 30 days per FORGE version, most common first.
- `history`: the last 30 UTC days including today, oldest first; `tokens` is the increase of all four token types, `claudeTurns` the increase in runs, `sessions` and `claudeWorkMs` likewise.
- The README badge reads `installs`.

The totals are recomputed from the database at most every 5 minutes (in-process cache). New reports therefore appear with a delay of up to 5 minutes.

## Environment variables

| Variable | Required | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres connection, e.g. `postgres://user:pass@host:5432/forge_stats` |
| `PORT` | no | Server port, `3000` in the image |
| `CLIENT_IP_HEADER` | no | Header in which a proxy in front of Coolify passes the client address, e.g. `x-client-ip` |
| `STRIPE_SECRET_KEY` | no | Stripe key for the "Bisher gespendet" (donated so far) figure. A restricted key (`rk_live_…`) with read access to *Checkout Sessions* is enough. Without it the figure is missing from the page. |
| `STRIPE_PAYMENT_LINK` | no | A different donation link (`plink_…`). The default is the link behind "Support" (`DONATE_LINK_ID` in `src/lib/donations.ts`). |

"Bisher gespendet" is the sum of all paid checkouts in euros via the donation link, before Stripe fees and without deducting refunds. The service queries Stripe at most every 10 minutes.

The service reads the client IP from the header in `CLIENT_IP_HEADER` (if set), otherwise from `CF-Connecting-Ip`, otherwise from `X-Real-Ip`, otherwise from the last entry of `X-Forwarded-For`. Traefik sets the last two.

### Behind our own HAProxy (how it is run)

HAProxy terminates TLS with its own certificate and forwards to Traefik over HTTP. Therefore:

- Domain in Coolify with **`http://`**: `http://forge.vanturis.de:3000`. With `https://`, Traefik redirects every
  request to HTTPS, HAProxy sends it again over HTTP, and the browser reports `ERR_TOO_MANY_REDIRECTS`.
- Pass the client address in the HAProxy frontend (overwrites whatever the client sends itself):
  `http-request set-header X-Client-IP %[src]`
- Set the environment variable `CLIENT_IP_HEADER=x-client-ip` in Coolify. Without both, the service sees the
  HAProxy address for every user, and the limit on new installations applies to all of them together.

Behind Cloudflare (proxy on), the SSL mode must be **Full (strict)**, for the same reason.

## Setup in Coolify (one resource with Postgres)

`docker-compose.yml` starts the service and its Postgres together. The database is only reachable on the internal network,
its data lives in the volume `stats-db`.

1. DNS: A record `forge.vanturis.de` pointing to the Coolify server.
2. In Coolify: choose a project, **+ New**, **Public Repository** (or **Private Repository (with GitHub App)**
   while the repo is private), URL `https://github.com/vanturis/forge`, branch `main`.
3. Build Pack: **Docker Compose**. Base Directory: **`/services/stats`**. Docker Compose Location:
   **`/docker-compose.yml`**. Save: Coolify reads the file and shows the services `stats` and `postgres`.
4. For the service `stats`, enter **`https://forge.vanturis.de:3000`** as the domain. The `:3000` is the port
   inside the container, not the public port. Traefik handles TLS (Let's Encrypt) and compression.
5. Enter nothing under Environment Variables: Coolify generates `SERVICE_USER_POSTGRES` and `SERVICE_PASSWORD_POSTGRES`
   itself on the first deploy. If they do not appear there, set both by hand (password only
   letters and digits, it is part of a URL).
6. **Deploy**. Then check: `https://forge.vanturis.de/api/health` returns `ok`.
7. Auto deploy: with the GitHub App, Coolify rebuilds on every push. With **Watch Paths** `services/stats/**`
   only when the service changes.

Until 2026-10-18 the service ran at `forge-stats.vanturis.de`, and FORGE up to 0.1.103 reports there. Keep that
domain as a second one on the service (Coolify: both, comma separated; HAProxy: a certificate for both) until
those versions are gone.

The image runs as user `nextjs` (not root) and starts the Next standalone output with
`node server.js`. It includes a `HEALTHCHECK` on `/api/health`.

It also works without Compose: Postgres as a separate Coolify resource, the application with Build Pack **Dockerfile**,
Base Directory `/services/stats`, port `3000`, `DATABASE_URL` set to the internal URL of the database.

The image runs as user `nextjs` (not root) and starts the Next standalone output with `node server.js`.

## Running locally

```sh
cd services/stats
pnpm install --ignore-workspace
DATABASE_URL=postgres://user:pass@127.0.0.1:5432/forge_stats pnpm dev
```

The page then runs at http://localhost:3000. A test report:

```sh
curl -i -X POST http://localhost:3000/api/v1/report \
  -H 'Content-Type: application/json' \
  -d '{"schema":1,"installId":"00000000-0000-4000-8000-000000000001","appVersion":"0.1.80","os":"Windows","counters":{"sessions":1}}'
curl http://localhost:3000/api/v1/totals
```

More commands:

```sh
pnpm test             # unit tests (vitest, without a database)
STATS_TEST_DATABASE_URL=postgres://... pnpm test   # plus the history calculation against a real Postgres
pnpm exec tsc --noEmit
pnpm build            # standalone output in .next/standalone
```

Docker locally:

```sh
docker build -t forge-stats services/stats
docker run --rm -p 3000:3000 -e DATABASE_URL=postgres://... forge-stats
```
