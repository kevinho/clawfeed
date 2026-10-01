#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const require = createRequire(`${ROOT}/package.json`);
const Database = require('better-sqlite3');

const DEFAULT_DB = join(ROOT, 'data', 'digest.db');
const DEFAULT_USER_SLUG = 'kevin';
const X_BEARER_FALLBACK = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
const HOME_QUERY_ID_FALLBACK = '0Q7Duc1hJgZkVNZrHeJOXw';
const SEARCH_QUERY_ID_FALLBACK = 'Yw6L66Pw54NHKuq4Dp7b4Q';
const FOLLOWING_QUERY_ID_FALLBACK = 'U96721pgL7wU5QUwu2goUA';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--db') args.db = argv[++i];
    else if (a === '--user-slug') args.userSlug = argv[++i];
    else if (a === '--pages') args.pages = Number(argv[++i]);
    else if (a === '--limit') args.limit = Number(argv[++i]);
    else if (a === '--hours') args.hours = Number(argv[++i]);
    else if (a === '--query') args.query = argv[++i];
    else if (a === '--slice-minutes') args.sliceMinutes = Number(argv[++i]);
    else if (a === '--min-slice-minutes') args.minSliceMinutes = Number(argv[++i]);
    else if (a === '--pages-per-slice') args.pagesPerSlice = Number(argv[++i]);
    else if (a === '--batch-hours') args.batchHours = Number(argv[++i]);
    else if (a === '--candidate-hours') args.candidateHours = Number(argv[++i]);
    else if (a === '--sampled-hours') args.sampledHours = Number(argv[++i]);
    else if (a === '--no-popular-refresh') args.popularRefresh = false;
    else if (a === '--popular-refresh-min-faves') args.popularRefreshMinFaves = Number(argv[++i]);
    else if (a === '--popular-refresh-pages') args.popularRefreshPages = Number(argv[++i]);
    else if (a === '--exclude-active-source') args.excludeActiveSource = true;
    else if (a === '--sync-following-pages') args.syncFollowingPages = Number(argv[++i]);
    else if (a === '--file') args.file = argv[++i];
    else if (a === '--json') args.json = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else args._.push(a);
  }
  return args;
}

function usage() {
  console.log(`Usage: scripts/clawfeed-x-pipeline.mjs <fetch|fetch-following|sync-following|candidates|popular|insert|run|run-following|run-following-popular|run-home-popular> [options]\n\nCommands:\n  fetch            Fetch X Home timeline via the logged-in OpenClaw browser session and store raw_items\n  fetch-following  Fetch latest tweets from all followed accounts via X search filter:follows\n  sync-following   Best-effort sync of ClawFeed twitter_feed sources to the logged-in X account's current Following list\n  candidates       Print recent high-signal raw_items for a digest\n  insert           Insert a digest from stdin or --file into ClawFeed\n  run              Fetch Home timeline + print candidates (cron/agent composes the digest)\n  run-following    Fetch all-following timeline + print candidates\n  run-following-popular  Fetch live all-following tweets, then rank only rows refreshed by this run\n  run-home-popular  Fetch a For you (Home) sample, then rank all samples from --sampled-hours (default 24) by likes\n\nOptions:\n  --pages N       X API pages to fetch (default fetch/run: 6, following: 300)\n  --limit N       Candidate count (default: 40)\n  --hours N       Candidate lookback/fetch stop hours (default: 30)\n  --query Q       X search query for fetch-following (default: filter:follows)\n  --slice-minutes N  Time-slice width for exhaustive following search (default: 10)\n  --min-slice-minutes N  Smallest adaptive split window when a slice is still full (default: 1)\n  --pages-per-slice N  Search pages per time slice (default: 2)\n  --batch-hours N  Browser-evaluate batch size in hours (default: 1)\n  --candidate-hours N  Candidate lookback for run/run-following (default: --hours)\n  --sync-following-pages N  Page budget for manual current-following sync (default: 120)\n  --no-popular-refresh  Disable the min_faves backfill used by run-following-popular\n  --popular-refresh-min-faves N  Backfill threshold for viral posts that grew after initial ingest (default: 100)\n  --popular-refresh-pages N  Page budget for the popular backfill (default: 2 pages per candidate hour, min 60)\n  --exclude-active-source  Exclude posts from active twitter_feed subscriptions when ranking popular rows\n  --db PATH       SQLite DB path\n  --user-slug S   ClawFeed user slug (default: kevin)\n  --file PATH     Digest file for insert\n  --json          JSON output where supported`);
}

function getDb(dbPath = DEFAULT_DB) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  ensureRawItems(db);
  return db;
}

