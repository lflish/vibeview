# vibeview user guide

[← README.en.md](../README.en.md) · [简体中文](user-guide.zh-CN.md)

The service is named **vibeview**; its CLI is **`dview`**. Supported formats include HTML, PNG / JPG / GIF / WebP / SVG and other images, and MP4 / WebM videos. HTML descriptions use the uploaded `description` first, then fall back to `<meta name="description">`, `<title>`, or a heading. The default per-file limit is 50 MB, with indefinite retention.

## Quick start

### 1. Install and configure

Use **Node.js 22** and npm, matching the project's render image. The upload CLI needs Bash, curl, and either Python 3 or Node.js; the Skill upload script requires Python 3. Docker is only needed for the sidecar.

```bash
git clone https://github.com/lflish/vibeview.git
cd vibeview
npm ci
cp config.example.yaml config.yaml
```

Edit `config.yaml` and set at least these fields:

| Field | Value for local use |
| --- | --- |
| `server.base_url` | `http://localhost:3000`; use your actual HTTPS URL in production |
| `tokens[].name` | A unique upload source name, such as `my-machine` |
| `tokens[].token` | Your own randomly generated upload token |
| `admin.user` / `admin.password` | Your administrator username and password |
| `admin.session_secret` | Your own randomly generated session signing secret |

Run `openssl rand -hex 24` separately to generate the token and session secret. `config.yaml` is ignored by Git; keep its credentials out of the repository.

### 2. Start the service

```bash
npm start
```

