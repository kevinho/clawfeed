# Source 个性化：raw_items 采集管道 PRD

## 背景

ClawFeed 目前的 digest 生成是全局的——所有用户看到同一份 digest。虽然已有 sources 表和 user_subscriptions 表（PR #5 已合并），但缺少中间层来存储采集到的原始内容。没有这一层，无法实现"每个用户基于自己订阅的 sources 生成个性化 digest"。

PR #6（已关闭）曾提交了完整的采集管道实现，但未经 PRD 审核流程。本 PRD 正式定义需求和技术方案。

## 目标

1. 建立 `raw_items` 中间存储层，解耦"源采集"和"digest 生成"
2. 实现多源采集管道（RSS、Hacker News、Reddit、GitHub Trending、Website）
3. Source 级别去重，避免重复采集
4. 为后续"用户级 digest 个性化"打下基础

## 方案

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

> Twitter 类型暂不实现（需 API 授权），后续单独处理。

#### 采集频率策略

根据源类型设定不同采集间隔，由 `getSourcesDueForFetch()` 查询 `last_fetched_at` 判断：
- HN / Reddit：1 小时
- RSS / Website / GitHub Trending：4 小时
- 首次采集（`last_fetched_at IS NULL`）：立即

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

### 影响范围

- 新增：`migrations/010_raw_items.sql`
- 新增：`src/collector.mjs`（采集管道 + fetcher 模块）
- 修改：`src/db.mjs`（raw_items CRUD 函数）
- 修改：`src/server.mjs`（3 个 API 端点）
- 修改：`package.json`（collect / collect:loop scripts）

不影响：现有 digest 生成逻辑、认证、marks、packs、subscriptions、feed 输出。

## 验收标准

1. [ ] `raw_items` 表通过 migration 创建成功
2. [ ] `npm run collect` 能采集所有活跃 source 并写入 raw_items
3. [ ] 同一 item 重复采集时不产生重复记录（dedup_key 去重）
4. [ ] RSS 源采集正确解析标题、URL、内容、发布时间
5. [ ] HN 源按 min_score 过滤，metadata 包含 score 和 comments
6. [ ] Reddit 源采集 subreddit posts
7. [ ] GitHub Trending 源采集 trending repos
8. [ ] Website 源支持 RSS 自动发现
9. [ ] SSRF 防护：私有 IP 地址被拒绝
10. [ ] `/api/raw-items/stats` 返回各 source 统计
11. [ ] `/api/raw-items/for-digest` 仅返回用户订阅 source 的数据
12. [ ] 30 天 TTL 清理函数可调用

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
