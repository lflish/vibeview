# Agent notes — vibeview

## Specs

Feature requirements live in [docs/specs/](docs/specs/README.md), one file per feature with a status line.
When a requirement changes, update its spec first, then implement against it. Only start implementing a
spec whose status is “已确认” or later; record scope changes under its 变更记录.

## Release and deployment skills

- [release](.agents/skills/release/SKILL.md): cut a version — checks, version bump, bilingual notes,
  tag, deterministic runtime package, GitHub Release. Touches only git/GitHub. Example: “使用 $release 发布 1.2.0”。
- [deploy-view](.agents/skills/deploy-view/SKILL.md): deploy a released tag (or, by exception, a commit
  or the worktree) to production with dry run, backup, health checks, `RELEASE` record, and automatic rollback.
  Example: “使用 $deploy-view 部署 v1.2.0”。
The deployment target (host, directory, public URL) comes from `VIEW_*` environment variables or the
untracked `.agents/skills/deploy-view/local.env`; never commit real hosts, IPs, or usernames.

When you generate HTML, charts, screenshots, images, or short videos that the user should open in a browser, **upload them to vibeview** and return the preview URL instead of only leaving a local path.

## Default style for generated pages

When generating HTML pages, charts, or reports, default to a light theme: pale gray background (`#f6f8fb`), white surfaces, dark text (`#1e293b`), and blue accents (`#2563eb`). Follow explicit user styling requests or an existing design when provided. Preserve existing files when the task is only to upload them. See `skill/dview-upload/SKILL.md` for generation and theme preferences.

## Config

Required env (ask the user / admin if missing):

- `DVIEW_URL` — service base URL, e.g. `https://view.example.com`
- `DVIEW_TOKEN` — account upload token

Do not print the full token in chat logs.

## How to upload

Prefer the CLI if available:

```bash
dview upload /path/to/file.html
# stdout: https://view.example.com/v/<id>
```

Fallbacks (first that works):

1. `bash bin/dview upload <file>` (inside this repo)
2. `bash skill/dview-upload/upload.sh <file>`
3. `bash "$HOME/.claude/skills/dview-upload/upload.sh" <file>`
4. curl:

```bash
curl -fsS -X POST "$DVIEW_URL/upload" \
  -H "Authorization: Bearer $DVIEW_TOKEN" \
  -F "file=@/path/to/file.html"
```

Parse JSON field `url` and show it to the user.

Pages that change over time (requirements, prototypes) should keep one link. Inside a git repository,
`dview upload` records `path → id` in `.dview.json` at the repository root; uploading the same path again
creates a new version at the same URL with the same access code. Add `-m "what changed"` to each update,
commit `.dview.json`, use `--id <id>` to update a specific resource, and `--new` to force a new one.
Version history: `dview versions <id>`; version `n` is at `/v/<id>/@<n>`.

Page templates fix the layout of recurring pages (bills, reports). Before generating a page, run
`dview template match "<the user's request>" --json`. On a single match, read `dview template show <name>`
and follow its guide: for a fixed layout write only the data as JSON and run
`dview render <name> --data <file.json> --json` (do not write HTML or compute totals); for a free layout
generate the HTML and upload it with `--template <name>`. Ask the user when several templates match.
If a `dview-tpl-<name>` skill triggers, follow it directly; `dview template skills sync` generates these
skills from the server's templates. Details: `skill/dview-upload/SKILL.md`, `docs/specs/page-templates.md`,
`docs/specs/template-skills.md`.

Choose a mode before generating a page. Use a **single self-contained HTML file** by default.
Use a **multi-page site** only when the work needs two or more pages that link to each other, separate
asset files (images, data, fonts), is a front-end build (`dist/`), or would exceed about 1 MB as one file.
Write sites to a new directory with `index.html` at the root, use relative links only (`about.html`,
`css/app.css`; for Vite set `base: './'`), use hash routing for SPAs, and upload the directory with
`dview upload <dir> --json`. The whole site shares one URL and one access code. Details and limits:
`skill/dview-upload/SKILL.md`.

Classify every upload so the admin can filter thousands of pages later: pass one
`--category` (`doc`, `report`, `dashboard`, `prototype`, `game`, `slides`, `tool`,
`demo`, `screenshot`, `other`) plus 1–3 lowercase `--tag` values, and `--model` when
known. `project` defaults to the git repository name and `agent` is auto-detected; set
`DVIEW_AGENT` (e.g. `codex`, `cursor`) if detection does not recognize your tool. curl
uses the same form field names (`category`, `tags`, `project`, `agent`, `model`).
Fix a wrong label with `dview edit <id> --category <value>`.
Uploads now require a preview access code by default. Prefer `dview upload <file> --json` to obtain `url`, `accessCode`, and `access.expiresAt`; share the code and expiration with the user separately from the URL. Do not embed the code in URLs or generated HTML. Use `--public` only when the user explicitly requests an unprotected preview. A code expiring does not delete the file.

## Manage own resources

```bash
dview me
dview list [--category C] [--project P] [--tag T]
dview edit <id> [--category C] [--tag T] [--project P]
dview delete <id>
```

Same APIs: `GET /api/me`, `GET /api/me/items`, `PATCH /api/me/items/:id/meta`, `DELETE /api/me/items/:id`.

## Constraints

- Supported: HTML, png/jpg/gif/webp/svg, mp4/webm, and multi-page sites (a directory or `.zip` with `index.html` at its root)
- Size / quota limits are server-side; `429` means account quota exceeded
- Only upload **trusted** content — HTML runs as scripts in the visitor's browser
- Preview links are unguessable random IDs; still treat them as shareable URLs

## Claude-only extras

If Claude Code is installed: skill `dview-upload`, slash command `/dview`.  
Other agents: use this file + CLI/curl. See `docs/integrations.md`.
