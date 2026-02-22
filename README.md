# ClawFeed

> **Stop scrolling. Start knowing.**

<div align="center">

https://github.com/kevinho/clawfeed/releases/download/v0.2.0/demo.mp4

[Live Demo](https://clawfeed.kevinhe.io)

</div>

AI-powered news digest tool that curates 5,000 accounts down to 10 highlights that matter. Generates structured summaries from Twitter/RSS feeds. Works as a standalone service or as an [OpenClaw](https://github.com/openclaw/openclaw) / [Zylos](https://github.com/zylos-ai) skill.

![Dashboard](docs/demo.gif)

## Features

- 📰 **Multi-frequency digests** — 4-hourly, daily, weekly, monthly summaries
- 📌 **Mark & Deep Dive** — Bookmark content for AI-powered deep analysis
- 🎯 **Smart curation** — Configurable rules for content filtering
- 👀 **Follow/Unfollow suggestions** — Based on feed quality analysis
- 🖥️ **Web dashboard** — Dark-themed SPA for browsing digests
- 💾 **SQLite storage** — Fast, portable, zero-config database
- 🔐 **Google OAuth login** — Multi-user support with personal bookmarks

## Installation

### Option 1: OpenClaw Skill

Drop the `clawfeed` folder into your OpenClaw skills directory, or symlink it:

```bash
# Clone into your skills folder
cd ~/.openclaw/skills/
git clone https://github.com/kevinho/clawfeed.git

# Or symlink from wherever you cloned it
ln -s /path/to/clawfeed ~/.openclaw/skills/clawfeed
```

OpenClaw will auto-detect `SKILL.md` and load the skill. The agent can then:
- Generate digests via cron jobs
- Serve the dashboard via reverse proxy
- Handle `mk <url>` / `mark <url>` commands for bookmarking

### Option 2: Zylos Skill

```bash
# Clone into Zylos skills directory
cd ~/.zylos/skills/  # or wherever Zylos looks for skills
git clone https://github.com/kevinho/clawfeed.git
```

Zylos reads `SKILL.md` for tool definitions. The digest API server runs as a sidecar service.

### Option 3: Standalone (no agent framework)

```bash
git clone https://github.com/kevinho/clawfeed.git
cd clawfeed
npm install
```

## Quick Start

```bash
# 1. Copy and edit environment config
cp .env.example .env
# Edit .env with your settings

# 2. Start the API server
npm start
# → API running on http://127.0.0.1:8767
```

## Environment Variables

Create a `.env` file in the project root:

| Variable | Description | Required | Default |
|----------|-------------|----------|---------|
| `GOOGLE_CLIENT_ID` | Google OAuth client ID | No* | - |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret | No* | - |
| `SESSION_SECRET` | Session encryption key | No* | - |
| `DIGEST_PORT` | Server port | No | 8767 |
| `ALLOWED_ORIGINS` | Allowed origins for CORS | No | localhost |

*Required for authentication features. Without OAuth, the app runs in read-only mode.

## Authentication Setup

To enable Google OAuth login:

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select existing one
3. Enable the Google+ API
4. Create OAuth 2.0 credentials
5. Add your domain to authorized origins
6. Add your callback URL: `https://yourdomain.com/api/auth/callback`
7. Set the credentials in your `.env` file

## API

All endpoints are prefixed with `/api/`.

| Method | Endpoint | Description | Auth |
|--------|----------|-------------|------|
| `GET` | `/api/digests` | List digests. Query: `?type=4h&limit=20&offset=0` | - |
| `GET` | `/api/digests/:id` | Get single digest | - |
| `POST` | `/api/digests` | Create digest (internal use) | - |
| `GET` | `/api/auth/google` | Start Google OAuth flow | - |
| `GET` | `/api/auth/callback` | OAuth callback endpoint | - |
| `GET` | `/api/auth/me` | Get current user info | Yes |
| `POST` | `/api/auth/logout` | Logout user | Yes |
| `GET` | `/api/marks` | List user bookmarks | Yes |
| `POST` | `/api/marks` | Add bookmark `{ url, title?, note? }` | Yes |
| `DELETE` | `/api/marks/:id` | Remove bookmark | Yes |
| `GET` | `/api/config` | Get current config | - |
| `PUT` | `/api/config` | Update config `{ key: value, ... }` | - |

## Reverse Proxy

Example Caddy configuration:

```
handle /digest/api/* {
    uri strip_prefix /digest/api
    reverse_proxy localhost:8767
}
handle_path /digest/* {
    root * /path/to/clawfeed/web
    file_server
}
```

## Customization

- **Curation rules**: Edit `templates/curation-rules.md` to control how content is filtered
- **Digest format**: Edit `templates/digest-prompt.md` to customize AI output format

## Development

```bash
npm run dev  # Start with --watch for auto-reload
```

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

MIT License - see the [LICENSE](LICENSE) file for details.

Copyright 2026 Kevin He
