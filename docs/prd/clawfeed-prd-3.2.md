# PRD 3.2: Source Market (社区源发现)

ClawFeed v3.0 · Phase 3 · P1 | Author: Lucy | 2026-02-25

## BACKGROUND

Current explore experience in Sources page has bottlenecks:
1. Low discovery efficiency — flat list, no categories, doesn't scale with 393+ users
2. No quality signals — only subscriber count, no rating mechanism
3. Packs underutilized — no classification, search, or ranking; no community contribution entry
4. No creator incentives — no profile page, no contribution stats, no recognition
5. No SEO — SPA content invisible to search engines, missing long-tail traffic

Source Market = independent page upgrading 'explore' into a full community discovery platform.

## GOALS

1. Build community discovery platform with categories, search, rankings
2. Introduce quality signals via upvote/rating system
3. Activate Pack ecosystem — searchable, rankable, classifiable, community-contributed
4. Incentivize creators via author profile pages with contribution stats
5. SEO — Market pages indexed by search engines for organic growth

## USER STORIES (6 total)

US-1: Browse Sources by category (Tech, AI/ML, News, Finance, Crypto, Design, DevOps, Product, Career, Other) with counts and instant filtering
US-2: Keyword search with real-time results, fuzzy matching (e.g. 'HN' → Hacker News), results for both Sources & Packs
US-3: Discover & install hot Packs — preview included Sources, one-click install, installed state shown
US-4: Upvote Sources — thumbs up toggle (subscribers only), total count displayed, unsub doesn't remove vote
US-5: Author profile pages — avatar, created Sources/Packs, total subscribers, join date, independent URL, SEO-indexable
US-6: Anonymous access — full browsing without login, action buttons replaced with login CTA, SSR for crawlers

## FUNCTIONAL REQUIREMENTS OVERVIEW

F-1: Market as independent page, new 'Market' nav entry. Layout: search box → hot Packs (horizontal scroll) → category tabs → sort options → Source card grid → infinite scroll
F-2: 10 predefined categories (tech, ai-ml, news, finance, crypto, design, devops, product, career, other). Optional on Source creation (default: other). Pack category = mode of its Sources' categories. Batch auto-classify existing Sources via LLM/rules.
F-3: Search via SQLite FTS5. 300ms debounce, fuzzy matching, results split into Sources & Packs, URL param sync (/market?q=...&category=...)
F-4: Sort options — composite score (default), most subscribed, highest rated, newest. Score formula: subscribers×1.0 + upvotes×2.0 + recency bonus (≤7d:+10, ≤30d:+5) + activity bonus (fetched ≤24h:+5, ≤72h:+2). Weights configurable, not hardcoded.
F-5: Thumbs-up system (not star rating). Subscribers only, toggle, one per user per source, count cached on sources table.
F-6: Author profile at /market/author/:userId — Sources list, Packs list, total subscribers, join date.
F-7: Pack detail page + browsing with category filter. Top 6 hot Packs on homepage.
F-8: SSR for all Market pages (ejs templates), meta tags + OG tags, SPA hydration after load.
F-9: Pagination — Sources 20/page, Packs 12/page, search results 10 each with 'view all' link. Score cached in DB, refreshed hourly.

## DATABASE CHANGES (Migration 010)

1. New 'categories' table: id, slug, name, display_order, created_at. Pre-seeded with 10 categories.

2. sources table additions:
   - category_id (FK → categories, default 10/other)
   - upvote_count (INTEGER, default 0, cached count)
   - market_score (REAL, default 0, hourly refresh)

3. source_packs table: + category_id (FK → categories)

4. New 'source_ratings' table: id, source_id (FK), user_id, created_at. UNIQUE(source_id, user_id). Indexes on source_id and user_id.

5. FTS5 virtual tables:
   - sources_fts (indexed: name)
   - source_packs_fts (indexed: name, description)
   - Auto-sync triggers on INSERT/UPDATE/DELETE for both tables
   - Initial data population from existing records

## BACKEND APIs (7 endpoints)

API-1: GET /api/market/sources — params: category, q, sort (score|subscribers|rating|newest), page, limit(20, max 50). Returns sources with category, subscriber_count, upvote_count, market_score, is_subscribed, is_upvoted, created_by, pagination. Uses FTS5 MATCH for search.

API-2: GET /api/market/packs — params: category, q, sort (installs|newest), page, limit. Returns packs with slug, description, category, source_count, install_count, is_installed, sources_preview (first few sources).

API-3: POST /api/market/sources/:id/upvote — Toggle upvote. Requires active subscription (403 otherwise). Returns {upvoted: bool, upvote_count: N}. INSERT/DELETE on source_ratings + update cached count.

