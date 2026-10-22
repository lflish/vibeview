# vibeview user guide

[← README](../README.md) · [简体中文](user-guide.zh-CN.md)

The service is named **vibeview**; its CLI is **`dview`**. Supported formats include HTML, PNG / JPG / GIF / WebP / SVG and other images, MP4 / WebM videos, and multi-page sites (a directory or zip). HTML descriptions use the uploaded `description` first, then fall back to `<meta name="description">`, `<title>`, or a heading. The default per-file limit is 50 MB, with indefinite retention.

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

Open `url` and enter `accessCode` to view the preview. **Save the code and expiration; preferably share the code separately from the URL.** The server verifies codes by hash and keeps an encrypted copy so administrators can view them in the admin UI; the upload-token API returns a code only when it is generated.

## Upload and share

### CLI

Use `bash bin/dview` inside the repository, or run `npm link` to register `dview` (and the equivalent alias `vibeview`). The CLI is distributed through this repository or the installer; it has not been published to the npm registry.

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

Optional form fields: `access_days=7` sets the code's validity in days; `access_mode=public` explicitly allows public access. Omitted fields use the server defaults. Classification fields are covered in the next section.

### Multi-page sites

Content that does not fit in one HTML file (a prototype whose pages link to each other, a demo with images and data files, or a front-end `dist/` build) can be uploaded as a **site**: the whole directory is one resource with one link and one access code.

```bash
dview upload ./dist --json                 # The CLI zips the directory
curl -fsS -X POST "${DVIEW_URL%/}/upload" \
  -H "Authorization: Bearer $DVIEW_TOKEN" \
  -F "file=@./site.zip"                    # Or upload a zip directly
```

- The entry point is `index.html` at the root. If the zip holds a single top-level directory (for example, you zipped `dist/` itself), that level is removed.
- The preview URL is `/v/<id>/`; pages and assets live at `/v/<id>/about.html`, `/v/<id>/assets/app.js`. Links inside the site must be **relative**: paths starting with `/` point at the server root and return 404. For Vite, set `base: './'`; other build tools have an equivalent setting.
- Directory requests return their `index.html`. Missing files return the site's `404.html` if it has one. Use hash routing for single-page apps.
- The CLI and Skill skip files and directories starting with `.` (such as `.env` and `.git`), `node_modules`, and symlinks when packing. The server also skips `__MACOSX` and rejects paths that escape the directory, symlinks, encrypted entries, path segments starting with `~`, and file types outside the allowlist: html, css, js, mjs, json, map, txt, md, xml, csv, tsv, webmanifest, common images, mp4/webm, mp3/wav/ogg/m4a, woff/woff2/ttf/otf/eot, wasm, glb/gltf/bin, and pdf.
- Limits: the zip itself counts against `storage.max_size_mb`; a site may hold at most `storage.site_max_files` files (default 500) and `storage.site_max_unpacked_mb` MB once unpacked (default 50), measured on the bytes actually unpacked. Quotas use the unpacked size.
- The upload response also includes `type: "site"`, `fileCount`, and `size` (unpacked bytes). The admin UI labels it as a site and shows the file count.

**Access protection:** a visitor enters the access code once, on any page, and can then browse the whole site; after verification they return to the page they opened. Site pages run in a browser sandbox, where subrequests for styles, module scripts, and `fetch` carry no cookies. So after verification the visitor is redirected to a URL with a short-lived credential, `/v/<id>/~<credential>/...`, which relative links inside the site carry automatically. The credential is bound to the site and the current access-code version and expires with the preview grant (30 minutes by default). Resetting the code, changing its validity, or restarting the main service revokes it, and visitors must verify again. Because the credential is visible in the address bar, share the URL returned by the upload rather than the one in the browser.

### Updates and versions

Pages that change over time, such as requirements and prototypes, can keep one link: each update creates a new version, the link and access code stay the same, and the link you already shared always opens the latest content.

```bash
dview upload docs/prd/login.html                              # First time: creates it and writes .dview.json
dview upload docs/prd/login.html -m "Add error messages"     # Same path again: updates the link as version 2
dview upload ./dist --id Ab3xK9mP2qR7sT1v -m "Fix styles"    # Update a specific resource
dview versions Ab3xK9mP2qR7sT1v                               # List versions
```

