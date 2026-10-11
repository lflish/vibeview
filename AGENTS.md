# Agent notes — vibeview

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

## Manage own resources

```bash
dview me
dview list
dview delete <id>
```

Same APIs: `GET /api/me`, `GET /api/me/items`, `DELETE /api/me/items/:id`.

## Constraints

- Supported: HTML, png/jpg/gif/webp/svg, mp4/webm
- Size / quota limits are server-side; `429` means account quota exceeded
- Only upload **trusted** content — HTML runs as scripts in the visitor's browser
- Preview links are unguessable random IDs; still treat them as shareable URLs

## Claude-only extras

If Claude Code is installed: skill `dview-upload`, slash command `/dview`.  
Other agents: use this file + CLI/curl. See `docs/integrations.md`.
