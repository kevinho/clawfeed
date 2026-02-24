# Changelog

## v0.8.1 — 2026-02-24
### ✨ New
- **Telegram group link in info banner** — Clickable TG icon + group invite link with i18n support (#16)
- **DEVOPLOG.md** — R&D lifecycle tracking for staging/production changes (#20)

### 🔧 Fixed
- **TG icon rendering** — Replace emoji with proper SVG icon, make TG group link clickable (#17)
- **Subtitle Twitter links** — @mentions in subtitle now link to Twitter profiles (#18)
- **ClawHub metadata alignment** — SKILL.md credentials declared, TESTING.md HttpOnly note, README/SKILL.md consistency (#25)

### 🏗️ Infrastructure
- **CI pipeline** — GitHub Actions for lint + security audit on PRs (#2, #9)
- **PR template & CONTRIBUTING.md** — Standardized contribution workflow (#3)
- **Health endpoint** — `GET /api/health` for CI readiness checks (#4)
- **Feedback webhook config** — `FEEDBACK_LARK_WEBHOOK` in .env.example (#5)
- **Dev process docs** — Full PROCESS.md workflow (#7)
- **Security hardening** — SSRF protection, OAuth state validation, API key handling (#1)

## v0.7.0 — 2026-02-22
### ✨ New
- **Dark/Light mode toggle** — Sun/moon toggle in header, persists in localStorage
- **Video demo in README** — Uploaded demo.mp4 as GitHub release asset for proper embedding

### 🔧 Fixed
- README video now auto-plays on GitHub (release asset URL instead of relative path)

## v0.6.0 — 2026-02-22
### ✨ New
- **Soft Delete Sources** — Sources marked `is_deleted` instead of hard delete; prevents pack zombie resurrection
- **Roadmap page** — Accessible from ⋯ More menu
- **Test documentation** — Full test case index with iteration log

### 🔧 Fixed
- Pack install skips deleted sources (no more zombie duplicates)
- Subscription list shows deactivated sources (greyed out + ⚠️ badge)

## v0.5.0 — 2026-02-21
### ✨ New
- **Digest Feed System** — Each user gets a subscribable feed (`/feed/:slug.json`, `/feed/:slug.rss`, `/feed/:slug`)
- **Smart Source Detection** — Paste any URL, auto-detect source type (RSS, Twitter, HN, Reddit, etc.)
- **Sources Management** — ⚙️ UI to add/edit/delete data sources with type-specific config examples
- **Auth Config API** — Hide login UI when Google OAuth not configured (for third-party deployments)
- **API Key Auth** — `POST /api/digests` uses Bearer token authentication

### 🔧 Fixed
- Tab switching state reset when navigating from Sources
- Timezone grouping bug (UTC vs local date)
- Title click returns to home

### 🗑️ Removed
- Admin role system (every user manages own data)

## v0.4.0 — 2026-02-21
### ✨ New
- **i18n** — Chinese/English toggle with localStorage persistence
- **Google OAuth** — Sign in with Google, session cookies, per-user marks
- **Private sections** — 🧹建议取关 and 🔖Bookmarks hidden for non-logged-in users
- **Open source** — Published to GitHub under MIT license

### 🔧 Fixed
- Header layout flex (no more position:absolute overlap)
- Auth timing race condition (checkAuth before renderList)
- Mobile responsive title

## v0.3.0 — 2026-02-21
### ✨ New
- **SQLite storage** — Migrated from markdown files to better-sqlite3
- **Marks system** — Bookmark articles with dedup, per-user isolation
- **Dashboard pagination** — 10 items per page with "Load more"
- **Excerpt preview** — 1-2 line preview for digest cards
- **Time grouping** — 4H→day, daily→week, weekly→month, monthly→year

## v0.2.0 — 2026-02-21
### ✨ New
- **Standalone server** — Node HTTP server on port 8767
- **REST API** — GET/POST digests, GET/POST/DELETE marks
- **Dashboard** — Dark theme, tabs for 4H/Daily/Weekly/Monthly/Marks
- **Domain** — digest.kevinhe.io with Cloudflare Access

## v0.1.0 — 2026-02-21
### ✨ New
- **Initial release** — ClawFeed with web dashboard, Google OAuth, SQLite storage
- **4H cron** — Every 4 hours digest from Twitter For You feed
- **Daily/Weekly/Monthly** — Recursive summarization pipeline
