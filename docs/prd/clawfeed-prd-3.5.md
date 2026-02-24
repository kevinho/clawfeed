# PRD 3.5: Analytics Dashboard (分析仪表板)

ClawFeed v3.0 · Phase 3 · P1 · Author: Lucy · 2026-02-25

## BACKGROUND

ClawFeed has 393 users producing Digests, bookmarks, and Source subscriptions, but ops is flying blind — no data visualization. Key gaps:
- User behavior: Digest read rate? Bookmark conversion? Push open rate?
- Source quality: Which Sources get selected into Digests most? Which fail frequently?
- System health: LLM call volume/latency trends? Fetch success rate? Silent failures?
- User management: No admin panel — all management requires direct DB operations.

Tech stack: Node.js + SQLite + Vanilla JS SPA (~3100 LOC). Solution stays lightweight — no ClickHouse/Grafana.

Existing tables: users (393 rows, Google OAuth), digests (type/content/metadata/user_id), marks (bookmarks), sources (fetch_count/last_fetched_at), raw_items (PR #15, per-source fetched content), feedback (category/read_at), user_subscriptions.

## GOALS

1. Data-driven ops via real-time dashboard (user behavior, Source quality, system health)
2. Unified event tracking infrastructure (foundation for recommendations, personalization, A/B testing)
3. Admin panel for user management, Source review, system monitoring — eliminate direct DB ops
4. Stay lightweight — all on SQLite, no external data stores

## USER STORIES

US-1: Admin views user behavior overview — DAU/WAU/MAU trend (30d line chart), Digest read rate, bookmark rate, time range filter (7/30/90d), data delay ≤5min
US-2: Admin analyzes Source contribution — table of all active Sources showing name, type, subscriber count, fetch success rate, Digest selection rate, last fetch time; sortable; 3+ consecutive failures highlighted red
US-3: Admin monitors system health — LLM call volume (hourly/daily bar chart), P50/P95 latency trend, fetch success/fail ratio, warning banner if error rate >10%, recent 10 error log summaries
US-4: Admin manages users — list with avatar/name/email/registered/last active/subscriptions/digest reads; search by name/email; view details (subscriptions, recent activity); disable/enable accounts
US-5: Admin reviews Sources — list filterable by type/status (active/unlisted/disabled/deleted); can unlist or disable; shows affected subscriber count before action; audit trail for all operations
US-6: Regular user sees personal stats — card in Profile/Settings showing: Digests read, bookmarks count, subscribed Sources, days since joined; real-time; minimal style

## FUNCTIONAL REQUIREMENTS OVERVIEW

F-1: Event Tracking System — unified event table tracking 12 event types (page_view, digest_read, item_click, mark_create/delete, push_open, source_subscribe/unsubscribe, search, llm_call, fetch_job, admin_action). Frontend events via trackEvent() → POST /api/events (batched every 10s + sendBeacon on page leave). Backend events inserted directly. Anonymous users tracked via session_id.
F-2: Admin Dashboard — SPA view at #/admin with 4 sub-pages (Dashboard/Users/Sources/System), admin-only access
F-3: Admin Role — dual mechanism: .env ADMIN_EMAILS + DB is_admin flag; .env takes priority; auto-sync on login
F-4: User Stats Panel — lightweight stats card in Settings/Profile (read count, bookmarks, subscriptions, days joined) — all from existing table aggregations
F-5: Metric Definitions — standardized calculations for DAU, Digest read rate, bookmark rate, push open rate, Source selection rate, fetch success rate, LLM P95 latency

## DB MIGRATION (010_analytics.sql)

New 'events' table: id (PK auto), user_id (FK users), session_id (text, for anon tracking), event_type (text, NOT NULL), event_data (JSON text, default '{}'), created_at (datetime default now).
Indexes: (event_type, created_at DESC), (user_id, created_at DESC), (created_at DESC).
users table additions: is_admin (int default 0), is_disabled (int default 0).

Data volume estimates (90-day retention):
- Current (393 users, ~40 DAU): ~5K events/day → 450K rows → ~50MB
- Mid-term (1K users, ~100 DAU): ~15K/day → 1.35M rows → ~150MB
- Upper bound (5K users, ~500 DAU): ~75K/day → 6.75M rows → ~750MB
SQLite handles <1M rows aggregations in <100ms; up to 7M in 200-500ms — acceptable.

## API ENDPOINTS

POST /api/events — logged-in or anonymous, batch write events (max 50/request, 1KB/event, 10 req/min/user rate limit, invalid types silently dropped)
GET /api/admin/dashboard — overview data (total users, DAU/WAU/MAU, read rate, bookmark rate, 30d trends, top sources, system status)
GET /api/admin/users — paginated user list with search
GET /api/admin/users/:id — user details
PATCH /api/admin/users/:id — disable/enable user
GET /api/admin/sources — source list with analytics
PATCH /api/admin/sources/:id — source review actions
GET /api/admin/system — system monitoring data
GET /api/admin/events — event log query
GET /api/me/stats — current user's personal stats
All /api/admin/* routes require admin check middleware.

Valid frontend event types whitelist: page_view, digest_read, item_click, mark_create, mark_delete, push_open, source_subscribe, source_unsubscribe, search.
Backend-only events (llm_call, fetch_job, admin_action) — server-side insert only, not accepted from frontend.

## SOURCE SELECTION RATE

Extend Digest metadata JSON to include source_contributions map (source_id → count of items selected), plus total_candidates and total_selected. Selection rate calculated by aggregating this metadata — no extra table needed.

## ADMIN AUTH MIDDLEWARE

All /api/admin/* paths checked: isAdmin(session) verifies session.is_admin === 1 OR session.email in ADMIN_EMAILS from .env. Returns 403 if not admin.

## FRONTEND CHANGES

FE-1: Event tracking SDK (~50 LOC) — eventQueue buffer, 10s flush timer, sendBeacon fallback on visibilitychange. Instrumentation points: hashchange → page_view, Digest detail expand → digest_read, link click → item_click, search execute → search.
FE-2: Admin SPA routes — #/admin (dashboard), #/admin/users, #/admin/sources, #/admin/system. Uses Chart.js via CDN (~60KB gzip) for line/bar/pie charts. Non-admin visiting #/admin redirected to #/digests. Admin entry hidden in avatar dropdown (admin-only).
FE-3: Personal stats card — appended to Settings/Profile page, calls GET /api/me/stats, pure HTML+CSS.

## DATA CLEANUP

Events table: 90-day TTL via scheduled DELETE. No aggregation cache needed initially (SQLite fast enough).
Optional future optimization: daily_stats pre-aggregation table (date + metric + value PK) — only if trend queries exceed 500ms. Scheduled at 01:00 daily. Not implemented in this phase.

## ACCEPTANCE CRITERIA (38 items)

Event Tracking (AC-1 to AC-8):
- page_view on every SPA route change; digest_read on Digest detail expand; item_click on Digest link click
- Frontend events batch-sent (10s interval or sendBeacon on page leave)
- Backend llm_call event auto-recorded per LLM call (model, tokens, latency); fetch_job event per fetch task (source_id, success/fail)
- POST /api/events max 50 events/batch, invalid types silently dropped
- Events auto-cleaned after 90 days

Admin Auth (AC-9 to AC-13):
- ADMIN_EMAILS in .env → auto admin on login; users.is_admin=1 → admin
- Non-admin → 403 on /api/admin/*, redirected to #/digests on #/admin
- Admin entry visible only in admin's avatar dropdown

Dashboard (AC-14 to AC-18):
- Overview cards: total users, DAU, Digest read rate, bookmark rate
- DAU line chart (30d), Digest read trend line chart (30d)
- Top 10 Sources table sorted by selection rate
- System status bar: LLM calls (24h), P95 latency, error count

User Management (AC-19 to AC-23):
- User list: avatar, name, email, registered, last active, subscription count
- Search by name/email (fuzzy); user detail view (subscriptions, recent 20 events)
- Disable/enable users (disabled users cannot log in); pagination at 50/page

Source Management (AC-24 to AC-27):
- Source list: name, type, subscribers, fetch success rate, selection rate
- Filter by type and status; disable with affected subscriber count shown
- All admin operations logged as admin_action events

System Monitoring (AC-28 to AC-32):
- LLM call volume bar chart (hourly); P50/P95 latency trend line chart
- Fetch success/fail pie chart; recent 20 error logs viewable
- Warning banner when error rate >10%

Personal Stats (AC-33 to AC-34):
- Stats card visible in Profile/Settings for logged-in users
- Accurate counts: Digests read, bookmarks, subscriptions, days since joined

Performance (AC-35 to AC-38):
- Dashboard first load <1s (incl. data fetch)
- All aggregation queries <200ms with events table under 500K rows
- Mobile responsive (card stacking layout)
- Chart.js loaded via CDN, no impact on existing build

## DEPENDENCIES

Upstream (all completed):
- PR #15 raw_items pipeline (merged) — basis for fetch success rate & selection rate
- users table + Google OAuth — admin role foundation
- digests table with user_id — read rate analysis
- marks table with user_id — bookmark rate analysis
- sources + user_subscriptions — Source contribution & subscription stats
- Digest generation flow — needs metadata extension for source_contributions

Downstream consumers:
- Recommendation system (user behavior from events)
- A/B testing framework (event tracking foundation)
- Source Market ranking (selection rate + fetch success as signals)
- Push optimization (push_open data)
- v3.6+ paid tiers (usage data for pricing)

External dependency:
- Chart.js via CDN (cdn.jsdelivr.net/npm/chart.js) — ~60KB gzip, no other third-party libs needed.

---
Author: Lucy · ClawFeed Phase 3