API-4: GET /api/market/authors/:userId — Returns author profile: name, joined_at, stats (sources_created, packs_created, total_subscribers), plus full sources and packs lists.

API-5: GET /api/market/categories — Returns all categories with source_count per category.

API-6: PATCH /api/sources/:id (extended) — Existing endpoint extended to support category_id update by source creator.

API-7: GET /api/market/search — Unified search. Params: q (required), category (optional), limit (default 10 each). Returns {sources, packs, total: {sources: N, packs: N}}.

## SSR ROUTES

5 server-rendered pages via Express + ejs (or template strings):
- GET /market → Homepage (hot Packs + category entry)
- GET /market/category/:slug → Category page
- GET /market/pack/:slug → Pack detail
- GET /market/author/:userId → Author profile
- GET /market/source/:id → Source detail
Strategy: Full HTML with meta/OG tags for crawlers; SPA JS hydrates after load for interactivity.

## MARKET SCORE REFRESH

Hourly cron/setInterval recalculates market_score for all public Sources:
score = subscriber_count×1.0 + upvote_count×2.0 + recency_bonus + activity_bonus
(recency: ≤7d→+10, ≤30d→+5; activity: last_fetched ≤24h→+5, ≤72h→+2)

## FRONTEND CHANGES

FE-1: New renderMarket() top-level function with sub-components: MarketHeader (search), FeaturedPacks (horizontal scroll), CategoryTabs, SortOptions, MarketSourceList (infinite scroll), MarketEmpty state.
FE-2: SPA routes: #/market, #/market/pack/:slug, #/market/author/:userId. URL params sync for category, q, sort.
FE-3: Enriched Source cards — type icon + name, category tag, subscriber + upvote counts, clickable author name, upvote button (highlighted when active), subscribe button.
FE-4: IntersectionObserver-based infinite scroll with skeleton loading placeholders.
FE-5: 'Explore' section in Sources page gets 'Go to Source Market →' link at bottom.

## ACCEPTANCE CRITERIA (40 items)

Page & Navigation (AC-1~3): Market nav entry in top bar; page has 4 main zones (search, hot Packs, categories, Source list); independent URL #/market with browser history support.

Category Browsing (AC-4~7): All 10 categories shown with Source counts; instant filtering on click with URL sync; category + search can stack together.

Search (AC-8~11): Real-time search with 300ms debounce; fuzzy matching; friendly empty state with hot Source recommendations; search keywords in URL for sharing.

Ranking & Sorting (AC-12~14): Default composite ranking; switchable to subscribers/rating/newest; scoring algorithm correct (upvotes weighted > subscribers, recency + activity bonuses); market_score auto-refreshes hourly.

Rating System (AC-15~18): Subscribers can toggle upvote; non-subscribers see greyed button; real-time count update on card; one vote per user per source enforced by DB unique constraint.

Pack Browsing (AC-19~22): Top 6 hot Packs on homepage with horizontal scroll; Pack detail shows description + Sources list + install count + author; one-click install shows 'installed' state; 'View all' leads to full Pack list with category filter.

Author Profile (AC-23~26): Clickable author name on cards; profile shows created Sources, Packs, total subscribers, join date; direct subscribe/install from profile; independent URL /market/author/:userId.

SEO (AC-27~29): SSR output for all 5 Market page types; correct title, meta description, OG tags; crawlers receive full HTML (not empty SPA shell).

Anonymous Users (AC-30~31): Full browse access without login; action buttons replaced with login CTA.

Performance & UX (AC-32~35): Infinite scroll with skeleton loading; category/search/sort response < 300ms; mobile responsive (single column cards, horizontal scroll categories); dark/light theme support.

Data Migration (AC-36~38): All existing Sources auto-classified (LLM/rules + default 'other'); FTS index populated with all existing Sources and Packs; upvote_count and market_score initialized to 0.

PRD 1.4 Integration (AC-39~40): Explore section gets 'Go to Source Market →' link; existing subscribe/unsubscribe works identically in Market.

## DEPENDENCIES

Upstream (required before this PRD):
- PRD 1.4 Sources page refactor (status: pending) — explore section is Market's base; Source cards + subscribe/unsub reused
- Pack install API POST /api/packs/:slug/install — DONE
- Google OAuth auth system — DONE
- Core tables (sources, source_packs, user_subscriptions) — DONE

Downstream (depends on this PRD):
- PRD 3.3 Source Creation Wizard — 'Contribute Source' entry in Market
- PRD 3.4 Pack Editor — community Pack creation for Market ecosystem
- PRD 4.x Recommendation System — composite ranking is initial form, later evolves to personalized recommendations

External:
- SQLite FTS5 — included in better-sqlite3 by default, no extra install
- Template engine (ejs) — lightweight; can use native template strings instead for zero deps

---
PRD by Lucy · ClawFeed Phase 3