- **`.dview.json`**: inside a git repository, the CLI records "file path (relative to the repository root) → resource id" in `.dview.json` at the root, and later uploads of the same path update that resource. Commit it so other machines and agents update the same link. Files outside the repository and files ignored by `.gitignore` are not recorded. `--new` forces a new resource and rewrites the mapping; `--no-map` neither reads nor writes it. If the mapped resource was deleted or belongs to another account, the CLI stops with an error instead of creating a new one.
- **Notes and commits**: `-m` describes the change. Inside a git repository the current commit is recorded, and the version is flagged when the uploaded file has uncommitted changes.
- **History**: version n is at `/v/<id>/@<n>` (`/v/<id>/@<n>/` for sites) and opens with the same access code. A site cannot have a top-level directory named `@<number>`.
- **Retention and quota**: each resource keeps at most `versions.max_per_resource` versions (default 50); the oldest are removed first, and version 1 and the current version are always kept. The resource size and the account's storage quota count all kept versions; updates do not count toward the file limit. With `storage.retention_days`, age is measured from the last update.
- **What stays the same**: the access code, category, project, and tags carry over; only fields present in the request override them. A description taken from the page title follows the new version; one set by hand is kept.
- **Same type only**: HTML updates HTML, a site updates a site, and only resources of your own account can be updated.
- The admin UI shows the version next to the name (such as `v3`); "⋯ → Version history" opens or deletes past versions.

With curl, add an `id` field and optionally `message`:

```bash
curl -fsS -X POST "${DVIEW_URL%/}/upload" -H "Authorization: Bearer $DVIEW_TOKEN" \
  -F "id=Ab3xK9mP2qR7sT1v" -F "message=Add error messages" -F "file=@./login.html"
```

### Categories, projects, and tags

Each resource can record what kind of page it is, which project it belongs to, and which agent produced it, so large collections stay easy to filter:

| Field | Meaning |
| --- | --- |
| `category` | Page purpose from a fixed list: `doc`, `report`, `dashboard`, `prototype`, `game`, `slides`, `tool`, `demo`, `screenshot`, `other`. Unknown values become `other`; omitted means uncategorized |
| `project` | Owning project; the CLI defaults to the directory name of the git repository containing the file or the current directory |
| `agent` / `model` | The agent and model that produced the file; the CLI detects the agent from `AI_AGENT`, `CLAUDECODE`, and similar variables |
| `tags` | Free tags, comma-separated or repeated, up to 8 |

```bash
dview upload ./snake.html --json --category game --tag h5,canvas --model claude-opus-5-5
dview list --category report --project vibeview   # filter by category / project / --tag
dview edit Ab3xK9mP2qR7sT1v --category doc --tag onboarding
dview edit Ab3xK9mP2qR7sT1v --tag ''               # clear tags
```

`DVIEW_AGENT`, `DVIEW_MODEL`, and `DVIEW_PROJECT` set defaults; `--no-detect` disables detection. curl uploads use form fields with the same names. HTML pages may also declare `<meta name="dview:category" content="game">`, `dview:tags`, and so on as a fallback for fields not sent. Values are normalized to lowercase, hyphenated form.

