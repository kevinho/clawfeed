# Source 个性化：raw_items 采集管道 PRD

## 背景

ClawFeed 目前的 digest 生成是全局的——所有用户看到同一份 digest。虽然已有 sources 表和 user_subscriptions 表（PR #5 已合并），但缺少中间层来存储采集到的原始内容。没有这一层，无法实现"每个用户基于自己订阅的 sources 生成个性化 digest"。

PR #6（已关闭）曾提交了完整的采集管道实现，但未经 PRD 审核流程。本 PRD 正式定义需求和技术方案。

### 线上数据分析（来自 Lisa 导出的 production 数据）

| 类型 | 数量 | 占比 | 说明 |
|------|------|------|------|
| `twitter_feed` | ~200+ | ~90% | 压倒性多数 |
| `twitter_list` | 少量 | ~3% | |
| `rss` | 1 | <1% | 仅 Hacker News |
| `website` | 少量 | ~2% | |
| `digest_feed` | 少量 | ~2% | Kevin's AI Digest 订阅最高（267人） |

**Top 订阅 sources**：@karpathy (262)、@polin_solana (219)、0xkevinhe AI/LLM filter (139)、@akokoi1 (139) 等——**全是 Twitter 账号**。

**结论**：Twitter 不是 nice-to-have，是用户最核心的信息源。采集管道必须优先支持 Twitter。

**数据质量问题**（需清理）：
- 重复 sources（@libukai 3条、@akokoi1 3条等）
- 个别 source config 异常（id=105 塞了 600+ handles）
- name 与实际 handle 不匹配

## 目标

1. 建立 `raw_items` 中间存储层，解耦"源采集"和"digest 生成"
2. 实现多源采集管道（RSS、Hacker News、Reddit、GitHub Trending、Website）
3. Source 级别去重，避免重复采集
4. 实现用户订阅驱动的个性化 digest 体验

## 方案

### 用户体验流程

#### 公共 Source 与默认订阅

1. 系统维护若干**公共 source**（`is_public = 1`），初期先有一份，逐步添加
2. **未登录用户**：看到的是其中一份默认公共 source 生成的 digest（由 `DEFAULT_SOURCE_ID` 环境变量指定）
3. **新注册用户**：登录后自动订阅其未登录时看到的那份默认 source
4. **已有用户**：可在 Sources 页面自行添加/删除订阅，digest 内容随之变化

#### 用户视角

```
未登录 → 看默认 source 的 digest（无需注册即可体验）
    ↓ 注册/登录
新用户 → 自动继承默认 source 订阅
    ↓ 探索
浏览公共 source 列表 → 订阅感兴趣的 → 取消不想看的
    ↓ 日常使用
每次打开看到基于自己订阅的个性化 digest
```

### 分布式可扩展设计

当前 Phase 1 采用单进程 Collector，但架构需为水平扩展做准备：

- **Collector 无状态**：所有状态存在数据库（sources 表的 last_fetched_at），Collector 本身无本地状态，可以多实例运行
- **任务分发**：通过数据库行锁（`SELECT ... WHERE last_fetched_at < threshold FOR UPDATE`）或消息队列（Redis/BullMQ）分发采集任务，避免多实例重复采集同一 source
- **数据库层**：Phase 1 用 SQLite（单机够用），后续 sources 量大时可迁移到 PostgreSQL，raw_items 写入量大时可分表（按 source_id 或时间分区）
- **存储分离**：raw_items 内容较大时，content 字段可改为存 S3/R2 对象引用，数据库只存元数据

Phase 1 先跑通单机流程，架构上留好扩展口。

### 设计

#### 数据模型

新增 `raw_items` 表：

```sql
CREATE TABLE IF NOT EXISTS raw_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  author TEXT DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  published_at TEXT,
  dedup_key TEXT NOT NULL,
  metadata TEXT DEFAULT '{}',
  UNIQUE(source_id, dedup_key)
);
```

关键设计：
- `dedup_key`：`source_id:url`，无 URL 时用 `source_id:content_hash`
- `UNIQUE(source_id, dedup_key)`：INSERT OR IGNORE 实现去重
- `metadata`：JSON，存储源特有信号（HN score、Reddit upvotes 等）
- 30 天 TTL 清理旧数据

#### 采集管道架构

```
Sources 表（活跃 + 到期需采集）
    ↓ getSourcesDueForFetch()
Collector 进程（独立运行）
    ↓ 按 source.type 分发到对应 fetcher
    ↓ HTTP 请求 + 解析
raw_items 表（共享池）
    ↓ 按用户订阅过滤
Digest 生成（Phase 2）
```

#### 支持的源类型

| 类型 | 配置字段 | 采集频率 | 说明 |
|------|----------|----------|------|
| `rss` | `{ url }` | 4h | XML 解析，支持 RSS 2.0 / Atom |
| `hackernews` | `{ filter: "top"\|"new", min_score }` | 1h | Firebase API |
| `reddit` | `{ subreddit, sort, limit }` | 1h | JSON API |
| `github_trending` | `{ language, since }` | 4h | HTML 解析 |
| `website` | `{ url }` | 4h | RSS 自动发现，降级到标题提取 |

