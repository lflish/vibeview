<p align="center">
  <img src="docs/assets/banner.svg" alt="vibeview — Local files. Shareable previews." width="100%">
</p>

<h1 align="center">Local files. Shareable previews.</h1>

<p align="center">
  A lightweight, self-hosted preview service.<br>
  Turn AI reports, HTML charts, screenshots, and demo videos into browser links you can protect and manage.
</p>

<p align="center">
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-22-43853d?style=flat-square&amp;logo=nodedotjs&amp;logoColor=white" alt="Node.js 22"></a>
  <a href="docs/user-guide.en.md#deployment"><img src="https://img.shields.io/badge/deploy-self--hosted-2563eb?style=flat-square" alt="Self-hosted"></a>
  <a href="#access-protection-and-retention"><img src="https://img.shields.io/badge/access-code%20protected-2563eb?style=flat-square" alt="Access-code protected"></a>
</p>

<p align="center">
  <a href="README.md">简体中文</a> · <strong>English</strong>
</p>

<p align="center">
  <a href="#screenshots">Screenshots</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#upload-and-share">Upload &amp; share</a> ·
  <a href="docs/user-guide.en.md">User guide</a> ·
  <a href="https://github.com/lflish/vibeview/issues">Report an issue</a>
</p>

---

## Why vibeview

Sharing and organizing a file should be as easy as generating it. Upload with `dview`, share the link, and find it later in one admin page. Files stay on your own server; personal use needs just one upload token.

| Upload and preview | Share with access protection |
| :--- | :--- |
| One upload workflow for HTML, images, and video. Built for AI reports, visualizations, page prototypes, and short demos. | Random access codes by default, with adjustable expiration, reset, no expiration, or explicit public access. Original files are protected too. |
| **Find it as your library grows** | **Use your existing tools** |
| Descriptions, sources, creation dates, and age at a glance. Search, filter, sort, paginate, and delete in bulk. | Upload through the CLI, curl, AI Skills, or CI. Admin pages support light, dark, and system themes, starting with light. |

**Defaults:** **50 MB** per file · **7-day** access codes · **Indefinite** file retention · **Optional** account quotas.

## Screenshots

### An uploaded page in action