These fields are self-reported by the uploader. They organize and filter resources and never grant access; the trusted upload identity remains the source (the token's account). Edit them later in the admin UI or with `dview edit`.

### AI Skills and integrations

- **Claude Code**: run `bash install-skill.sh --url "$DVIEW_URL" --token "$DVIEW_TOKEN"` to install the upload Skill, `/dview` command, and CLI. By default, the installer writes environment variables to your shell configuration.
- **Codex / Cursor / other agents**: use [AGENTS.md](../AGENTS.md) and the [upload Skill](../skill/dview-upload/SKILL.md). After generating a file, run the CLI or `bash skill/dview-upload/upload.sh <file> --json`. The repository's installer targets Claude directories by default; install Skills for other tools according to their directory conventions.
- **Generated pages**: the upload Skill defaults to a light theme. Uploading an existing file preserves its appearance.
- **GitHub Actions**: see the [workflow example](../examples/github-actions/upload-preview.yml) and configure the `DVIEW_URL` and `DVIEW_TOKEN` secrets. The example currently comments only the URL; protected previews also require saving the returned access code and choosing an appropriate way to share it.

## Manage previews

At `/admin`, you can:

- View filenames, descriptions, sources, sizes, creation dates, and resource ages; the Access column shows protection status and remaining validity.
- See each row's category, project, agent / model, and tags; click one to show only matching resources, or click **未分类** to classify an item.
- Select several rows to set category and project, append tags, or delete from the bottom action bar.
- On narrow screens, resources show as cards and filters fold behind a **筛选** button.
- Search filenames, descriptions, projects, tags, or IDs; filter by type / source / category / project / agent / tag (each option shows its count), sort, and paginate.
- Use **复制分享** to copy the page description (or filename), URL, access code, and expiration as ready-to-send text; the **⋯** menu copies the URL only, opens access settings, edits classification, or deletes.
- View or copy codes in the Access column; generate or reset codes in access settings, change expiration, choose no expiration, or allow public access. Codes created before this feature cannot be viewed until reset.
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
- **Projects**: projects are self-reported by uploaders (defaulting to the git repository name). Statistics can be filtered by project and list uploads, current files, and opens per project. Retained resources use their current project; deleted ones keep the project they had at upload. The project bar in resource management switches between projects like folders.

### Access statistics

The "访问情况" (access) section of the statistics page and the "打开" (opens) column in resource management show how preview links are used:

- **Opens**: each visitor load of a preview page (`GET /v/:id`) counts once. Raw file requests (`/raw`) do not count. Previews by a signed-in administrator and link-preview crawlers or script clients (such as Slackbot or curl) are counted separately and excluded from opens.
- **Access-code checks**: challenge pages shown, successful and failed unlocks, rate-limited attempts, and visits to expired links are counted separately, showing whether codes were shared, whether someone is guessing, and which links need renewing.
- **Never opened**: resource management filters by "never opened / not opened in 30 days / opened in the last 7 days" and sorts by opens or most recent open, which helps with cleanup.
- **Access-code status**: counts of active, expiring within 3 days, expired, unconfigured, and public resources, independent of the date range.
- **Privacy**: only per-resource daily counts and first/last open times are stored; no IPs, user agents, or individual visits. Counts accumulate in memory and are written to `visits.sqlite` under `statistics.directory` every 30 seconds and on graceful shutdown; killing the process may lose up to 30 seconds of counts. Daily rows are kept for 400 days.
- Access statistics start when the new version first runs; earlier visits cannot be recovered. Resources uploaded before then and not opened since show "暂无记录" (no record) rather than "never opened". They require Node.js built-in SQLite; when it is unavailable the page says so and upload statistics are unaffected.

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
- `GET /admin/api/statistics/visits?from=2026-09-19&to=2026-10-18&project=&source=&type=`: access statistics. `project=-` selects resources without a project (the upload statistics API accepts `project` too). Returns `totals` (`views`, `admin_views`, `bots`, `challenges`, `unlock_ok`, `unlock_fail`, `rate_limited`, `expired_hits`), `daily`, `top`, `projects`, `neverViewed`, `viewedInRange`, `current`, `accessStatus`, and `startedAt`.

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
| `storage.max_size_mb` | `50`, maximum size per uploaded file; for sites, the zip size |
| `storage.site_max_files` / `site_max_unpacked_mb` | `500` / `50`, maximum files and unpacked size per site |
| `storage.site_dir` | `./data/sites`, where sites are unpacked |
| `storage.retention_days` | `0`; a positive value automatically deletes files older than that many days |
| `tokens[].max_files` / `max_storage_mb` | No account quota when omitted |
| `tokens[].retention_days` | Overrides global retention; `0` keeps files indefinitely |
| `access.default_required` / `protect_legacy` | `true` / `true`, protect new and historical files |
| `access.default_days` / `grant_minutes` | `7` days / `30` minutes of preview authorization |
| `access.max_attempts` / `retry_window_minutes` | `10` attempts / `10` minutes |
| `access.attempts_file` | `./data/preview-attempts.json`, persistent failed-attempt counters |
| `access.code_secret` | Defaults to `admin.session_secret`; key for the encrypted code copies. After changing it, existing codes still verify but must be reset to become viewable. `DVIEW_ACCESS_CODE_SECRET` also works |
| `preview.proxy_to_render` / `render_url` | `false` / `http://127.0.0.1:3001` |

Configuration is read from `config.yaml` in the repository root. Set `DVIEW_CONFIG_PATH` (or `CONFIG_PATH`) to use another file. Relative storage paths are resolved against the **configuration file's directory**. When automatic deletion is enabled, cleanup runs at startup and every 6 hours afterward. Changing retention cannot restore deleted files.

## Deployment

### Main service

The main service handles uploads, access verification, administration, accounts, and cleanup. Run it under a process manager such as PM2 or systemd. Public deployments need a reverse proxy and HTTPS; set `server.base_url` to the actual domain. Behind nginx or another reverse proxy, set `server.host: 127.0.0.1` and `server.trust_proxy: loopback` so the main service accepts only local proxy connections and nobody can bypass HTTPS by connecting to its port directly.

Back up `config.yaml`, uploaded data, and restricted environment files. JSON metadata is the authoritative resource record; `data/resources.sqlite` is a rebuildable query index. Keep configured tokens, passwords, and session secrets private. Give upload credentials only to machines or users that need to upload.

#### Data backups

`npm run backup` (`node scripts/backup.js`) packs uploaded files, metadata, the statistics directory, account and rate-limit state files, and `config.yaml` into one `auto-<time>.tar.gz`. It defaults to `data/backups/` (mode 700) and keeps the latest 14 automatic backups without touching manual ones. It is safe to run while the service is up: statistics events are atomically written single files, and `visits.sqlite` is snapshotted consistently first. Visit counts still in memory (at most 30 seconds) are not included.

| Option | Meaning |
| :--- | :--- |
| `--dest DIR` | Backup directory |
| `--keep N` | Keep the latest N automatic backups; `0` disables pruning |
| `--no-config` | Leave out `config.yaml` (it contains tokens and the admin password) |

For a daily backup with systemd, set the repository path in both files under [examples/systemd](../examples/systemd/), copy them to `~/.config/systemd/user/`, then run `systemctl --user daemon-reload && systemctl --user enable --now vibeview-backup.timer`. User services need `loginctl enable-linger` to run while logged out. PM2 deployments can use crontab instead, e.g. `30 3 * * * cd /path/to/vibeview && node scripts/backup.js`. Backups sit on the same disk as the data, so copy important ones to another machine regularly.

To restore: stop the main service, extract the backup to a temporary directory, move each directory and file back to the original path recorded in the archive's `manifest.json`, then start the service. `resources.sqlite` is not backed up; it is rebuilt on startup.

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

[Sidecar design](../docs/design-render-sidecar.md) · [Deployment Skill](../.agents/skills/deploy-view/SKILL.md)

### Browser behavior of HTML

Upload only trusted content. Every HTML preview and multi-page site, including explicitly public ones, uses `sandbox allow-scripts` to isolate same-origin privileges, so page scripts cannot call admin APIs with an administrator's session. Scripts can run, but browser storage and same-origin requests are unavailable; pages relying on those features need adaptation. The Docker sidecar provides server-process isolation, which does not replace browser isolation.

For `NET::ERR_CERT_DATE_INVALID`, check the validity of the certificate actually served to visitors. After renewal, install the certificate and reload the reverse proxy. The [Nginx certificate helper](../scripts/install-nginx-cert.sh) requires target paths matching your deployment and administrator sudo privileges.

## API

| Method and path | Authentication | Purpose |
| --- | --- | --- |
| `POST /upload` | Bearer upload token | Upload a file or site zip; return its URL, access status, and new access code |
| `GET /api/me` | Bearer upload token | Account information, usage, and quotas |
| `GET /api/me/items` | Bearer upload token | List this account's resources |
| `DELETE /api/me/items/:id` | Bearer upload token | Delete this account's resource |
| `PATCH /api/me/items/:id/access` | Bearer upload token | Change protection for this account's resource |
| `PATCH /api/me/items/:id/meta` | Bearer upload token | Change category, project, agent, model, tags, or description of this account's resource |
| `GET /api/me/items/:id/versions` | Bearer upload token | List versions of this account's resource |
| `DELETE /api/me/items/:id/versions/:n` | Bearer upload token | Delete a past version (version 1 and the current version cannot be deleted) |
| `GET /v/:id` | Public, or a verified preview cookie | Show the preview; show the code form when unauthorized |
| `POST /v/:id/unlock` | Form field `code` | Verify a code and set a preview cookie |
| `GET /v/:id/raw` | Same as the preview | Retrieve the original file; supports Range requests |
| `GET /v/:id/@:n`, `/v/:id/@:n/raw`, `/v/:id/@:n/<path>` | Same as the preview | Page, original file, or site content of version n |
| `GET /v/:id/<path>` | Public sites directly; protected sites via `/v/:id/~<credential>/<path>` | Pages and assets of a multi-page site; unverified pages show the access-code form |
| `GET /admin/api/statistics` | Admin session | Summary, trends, calendar, breakdowns, and activity |
| `GET /admin/api/statistics/day` | Admin session | Paginated upload events for one day |
| `GET /admin/api/statistics/visits` | Admin session | Opens, access-code checks, top resources, per-project breakdown, and access-code status |
| `GET /admin/api/list` | Administrator session | Pagination, search, filtering, sorting |
| `PATCH /admin/api/item/:id/access` | Administrator session | Generate / reset / change access protection |
| `GET /admin/api/item/:id/access-code` | Administrator session | Read the current code; `409` when public or not readable |
| `PATCH /admin/api/item/:id/meta` | Administrator session | Change category, project, agent, model, tags, or description |
| `PATCH /admin/api/items/meta` | Administrator session | Bulk relabel with `{"ids":[...],"category":"report","project":"x","addTags":"q3"}`, up to 100 items; omitted fields stay unchanged and tags are appended |
| `GET /admin/api/item/:id/versions` | Administrator session | List versions |
| `DELETE /admin/api/item/:id/versions/:n` | Administrator session | Delete a past version |
| `DELETE /admin/api/item/:id` | Administrator session | Delete a resource and all its versions |
| `DELETE /admin/api/items` | Administrator session | Bulk deletion; JSON `{"ids":["id1","id2"]}`, up to 100 items |
| `GET /admin/api/accounts` | Administrator session | Accounts and usage |
| `POST /admin/api/accounts/:name/disable` or `/enable` | Administrator session | Disable or enable an account |
| `GET /healthz` | None | Shallow health check for the main service or sidecar |

Access-protection PATCH bodies use `mode: "code"` or `"public"`, `expiresAt` (an ISO timestamp, or `null` for no expiration), and `reset: true` to generate a new code. Listings expose neither codes nor hashes; administrators read a code on demand through the `access-code` endpoint, served with `no-store`.

The admin list accepts `page`, `pageSize` (maximum 100), `q`, `type`, `source`, `category` (`none` for uncategorized), `project`, `agent`, `tag`, `sort=time|name|size|type|source|category|project|agent`, and `order=asc|desc`. Responses contain `items`, `total`, `page`, `pageSize`, `totalPages`, `sources`, `categories` (allowed values), and `facets` (values and counts per classification field). `GET /api/me/items` also accepts `q`, `type`, `category`, `project`, `agent`, and `tag`.

A classification PATCH body may contain any of `category`, `project`, `agent`, `model`, `tags` (array or comma-separated string), and `description`; only fields present change. An empty string clears a field; a cleared `description` falls back to the page title.

## Development and tests

```bash
npm test                          # Retention, descriptions, classification, index, upload/admin smoke
npm run test:statistics            # Statistics, durable recovery, and APIs (including access statistics)
npm run test:visits                # Access counting rules, filters and sorting, flush on shutdown
npm run test:admin-login           # Admin brute-force protection and proxy IP handling
npm run test:access                # Access protection, retry limits, sidecar bypass prevention
npm run smoke:render               # Render tests; adds a real container check when Docker is available

# These require Playwright and Chromium: npm install adds the pinned playwright devDependency;
# if the browser is missing, run npx playwright install chromium
npm run test:browser               # Runs all browser tests below at once (CI runs this too)
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
.agents/skills/      Release (release) and deployment (deploy-view) Skills
scripts/             Regression tests and deployment helpers
```

## Scope and contributions

The current scope is one administrator, local file storage, and a single main-service process. It does not include multi-admin RBAC, token creation / rotation in the admin UI, object-storage backends, or a fully containerized main service.

Issues and PRs are welcome. For bug reports, include your Node.js version, deployment mode, reproduction steps, and redacted logs. When changing defaults, update both READMEs, configuration examples, and relevant tests together.

- [Full configuration](../config.example.yaml)
- [Agent instructions](../AGENTS.md) · [Upload Skill](../skill/dview-upload/SKILL.md)
- [Sidecar design](../docs/design-render-sidecar.md) · [Deployment Skill](../.agents/skills/deploy-view/SKILL.md)
- [Requirements and design notes](../docs/SPEC.md)