#### Twitter 源（重点支持）

Twitter 是用户最高频的信息源之一，需尽可能支持。目标场景：

| 子类型 | 说明 | 数据 |
|--------|------|------|
| `twitter_account` | 某账号的 timeline | 该用户发的推文 |
| `twitter_foryou` | 某用户的 For You 推荐流 | 算法推荐内容 |
| `twitter_favorites` | 某用户的 Likes/Favorites | 点赞的推文 |
| `twitter_list` | Twitter List 的内容 | List 成员的推文 |
| `twitter_bookmarks` | 某用户的书签 | 收藏的推文 |

**获取条件分析：**

| 方式 | 能拿到什么 | 前置条件 | 限制 |
|------|-----------|----------|------|
| Twitter API v2（Basic $100/月） | 用户 timeline、搜索 | API Key + OAuth 2.0 | 10K tweets/月读取 |
| Twitter API v2（Pro $5000/月） | 全部端点 | API Key | 1M tweets/月 |
| 用户自授权 OAuth | 该用户的 for you/favorites/bookmarks | 用户登录授权 | 仅限授权用户自己的数据 |
| RSS Bridge（开源） | 公开 timeline → RSS | 自部署 RSS Bridge | 不稳定，Twitter 常封 |
| Nitter（开源） | 公开 timeline | 自部署 Nitter 实例 | Twitter 持续打压，不可靠 |
| 浏览器自动化 | 所有可见内容 | Puppeteer + 登录态 | 慢、脆弱、有封号风险 |

**建议方案（渐进式）：**

1. **Phase 1（本次）**：支持 `twitter_account`（公开 timeline），先调研现有系统如何采集 Twitter（可能已有方案），确保 raw_items 管道兼容 Twitter 数据格式
2. **Phase 1.5**：接入 Twitter API v2 Basic（$100/月），支持正式的 timeline + 搜索；覆盖 90% 的现有用户 sources
3. **Phase 2**：OAuth 用户授权流程，支持 for you / favorites / bookmarks（需要用户自己授权）

> **线上数据验证**：224 个 sources 中 ~90% 是 twitter_feed/twitter_list，Top 订阅全是 Twitter 账号。Twitter 必须在 Phase 1 中至少有 best-effort 支持。

#### 采集频率策略

根据源类型设定不同采集间隔，由 `getSourcesDueForFetch()` 查询 `last_fetched_at` 判断：
- HN / Reddit：1 小时
- RSS / Website / GitHub Trending：4 小时
- 首次采集（`last_fetched_at IS NULL`）：立即

#### 采集失败处理

- sources 表新增 `fetch_error_count INTEGER DEFAULT 0`
- 采集成功：`fetch_error_count = 0`
- 采集失败：`fetch_error_count += 1`，记录 `last_error`（JSON：错误信息 + 时间）
- 连续失败 5 次：自动暂停该 source（`is_active = 0`），需管理员手动恢复
- 单个 source 失败不影响其他 source 的采集

#### 并发控制

- Collector 默认并行采集，并发上限 5（`COLLECTOR_CONCURRENCY` 环境变量控制）
- 使用 Promise 池限制同时发出的 HTTP 请求数
- 避免瞬间对同一域名发大量请求

#### Website 降级逻辑

当 website 类型 source 找不到 RSS 时的 fallback 顺序：
1. 查找页面 `<link rel="alternate" type="application/rss+xml">` → 有则当 RSS 采集
2. 没有 RSS → 提取 `<title>` + `og:title` + `og:description` 作为一条 raw_item
3. 判断"新内容"：对比 `dedup_key`（URL hash），内容变化才写入新记录

#### 安全

- **SSRF 防护**：DNS 解析后检查 IP，拒绝私有地址（127.x, 10.x, 172.16-31.x, 192.168.x, fc/fd IPv6）
- **请求限制**：10s 超时，500KB 最大响应体，最多 3 次重定向
- **User-Agent**：`ClawFeed-Collector/1.0`

### API 端点

```
GET /api/raw-items
  参数：source_id, since (ISO), limit (max 200), offset
  鉴权：需登录
  用途：调试/管理

GET /api/raw-items/stats
  鉴权：需登录
  返回：每个 source 的 total_items, last_item_at, items_24h
  用途：监控采集健康度

GET /api/raw-items/for-digest
  参数：since, limit (max 500)
  鉴权：需登录
  逻辑：仅返回当前用户已订阅 source 的 raw_items
  用途：为 digest 生成提供数据
```

### 运行方式

```bash
npm run collect              # 单次采集所有到期 source
npm run collect:loop         # 循环采集（COLLECTOR_INTERVAL 秒间隔，默认 300）
npm run collect -- --source 5  # 采集指定 source
```