function ensureRawItems(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS raw_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER REFERENCES sources(id),
      source_type TEXT NOT NULL DEFAULT 'x_home',
      external_id TEXT NOT NULL,
      author_handle TEXT,
      author_name TEXT,
      url TEXT,
      title TEXT,
      content TEXT NOT NULL,
      engagement_json TEXT DEFAULT '{}',
      raw_json TEXT DEFAULT '{}',
      published_at TEXT,
      fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(source_type, external_id)
    );
    CREATE INDEX IF NOT EXISTS idx_raw_items_source ON raw_items(source_id);
    CREATE INDEX IF NOT EXISTS idx_raw_items_published ON raw_items(published_at DESC);
    CREATE INDEX IF NOT EXISTS idx_raw_items_fetched ON raw_items(fetched_at DESC);
    CREATE INDEX IF NOT EXISTS idx_raw_items_author ON raw_items(author_handle);
  `);
}

function getUser(db, slug) {
  return db.prepare('SELECT id, slug, name FROM users WHERE slug = ?').get(slug);
}

function loadSourceMap(db, userId) {
  const rows = db.prepare(`
    SELECT s.id, s.name, s.config
    FROM sources s
    JOIN user_subscriptions us ON us.source_id = s.id AND us.user_id = ? AND us.is_active = 1
    WHERE s.type LIKE 'twitter%' AND s.is_active = 1 AND COALESCE(s.is_deleted, 0) = 0
  `).all(userId);
  const map = new Map();
  for (const row of rows) {
    let handle = row.name;
    try { handle = JSON.parse(row.config || '{}').handle || handle; } catch {}
    if (!handle) continue;
    handle = String(handle).replace(/^@?/, '@').toLowerCase();
    map.set(handle, row.id);
  }
  return map;
}

function runOpenClawBrowser(args, { timeoutMs = 120000, maxBuffer = 64 * 1024 * 1024 } = {}) {
  const browserProfile = (process.env.CLAWFEED_X_BROWSER_PROFILE || '').trim();
  const profileArgs = browserProfile ? ['--browser-profile', browserProfile] : [];
  const stdout = execFileSync('openclaw', ['browser', ...profileArgs, '--json', '--timeout', String(timeoutMs), ...args], {
    encoding: 'utf8',
    maxBuffer,
    timeout: timeoutMs + 10000,
  });
  return JSON.parse(stdout);
}

function summarizeError(err) {
  const parts = [err?.message, err?.stderr, err?.stdout]
    .filter(Boolean)
    .map((value) => String(value));
  const text = parts.join('\n').trim() || String(err);
  return text.split('\n').slice(-14).join('\n').slice(0, 1600);
}

function isTransientBrowserError(err) {
  return /Page closed before browser action completed|Target closed|Session closed|Execution context was destroyed|evaluate timed out|TimeoutError|WebSocket is not open|ECONNREFUSED|ECONNRESET|browser has disconnected/i
    .test(summarizeError(err));
}

function startBrowserSession() {
  const browserProfile = (process.env.CLAWFEED_X_BROWSER_PROFILE || '').trim();
  const profileArgs = browserProfile ? ['--browser-profile', browserProfile] : [];
  try {
    execFileSync('openclaw', ['browser', ...profileArgs, 'start', '--headless'], {
      encoding: 'utf8',
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 45000,
    });
  } catch {}
}

function stopBrowserSession() {
  const browserProfile = (process.env.CLAWFEED_X_BROWSER_PROFILE || '').trim();
  const profileArgs = browserProfile ? ['--browser-profile', browserProfile] : [];
  try {
    execFileSync('openclaw', ['browser', ...profileArgs, 'stop'], {
      encoding: 'utf8',
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 45000,
    });
  } catch {}
}

function restartBrowserSession() {
  stopBrowserSession();
  startBrowserSession();
}

function focusXTab() {
  let tabs;
  try { tabs = runOpenClawBrowser(['tabs'], { timeoutMs: 30000 }).tabs || []; } catch { tabs = []; }
  const page = tabs.find(t => t.type === 'page' && /^https:\/\/x\.com\//.test(t.url || '')) ||
    tabs.find(t => t.type === 'page' && /^https:\/\/twitter\.com\//.test(t.url || ''));
  if (page) {
    runOpenClawBrowser(['focus', page.suggestedTargetId || page.tabId || page.targetId], { timeoutMs: 30000 });
    return page.suggestedTargetId || page.tabId || page.targetId;
  }
  const opened = runOpenClawBrowser(['open', 'https://x.com/home'], { timeoutMs: 30000 });
  return opened.suggestedTargetId || opened.tabId || opened.targetId;
}

function evaluateOnX(fn, { timeoutMs = 120000, maxBuffer = 64 * 1024 * 1024, label = 'evaluate' } = {}) {
  const retries = Math.max(0, Number(process.env.CLAWFEED_X_BROWSER_RETRIES || 2));
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) restartBrowserSession();
    try {
      focusXTab();
      return runOpenClawBrowser(['evaluate', '--fn', fn], { timeoutMs, maxBuffer }).result;
    } catch (err) {
      lastErr = err;
      if (attempt >= retries || !isTransientBrowserError(err)) throw err;
      console.error(`[clawfeed-x-pipeline] transient browser ${label} failure; retry ${attempt + 1}/${retries}: ${summarizeError(err)}`);
    }
  }
  throw lastErr;
}

function makeFetchFn(pages) {
  return `async () => {
    const maxPages = ${Number(pages) || 6};
    const BEARER_FALLBACK = ${JSON.stringify(X_BEARER_FALLBACK)};
    const HOME_QUERY_ID_FALLBACK = ${JSON.stringify(HOME_QUERY_ID_FALLBACK)};
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    if (!location.hostname.endsWith('x.com')) location.href = 'https://x.com/home';
    await sleep(800);

    async function getClientConfig() {
      let bearer = BEARER_FALLBACK;
      let homeQueryId = HOME_QUERY_ID_FALLBACK;
      const mainSrc = Array.from(document.scripts).map(s => s.src).find(src => src.includes('/responsive-web/client-web/main.') && src.endsWith('.js'));
      if (mainSrc) {
        try {
          const js = await (await fetch(mainSrc, { credentials: 'omit' })).text();
          const b = js.match(/AAAAAAAAAAAAAAAAAAAAA[^"']+/);
          if (b) bearer = b[0];
          const q = js.match(/queryId:"([^"]+)",operationName:"HomeTimeline"/);
          if (q) homeQueryId = q[1];
        } catch {}
      }
      return { bearer, homeQueryId };
    }

    const features = {
      rweb_video_screen_enabled:false,
      rweb_cashtags_enabled:true,
      profile_label_improvements_pcf_label_in_post_enabled:true,
      responsive_web_profile_redirect_enabled:false,
      rweb_tipjar_consumption_enabled:false,
      verified_phone_label_enabled:false,
      creator_subscriptions_tweet_preview_api_enabled:true,
      responsive_web_graphql_timeline_navigation_enabled:true,
      responsive_web_graphql_skip_user_profile_image_extensions_enabled:false,
      premium_content_api_read_enabled:false,
      communities_web_enable_tweet_community_results_fetch:true,
      c9s_tweet_anatomy_moderator_badge_enabled:true,
      responsive_web_grok_analyze_button_fetch_trends_enabled:false,
      responsive_web_grok_analyze_post_followups_enabled:true,
      rweb_cashtags_composer_attachment_enabled:true,
      responsive_web_jetfuel_frame:true,
      responsive_web_grok_share_attachment_enabled:true,
      responsive_web_grok_annotations_enabled:true,
      articles_preview_enabled:true,
      responsive_web_edit_tweet_api_enabled:true,
      graphql_is_translatable_rweb_tweet_is_translatable_enabled:true,
      view_counts_everywhere_api_enabled:true,
      longform_notetweets_consumption_enabled:true,
      responsive_web_twitter_article_tweet_consumption_enabled:true,
      content_disclosure_indicator_enabled:true,
      content_disclosure_ai_generated_indicator_enabled:true,
      responsive_web_grok_show_grok_translated_post:true,
      responsive_web_grok_analysis_button_from_backend:true,
      post_ctas_fetch_enabled:true,
      freedom_of_speech_not_reach_fetch_enabled:true,
      standardized_nudges_misinfo:true,
      tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled:true,
      longform_notetweets_rich_text_read_enabled:true,
      longform_notetweets_inline_media_enabled:false,
      responsive_web_grok_image_annotation_enabled:true,
      responsive_web_grok_imagine_annotation_enabled:true,
      responsive_web_grok_community_note_auto_translation_is_enabled:true,
      responsive_web_enhance_cards_enabled:false
    };
    const fieldToggles = {
      withPayments:true,
      withAuxiliaryUserLabels:true,
      withArticleRichContentState:true,
      withArticlePlainText:true,
      withArticleSummaryText:true,
      withArticleVoiceOver:false,
      withGrokAnalyze:false,
      withDisallowedReplyControls:true
    };
    const { bearer, homeQueryId } = await getClientConfig();
    const ct0 = (document.cookie.match(/(?:^|; )ct0=([^;]+)/)||[])[1] || '';
    if (!ct0) return { ok:false, error:'missing_ct0_cookie_login_required', tweets:[] };
    const endpoint = 'https://x.com/i/api/graphql/' + homeQueryId + '/HomeTimeline';
    const headers = {
      authorization:'Bearer '+bearer,
      'x-csrf-token':ct0,
      'content-type':'application/json',
      'x-twitter-active-user':'yes',
      'x-twitter-auth-type':'OAuth2Session',
      'x-twitter-client-language':'en'
    };
    const tweets = new Map();
    const pages = [];
    const seenTweetIds = [];
    let cursor = null;

    function legacyText(legacy, noteTweet) {
      const note = noteTweet?.note_tweet_results?.result;
      return note?.text || legacy?.full_text || legacy?.text || '';
    }
    function addTweet(result, context = {}) {
      if (!result || typeof result !== 'object') return;
      if (result.__typename === 'TweetWithVisibilityResults') result = result.tweet;
      if (result.__typename === 'TweetTombstone' || result.__typename === 'TweetUnavailable') return;
      const legacy = result.legacy;
      if (!legacy?.id_str) return;
      const core = result.core?.user_results?.result;
      const userCore = core?.core || {};
      const userLegacy = core?.legacy || {};
      const screen = userCore.screen_name || userLegacy.screen_name;
      const text = legacyText(legacy, result.note_tweet);
      if (!screen || !text || /^RT @/.test(text)) return;
      const id = legacy.id_str;
      if (tweets.has(id)) return;
      tweets.set(id, {
        id,
        text,
        authorHandle:'@' + screen,
        authorName:userCore.name || userLegacy.name || screen,
        createdAt: legacy.created_at || null,
        url:'https://x.com/' + screen + '/status/' + id,
        lang: legacy.lang || null,
        favoriteCount: legacy.favorite_count || 0,
        retweetCount: legacy.retweet_count || 0,
        replyCount: legacy.reply_count || 0,
        quoteCount: legacy.quote_count || 0,
        viewCount: Number(result.views?.count || legacy.ext_views?.count || 0) || 0,
        context
      });
      seenTweetIds.push(id);
    }
    function walk(o, context = {}) {
      if (!o || typeof o !== 'object') return;
      if (o.tweet_results?.result) addTweet(o.tweet_results.result, context);
      if (o.itemContent?.tweet_results?.result) addTweet(o.itemContent.tweet_results.result, context);
      if (Array.isArray(o)) for (const v of o) walk(v, context);
      else for (const [k, v] of Object.entries(o)) {
        if (k === 'quoted_status_result' || k === 'retweeted_status_result') continue;
        walk(v, context);
      }
    }

    for (let page = 0; page < maxPages; page += 1) {
      const variables = {
        count: 80,
        includePromotedContent: false,
        latestControlAvailable: true,
        requestContext: page === 0 ? 'launch' : 'scroll',
        withCommunity: true,
        seenTweetIds: seenTweetIds.slice(-500)
      };
      if (cursor) variables.cursor = cursor;
      const resp = await fetch(endpoint, {
        method:'POST',
        credentials:'include',
        headers,
        body: JSON.stringify({ variables, features, fieldToggles })
      });
      const text = await resp.text();
      if (!resp.ok) return { ok:false, status:resp.status, error:text.slice(0,500), tweets:Array.from(tweets.values()), pages };
      const json = JSON.parse(text);
      const instructions = json?.data?.home?.home_timeline_urt?.instructions || [];
      const entries = instructions.flatMap(i => i.entries || []);
      let bottom = null;
      for (const entry of entries) {
        const c = entry.content || {};
        if (c.entryType === 'TimelineTimelineCursor' && c.cursorType === 'Bottom') bottom = c.value;
        walk(entry, { entryId: entry.entryId || null });
      }
      pages.push({ page, status:resp.status, entries:entries.length, totalTweets:tweets.size, cursor:bottom });
      if (!bottom || bottom === cursor) break;
      cursor = bottom;
      await sleep(250);
    }
    return { ok:true, endpoint, count:tweets.size, pages, tweets:Array.from(tweets.values()) };
  }`;
}

function makeFetchFollowingSearchFn({ pages, query, hours, sliceMinutes, minSliceMinutes, pagesPerSlice, untilMs }) {
  return `async () => {
    const maxPages = ${Number(pages) || 300};
    const baseQuery = ${JSON.stringify(query || 'filter:follows')};
    const lookbackHours = ${Number(hours) || 30};
    const sliceMinutes = ${Number(sliceMinutes) || 10};
    const minSliceMinutes = ${Number(minSliceMinutes) || 1};
    const pagesPerSlice = ${Number(pagesPerSlice) || 2};
    const untilMs = ${Number(untilMs) || 0} || Date.now();
    const cutoffMs = untilMs - (lookbackHours * 60 * 60 * 1000);
    const BEARER_FALLBACK = ${JSON.stringify(X_BEARER_FALLBACK)};
    const SEARCH_QUERY_ID_FALLBACK = ${JSON.stringify(SEARCH_QUERY_ID_FALLBACK)};
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    if (!location.hostname.endsWith('x.com')) location.href = 'https://x.com/home';
    await sleep(800);

    async function getClientConfig() {
      let bearer = BEARER_FALLBACK;
      let searchQueryId = SEARCH_QUERY_ID_FALLBACK;
      const mainSrc = Array.from(document.scripts).map(s => s.src).find(src => src.includes('/responsive-web/client-web/main.') && src.endsWith('.js'));
      if (mainSrc) {
        try {
          const js = await (await fetch(mainSrc, { credentials: 'omit' })).text();
          const b = js.match(/AAAAAAAAAAAAAAAAAAAAA[^"']+/);
          if (b) bearer = b[0];
          const q = js.match(/queryId:"([^"]+)",operationName:"SearchTimeline"/);
          if (q) searchQueryId = q[1];
        } catch {}
      }
      return { bearer, searchQueryId };
    }

    const features = {
      rweb_video_screen_enabled:false,
      responsive_web_graphql_exclude_directive_enabled:true,
      verified_phone_label_enabled:false,
      creator_subscriptions_tweet_preview_api_enabled:true,
      responsive_web_graphql_timeline_navigation_enabled:true,
      responsive_web_graphql_skip_user_profile_image_extensions_enabled:false,
      c9s_tweet_anatomy_moderator_badge_enabled:true,
      tweetypie_unmention_optimization_enabled:true,
      responsive_web_edit_tweet_api_enabled:true,
      graphql_is_translatable_rweb_tweet_is_translatable_enabled:true,
      view_counts_everywhere_api_enabled:true,
      longform_notetweets_consumption_enabled:true,
      responsive_web_twitter_article_tweet_consumption_enabled:true,
      tweet_awards_web_tipping_enabled:false,
      freedom_of_speech_not_reach_fetch_enabled:true,
      standardized_nudges_misinfo:true,
      tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled:true,
      rweb_video_timestamps_enabled:true,
      longform_notetweets_rich_text_read_enabled:true,
      longform_notetweets_inline_media_enabled:true,
      responsive_web_enhance_cards_enabled:false,
      responsive_web_grok_analysis_button_from_backend:true,
      responsive_web_grok_analyze_post_followups_enabled:true,
      responsive_web_grok_share_attachment_enabled:true,
      responsive_web_grok_annotations_enabled:true
    };
    const fieldToggles = {
      withArticleRichContentState:true,
      withArticlePlainText:true,
      withGrokAnalyze:false,
      withDisallowedReplyControls:true
    };
    const { bearer, searchQueryId } = await getClientConfig();
    const ct0 = (document.cookie.match(/(?:^|; )ct0=([^;]+)/)||[])[1] || '';
    if (!ct0) return { ok:false, error:'missing_ct0_cookie_login_required', tweets:[] };
    const endpoint = 'https://x.com/i/api/graphql/' + searchQueryId + '/SearchTimeline';
    const headers = {
      authorization:'Bearer '+bearer,
      'x-csrf-token':ct0,
      'content-type':'application/json',
      'x-twitter-active-user':'yes',
      'x-twitter-auth-type':'OAuth2Session',
      'x-twitter-client-language':'en'
    };
    const tweets = new Map();
    const pages = [];
    const sliceMs = Math.max(1, sliceMinutes) * 60 * 1000;
    const minSliceMs = Math.max(1, minSliceMinutes) * 60 * 1000;
    function makeWindow(startMs, endMs) {
      return { startMs, endMs, query: baseQuery + ' since_time:' + Math.floor(startMs / 1000) + ' until_time:' + Math.floor(endMs / 1000) };
    }
    const windows = [];
    for (let endMs = untilMs; endMs > cutoffMs; endMs -= sliceMs) {
      const startMs = Math.max(cutoffMs, endMs - sliceMs);
      windows.push(makeWindow(startMs, endMs));
    }
    if (!windows.length) windows.push(makeWindow(cutoffMs, untilMs));
    let pageBudget = maxPages;
    const saturatedWindows = [];
    const truncatedWindows = [];
    let skippedWindows = 0;

    function legacyText(legacy, noteTweet) {
      const note = noteTweet?.note_tweet_results?.result;
      return note?.text || legacy?.full_text || legacy?.text || '';
    }
    function addTweet(result, context = {}) {
      if (!result || typeof result !== 'object') return;
      if (result.__typename === 'TweetWithVisibilityResults') result = result.tweet;
      if (result.__typename === 'TweetTombstone' || result.__typename === 'TweetUnavailable') return;
      const legacy = result.legacy;
      if (!legacy?.id_str) return;
      const core = result.core?.user_results?.result;
      const userCore = core?.core || {};
      const userLegacy = core?.legacy || {};
      const screen = userCore.screen_name || userLegacy.screen_name;
      const text = legacyText(legacy, result.note_tweet);
      if (!screen || !text) return;
      const id = legacy.id_str;
      if (tweets.has(id)) return;
      tweets.set(id, {
        id,
        text,
        authorHandle:'@' + screen,
        authorName:userCore.name || userLegacy.name || screen,
        createdAt: legacy.created_at || null,
        url:'https://x.com/' + screen + '/status/' + id,
        lang: legacy.lang || null,
        favoriteCount: legacy.favorite_count || 0,
        retweetCount: legacy.retweet_count || 0,
        replyCount: legacy.reply_count || 0,
        quoteCount: legacy.quote_count || 0,
        viewCount: Number(result.views?.count || legacy.ext_views?.count || 0) || 0,
        context
      });
    }
    function walk(o, context = {}) {
      if (!o || typeof o !== 'object') return;
      if (o.tweet_results?.result) addTweet(o.tweet_results.result, context);
      if (o.itemContent?.tweet_results?.result) addTweet(o.itemContent.tweet_results.result, context);
      if (Array.isArray(o)) for (const v of o) walk(v, context);
      else for (const [k, v] of Object.entries(o)) {
        if (k === 'quoted_status_result' || k === 'retweeted_status_result') continue;
        walk(v, context);
      }
    }

    while (windows.length && pageBudget > 0) {
      const window = windows.shift();
      let cursor = null;
      let hasMore = false;
      let pageCount = 0;
      for (let page = 0; page < pagesPerSlice && pageBudget > 0; page += 1) {
        const variables = {
          rawQuery: window.query,
          count: 100,
          querySource: 'typed_query',
          product: 'Latest'
        };
        if (cursor) variables.cursor = cursor;
        const resp = await fetch(endpoint, {
          method:'POST',
          credentials:'include',
          headers,
          body: JSON.stringify({ variables, features, fieldToggles })
        });
        const text = await resp.text();
        if (!resp.ok) return { ok: resp.status === 429, rateLimited: resp.status === 429, status:resp.status, error:text.slice(0,500), tweets:Array.from(tweets.values()), pages, query:baseQuery, lookbackHours, sliceMinutes, minSliceMinutes, pagesPerSlice, pageBudgetRemaining:pageBudget, saturatedWindows, truncatedWindows, skippedWindows: windows.length };
        const json = JSON.parse(text);
        const instructions = json?.data?.search_by_raw_query?.search_timeline?.timeline?.instructions || [];
        const entries = instructions.flatMap(i => i.entries || []);
        let bottom = null;
        for (const entry of entries) {
          const c = entry.content || {};
          if (c.entryType === 'TimelineTimelineCursor' && c.cursorType === 'Bottom') bottom = c.value;
          walk(entry, { entryId: entry.entryId || null, query: window.query, windowStart: new Date(window.startMs).toISOString(), windowEnd: new Date(window.endMs).toISOString() });
        }
        pageBudget -= 1;
        pageCount += 1;
        pages.push({
          page: pages.length,
          status:resp.status,
          entries:entries.length,
          totalTweets:tweets.size,
          cursor:bottom,
          windowStart:new Date(window.startMs).toISOString(),
          windowEnd:new Date(window.endMs).toISOString(),
          windowMinutes: Math.round(((window.endMs - window.startMs) / 60000) * 100) / 100
        });
        hasMore = Boolean(bottom && bottom !== cursor);
        if (!hasMore) break;
        cursor = bottom;
        await sleep(200);
      }
      if (hasMore) {
        const duration = window.endMs - window.startMs;
        if (duration > minSliceMs) {
          const mid = Math.floor((window.startMs + window.endMs) / 2);
          saturatedWindows.push({ windowStart:new Date(window.startMs).toISOString(), windowEnd:new Date(window.endMs).toISOString(), pages:pageCount, split:true });
          windows.unshift(makeWindow(mid, window.endMs), makeWindow(window.startMs, mid));
        } else {
          truncatedWindows.push({ windowStart:new Date(window.startMs).toISOString(), windowEnd:new Date(window.endMs).toISOString(), pages:pageCount });
        }
      }
    }
    skippedWindows = windows.length;
    return { ok:true, endpoint, query:baseQuery, lookbackHours, sliceMinutes, minSliceMinutes, pagesPerSlice, pageBudgetRemaining:pageBudget, saturatedWindows, truncatedWindows, skippedWindows, count:tweets.size, pages, tweets:Array.from(tweets.values()) };
  }`;
}

function makeFetchFollowingListFn({ pages }) {
  return `async () => {
    const maxPages = ${Number(pages) || 120};
    const BEARER_FALLBACK = ${JSON.stringify(X_BEARER_FALLBACK)};
    const FOLLOWING_QUERY_ID_FALLBACK = ${JSON.stringify(FOLLOWING_QUERY_ID_FALLBACK)};
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    if (!location.hostname.endsWith('x.com')) location.href = 'https://x.com/home';
    await sleep(800);

    async function getClientConfig() {
      let bearer = BEARER_FALLBACK;
      let followingQueryId = FOLLOWING_QUERY_ID_FALLBACK;
      const mainSrc = Array.from(document.scripts).map(s => s.src).find(src => src.includes('/responsive-web/client-web/main.') && src.endsWith('.js'));
      if (mainSrc) {
        try {
          const js = await (await fetch(mainSrc, { credentials: 'omit' })).text();
          const b = js.match(/AAAAAAAAAAAAAAAAAAAAA[^"']+/);
          if (b) bearer = b[0];
          const q = js.match(/queryId:"([^"]+)",operationName:"Following"/);
          if (q) followingQueryId = q[1];
        } catch {}
      }
      return { bearer, followingQueryId };
    }

    const features = {
      rweb_video_screen_enabled:false,
      rweb_cashtags_enabled:true,
      profile_label_improvements_pcf_label_in_post_enabled:true,
      responsive_web_profile_redirect_enabled:false,
      rweb_tipjar_consumption_enabled:false,
      verified_phone_label_enabled:false,
      creator_subscriptions_tweet_preview_api_enabled:true,
      responsive_web_graphql_timeline_navigation_enabled:true,
      responsive_web_graphql_skip_user_profile_image_extensions_enabled:false,
      premium_content_api_read_enabled:false,
      communities_web_enable_tweet_community_results_fetch:true,
      c9s_tweet_anatomy_moderator_badge_enabled:true,
      responsive_web_grok_analyze_button_fetch_trends_enabled:false,
      responsive_web_grok_analyze_post_followups_enabled:true,
      rweb_cashtags_composer_attachment_enabled:true,
      responsive_web_jetfuel_frame:true,
      responsive_web_grok_share_attachment_enabled:true,
      responsive_web_grok_annotations_enabled:true,
      articles_preview_enabled:true,
      responsive_web_edit_tweet_api_enabled:true,
      rweb_conversational_replies_downvote_enabled:false,
      graphql_is_translatable_rweb_tweet_is_translatable_enabled:true,
      view_counts_everywhere_api_enabled:true,
      longform_notetweets_consumption_enabled:true,
      responsive_web_twitter_article_tweet_consumption_enabled:true,
      content_disclosure_indicator_enabled:true,
      content_disclosure_ai_generated_indicator_enabled:true,
      responsive_web_grok_show_grok_translated_post:true,
      responsive_web_grok_analysis_button_from_backend:true,
      post_ctas_fetch_enabled:true,
      freedom_of_speech_not_reach_fetch_enabled:true,
      standardized_nudges_misinfo:true,
      tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled:true,
      longform_notetweets_rich_text_read_enabled:true,
      longform_notetweets_inline_media_enabled:false,
      responsive_web_grok_image_annotation_enabled:true,
      responsive_web_grok_imagine_annotation_enabled:true,
      responsive_web_grok_community_note_auto_translation_is_enabled:true,
      responsive_web_enhance_cards_enabled:false
    };
    const fieldToggles = {
      withPayments:true,
      withAuxiliaryUserLabels:true,
      withArticleRichContentState:true,
      withArticlePlainText:true,
      withArticleSummaryText:true,
      withArticleVoiceOver:false,
      withGrokAnalyze:false,
      withDisallowedReplyControls:true
    };
    const { bearer, followingQueryId } = await getClientConfig();
    const ct0 = (document.cookie.match(/(?:^|; )ct0=([^;]+)/)||[])[1] || '';
    const twid = decodeURIComponent((document.cookie.match(/(?:^|; )twid=([^;]+)/)||[])[1] || '');
    const userId = (twid.match(/u=(\\d+)/)||[])[1] || '';
    if (!ct0 || !userId) return { ok:false, error:'missing_x_login_cookie', following:[] };
    const endpoint = 'https://x.com/i/api/graphql/' + followingQueryId + '/Following';
    const headers = {
      authorization:'Bearer '+bearer,
      'x-csrf-token':ct0,
      'content-type':'application/json',
      'x-twitter-active-user':'yes',
      'x-twitter-auth-type':'OAuth2Session',
      'x-twitter-client-language':'en'
    };
    const users = new Map();
    const pageSummaries = [];
    let cursor = null;
    let complete = false;

    function addUser(result) {
      if (!result || typeof result !== 'object') return;
      if (result.__typename === 'UserUnavailable' || result.__typename === 'UserTombstone') return;
      const restId = result.rest_id || result.id_str || '';
      if (restId && restId === userId) return;
      const core = result.core || {};
      const legacy = result.legacy || {};
      const screen = core.screen_name || legacy.screen_name;
      if (!screen) return;
      const handle = '@' + String(screen).replace(/^@/, '');
      users.set(handle.toLowerCase(), {
        handle,
        screenName: String(screen),
        name: core.name || legacy.name || screen,
        restId: restId || null
      });
    }
    function walk(o) {
      if (!o || typeof o !== 'object') return;
      if (o.user_results?.result) addUser(o.user_results.result);
      if (Array.isArray(o)) for (const v of o) walk(v);
      else for (const v of Object.values(o)) walk(v);
    }

    for (let page = 0; page < maxPages; page += 1) {
      const variables = {
        userId,
        count: 200,
        includePromotedContent: false
      };
      if (cursor) variables.cursor = cursor;
      const resp = await fetch(endpoint, {
        method:'POST',
        credentials:'include',
        headers,
        body: JSON.stringify({ variables, features, fieldToggles })
      });
      const text = await resp.text();
      if (!resp.ok) return { ok:false, rateLimited:resp.status === 429, status:resp.status, error:text.slice(0,500), following:Array.from(users.values()), pages:pageSummaries, complete:false };
      const json = JSON.parse(text);
      const instructions = json?.data?.user?.result?.timeline?.timeline?.instructions || [];
      const entries = instructions.flatMap(i => i.entries || []);
      let bottom = null;
      for (const entry of entries) {
        const c = entry.content || {};
        if (c.entryType === 'TimelineTimelineCursor' && c.cursorType === 'Bottom') bottom = c.value;
        walk(entry);
      }
      pageSummaries.push({ page, status:resp.status, entries:entries.length, totalFollowing:users.size, cursor:bottom });
      if (!bottom || bottom === cursor) {
        complete = true;
        break;
      }
      cursor = bottom;
      await sleep(150);
    }
    return { ok:true, endpoint, userId, count:users.size, pageBudget:maxPages, pages:pageSummaries, complete, following:Array.from(users.values()) };
  }`;
}

function normalizeHandle(value) {
  const handle = String(value || '').trim().replace(/^@?/, '@');
  return /^@[A-Za-z0-9_]{1,15}$/.test(handle) ? handle : '';
}

function sourceHandle(row) {
  let handle = row?.name;
  try { handle = JSON.parse(row?.config || '{}').handle || handle; } catch {}
  return normalizeHandle(handle);
}

function normalizeIsoDate(createdAt) {
  if (!createdAt) return null;
  const d = new Date(createdAt);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function fetchTweets({ dbPath, userSlug, pages }) {
  const db = getDb(dbPath);
  const user = getUser(db, userSlug);
  if (!user) throw new Error(`No ClawFeed user found for slug ${userSlug}`);
  const sourceByHandle = loadSourceMap(db, user.id);

  const result = evaluateOnX(makeFetchFn(pages), {
    timeoutMs: Math.max(120000, (pages || 6) * 25000),
    label: 'home fetch',
  });
  if (!result?.ok) throw new Error(`X fetch failed: ${JSON.stringify(result || {})}`);

  const stmt = db.prepare(`
    INSERT INTO raw_items (
      source_id, source_type, external_id, author_handle, author_name, url, title,
      content, engagement_json, raw_json, published_at, fetched_at
    ) VALUES (?, 'x_home', ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(source_type, external_id) DO UPDATE SET
      source_id = excluded.source_id,
      author_handle = excluded.author_handle,
      author_name = excluded.author_name,
      url = excluded.url,
      title = excluded.title,
      content = excluded.content,
      engagement_json = excluded.engagement_json,
      raw_json = excluded.raw_json,
      published_at = excluded.published_at,
      fetched_at = datetime('now')
  `);
  let insertedOrUpdated = 0;
  let matchedSources = 0;
  const tx = db.transaction((tweets) => {
    for (const t of tweets) {
      const sourceId = sourceByHandle.get(String(t.authorHandle || '').toLowerCase()) || null;
      if (sourceId) matchedSources += 1;
      const info = stmt.run(
        sourceId,
        t.id,
        t.authorHandle,
        t.authorName,
        t.url,
        `${t.authorName || t.authorHandle}: ${String(t.text || '').slice(0, 120)}`,
        t.text,
        JSON.stringify({ favoriteCount:t.favoriteCount, retweetCount:t.retweetCount, replyCount:t.replyCount, quoteCount:t.quoteCount, viewCount:t.viewCount, lang:t.lang }),
        JSON.stringify(t),
        normalizeIsoDate(t.createdAt)
      );
      insertedOrUpdated += info.changes || 0;
    }
  });
  tx(result.tweets || []);
  return {
    ok: true,
    fetched: result.tweets?.length || 0,
    storedChanges: insertedOrUpdated,
    matchedSources,
    pages: result.pages,
    latestTweetUrls: (result.tweets || []).slice(0, 10).map(t => t.url),
  };
}

function fetchFollowingSearch({ dbPath, userSlug, pages, hours, query, sliceMinutes, minSliceMinutes, pagesPerSlice, batchHours }) {
  const db = getDb(dbPath);
  const user = getUser(db, userSlug);
  if (!user) throw new Error(`No ClawFeed user found for slug ${userSlug}`);
  const sourceByHandle = loadSourceMap(db, user.id);

  focusXTab();
  const totalHours = Number(hours) || 30;
  const batchSizeHours = Math.max(0.1, Math.min(Number(batchHours) || 1, totalHours));
  const totalPageBudget = Number(pages) || 300;
  const allTweets = new Map();
  const allPages = [];
  const batches = [];
  let partialFailures = 0;
  let pageBudget = totalPageBudget;
  let endMs = Date.now();
  const cutoffMs = endMs - totalHours * 60 * 60 * 1000;

  while (endMs > cutoffMs && pageBudget > 0) {
    const currentHours = Math.min(batchSizeHours, (endMs - cutoffMs) / (60 * 60 * 1000));
    const windowsInBatch = Math.ceil((currentHours * 60) / (Number(sliceMinutes) || 10));
    const batchPages = Math.min(pageBudget, Math.max(1, windowsInBatch * (Number(pagesPerSlice) || 2)));
    const result = evaluateOnX(makeFetchFollowingSearchFn({
      pages: batchPages,
      hours: currentHours,
      query,
      sliceMinutes,
      minSliceMinutes,
      pagesPerSlice,
      untilMs: endMs,
    }), {
      timeoutMs: Math.max(90000, batchPages * 4000),
      maxBuffer: 128 * 1024 * 1024,
      label: `following search batch ${batches.length + 1}`,
    });

    for (const t of result.tweets || []) allTweets.set(t.id, t);
    for (const p of result.pages || []) allPages.push({ ...p, batch: batches.length });
    batches.push({
      hours: currentHours,
      until: new Date(endMs).toISOString(),
      fetched: result.tweets?.length || 0,
      pages: result.pages?.length || 0,
      pageBudgetRemaining: result.pageBudgetRemaining,
      saturatedWindows: result.saturatedWindows?.length || 0,
      truncatedWindows: result.truncatedWindows?.length || 0,
      skippedWindows: result.skippedWindows || 0,
      rateLimited: Boolean(result.rateLimited),
      status: result.status || 200,
      ok: Boolean(result.ok),
      error: result.error || null,
    });
    pageBudget -= result.pages?.length || 0;
    if (!result?.ok) {
      partialFailures += 1;
      if (result.rateLimited) break;
      if (Number(result.status || 0) >= 500) {
        endMs -= currentHours * 60 * 60 * 1000;
        continue;
      }
      throw new Error(`X following search fetch failed: ${JSON.stringify(result || {})}`);
    }
    if (result.rateLimited) break;
    endMs -= currentHours * 60 * 60 * 1000;
  }

  const tweets = Array.from(allTweets.values());
  const stmt = db.prepare(`
    INSERT INTO raw_items (
      source_id, source_type, external_id, author_handle, author_name, url, title,
      content, engagement_json, raw_json, published_at, fetched_at
    ) VALUES (?, 'x_following_search', ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(source_type, external_id) DO UPDATE SET
      source_id = excluded.source_id,
      author_handle = excluded.author_handle,
      author_name = excluded.author_name,
      url = excluded.url,
      title = excluded.title,
      content = excluded.content,
      engagement_json = excluded.engagement_json,
      raw_json = excluded.raw_json,
      published_at = excluded.published_at,
      fetched_at = datetime('now')
  `);
  let insertedOrUpdated = 0;
  let matchedSources = 0;
  const tx = db.transaction((tweetsToStore) => {
    for (const t of tweetsToStore) {
      const sourceId = sourceByHandle.get(String(t.authorHandle || '').toLowerCase()) || null;
      if (sourceId) matchedSources += 1;
      const info = stmt.run(
        sourceId,
        t.id,
        t.authorHandle,
        t.authorName,
        t.url,
        `${t.authorName || t.authorHandle}: ${String(t.text || '').slice(0, 120)}`,
        t.text,
        JSON.stringify({ favoriteCount:t.favoriteCount, retweetCount:t.retweetCount, replyCount:t.replyCount, quoteCount:t.quoteCount, viewCount:t.viewCount, lang:t.lang }),
        JSON.stringify(t),
        normalizeIsoDate(t.createdAt)
      );
      insertedOrUpdated += info.changes || 0;
    }
  });
  tx(tweets);
  return {
    ok: true,
    query: query || 'filter:follows',
    lookbackHours: totalHours,
    sliceMinutes: sliceMinutes || 10,
    minSliceMinutes: minSliceMinutes || 1,
    pagesPerSlice: pagesPerSlice || 2,
    batchHours: batchSizeHours,
    pageBudgetRemaining: pageBudget,
    rateLimited: batches.some(b => b.rateLimited),
    partial: partialFailures > 0,
    partialFailures,
    fetched: tweets.length,
    storedChanges: insertedOrUpdated,
    matchedSources,
    batches,
    saturatedWindows: batches.reduce((n, b) => n + (b.saturatedWindows || 0), 0),
    truncatedWindows: batches.reduce((n, b) => n + (b.truncatedWindows || 0), 0),
    skippedWindows: batches.reduce((n, b) => n + (b.skippedWindows || 0), 0),
    pages: allPages,
    latestTweetUrls: tweets.slice(0, 10).map(t => t.url),
  };
}

function fetchFollowingList({ pages }) {
  focusXTab();
  const pageBudget = Number(pages) || 120;
  const result = evaluateOnX(makeFetchFollowingListFn({ pages: pageBudget }), {
    timeoutMs: Math.max(120000, pageBudget * 2500),
    maxBuffer: 128 * 1024 * 1024,
    label: 'current following sync',
  });
  if (!result?.ok) throw new Error(`X following list fetch failed: ${JSON.stringify(result || {})}`);
  if (!result.complete) throw new Error(`X following list fetch did not complete within ${pageBudget} pages`);
  return result;
}

function syncFollowingSources({ dbPath, userSlug, pages }) {
  const db = getDb(dbPath);
  const user = getUser(db, userSlug);
  if (!user) throw new Error(`No ClawFeed user found for slug ${userSlug}`);

  const result = fetchFollowingList({ pages });
  const latestByHandle = new Map();
  for (const account of result.following || []) {
    const handle = normalizeHandle(account.handle || account.screenName);
    if (!handle) continue;
    latestByHandle.set(handle.toLowerCase(), { ...account, handle });
  }
  if (!latestByHandle.size) throw new Error('X following list fetch returned zero handles');

  const existingRows = db.prepare(`
    SELECT
      s.id,
      s.name,
      s.config,
      s.created_by,
      s.is_active AS source_active,
      COALESCE(s.is_deleted, 0) AS is_deleted,
      us.id AS subscription_id,
      us.is_active AS subscription_active
    FROM sources s
    LEFT JOIN user_subscriptions us ON us.source_id = s.id AND us.user_id = ?
    WHERE s.type = 'twitter_feed'
  `).all(user.id);
  const sourceByHandle = new Map();
  const subscribedByHandle = new Map();
  for (const row of existingRows) {
    const handle = sourceHandle(row);
    if (!handle) continue;
    const key = handle.toLowerCase();
    if (!sourceByHandle.has(key)) sourceByHandle.set(key, row);
    if (row.subscription_id && !subscribedByHandle.has(key)) subscribedByHandle.set(key, row);
  }

  const insertSource = db.prepare(`
    INSERT INTO sources (name, type, config, is_public, created_by, is_active, is_deleted, deleted_at, updated_at)
    VALUES (?, 'twitter_feed', ?, 0, ?, 1, 0, NULL, datetime('now'))
  `);
  const activateSource = db.prepare(`
    UPDATE sources
    SET name = ?, config = ?, is_active = 1, is_deleted = 0, deleted_at = NULL, updated_at = datetime('now')
    WHERE id = ?
  `);
  const insertSubscription = db.prepare(`
    INSERT OR IGNORE INTO user_subscriptions (user_id, source_id, is_active)
    VALUES (?, ?, 1)
  `);
  const activateSubscription = db.prepare(`
    UPDATE user_subscriptions
    SET is_active = 1
    WHERE user_id = ? AND source_id = ?
  `);
  const deactivateSubscription = db.prepare(`
    UPDATE user_subscriptions
    SET is_active = 0
    WHERE user_id = ? AND source_id = ?
  `);
  const deactivateOrphanSource = db.prepare(`
    UPDATE sources
    SET is_active = 0, updated_at = datetime('now')
    WHERE id = ?
      AND NOT EXISTS (
        SELECT 1 FROM user_subscriptions
        WHERE source_id = ? AND is_active = 1
      )
  `);
  const deleteRawForHandle = db.prepare(`
    DELETE FROM raw_items
    WHERE lower(author_handle) = ?
       OR lower(url) LIKE ?
  `);

  const stats = {
    ok: true,
    fetched: latestByHandle.size,
    pages: result.pages?.length || 0,
    complete: result.complete,
    created: 0,
    reactivatedSources: 0,
    activatedSubscriptions: 0,
    deactivatedSubscriptions: 0,
    deletedRawRows: 0,
    generatedAt: new Date().toISOString(),
  };

  const tx = db.transaction(() => {
    for (const [key, account] of latestByHandle) {
      const handle = account.handle;
      const config = JSON.stringify({ handle });
      let source = sourceByHandle.get(key);
      if (!source) {
        const info = insertSource.run(handle, config, user.id);
        source = { id: Number(info.lastInsertRowid), name: handle, config, subscription_id: null, subscription_active: 0 };
        sourceByHandle.set(key, source);
        stats.created += 1;
      } else if (!source.source_active || source.is_deleted || source.name !== handle || source.config !== config) {
        activateSource.run(handle, config, source.id);
        stats.reactivatedSources += 1;
      }
      insertSubscription.run(user.id, source.id);
      if (!source.subscription_active) {
        activateSubscription.run(user.id, source.id);
        stats.activatedSubscriptions += 1;
      }
    }

    for (const [key, source] of subscribedByHandle) {
      if (latestByHandle.has(key) || !source.subscription_active) continue;
      deactivateSubscription.run(user.id, source.id);
      deactivateOrphanSource.run(source.id, source.id);
      const handle = sourceHandle(source).toLowerCase();
      const info = deleteRawForHandle.run(handle, `%/${handle.slice(1)}/status/%`);
      stats.deactivatedSubscriptions += 1;
      stats.deletedRawRows += info.changes || 0;
    }
  });
  tx();

  return stats;
}

const AI_KEYWORDS = [
  'ai','agent','agents','agentic','harness','openclaw','hermes','codex','claude','anthropic','openai','gpt','gemini','grok','llm','model','models','inference','mcp','cursor','vibe','coding agent','workflow','memory','sqlite','local ai','automation','eval','review','tool','tools','browser','remote-control','skill','skills'
];
const OPERATOR_KEYWORDS = ['founder','startup','saas','growth','sales','product','pm','hiring','workflow','leverage','ship','shipping'];
const BITCOIN_KEYWORDS = ['bitcoin','op_cat','opcat','bip-110','bip110','btc','lightning','x402','psbt','sats','utxo'];

function scoreItem(row) {
  const text = `${row.author_handle || ''} ${row.author_name || ''} ${row.content || ''}`.toLowerCase();
  let score = 0;
  for (const k of AI_KEYWORDS) if (text.includes(k)) score += 8;
  for (const k of OPERATOR_KEYWORDS) if (text.includes(k)) score += 3;
  for (const k of BITCOIN_KEYWORDS) if (text.includes(k)) score += 2;
  try {
    const e = JSON.parse(row.engagement_json || '{}');
    score += Math.min(20, Math.log10(1 + Number(e.favoriteCount || 0)) * 5);
    score += Math.min(12, Math.log10(1 + Number(e.viewCount || 0)) * 2);
  } catch {}
  if (/\b(ad|sponsored)\b/i.test(row.content || '')) score -= 30;
  return Math.round(score * 100) / 100;
}

function candidateRows({ dbPath, userSlug, limit = 40, hours = 30 }) {
  const db = getDb(dbPath);
  const user = getUser(db, userSlug);
  if (!user) throw new Error(`No ClawFeed user found for slug ${userSlug}`);
  const rows = db.prepare(`
    SELECT r.*
    FROM raw_items r
    WHERE r.source_type LIKE 'x_%'
      AND datetime(COALESCE(r.published_at, r.fetched_at)) >= datetime('now', ?)
      AND length(trim(r.content)) > 0
    ORDER BY datetime(COALESCE(r.published_at, r.fetched_at)) DESC
    LIMIT 20000
  `).all(`-${Number(hours) || 30} hours`);
  const seen = new Set();
  const ranked = rows
    .map(r => ({ ...r, score: scoreItem(r) }))
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score || String(b.published_at || b.fetched_at).localeCompare(String(a.published_at || a.fetched_at)))
    .filter(r => {
      if (seen.has(r.external_id)) return false;
      seen.add(r.external_id);
      return true;
    })
    .slice(0, limit)
    .map(r => ({
      id: r.external_id,
      score: r.score,
      author: r.author_handle,
      authorName: r.author_name,
      url: r.url,
      publishedAt: r.published_at,
      content: r.content,
      engagement: safeJson(r.engagement_json),
    }));
  return { ok: true, count: ranked.length, generatedAt: new Date().toISOString(), candidates: ranked };
}

function popularRows({ dbPath, userSlug, limit = 10, hours = 30, fetchedSince = null, requireActiveSource = true, excludeActiveSource = false, sourceType = 'x_following_search' }) {
  const db = getDb(dbPath);
  const user = getUser(db, userSlug);
  if (!user) throw new Error(`No ClawFeed user found for slug ${userSlug}`);
  const shouldRequireActiveSource = requireActiveSource && !excludeActiveSource;
  const fetchedSinceFilter = fetchedSince ? 'AND datetime(r.fetched_at) >= datetime(?)' : '';
  const activeSourceExists = `EXISTS (
          SELECT 1
          FROM sources s
          JOIN user_subscriptions us ON us.source_id = s.id
          WHERE us.user_id = ?
            AND us.is_active = 1
            AND s.type LIKE 'twitter%'
            AND s.is_active = 1
            AND COALESCE(s.is_deleted, 0) = 0
            AND lower(
              CASE
                WHEN substr(COALESCE(json_extract(s.config, '$.handle'), s.name), 1, 1) = '@'
                  THEN COALESCE(json_extract(s.config, '$.handle'), s.name)
                ELSE '@' || COALESCE(json_extract(s.config, '$.handle'), s.name)
              END
            ) = lower(r.author_handle)
        )`;
  const activeSourceFilter = shouldRequireActiveSource
    ? `AND ${activeSourceExists}`
    : (excludeActiveSource ? `AND NOT ${activeSourceExists}` : '');
  const params = [sourceType, `-${Number(hours) || 30} hours`];
  if (fetchedSince) params.push(fetchedSince);
  if (shouldRequireActiveSource || excludeActiveSource) params.push(user.id);
  params.push(Number(limit) || 10);
  const rows = db.prepare(`
    WITH ranked AS (
      SELECT
        r.external_id,
        r.author_handle,
        r.author_name,
        r.url,
        r.content,
        r.published_at,
        r.fetched_at,
        CAST(COALESCE(json_extract(r.engagement_json,'$.favoriteCount'), 0) AS INTEGER) AS likes,
        CAST(COALESCE(json_extract(r.engagement_json,'$.retweetCount'), 0) AS INTEGER) AS retweets,
        CAST(COALESCE(json_extract(r.engagement_json,'$.quoteCount'), 0) AS INTEGER) AS quotes,
        CAST(COALESCE(json_extract(r.engagement_json,'$.replyCount'), 0) AS INTEGER) AS replies,
        CAST(COALESCE(json_extract(r.engagement_json,'$.viewCount'), 0) AS INTEGER) AS views,
        ROW_NUMBER() OVER (PARTITION BY r.external_id ORDER BY datetime(r.fetched_at) DESC) rn
      FROM raw_items r
      WHERE r.source_type = ?
        AND datetime(COALESCE(r.published_at, r.fetched_at)) >= datetime('now', ?)
        ${fetchedSinceFilter}
        AND length(trim(r.content)) > 0
        ${activeSourceFilter}
    ), scored AS (
      SELECT
        external_id,
        author_handle,
        author_name,
        url,
        published_at,
        likes,
        retweets,
        quotes,
        replies,
        views,
        likes AS viralScore,
        content
      FROM ranked
      WHERE rn = 1
    ), author_capped AS (
      SELECT
        *,
        ROW_NUMBER() OVER (PARTITION BY lower(author_handle) ORDER BY likes DESC, views DESC) authorRank
      FROM scored
    )
    SELECT
      external_id AS id,
      author_handle AS author,
      author_name AS authorName,
      url,
      published_at AS publishedAt,
      likes,
      retweets,
      quotes,
      replies,
      views,
      viralScore,
      content
    FROM author_capped
    WHERE authorRank = 1
    ORDER BY likes DESC, views DESC
    LIMIT ?
  `).all(...params);
  const ranking = sourceType === 'x_home'
    ? 'For you (Home) timeline samples; one tweet per author; likes descending'
    : shouldRequireActiveSource
    ? 'current active local sources only; one tweet per author; likes descending'
    : (excludeActiveSource
      ? 'current live search run only; excluding active local sources; one tweet per author; likes descending'
      : 'current live search run only; one tweet per author; likes descending');
  return { ok: true, count: rows.length, generatedAt: new Date().toISOString(), hours: Number(hours) || 30, fetchedSince, requireActiveSource: shouldRequireActiveSource, excludeActiveSource, ranking, items: rows };
}

function safeJson(s) { try { return JSON.parse(s || '{}'); } catch { return {}; } }

function printCandidates(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`ClawFeed X candidates (${result.count}) — ${result.generatedAt}`);
  for (const [i, c] of result.candidates.entries()) {
    const oneLine = c.content.replace(/\s+/g, ' ').slice(0, 500);
    console.log(`\n${i + 1}. ${c.author} score=${c.score} ${c.url}`);
    console.log(oneLine);
  }
}

function printPopular(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`ClawFeed X popular (${result.count}) — ${result.generatedAt}`);
  for (const [i, c] of result.items.entries()) {
    const oneLine = c.content.replace(/\s+/g, ' ').slice(0, 300);
    console.log(`\n${i + 1}. ${c.author} likes=${c.likes} views=${c.views} retweets=${c.retweets} ${c.url}`);
    console.log(oneLine);
  }
}

function insertDigest({ dbPath, userSlug, file }) {
  const db = getDb(dbPath);
  const user = getUser(db, userSlug);
  if (!user) throw new Error(`No ClawFeed user found for slug ${userSlug}`);
  const content = file ? readFileSync(file, 'utf8') : readFileSync(0, 'utf8');
  if (!content.trim()) throw new Error('Digest content is empty');
  const metadata = JSON.stringify({ source: 'clawfeed-x-pipeline', generatedAt: new Date().toISOString() });
  const info = db.prepare('INSERT INTO digests (type, content, metadata, user_id) VALUES (?, ?, ?, ?)')
    .run('daily', content.trim(), metadata, user.id);
  return { ok: true, id: Number(info.lastInsertRowid), userSlug: user.slug, chars: content.trim().length };
}

function popularRefreshFetch({ common, args, fetchHours, candidateHours }) {
  const baseQuery = String(args.query || 'filter:follows').trim();
  if (args.popularRefresh === false || baseQuery !== 'filter:follows') return null;
  const lookbackHours = Number(candidateHours) || Number(fetchHours) || 30;
  if (lookbackHours <= (Number(fetchHours) || 30)) return null;

  const minFaves = Number.isFinite(args.popularRefreshMinFaves) && args.popularRefreshMinFaves > 0
    ? Math.floor(args.popularRefreshMinFaves)
    : 100;
  const pages = Number.isFinite(args.popularRefreshPages) && args.popularRefreshPages > 0
    ? Math.floor(args.popularRefreshPages)
    : Math.max(60, Math.ceil(lookbackHours) * 2);

  return fetchFollowingSearch({
    ...common,
    pages,
    hours: lookbackHours,
    query: `filter:follows min_faves:${minFaves}`,
    sliceMinutes: 60,
    minSliceMinutes: 15,
    pagesPerSlice: 2,
    batchHours: Math.min(6, lookbackHours),
  });
}

function failedFetchResult(err, context = {}) {
  return {
    ok: false,
    fetched: 0,
    storedChanges: 0,
    matchedSources: 0,
    pages: [],
    rateLimited: false,
    saturatedWindows: 0,
    truncatedWindows: 0,
    skippedWindows: 0,
    transientBrowserError: isTransientBrowserError(err),
    error: summarizeError(err),
    ...context,
  };
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
if (args.help || !cmd) { usage(); process.exit(args.help ? 0 : 2); }
const common = { dbPath: args.db || process.env.CLAWFEED_DB || DEFAULT_DB, userSlug: args.userSlug || process.env.CLAWFEED_USER_SLUG || DEFAULT_USER_SLUG };

try {
  if (cmd === 'fetch') {
    const out = fetchTweets({ ...common, pages: args.pages || 6 });
    console.log(JSON.stringify(out, null, 2));
  } else if (cmd === 'fetch-following') {
    const out = fetchFollowingSearch({ ...common, pages: args.pages || 300, hours: args.hours || 30, query: args.query || 'filter:follows', sliceMinutes: args.sliceMinutes || 10, minSliceMinutes: args.minSliceMinutes || 1, pagesPerSlice: args.pagesPerSlice || 2, batchHours: args.batchHours || 1 });
    console.log(JSON.stringify(out, null, 2));
  } else if (cmd === 'sync-following') {
    const out = syncFollowingSources({ ...common, pages: args.syncFollowingPages || args.pages || 120 });
    console.log(JSON.stringify(out, null, 2));
  } else if (cmd === 'candidates') {
    printCandidates(candidateRows({ ...common, limit: args.limit || 40, hours: args.candidateHours || args.hours || 30 }), args.json);
  } else if (cmd === 'popular') {
    printPopular(popularRows({ ...common, limit: args.limit || 10, hours: args.candidateHours || args.hours || 30, excludeActiveSource: Boolean(args.excludeActiveSource) }), args.json);
  } else if (cmd === 'insert') {
    console.log(JSON.stringify(insertDigest({ ...common, file: args.file }), null, 2));
  } else if (cmd === 'run') {
    const fetch = fetchTweets({ ...common, pages: args.pages || 6 });
    const candidates = candidateRows({ ...common, limit: args.limit || 40, hours: args.candidateHours || args.hours || 30 });
    if (args.json) console.log(JSON.stringify({ fetch, candidates }, null, 2));
    else {
      console.log('FETCH_RESULT');
      console.log(JSON.stringify(fetch, null, 2));
      console.log('\nCANDIDATES');
      printCandidates(candidates, false);
    }
  } else if (cmd === 'run-following') {
    const fetch = fetchFollowingSearch({ ...common, pages: args.pages || 300, hours: args.hours || 30, query: args.query || 'filter:follows', sliceMinutes: args.sliceMinutes || 10, minSliceMinutes: args.minSliceMinutes || 1, pagesPerSlice: args.pagesPerSlice || 2, batchHours: args.batchHours || 1 });
    const candidates = candidateRows({ ...common, limit: args.limit || 80, hours: args.candidateHours || args.hours || 30 });
    if (args.json) console.log(JSON.stringify({ fetch, candidates }, null, 2));
    else {
      console.log('FETCH_FOLLOWING_RESULT');
      console.log(JSON.stringify(fetch, null, 2));
      console.log('\nCANDIDATES');
      printCandidates(candidates, false);
    }
  } else if (cmd === 'run-home-popular') {
    // The For you (Home) timeline: fetch a fresh sample, then rank every sample taken in
    // the last --sampled-hours (the ingest cron adds more through the day) of posts
    // published in the last --candidate-hours, by likes, one per author.
    const candidateHours = args.candidateHours || args.hours || 30;
    const sampledHours = args.sampledHours || 24;
    let fetch;
    try {
      fetch = fetchTweets({ ...common, pages: args.pages || 20 });
    } catch (err) {
      fetch = failedFetchResult(err, { query: 'HomeTimeline', lookbackHours: Number(sampledHours) || 24 });
      console.error(`[clawfeed-x-pipeline] For you fetch failed; ranking earlier samples only: ${fetch.error}`);
    }
    const popular = popularRows({
      ...common,
      limit: args.limit || 30,
      hours: candidateHours,
      fetchedSince: new Date(Date.now() - sampledHours * 3600000).toISOString(),
      requireActiveSource: false,
      sourceType: 'x_home',
    });
    if (args.json) console.log(JSON.stringify({ fetch, popular }, null, 2));
    else {
      console.log('FETCH_HOME_RESULT');
      console.log(JSON.stringify(fetch, null, 2));
      console.log('\nPOPULAR');
      printPopular(popular, false);
    }
  } else if (cmd === 'run-following-popular') {
    const runStartedAt = new Date().toISOString();
    const fetchHours = args.hours || 30;
    const candidateHours = args.candidateHours || args.hours || 30;
    let fetch;
    try {
      fetch = fetchFollowingSearch({ ...common, pages: args.pages || 300, hours: fetchHours, query: args.query || 'filter:follows', sliceMinutes: args.sliceMinutes || 10, minSliceMinutes: args.minSliceMinutes || 1, pagesPerSlice: args.pagesPerSlice || 2, batchHours: args.batchHours || 1 });
    } catch (err) {
      fetch = failedFetchResult(err, { query: args.query || 'filter:follows', lookbackHours: Number(fetchHours) || 30 });
      console.error(`[clawfeed-x-pipeline] short catch-up failed; continuing only if live popular refresh succeeds: ${fetch.error}`);
    }
    let popularRefresh = null;
    try {
      popularRefresh = popularRefreshFetch({ common, args, fetchHours, candidateHours });
    } catch (err) {
      popularRefresh = failedFetchResult(err, { query: `${args.query || 'filter:follows'} min_faves`, lookbackHours: Number(candidateHours) || 30 });
      console.error(`[clawfeed-x-pipeline] popular refresh failed; falling back to stored all-following rows: ${popularRefresh.error}`);
    }
    const popularRefreshFailed = Boolean(popularRefresh && !popularRefresh.ok);
    const popular = popularRows({
      ...common,
      limit: args.limit || 10,
      hours: candidateHours,
      fetchedSince: popularRefreshFailed ? null : runStartedAt,
      requireActiveSource: popularRefreshFailed && !args.excludeActiveSource,
      excludeActiveSource: Boolean(args.excludeActiveSource),
    });
    if (popularRefreshFailed) {
      popular.fallback = 'stored all-following rows after popular refresh failure';
    }
    if (args.json) console.log(JSON.stringify({ fetch, popularRefresh, popular }, null, 2));
    else {
      console.log('FETCH_FOLLOWING_RESULT');
      console.log(JSON.stringify(fetch, null, 2));
      if (popularRefresh) {
        console.log('\nPOPULAR_REFRESH_RESULT');
        console.log(JSON.stringify(popularRefresh, null, 2));
      }
      console.log('\nPOPULAR');
      printPopular(popular, false);
    }
  } else {
    throw new Error(`Unknown command: ${cmd}`);
  }
} catch (err) {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
}
