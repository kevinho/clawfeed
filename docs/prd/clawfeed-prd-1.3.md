# PRD 1.3: Cron 采集集成

> ClawFeed Feature 1.3 — 动态化采集调度
> 状态：Draft
> 日期：2026-02-25
> 依赖：1.1 raw_items 采集管道 (PR #15, 已完成)

---

## 1. 背景与动机

### 当前状态

ClawFeed 在 PR #15 中实现了 `collector.mjs`——一个独立的采集进程，能从 sources 表读取到期的源并写入 `raw_items`。但目前存在几个问题：

1. **采集频率硬编码在 SQL 中**：`getSourcesDueForFetch()` 在 `db.mjs` 里用固定的 SQL 条件判断到期时间（HN/Reddit 1小时，RSS/Website 4小时），无法按 Source 或按类型灵活配置。

2. **Twitter 源完全跳过**：`getSourcesDueForFetch()` 的 `WHERE type IN (...)` 条件明确排除了 `twitter_feed`、`twitter_list` 等类型，注释写着"Phase 1.5"。实际上当前系统仍依赖外部硬编码脚本采集 Twitter 内容。

3. **单一循环间隔**：`collector.mjs --loop` 使用统一的 `COLLECTOR_INTERVAL`（默认 300秒）轮询所有源，无法让高频源（如 Twitter 30min）和低频源（如 RSS 4h）各自独立调度。

4. **采集进程与 API 服务完全分离**：Collector 是独立 Node 进程，需要 PM2 单独管理，没有与主服务的健康检查或协调机制。

### 为什么现在做

- 1.1 raw_items 管道已就绪，采集链路 `Source → Fetcher → raw_items` 已跑通
- 1.2 个性化 Digest 需要稳定的采集作为前提——如果采集不可靠，个性化就是空中楼阁
- 90% 的用户 sources 是 Twitter 类型，当前采集管道完全不覆盖，必须尽快补齐

---

## 2. 目标

| 目标 | 衡量标准 |
|------|---------|
| 采集频率可按 source type 配置 | 不同类型源在各自配置的间隔后被采集，不再硬编码 SQL |
| 替代外部硬编码脚本 | Twitter 采集纳入 collector 统一管理，外部脚本可下线 |
| 采集进程可运维 | 有健康检查、日志统计、错误报警机制 |
| 零停机部署 | Collector 重启不丢失采集进度（状态全在 DB） |

**非目标：**
- 不在本期实现 Twitter API 集成（那是 Phase 1.5 的范围）
- 不做分布式采集/消息队列（Phase 4 范围）
- 不修改前端 UI

---

## 3. 用户故事

### 3.1 运维视角（开发者/站长）

> 作为站长，我希望采集器能自动根据 source 类型以不同频率采集，这样我不需要手动维护多个 cron job 或硬编码脚本。

> 作为站长，我希望新增一个 source 后无需重启采集进程，采集器能在下一个周期自动发现并开始采集。

> 作为站长，我希望能通过 API 查看采集器的运行状态（上次运行时间、下次预计运行时间、各源状态），便于排查问题。

### 3.2 用户视角

> 作为用户，我添加一个新的 RSS 源后，希望最迟 4 小时内看到这个源的内容出现在我的 Digest 中。

> 作为用户，我的 Twitter 源应该在 30 分钟内刷新，而不是等待 4 小时的 RSS 周期。

---

## 4. 功能需求

### FR-1：Source 类型频率配置表

在系统中维护一张 source type → 采集间隔 的映射表，取代当前 `getSourcesDueForFetch()` 中的硬编码 SQL。

**默认频率配置：**

| Source Type | 采集间隔 | 说明 |
|---|---|---|
| `twitter_feed` | 30 min | 时效性最强，用户量最大 |
| `twitter_list` | 30 min | 同上 |
| `twitter_bookmarks` | 60 min | 时效性较强 |
| `hackernews` | 60 min | 热度变化较快 |
| `reddit` | 60 min | 同上 |
| `rss` | 4 h | 更新频率低 |
| `digest_feed` | 4 h | 同 RSS |
| `github_trending` | 4 h | 日维度数据 |
| `website` | 4 h | 更新频率低 |
| `custom_api` | 2 h | 可变 |

**可覆盖性：** 支持通过 `.env` 或 config 表覆盖默认值。

### FR-2：动态 Source 发现

每个采集周期开始时，从数据库动态查询所有到期的 active sources，而非依赖静态的 type 白名单。

当前代码中 `getSourcesDueForFetch()` 的硬编码 type 列表：
```sql
AND type IN ('rss', 'digest_feed', 'hackernews', 'reddit', 'github_trending', 'website')
```
需改为基于频率配置表动态生成，同时对无 fetcher 的 type 在采集时 gracefully skip（已有此逻辑）。

### FR-3：采集循环优化

当前 `--loop` 模式以固定间隔（`COLLECTOR_INTERVAL`）调用 `collectAll()`。问题是：如果间隔设为 5 分钟，但 Twitter 需要 30 分钟，那每次轮询都会查到 Twitter 还没到期，浪费查询。如果间隔设为 30 分钟，那 HN/Reddit 的 1 小时间隔精度下降。

**方案：** 保持短间隔轮询（默认 60 秒），但 `getSourcesDueForFetch()` 基于每个 source 的 `last_fetched_at` + type 频率来判断是否到期。轮询本身极轻量（一条 SQLite 查询），真正开销在网络请求。

### FR-4：采集状态 API

新增 API 端点暴露采集器运行状态，供运维监控和前端展示：

- 各 source 的采集状态（最后采集时间、下次预计时间、错误计数）
- 采集器全局统计（今日采集次数、成功/失败率）

### FR-5：Graceful Shutdown

当采集进程收到 SIGTERM/SIGINT 时：
1. 停止接受新的采集任务
2. 等待正在进行的采集完成（最长 30 秒超时）
3. 干净退出

当前 `--loop` 模式的 `setInterval` 没有清理逻辑。

---

## 5. 技术方案

### 5.1 频率配置模块

在 `collector.mjs` 中新增频率配置，取代硬编码：

```javascript
// ── 采集频率配置（分钟） ──
const DEFAULT_INTERVALS = {
  twitter_feed: 30,
  twitter_list: 30,
  twitter_bookmarks: 60,
  hackernews: 60,
  reddit: 60,
  rss: 240,
  digest_feed: 240,
  github_trending: 240,
  website: 240,
  custom_api: 120,
};

// 允许 .env 覆盖：FETCH_INTERVAL_RSS=120 → rss 改为 120 分钟
function getIntervals() {
  const intervals = { ...DEFAULT_INTERVALS };
  for (const [key, val] of Object.entries(env)) {
    const m = key.match(/^FETCH_INTERVAL_(.+)$/i);
    if (m) {
      const type = m[1].toLowerCase();
      intervals[type] = parseInt(val) || intervals[type];
    }
  }
  return intervals;
}
```

### 5.2 重构 `getSourcesDueForFetch()`

当前实现（`db.mjs` 第 534-547 行）用硬编码 SQL 判断到期。改为接收频率配置参数，动态构建查询：

```javascript
export function getSourcesDueForFetch(db, intervals = {}) {
  // 构建动态 CASE WHEN 子句
  const conditions = Object.entries(intervals)
    .map(([type, minutes]) =>
      `(type = '${type}' AND last_fetched_at < datetime('now', '-${minutes} minutes'))`
    )
    .join('\n      OR ');

  return db.prepare(`
    SELECT * FROM sources
    WHERE is_active = 1 AND is_deleted = 0
    AND (
      last_fetched_at IS NULL
      OR ${conditions}
    )
    ORDER BY last_fetched_at ASC NULLS FIRST
  `).all();
}
```

**安全说明：** `intervals` 对象由代码内部生成（不接受用户输入），type 名和分钟数都是受控值，无 SQL 注入风险。若后续需要支持用户自定义频率，改用参数化查询。

### 5.3 采集循环改造

```javascript
// 替代当前的 setInterval(collectAll, LOOP_INTERVAL)
const TICK_INTERVAL = parseInt(env.COLLECTOR_TICK || '60') * 1000; // 默认 60 秒检查一次
const intervals = getIntervals();

let running = false;
let shuttingDown = false;

async function tick() {
  if (running || shuttingDown) return;
  running = true;
  try {
    await collectAll(intervals);
  } finally {
    running = false;
  }
}

// --loop 模式
if (args.includes('--loop')) {
  console.log(`[collector] Starting loop (tick: ${TICK_INTERVAL/1000}s)`);
  console.log(`[collector] Intervals:`, intervals);

  const timer = setInterval(tick, TICK_INTERVAL);
  await tick(); // 立即执行一次

  // Graceful shutdown
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => {
      console.log(`[collector] Received ${sig}, shutting down...`);
      shuttingDown = true;
      clearInterval(timer);
      // 等待当前采集完成
      const check = setInterval(() => {
        if (!running) {
          clearInterval(check);
          console.log('[collector] Shutdown complete');
          process.exit(0);
        }
      }, 500);
      // 最长等 30 秒
      setTimeout(() => process.exit(1), 30000);
    });
  }
}
```

### 5.4 collectAll() 改造

```javascript
async function collectAll(intervals) {
  const sources = getSourcesDueForFetch(db, intervals);
  if (!sources.length) {
    // 静默跳过，不再每 60 秒打一行 "No sources due"
    return [];
  }

  console.log(`[collector] ${sources.length} source(s) due for fetch`);

  const tasks = sources.map((source) => () => collectSource(source));
  const poolResults = await runWithConcurrency(tasks, CONCURRENCY);

  // ... 结果日志（与现有逻辑相同）

  // 定期清理（不必每次 tick 都做，每小时一次即可）
  if (shouldClean()) {
    const cleaned = cleanOldRawItems(db);
    if (cleaned.changes > 0) {
      console.log(`[collector] Cleaned ${cleaned.changes} old raw_items`);
    }
  }

  return results;
}
```

### 5.5 采集状态 API

在 `server.mjs` 新增端点：

```
GET /api/collector/status
```

响应示例：
```json
{
  "sources": [
    {
      "id": 1,
      "name": "Hacker News",
      "type": "hackernews",
      "interval_minutes": 60,
      "last_fetched_at": "2026-02-25T10:30:00Z",
      "next_fetch_at": "2026-02-25T11:30:00Z",
      "fetch_count": 142,
      "fetch_error_count": 0,
      "last_error": null,
      "status": "ok"
    }
  ],
  "stats": {
    "total_sources": 224,
    "active_sources": 218,
    "paused_sources": 6,
    "fetches_24h": 1205,
    "errors_24h": 12,
    "raw_items_24h": 3421
  }
}
```

实现方式：复用已有的 `getRawItemStats()` 并扩展查询，新增 `getCollectorStatus()` 函数到 `db.mjs`。

此端点需要 API Key 认证（Bearer token），与 `POST /api/digests` 同级别权限。

### 5.6 文件变更清单

| 文件 | 变更 |
|---|---|
| `src/collector.mjs` | 新增频率配置模块、改造循环逻辑、添加 graceful shutdown |
| `src/db.mjs` | 重构 `getSourcesDueForFetch()` 接收 intervals 参数；新增 `getCollectorStatus()` |
| `src/server.mjs` | 新增 `GET /api/collector/status` 端点 |
| `.env.example` | 新增 `COLLECTOR_TICK`、`FETCH_INTERVAL_*` 配置说明 |
| 无新增 migration | 不需要 schema 变更，复用现有 sources 表字段 |

---

## 6. 配置设计

### 6.1 环境变量

```bash
# ── Collector 配置 ──

# 检查周期：多久检查一次有没有到期的 source（秒）
# 建议设为最高频源的一半间隔（Twitter 30min → tick 60s 足够）
COLLECTOR_TICK=60

# 并发上限：同时采集的 source 数
COLLECTOR_CONCURRENCY=5

# 按 source type 覆盖默认采集间隔（分钟）
# 格式：FETCH_INTERVAL_<TYPE>=<minutes>
# 示例：
# FETCH_INTERVAL_RSS=120           # RSS 改为 2 小时
# FETCH_INTERVAL_HACKERNEWS=30     # HN 改为 30 分钟
# FETCH_INTERVAL_TWITTER_FEED=15   # Twitter 改为 15 分钟
```

### 6.2 默认频率表

| Source Type | 默认间隔 | 环境变量 Key |
|---|---|---|
| `twitter_feed` | 30 min | `FETCH_INTERVAL_TWITTER_FEED` |
| `twitter_list` | 30 min | `FETCH_INTERVAL_TWITTER_LIST` |
| `twitter_bookmarks` | 60 min | `FETCH_INTERVAL_TWITTER_BOOKMARKS` |
| `hackernews` | 60 min | `FETCH_INTERVAL_HACKERNEWS` |
| `reddit` | 60 min | `FETCH_INTERVAL_REDDIT` |
| `rss` | 240 min | `FETCH_INTERVAL_RSS` |
| `digest_feed` | 240 min | `FETCH_INTERVAL_DIGEST_FEED` |
| `github_trending` | 240 min | `FETCH_INTERVAL_GITHUB_TRENDING` |
| `website` | 240 min | `FETCH_INTERVAL_WEBSITE` |
| `custom_api` | 120 min | `FETCH_INTERVAL_CUSTOM_API` |

### 6.3 未来扩展：Source 级别频率覆盖

本期不实现，但设计预留。sources 表已有 `config` JSON 字段，可添加 `fetch_interval_minutes` 属性：

```json
{
  "url": "https://example.com/rss",
  "fetch_interval_minutes": 60
}
```

`getSourcesDueForFetch()` 可优先读取 source 自身的 interval，fallback 到 type 默认值。此功能留给 Phase 2+ 按需实现。

---

## 7. API 变更

### 新增端点

#### `GET /api/collector/status`

**认证：** Bearer API Key（与 `POST /api/digests` 相同）

**响应 200：**
```json
{
  "sources": [
    {
      "id": 1,
      "name": "Hacker News",
      "type": "hackernews",
      "interval_minutes": 60,
      "last_fetched_at": "2026-02-25T10:30:00.000Z",
      "next_fetch_at": "2026-02-25T11:30:00.000Z",
      "fetch_count": 142,
      "fetch_error_count": 0,
      "last_error": null
    }
  ],
  "stats": {
    "total_sources": 224,
    "active_sources": 218,
    "paused_by_error": 6,
    "items_24h": 3421,
    "errors_24h": 12
  }
}
```

### 现有端点变更

#### `GET /api/sources`

在响应中新增以下字段（仅对已认证用户可见）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `fetch_interval_minutes` | number | 该 source type 的采集间隔 |
| `next_fetch_at` | string \| null | 预计下次采集时间 |

这些字段从频率配置 + `last_fetched_at` 计算得出，不存储。

### 不变的端点

- `GET /api/raw-items` — 不变
- `GET /api/raw-items/stats` — 不变
- `GET /api/raw-items/for-digest` — 不变

---

## 8. 验收标准

### 采集调度

| # | 场景 | 预期结果 |
|---|---|---|
| 1 | 启动 `collector --loop`，数据库有 RSS 源（从未采集） | 立即采集该源（`last_fetched_at IS NULL` 优先） |
| 2 | RSS 源上次采集在 3h 前 | 不采集（默认 4h 间隔未到） |
| 3 | RSS 源上次采集在 5h 前 | 采集 |
| 4 | HN 源上次采集在 50min 前 | 不采集（默认 1h 间隔未到） |
| 5 | HN 源上次采集在 70min 前 | 采集 |
| 6 | 设置 `FETCH_INTERVAL_RSS=60` | RSS 源 1 小时后即到期 |
| 7 | 新建 source 后不重启 collector | 下个 tick 自动发现并采集 |
| 8 | Source type 为 `twitter_feed` 但无 fetcher | collectSource 返回 `skipped`，不报错 |

### 采集执行

| # | 场景 | 预期结果 |
|---|---|---|
| 9 | 10 个源同时到期，`COLLECTOR_CONCURRENCY=3` | 同时最多 3 个在采集 |
| 10 | 某源采集报错 | `recordSourceError()` 记录错误，不影响其他源 |
| 11 | 某源连续失败 5 次 | 自动暂停（`is_active = 0`），已有逻辑 |
| 12 | 采集进程收到 SIGTERM | 等待当前任务完成后退出 |

### 状态 API

| # | 场景 | 预期结果 |
|---|---|---|
| 13 | `GET /api/collector/status` 无 API Key | 401 |
| 14 | `GET /api/collector/status` 有 API Key | 返回所有源的采集状态和统计 |
| 15 | 返回的 `next_fetch_at` | 等于 `last_fetched_at` + 该 type 的 interval |

### 向后兼容

| # | 场景 | 预期结果 |
|---|---|---|
| 16 | 不设置任何新的环境变量 | 行为与当前基本一致（仅 tick 间隔从 5min 改为 1min） |
| 17 | `collector.mjs --source 5` 单源模式 | 不受频率限制，立即采集 |
| 18 | 原有 `COLLECTOR_INTERVAL` 环境变量 | 改为 `COLLECTOR_TICK` 的 fallback，避免 breaking change |

---

## 9. 依赖关系

```
1.1 raw_items 采集管道 ✅ (PR #15)
  └── 1.3 Cron 采集集成 ← 本 PRD
        ├── collector.mjs 已有完整的 fetcher 注册表
        ├── db.mjs 已有 getSourcesDueForFetch / touchSourceFetch / recordSourceError
        ├── sources 表已有 last_fetched_at / fetch_count / fetch_error_count / last_error
        └── raw_items 表已就绪，dedup 机制已可用

1.2 个性化 Digest ← 依赖本 PRD 提供稳定的采集数据
1.5 Twitter API 集成 ← 在本 PRD 的 fetcher 注册表中添加 twitter_feed/twitter_list fetcher
```

**无外部依赖：**
- 不需要新的 npm 包（node-cron 等不需要，原生 setInterval + DB 状态即可）
- 不需要 Redis 或消息队列
- 不需要 schema migration（复用现有字段）

---

## 10. 风险与开放问题

### 风险

| 风险 | 影响 | 缓解措施 |
|---|---|---|
| Twitter 源占 90% 但无 fetcher | 采集覆盖率低，用户体验差 | 本期先做调度框架，Twitter fetcher 在 1.5 补齐。对无 fetcher 的 type 静默跳过，不报错 |
| 高频 tick（60s）增加 DB 查询压力 | SQLite 在大量 sources 时查询变慢 | `getSourcesDueForFetch()` 查询已有 `idx_sources_active` 索引；224 个 sources 下单次查询 <1ms |
| 并发采集占满网络/CPU | 影响 API 服务响应 | Collector 独立进程、`COLLECTOR_CONCURRENCY` 限制；API 服务不受采集进程影响 |
| `.env` 中 `COLLECTOR_INTERVAL` 已被用户使用 | 改为 `COLLECTOR_TICK` 可能引起困惑 | 保留 `COLLECTOR_INTERVAL` 作为 `COLLECTOR_TICK` 的 fallback |

### 开放问题

1. **Twitter fetcher 的优先级**：当前 90% 的 sources 是 twitter_feed/twitter_list，调度框架做好了但无法采集它们。是否应该和 1.5 Twitter API 并行推进？
   - 建议：是。1.3 完成调度框架后立即启动 1.5，两者可以 2 天内连续交付。

2. **Source 级别频率覆盖的时机**：部分用户可能需要对特定 source 设置更高/更低的采集频率。是否在本期实现？
   - 建议：不。本期只做 type 级别配置，source 级别留给 Phase 2+。当前用户没有表达过这个需求。

3. **采集器的部署形态**：当前是 PM2 独立进程。是否考虑嵌入 server.mjs 作为子线程？
   - 建议：不。独立进程更稳定，crash 不互相影响。PM2 已有进程管理能力，维持现状。

4. **静默跳过 vs 日志警告**：对没有 fetcher 的 source type（如 twitter_feed），每次跳过时是否打日志？
   - 建议：首次跳过时打一条 WARN，之后不再重复（避免日志刷屏）。可用内存 Set 记录已 warn 过的 type。

---

*Generated by Jessie --- 2026-02-25*