[![An actual vibeview HTML preview with a light report, metric cards, and an interactive chart](docs/assets/preview-demo.png)](https://view.lflish.fun/v/xE7Gp8xUszMtVoph)

[Open the interactive demo](https://view.lflish.fun/v/xE7Gp8xUszMtVoph) · **Access code:** `6kTR93sX9KaN` · **Expiration:** None · [HTML source](examples/preview-demo.html)

This standalone HTML report was uploaded to vibeview and uses fictional data. Switch between **7 days / 30 days** to try the interaction. The screenshot comes from the deployed preview. The demo's code is specifically configured without expiration; ordinary uploads still default to 7 days.

Upload the included example to your own service:

```bash
bash bin/dview upload examples/preview-demo.html --json
```

### Admin interface

![vibeview light admin UI with descriptions, access status, sources, and creation dates](docs/assets/admin-light.png)

<p align="center"><sub>Actual admin UI, captured with isolated sample data. The interface is currently in Chinese.</sub></p>

<details>
<summary><strong>Access protection settings</strong> — Set expiration, reset a code, or allow public access</summary>

<p align="center">
  <img src="docs/assets/access-settings.png" alt="Access settings: verification mode, expiration, and code reset" width="460">
</p>

Code expiration blocks access while keeping the file. A new code is shown only when generated; reset it if lost.

</details>

## Quick start

Use **Node.js 22** and npm. The upload CLI needs Bash, curl, and either Python 3 or Node.js. Run the main service locally; Docker is used for the optional render sidecar.

**1. Install**

```bash
git clone https://github.com/lflish/vibeview.git
cd vibeview
npm ci
cp config.example.yaml config.yaml
```

**2. Configure**

Edit `config.yaml`: set `tokens[].token`, `admin.password`, and `admin.session_secret` to your own random values, for example by running `openssl rand -hex 24` separately for each. `tokens[].name` identifies the upload source. Keep `server.base_url` at `http://localhost:3000` for local use.

**3. Start**

```bash
npm start
```

Open [http://localhost:3000/admin](http://localhost:3000/admin) and sign in with your configured administrator credentials. See the [user guide](docs/user-guide.en.md#quick-start) for full configuration and health checks.

## Upload and share

In another terminal:

```bash
export DVIEW_URL="http://localhost:3000"
export DVIEW_TOKEN="your-upload-token"

bash bin/dview upload ./report.html --json
```

The response includes a preview link, access code, and expiration time:

```json
{
  "url": "http://localhost:3000/v/Ab3xK9mP2qR7sT1v",
  "accessCode": "G7mK9pRX4aQ2",
  "access": { "expiresAt": "2026-10-19T12:00:00.000Z" }
}
```

*Selected response fields only. Actual codes and timestamps come from the upload response.*

Open the link and enter the access code to view the file. AI tools and scripts should save `url`, `accessCode`, and `access.expiresAt`. Keep the code out of URLs and generated HTML.

Run `npm link` to use `dview` directly:

```bash
dview upload ./report.html --json --access-days 1 # Code valid for 1 day
dview upload ./public.html --public               # Explicitly public
dview list                                       # Your resources
dview me                                         # Your usage
dview delete Ab3xK9mP2qR7sT1v                      # Delete your resource
```

**AI integrations:** [Claude Code setup](docs/user-guide.en.md#ai-skills-and-integrations) · [Codex / Cursor / Agents](AGENTS.md) · [Upload Skill](skill/dview-upload/SKILL.md) · [curl and CI](docs/user-guide.en.md#upload-and-share). Generated pages use a light theme by default.

## Access protection and retention

| What you want to control | What to use |
| :--- | :--- |
| Who can upload and manage an account's files | Upload token |
| Who can view a preview and its original file | Per-preview access code, valid for 7 days by default |
| When files are automatically deleted | `storage.retention_days`, default `0` for indefinite retention |

An expired code **does not delete the file**. Older previews are also locked by default; generate a code in the admin UI before sharing. By default, each preview allows 10 failed attempts per 10 minutes, then returns `429`. The limit is shared across IPs and persists through restarts.

Read more about [access protection and retention](docs/user-guide.en.md#access-protection-and-retention).

## Deployment

Run the Node.js main service under PM2 or systemd. Public deployments need HTTPS and the actual `server.base_url`. The optional Docker render sidecar mounts files read-only and serves previews through the main service's authenticated proxy.

[Deployment and gateway setup](docs/user-guide.en.md#deployment) · [Sidecar design](docs/design-render-sidecar.md) · [This project's TX deployment Skill](.agents/skills/deploy-tx/SKILL.md)

<a id="api"></a>

## Documentation and contributing

| Document | Contents |
| :--- | :--- |
| [English user guide](docs/user-guide.en.md) · [中文使用指南](docs/user-guide.zh-CN.md) | Full setup, CLI, curl, resource management, configuration, and deployment |
| [Example configuration](config.example.yaml) | Access protection, retention, account quotas, and sidecar settings |
| [API](docs/user-guide.en.md#api) | Uploads, account resources, administrator endpoints, and preview verification |
| [Development and tests](docs/user-guide.en.md#development-and-tests) | Local checks, browser tests, and repository layout |
| [Agent instructions](AGENTS.md) · [Upload Skill](skill/dview-upload/SKILL.md) | Conventions for generating and uploading files with AI |

The current scope is one administrator, one main-service process, and local file storage. Protected HTML uses a browser sandbox; pages that depend on browser storage or same-origin requests need adaptation. See [browser behavior](docs/user-guide.en.md#browser-behavior-of-html).

[Report an issue](https://github.com/lflish/vibeview/issues) or [contribute code](https://github.com/lflish/vibeview/pulls). Include your runtime environment, reproduction steps, and sanitized logs. Keep both language versions, configuration examples, and relevant tests in sync when changing defaults.