Collector 作为独立进程运行，不阻塞 API 服务。生产环境用 PM2 管理。

### 配置

新增环境变量：
- `COLLECTOR_INTERVAL` — 采集循环间隔秒数（default: 300）
- `COLLECTOR_CONCURRENCY` — 并行采集上限（default: 5）
- `DEFAULT_SOURCE_ID` — 未登录用户看到的默认 source ID

### 影响范围

- 新增：`migrations/010_raw_items.sql`（raw_items 表 + sources 表加 fetch_error_count/last_error）
- 新增：`src/collector.mjs`（采集管道 + fetcher 模块）
- 修改：`src/db.mjs`（raw_items CRUD 函数）
- 修改：`src/server.mjs`（3 个 API 端点 + 未登录用户默认 digest 逻辑）
- 修改：`package.json`（collect / collect:loop scripts）

需要配合修改：digest 列表页根据登录状态显示不同内容（未登录 → 默认 source digest，已登录 → 订阅 sources digest）。

## 验收标准

1. [ ] `raw_items` 表通过 migration 创建成功
2. [ ] `npm run collect` 能采集所有活跃 source 并写入 raw_items
3. [ ] 同一 item 重复采集时不产生重复记录（dedup_key 去重）
4. [ ] RSS 源采集正确解析标题、URL、内容、发布时间
5. [ ] HN 源按 min_score 过滤，metadata 包含 score 和 comments
6. [ ] Reddit 源采集 subreddit posts
7. [ ] GitHub Trending 源采集 trending repos
8. [ ] Website 源支持 RSS 自动发现 + 降级到标题提取
9. [ ] SSRF 防护：私有 IP 地址被拒绝
10. [ ] `/api/raw-items/stats` 返回各 source 统计
11. [ ] `/api/raw-items/for-digest` 仅返回用户订阅 source 的数据
12. [ ] 30 天 TTL 清理函数可调用
13. [ ] 未登录用户看到默认 source 的 digest
14. [ ] 新用户登录后自动订阅默认 source
15. [ ] 采集连续失败 5 次的 source 被自动暂停
16. [ ] 并发采集不超过 COLLECTOR_CONCURRENCY 上限

## 测试用例

| # | 场景 | 步骤 | 预期结果 |
|---|------|------|----------|
| 1 | RSS 采集 | 添加 RSS source → run collect | raw_items 有该 source 的条目 |
| 2 | 去重 | 同一 source 连续采集两次 | 第二次 inserted = 0 |
| 3 | HN 采集 + score 过滤 | 添加 HN source (min_score=100) → collect | 仅 score ≥ 100 的进入 raw_items |
| 4 | Reddit 采集 | 添加 reddit source (subreddit=programming) → collect | raw_items 有 reddit posts |
| 5 | GitHub Trending | 添加 github_trending source → collect | raw_items 有 trending repos |
| 6 | Website RSS 发现 | 添加 website source (有 RSS link) → collect | 自动发现 RSS 并采集 |
| 7 | SSRF 拦截 | 添加 source url=http://127.0.0.1 → collect | 采集失败，错误日志记录 |
| 8 | stats API | 采集后调用 /api/raw-items/stats | 返回正确的 item 计数和时间 |
| 9 | for-digest 过滤 | 用户订阅 source A 不订阅 B → GET /api/raw-items/for-digest | 仅返回 source A 的 items |
| 10 | TTL 清理 | 插入 31 天前的 raw_item → 调用 cleanOldRawItems() | 该记录被删除 |
| 11 | 采集频率 | source 1 小时前采集过（类型 rss，间隔 4h） → getSourcesDueForFetch() | 该 source 不在返回列表中 |
| 12 | 首次采集 | 新建 source（last_fetched_at=NULL） → getSourcesDueForFetch() | 该 source 在返回列表中 |
| 13 | 未登录默认 digest | 未登录访问 /digests | 看到默认 source 的 digest |
| 14 | 新用户自动订阅 | 新用户首次登录 → 查看订阅列表 | 已自动订阅默认 source |
| 15 | 采集失败暂停 | 某 source 连续失败 5 次 | is_active 变为 0，不再采集 |
| 16 | 并发上限 | 设置 COLLECTOR_CONCURRENCY=3 → 10 个 source 同时到期 | 同时只有 3 个在采集 |

## 后续阶段（不在本次范围）

- **Phase 2**：digest 生成接入 raw_items（按用户订阅过滤 → AI 摘要 → 写入 digest + user_id）
- **Phase 3**：订阅组合去重（subscription_hash 缓存，相同订阅组合共享 digest）
- **Phase 4**：Twitter 源支持、多渠道分发（Telegram/Email/Slack）

## 回滚方案

删除 migration 010 和 collector 模块即可。raw_items 表独立于现有功能，不影响已有数据。

## 负责人

- 开发：Jessie
- 测试：Lisa
- 审批：Kevin
