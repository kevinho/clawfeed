# ClawFeed

> **Stop scrolling. Start knowing.**

[![ClawHub](https://img.shields.io/badge/ClawHub-clawfeed-blue)](https://clawhub.ai/skills/clawfeed)
[![GitHub](https://img.shields.io/github/v/tag/kevinho/clawfeed?label=version)](https://github.com/kevinho/clawfeed)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[Live Demo: https://clawfeed.kevinhe.io](https://clawfeed.kevinhe.io)

AI-powered news digest that curates thousands of sources down to the highlights that matter. Generates structured summaries (4H/daily/weekly/monthly) from Twitter, RSS, and more. Works standalone or as an [OpenClaw](https://github.com/openclaw/openclaw) / [Zylos](https://github.com/zylos-ai) skill.

![Dashboard](docs/demo.gif)

## Features

- 📰 **Multi-frequency digests** — 4-hourly, daily, weekly, monthly summaries
- 📡 **Sources system** — Add Twitter feeds, RSS, HackerNews, Reddit, GitHub Trending, and more
- 📦 **Source Packs** — Share curated source bundles with the community
- 📌 **Mark & Deep Dive** — Bookmark content for AI-powered deep analysis
- 🎯 **Smart curation** — Configurable rules for content filtering and noise reduction
- 👀 **Follow/Unfollow suggestions** — Based on feed quality analysis
- 📢 **Feed output** — Subscribe to any user's digest via RSS or JSON Feed
- 🌐 **Multi-language** — English and Chinese UI
- 🌙 **Dark/Light mode** — Theme toggle with localStorage persistence
- 🖥️ **Web dashboard** — SPA for browsing and managing digests
- 💾 **SQLite storage** — Fast, portable, zero-config database
- 🔐 **Google OAuth** — Multi-user support with personal bookmarks and sources

## Installation

### Option 1: ClawHub (recommended)

```bash
clawhub install clawfeed
```

### Option 2: OpenClaw Skill

```bash
cd ~/.openclaw/skills/
git clone https://github.com/kevinho/clawfeed.git
```

OpenClaw auto-detects `SKILL.md` and loads the skill. The agent can then generate digests via cron, serve the dashboard, and handle bookmark commands.

### Option 3: Zylos Skill

```bash
cd ~/.zylos/skills/
git clone https://github.com/kevinho/clawfeed.git
```

### Option 4: Standalone

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
| `API_KEY` | API key for digest creation | No | - |
| `DIGEST_PORT` | Server port | No | 8767 |
| `ALLOWED_ORIGINS` | Allowed origins for CORS | No | localhost |

\*Required for authentication features. Without OAuth, the app runs in read-only mode.

## Authentication Setup

To enable Google OAuth login:

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select existing one
3. Enable the Google+ API
4. Create OAuth 2.0 credentials
5. Add your domain to authorized origins
6. Add callback URL: `https://yourdomain.com/api/auth/callback`
7. Set credentials in `.env`

## API

All endpoints prefixed with `/api/`.

### Digests

| Method | Endpoint | Description | Auth |
|--------|----------|-------------|------|
| `GET` | `/api/digests` | List digests `?type=4h&limit=20&offset=0` | - |
| `GET` | `/api/digests/:id` | Get single digest | - |
| `POST` | `/api/digests` | Create digest | API Key |

### Auth

| Method | Endpoint | Description | Auth |
|--------|----------|-------------|------|
| `GET` | `/api/auth/config` | Auth availability check | - |
| `GET` | `/api/auth/google` | Start OAuth flow | - |
| `GET` | `/api/auth/callback` | OAuth callback | - |
| `GET` | `/api/auth/me` | Current user info | Yes |
| `POST` | `/api/auth/logout` | Logout | Yes |

### Marks (Bookmarks)

| Method | Endpoint | Description | Auth |
|--------|----------|-------------|------|
| `GET` | `/api/marks` | List bookmarks | Yes |
| `POST` | `/api/marks` | Add bookmark `{ url, title?, note? }` | Yes |
| `DELETE` | `/api/marks/:id` | Remove bookmark | Yes |

### Sources

| Method | Endpoint | Description | Auth |
|--------|----------|-------------|------|
| `GET` | `/api/sources` | List user's sources | Yes |
| `POST` | `/api/sources` | Create source `{ name, type, config }` | Yes |
| `PUT` | `/api/sources/:id` | Update source | Yes |
| `DELETE` | `/api/sources/:id` | Soft-delete source | Yes |
| `GET` | `/api/sources/detect` | Auto-detect source type from URL | Yes |

### Source Packs

| Method | Endpoint | Description | Auth |
|--------|----------|-------------|------|
| `GET` | `/api/packs` | Browse public packs | - |
| `POST` | `/api/packs` | Create pack from your sources | Yes |
| `POST` | `/api/packs/:id/install` | Install pack (subscribe to its sources) | Yes |

### Feeds

| Method | Endpoint | Description | Auth |
|--------|----------|-------------|------|
| `GET` | `/feed/:slug` | User's digest feed (HTML) | - |
| `GET` | `/feed/:slug.json` | JSON Feed format | - |
| `GET` | `/feed/:slug.rss` | RSS format | - |

### Config

| Method | Endpoint | Description | Auth |
|--------|----------|-------------|------|
| `GET` | `/api/changelog` | Changelog `?lang=zh\|en` | - |
| `GET` | `/api/roadmap` | Roadmap `?lang=zh\|en` | - |

## Reverse Proxy

Example Caddy configuration:

```caddyfile
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

- **Curation rules**: Edit `templates/curation-rules.md` to control content filtering
- **Digest format**: Edit `templates/digest-prompt.md` to customize AI output format

## Source Types

| Type | Example | Description |
|------|---------|-------------|
| `twitter_feed` | `@karpathy` | Twitter/X user feed |
| `twitter_list` | List URL | Twitter list |
| `rss` | Any RSS/Atom URL | RSS feed |
| `hackernews` | HN Front Page | Hacker News |
| `reddit` | `/r/MachineLearning` | Subreddit |
| `github_trending` | `language=python` | GitHub trending repos |
| `website` | Any URL | Website scraping |
| `digest_feed` | ClawFeed user slug | Another user's digest |
| `custom_api` | JSON endpoint | Custom API |

## Development

```bash
npm run dev  # Start with --watch for auto-reload
```

### Testing

```bash
cd test
./setup.sh    # Create test users
./e2e.sh      # Run 66 E2E tests
./teardown.sh # Clean up
```

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for multi-tenant design and scale analysis.

## Roadmap

See [ROADMAP.md](ROADMAP.md) or the in-app roadmap page.

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

MIT License — see [LICENSE](LICENSE) for details.

Copyright 2026 Kevin He