Open [http://localhost:3000/admin](http://localhost:3000/admin) and sign in with the configured administrator credentials. Check health with:

```bash
curl -fsS http://localhost:3000/healthz
```

### 3. Upload a file

Configure upload credentials in another terminal:

```bash
export DVIEW_URL="http://localhost:3000"
export DVIEW_TOKEN="your-upload-token"

bash bin/dview upload /path/to/report.html --json
```

Example response; use the code and expiration returned by your actual upload:

```json
{
  "url": "http://localhost:3000/v/Ab3xK9mP2qR7sT1v",
  "id": "Ab3xK9mP2qR7sT1v",
  "source": "my-machine",
  "description": "Quarterly report",
  "access": {
    "required": true,
    "configured": true,
    "expiresAt": "2026-10-19T12:00:00.000Z",
    "expired": false
  },
  "accessCode": "G7mK9pRX4aQ2"
}
```

Open `url` and enter `accessCode` to view the preview. **Save the code and expiration; preferably share the code separately from the URL.** The server stores only the code's hash. A forgotten code must be reset; it cannot be retrieved.

## Upload and share

### CLI

Use `bash bin/dview` inside the repository, or run `npm link` to register `dview`. The CLI is distributed through this repository or the installer; it has not been published to the npm registry.

```bash
dview upload ./report.html --json                 # URL, access code, expiration
dview upload ./report.html --json --access-days 1 # Code valid for 1 day
dview upload ./public.html --public               # Explicitly allow public access
dview list                                       # This account's resources
dview me                                         # Account usage and settings
dview delete Ab3xK9mP2qR7sT1v                      # Delete this account's resource
```

Without `--json`, an upload prints the URL to stdout and the access code to stderr. **AI tools, scripts, and CI should use `--json` and retain `url`, `accessCode`, and `access.expiresAt`.** Do not embed access codes in URLs or generated HTML.

### curl

```bash
curl -fsS -X POST "${DVIEW_URL%/}/upload" \
  -H "Authorization: Bearer $DVIEW_TOKEN" \
  -F "file=@./report.html" \
  --form-string "description=Quarterly report and key metrics"
```

Optional form fields: `access_days=7` sets the code's validity in days; `access_mode=public` explicitly allows public access. Omitted fields use the server defaults.

### AI Skills and integrations

- **Claude Code**: run `bash install-skill.sh --url "$DVIEW_URL" --token "$DVIEW_TOKEN"` to install the upload Skill, `/dview` command, and CLI. By default, the installer writes environment variables to your shell configuration.
- **Codex / Cursor / other agents**: use [AGENTS.md](../AGENTS.md) and the [upload Skill](../skill/dview-upload/SKILL.md). After generating a file, run the CLI or `bash skill/dview-upload/upload.sh <file> --json`. The repository's installer targets Claude directories by default; install Skills for other tools according to their directory conventions.
- **Generated pages**: the upload Skill defaults to a light theme. Uploading an existing file preserves its appearance.
- **GitHub Actions**: see the [workflow example](../examples/github-actions/upload-preview.yml) and configure the `DVIEW_URL` and `DVIEW_TOKEN` secrets. The example currently comments only the URL; protected previews also require saving the returned access code and choosing an appropriate way to share it.

## Manage previews

At `/admin`, you can:

- View filenames, descriptions, sources, sizes, creation dates, resource ages, and access status.
- Search filenames, descriptions, sources, or IDs; filter by type / source, sort, and paginate.
- Copy preview URLs, delete individual resources, or bulk-delete selected resources on the current page.
- Generate or reset codes under access protection, change expiration, choose no expiration, or allow public access.
- Inspect account usage and quotas, disable / enable accounts, and switch the admin theme.

Upload accounts are maintained in `config.yaml` under `tokens`. The admin UI does not currently create accounts or rotate upload tokens. Restart the main service after changing configuration.

### Admin login protection

Admin login and preview access codes use separate counters. Defaults are 10 failures per client per 10 minutes and a shared cap of 100 failures to bound distributed guesses across IPs. Exceeding either limit returns `429` with `Retry-After`; the login page shows a cooldown countdown. State is stored in a file with mode `600`, containing hashed client IP keys, never usernames, passwords, or upload tokens. Limits survive restarts and expire after the window. Successful login clears that client's failures while retaining shared failures.

| Field | Default |
| --- | --- |
| `admin.login_max_attempts` | `10`, failures per client |
| `admin.login_global_max_attempts` | `100`, shared failures across clients |
| `admin.login_retry_window_minutes` | `10`, counter / cooldown window |
| `admin.login_attempts_file` | `./data/admin-login-attempts.json` |
| `server.trust_proxy` | `loopback`, trust only local reverse proxies |

The reverse proxy must correctly overwrite or append the actual client address, such as local Nginx using `X-Forwarded-For $proxy_add_x_forwarded_for`. Configure explicit IPs / CIDRs for other proxies; direct deployments can set `server.trust_proxy: false`. Do not blindly set this to `true` and trust arbitrary client IP headers.

Reaching the shared cap temporarily blocks all new administrator logins; existing sessions remain usable. One main-service process owns the counters. Multiple processes require shared atomic counter storage.

## Admin statistics

Open `/admin/statistics` using the statistics link in resource management. The page includes today's uploads, the last 7 / 30 days or current month, current file count and storage, daily trends, a calendar, type/source breakdowns, and recent upload/deletion activity. Source and type filters apply across the page; select a chart bar or calendar date to inspect paginated daily records.

- **Uploads and current inventory are distinct**: a successful upload is counted once. Deleting its file preserves upload history while reducing current count and storage. Access-code changes do not create upload events.
- **Date ranges** affect upload totals, trends, breakdowns, and activity. Current inventory ignores the date range. The calendar uses its displayed month and shares source/type filters.
- **Historical coverage**: first startup backfills existing files using their creation times. Previously deleted files cannot be reconstructed. The page shows the capture start time, incomplete-history notice, and skipped invalid metadata count. Empty days show zero; future dates cannot be selected.
- **Deletion events** distinguish administrator deletion, upload-account deletion, and retention cleanup. Deleted filenames are hidden in statistics. Event logs never store original filenames, descriptions, file content, passwords, upload tokens, or access codes.
- **Access**: statistics pages and APIs require an authenticated administrator session. Upload tokens do not grant access. Light, dark, and system themes share the existing admin preference.

```yaml
statistics:
  timezone: "Asia/Shanghai"
  directory: "./data/statistics"
```

`timezone` accepts valid IANA time zones and defaults to Beijing time. Grouping is independent of browser/OS time zones and accounts for daylight saving time. Relative paths resolve from the configuration directory; when omitted, the statistics directory is created next to `storage.meta_dir`.

Back up the statistics journal together with resource metadata. It is persistent history, unlike the rebuildable `resources.sqlite` index. Preserve it during code sync, rollback, and resource cleanup. One main-service process owns the in-memory cache. Manual data edits or running an older version that does not record events can introduce coverage gaps; restarting can only backfill surviving files. Durable intents recover interrupted uploads/deletions. Invalid journals produce explicit errors; do not clear them to bypass recovery. See the [statistics specification (Chinese)](specs/admin-statistics.md).

### Statistics API

- `GET /admin/api/statistics?range=30&month=2026-10&source=&type=`: `range` is `7`, `30`, or `month`. Explicit `from` / `to` dates (`YYYY-MM-DD`, inclusive, at most 366 days) take precedence. `month` selects the calendar month and defaults to the current month; future dates are rejected. `source` is an upload source and `type` is `html`, `image`, or `video`.
- The response contains `timezone`, `asOf`, `today`, `filters`, `coverage`, `summary`, `daily`, `calendar`, `types`, `sources`, `availableSources`, `activities`, and `deletionActivities`. `coverage.startedAt` marks the capture start; `completeFromDate` is the following local date. `periodComplete` means the range is in the complete capture period and contains no backfilled uploads.
- `GET /admin/api/statistics/day?date=2026-10-12&page=1&pageSize=20`: accepts the same source/type filters, with `pageSize` capped at 100. Returns `count`, `bytes`, `retainedCount`, `items`, and pagination. Deleted items have `retained: false` and `filename: null`.

Both endpoints require an administrator session and return `Cache-Control: no-store`. Unauthenticated requests, including upload-token-only requests, receive 401; invalid dates, filters, or pagination receive 400.

## Access protection and retention

These three settings serve different purposes:

| Setting / credential | Purpose | Default behavior |
| --- | --- | --- |
| Upload token | Lets a machine or user upload and manage its account's files | Must be configured on the server |
| Preview access code | Lets a visitor view one preview and its original file | Randomly generated for new uploads, valid for 7 days |
| File retention | Controls automatic file deletion | `storage.retention_days: 0`, keep indefinitely |

An expired code blocks access; it **does not delete the file**. Historical previews are protected by default too; generate a code in the admin UI or explicitly make them public. Resetting a code or changing protection settings revokes existing preview grants. Restarting the main service also revokes granted preview cookies, while the access codes remain valid.

Each preview allows **10 failed attempts per 10 minutes** by default, then returns `429` with `Retry-After`. Failed attempts are counted across IP addresses and persisted; restarting cannot clear the limit. Access becomes available after the cooldown. Continued guessing can temporarily block all visitors to that preview. The current limiter is maintained by a single main-service process.

For personal use, configure one upload token and omit `max_files` and `max_storage_mb`. Account quotas are optional local file-count / storage limits; they are unrelated to paid accounts or external AI-service credits.

See [config.example.yaml](../config.example.yaml) for the full configuration. Common settings:

| Field | Default / meaning |
| --- | --- |
| `server.port` / `server.base_url` | `3000` / public preview URL |
| `storage.max_size_mb` | `50`, maximum size per file |
| `storage.retention_days` | `0`; a positive value automatically deletes files older than that many days |
| `tokens[].max_files` / `max_storage_mb` | No account quota when omitted |
| `tokens[].retention_days` | Overrides global retention; `0` keeps files indefinitely |
| `access.default_required` / `protect_legacy` | `true` / `true`, protect new and historical files |
| `access.default_days` / `grant_minutes` | `7` days / `30` minutes of preview authorization |
| `access.max_attempts` / `retry_window_minutes` | `10` attempts / `10` minutes |
| `access.attempts_file` | `./data/preview-attempts.json`, persistent failed-attempt counters |
| `preview.proxy_to_render` / `render_url` | `false` / `http://127.0.0.1:3001` |

Configuration is read from `config.yaml` in the repository root. Set `DVIEW_CONFIG_PATH` (or `CONFIG_PATH`) to use another file. Relative storage paths are resolved against the **configuration file's directory**. When automatic deletion is enabled, cleanup runs at startup and every 6 hours afterward. Changing retention cannot restore deleted files.

## Deployment

### Main service

The main service handles uploads, access verification, administration, accounts, and cleanup. Run it under a process manager such as PM2 or systemd. Public deployments need a reverse proxy and HTTPS; set `server.base_url` to the actual domain.

Back up `config.yaml`, uploaded data, and restricted environment files. JSON metadata is the authoritative resource record; `data/resources.sqlite` is a rebuildable query index. Keep configured tokens, passwords, and session secrets private. Give upload credentials only to machines or users that need to upload.

### Docker render sidecar

The sidecar renders previews while the main service stays on the host. It mounts `./data` read-only and does not mount `config.yaml`. Protected previews reach the sidecar only after verification by the main service.

Stop the running main service, then execute these commands in the same terminal:

```bash
mkdir -p data/html data/images data/videos data/meta
export DVIEW_RENDER_GATEWAY_TOKEN="$(openssl rand -hex 32)"

RENDER_HOST_PORT=3001 docker compose up -d --build render
curl -fsS http://127.0.0.1:3001/healthz

DVIEW_PREVIEW_PROXY=true \
DVIEW_RENDER_URL=http://127.0.0.1:3001 \
npm start
```

The main service and Compose must use **the same** gateway secret. For production, store it in restricted environment configuration so both services retain the same value after restarts. The main service can also use `preview.gateway_token`; Compose reads `DVIEW_RENDER_GATEWAY_TOKEN`. Keep this secret out of the repository.

If the port is occupied, change `RENDER_HOST_PORT` and the main service's `preview.render_url` or `DVIEW_RENDER_URL` together. The sidecar port binds only to loopback. A sidecar failure causes preview errors without silently falling back to rendering in the main service. When using the sidecar, the main service's storage directories must match the mounted `./data` tree.

[Sidecar design](../docs/design-render-sidecar.md) · [This project's TX deployment Skill](../.agents/skills/deploy-tx/SKILL.md)

### Browser behavior of HTML

Upload only trusted content. Protected HTML uses `sandbox allow-scripts` to isolate same-origin privileges. Scripts can run, but browser storage and same-origin requests may be unavailable; pages relying on those features need adaptation. Explicitly public HTML does not receive that isolation. The Docker sidecar provides server-process isolation, which does not replace browser isolation.

For `NET::ERR_CERT_DATE_INVALID`, check the validity of the certificate actually served to visitors. After renewal, install the certificate and reload the reverse proxy. The [Nginx certificate helper](../scripts/install-nginx-cert.sh) requires target paths matching your deployment and administrator sudo privileges.

## API

| Method and path | Authentication | Purpose |
| --- | --- | --- |
| `POST /upload` | Bearer upload token | Upload a file; return its URL, access status, and new access code |
| `GET /api/me` | Bearer upload token | Account information, usage, and quotas |
| `GET /api/me/items` | Bearer upload token | List this account's resources |
| `DELETE /api/me/items/:id` | Bearer upload token | Delete this account's resource |
| `PATCH /api/me/items/:id/access` | Bearer upload token | Change protection for this account's resource |
| `GET /v/:id` | Public, or a verified preview cookie | Show the preview; show the code form when unauthorized |
| `POST /v/:id/unlock` | Form field `code` | Verify a code and set a preview cookie |
| `GET /v/:id/raw` | Same as the preview | Retrieve the original file; supports Range requests |
| `GET /admin/api/statistics` | Admin session | Summary, trends, calendar, breakdowns, and activity |
| `GET /admin/api/statistics/day` | Admin session | Paginated upload events for one day |
| `GET /admin/api/list` | Administrator session | Pagination, search, filtering, sorting |
| `PATCH /admin/api/item/:id/access` | Administrator session | Generate / reset / change access protection |
| `DELETE /admin/api/item/:id` | Administrator session | Delete a resource |
| `DELETE /admin/api/items` | Administrator session | Bulk deletion; JSON `{"ids":["id1","id2"]}`, up to 100 items |
| `GET /admin/api/accounts` | Administrator session | Accounts and usage |
| `POST /admin/api/accounts/:name/disable` or `/enable` | Administrator session | Disable or enable an account |
| `GET /healthz` | None | Shallow health check for the main service or sidecar |

Access-protection PATCH bodies use `mode: "code"` or `"public"`, `expiresAt` (an ISO timestamp, or `null` for no expiration), and `reset: true` to generate a new code. New codes are returned only when generated; listings expose neither codes nor hashes.

The admin list accepts `page`, `pageSize` (maximum 100), `q`, `type`, `source`, `sort=time|name|size|type|source`, and `order=asc|desc`. Responses contain `items`, `total`, `page`, `pageSize`, `totalPages`, and `sources`.

## Development and tests

```bash
npm test                          # Retention, descriptions, index, upload/admin smoke
npm run test:statistics            # Statistics, durable recovery, and APIs
npm run test:admin-login           # Admin brute-force protection and proxy IP handling
npm run test:access                # Access protection, retry limits, sidecar bypass prevention
npm run smoke:render               # Render tests; adds a real container check when Docker is available

# These require Playwright and Chromium in the environment
npm run test:admin
npm run test:theme
npm run test:access -- --browser
npm run test:admin-login -- --browser
npm run test:statistics -- --browser
```

Tests use temporary configuration and data rather than existing resources. Use `SMOKE_SKIP_RENDER=1 npm test` to skip the render checks in the default suite. Browser-test dependencies must be provided separately.

```text
server.js            Main service: upload, verification, admin, account APIs
render-server.js     Optional render sidecar
lib/                 Storage, index, protection, cleanup, preview logic
views/               Admin/login pages and themes
bin/dview            Upload / management CLI
skill/ + command/    Upload Skill and Claude command
.agents/skills/      This project's TX deployment Skill
scripts/             Regression tests and deployment helpers
```

## Scope and contributions

The current scope is one administrator, local file storage, and a single main-service process. It does not include multi-admin RBAC, token creation / rotation in the admin UI, object-storage backends, or a fully containerized main service.

Issues and PRs are welcome. For bug reports, include your Node.js version, deployment mode, reproduction steps, and redacted logs. When changing defaults, update both READMEs, configuration examples, and relevant tests together.

- [Full configuration](../config.example.yaml)
- [Agent instructions](../AGENTS.md) · [Upload Skill](../skill/dview-upload/SKILL.md)
- [Sidecar design](../docs/design-render-sidecar.md) · [TX deployment Skill](../.agents/skills/deploy-tx/SKILL.md)
- [Requirements and design notes](../docs/SPEC.md)
