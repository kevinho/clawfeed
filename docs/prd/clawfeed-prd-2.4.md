# PRD 2.4: Digest 质量提升

> **版本:** v0.1 | **作者:** Jessie | **日期:** 2026-02-25
> **状态:** Draft | **所属阶段:** Phase 2 (v1.0 → v1.5)

---

## 1. 背景与动机

ClawFeed 的核心价值主张是 **"AI 编辑部"** —— Source 越多，筛选池越大，输出质量越高，但篇幅保持不变（15-20 条/期）。当前系统已具备：

- **raw_items 采集管道** (v0.9, Migration 010): Collector 按 Source 类型差异化抓取（HN/Reddit 1h, RSS 4h），写入 `raw_items` 表，通过 `dedup_key` 做单 Source 内去重
- **用户订阅系统** (Migration 006): `user_subscriptions` 表关联用户与 Source
- **Digest 生成**: `listRawItemsForDigest()` 按用户订阅的 Source 拉取原始内容，喂给 LLM 生成摘要

**当前问题：**

1. **所有 Source 同权重** —— 一个低质灌水博客和 Hacker News Top 100 在筛选时权重相同，导致"劣币驱逐良币"
2. **用户反馈闭环缺失** —— 用户看完 Digest 后无法表达"这条有用 / 这条垃圾"，系统无法学习个人偏好
3. **话题追踪靠运气** —— 用户连续几天关注某个事件（如某次安全漏洞），但系统不知道，无法自动加权后续报道
4. **跨 Source 重复严重** —— 同一新闻事件（如"OpenAI 发布 GPT-5"）可能出现在 HN、Reddit、多个 RSS 中，Digest 里可能重复出现

解决这四个问题将直接提升 Digest 的信噪比，是从"能用"到"好用"的关键一步。

---

## 2. 目标

| 目标 | 衡量指标 | 目标值 |
|------|---------|--------|
| Digest 信息密度提升 | 单期 Digest 中"有用"标记比例 | > 70%（当前无基线） |
| 减少重复内容 | 单期 Digest 中重复事件数 | 0（当前估计 2-3 条） |
| 用户参与度 | 反馈（有用/没用）的操作率 | > 20% 的活跃用户 |
| 话题连续性 | 用户追踪话题后，相关后续报道命中率 | > 80% |
| 个性化差异度 | 不同用户相同 Source 组合的 Digest 差异度 | > 30% 内容不同 |

---

## 3. 用户故事

### US-1: Source 权重感知
> 作为一个订阅了 20 个 Source 的用户，我希望来自 Hacker News Top 和 arXiv 的高质量内容在 Digest 中占更大比重，而低质量 RSS 博客的噪音被自动降低，这样我不需要手动退订就能获得更好的 Digest。

### US-2: 内容反馈
> 作为一个每天阅读 Digest 的用户，我希望能快速标记每条内容"有用"或"没用"，让 AI 编辑部逐渐理解我的口味，这样下一期 Digest 能更符合我的偏好。

### US-3: 话题追踪
> 作为一个正在关注"Rust 异步运行时之争"事件的用户，当我连续几天点击/收藏了这个话题的内容，我希望系统自动追踪这个话题，在接下来几期 Digest 中优先包含相关新进展。

### US-4: 跨源去重
> 作为一个同时订阅了 HN、Reddit r/programming 和多个技术博客 RSS 的用户，当"Go 2.0 发布"这个大新闻发生时，我希望 Digest 里只出现一条综合报道，而不是三条内容雷同的条目。

---

## 4. 功能需求

### 4.1 Source 权重系统

**目标：** 让高质量 Source 在 Digest 生成时获得更高选中概率。

#### 4.1.1 全局 Source 质量分

系统自动计算每个 Source 的质量分 `quality_score`（0.0 - 1.0），基于：

| 信号 | 权重 | 说明 |
|------|------|------|
| 采集成功率 | 20% | `1 - (fetch_error_count / fetch_count)`，当前 sources 表已有这两个字段 |
| 内容被选中率 | 30% | 该 Source 的 raw_items 最终进入 Digest 的比例 |
| 用户正向反馈率 | 30% | 来自该 Source 的内容获得"有用"标记的比例 |
| 订阅者数量 | 10% | `subscriber_count` 归一化（对数尺度） |
| 内容鲜度 | 10% | 平均发布时间到采集时间的间隔（越短越好） |

`quality_score` 每日批量重算一次（定时任务），结果写入 `source_weights` 表。

#### 4.1.2 用户级 Source 权重

用户可在订阅列表中手动调整权重：

- 默认：自动（跟随全局 quality_score）
- 手动：高 / 中 / 低 / 静音（映射到乘数 1.5 / 1.0 / 0.5 / 0.0）

存储在 `user_source_weights` 表。

#### 4.1.3 Digest 生成时的权重应用

当前 `listRawItemsForDigest()` 按时间倒序拉取 raw_items。改为：

```
effective_weight = quality_score * user_weight_multiplier
```

将 raw_items 按 `effective_weight` 加权采样后喂入 LLM，而非简单截断。

---

### 4.2 用户反馈循环

**目标：** 收集用户对 Digest 中每条内容的有用/没用信号，训练个人偏好模型。

#### 4.2.1 反馈收集

每条 Digest item 旁显示 thumbs-up / thumbs-down 按钮。用户点击后立即记录：

- `user_id` — 谁打的标
- `digest_id` — 哪期 Digest
- `item_index` — 该条在 Digest 中的位置
- `raw_item_id` — 对应的原始条目（如可关联）
- `source_id` — 来源
- `signal` — `useful` / `not_useful`
- `created_at`

#### 4.2.2 偏好模型

初期采用**轻量统计模型**，不上 ML：

1. **Source 偏好**: 用户对各 Source 的正向反馈率 → 影响用户级权重
2. **话题偏好**: 对反馈内容提取关键词/话题标签 → 累计正负计数 → 形成用户话题偏好向量
3. **时间衰减**: 旧反馈权重指数衰减（半衰期 30 天），防止偏好固化

偏好模型输出存入 `user_preferences` 表（JSON blob），Digest 生成时读取。

#### 4.2.3 反馈效果可见

在设置页或 Digest 页展示简要统计："你已标记 X 条内容，系统正在学习你的偏好"，让用户感知反馈有实际作用。

---

### 4.3 话题追踪

**目标：** 检测用户持续关注的话题，自动加权相关内容。

#### 4.3.1 话题检测

对 raw_items 进行轻量话题聚类：

- **方法 A（推荐）**: LLM 在生成 Digest 时顺带输出每条的话题标签（1-3 个关键词），存入 `raw_item_topics`
- **方法 B（备选）**: TF-IDF + 简单关键词提取（纯本地，无 LLM 成本）

#### 4.3.2 用户追踪信号

以下行为视为"对某话题感兴趣"：

| 信号 | 强度 |
|------|------|
| 标记"有用" | 强 |
| 收藏（Mark）相关内容 | 强 |
| 手动追踪（点击"追踪此话题"按钮） | 最强 |
| 连续 2 期以上阅读含该话题的 Digest | 弱（需前端阅读追踪） |

#### 4.3.3 话题自动加权

当系统检测到用户对某话题产生兴趣信号：

1. 创建 `user_topic_tracking` 记录
2. 后续 Digest 生成时，匹配该话题的 raw_items 获得 1.5-2.0x 权重提升
3. 话题追踪有 TTL（默认 14 天无新信号自动过期）
4. 用户可在 UI 中查看和管理追踪的话题列表

#### 4.3.4 话题更新通知

（可选，Phase 2.1 推送功能就绪后）追踪话题有重大更新时，可触发推送通知。

---

### 4.4 跨 Source 去重改进

**目标：** 同一事件在多个 Source 报道时，Digest 中只保留最佳版本。

#### 4.4.1 当前去重机制

现有 `raw_items.dedup_key` = `{source_id}:{url}` 或 `{source_id}:{content_hash}`，仅做**单 Source 内去重**。跨 Source 的同一事件（不同 URL、不同标题措辞）完全不去重。

#### 4.4.2 跨源事件聚类

分两步：

**Step 1: 候选对检测**（Collector 阶段或 Digest 前）

- 对同一时间窗口（24h）内的 raw_items，计算标题相似度
- 方法：标题归一化（小写、去停用词、去标点）→ 3-gram Jaccard 相似度
- 阈值 > 0.5 则标记为同一事件候选对

**Step 2: 事件聚类**

- 候选对构成图 → 连通分量 = 一个事件簇
- 每个簇分配 `event_id`，写入 `raw_item_events` 表

**Step 3: 代表选取**（Digest 生成时）

- 每个事件簇只选一条代表进入 Digest 候选池
- 选取标准：Source 权重最高 + 内容最丰富（content 字段最长且非截断）
- 其他同事件条目附加为"相关报道"引用（可选显示）

#### 4.4.3 去重效果展示

Digest 中对去重合并的条目，显示"综合 N 个来源"标记，点击可展开所有源。

---

## 5. 技术方案

### 5.1 权重计算算法

```javascript
// 每日批量计算 — 作为 cron 任务
function calculateSourceQualityScores(db) {
  const sources = db.prepare(`
    SELECT s.id, s.fetch_count, s.fetch_error_count,
      (SELECT COUNT(*) FROM user_subscriptions WHERE source_id = s.id) as sub_count
    FROM sources s WHERE s.is_active = 1 AND s.is_deleted = 0
  `).all();

  for (const s of sources) {
    const fetchReliability = s.fetch_count > 0
      ? 1 - (s.fetch_error_count / s.fetch_count) : 0.5;
    const selectionRate = getSelectionRate(db, s.id);   // 被 Digest 选中比例
    const feedbackScore = getFeedbackScore(db, s.id);   // 正向反馈率
    const subScore = Math.log2(Math.max(1, s.sub_count)) / 10; // 对数归一化
    const freshnessScore = getFreshnessScore(db, s.id); // 发布-采集间隔

    const quality = (
      fetchReliability * 0.2 +
      selectionRate   * 0.3 +
      feedbackScore   * 0.3 +
      Math.min(subScore, 1) * 0.1 +
      freshnessScore  * 0.1
    );

    upsertSourceWeight(db, s.id, clamp(quality, 0, 1));
  }
}
```

### 5.2 反馈偏好聚合

```javascript
// 用户偏好向量：{ source偏好, 话题偏好 }
function computeUserPreferences(db, userId) {
  const feedback = db.prepare(`
    SELECT df.signal, df.source_id, df.created_at, rit.topic
    FROM digest_feedback df
    LEFT JOIN raw_item_topics rit ON df.raw_item_id = rit.raw_item_id
    WHERE df.user_id = ?
    ORDER BY df.created_at DESC LIMIT 500
  `).all(userId);

  const now = Date.now();
  const HALF_LIFE = 30 * 86400 * 1000; // 30 天半衰期

  const sourceScores = {};
  const topicScores = {};

  for (const f of feedback) {
    const age = now - new Date(f.created_at).getTime();
    const decay = Math.pow(0.5, age / HALF_LIFE);
    const value = (f.signal === 'useful' ? 1 : -1) * decay;

    // Source 偏好
    sourceScores[f.source_id] = (sourceScores[f.source_id] || 0) + value;

    // 话题偏好
    if (f.topic) {
      topicScores[f.topic] = (topicScores[f.topic] || 0) + value;
    }
  }

  return { sourceScores, topicScores };
}
```

### 5.3 跨源去重算法

```javascript
// 标题相似度 — 3-gram Jaccard
function titleSimilarity(a, b) {
  const normalize = s => s.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
  const ngrams = (s, n) => {
    const tokens = s.split(' ');
    const grams = new Set();
    for (let i = 0; i <= tokens.length - n; i++) {
      grams.add(tokens.slice(i, i + n).join(' '));
    }
    return grams;
  };

  const ga = ngrams(normalize(a), 3);
  const gb = ngrams(normalize(b), 3);
  if (!ga.size || !gb.size) return 0;

  let intersection = 0;
  for (const g of ga) if (gb.has(g)) intersection++;
  return intersection / (ga.size + gb.size - intersection);
}

// 事件聚类 — Union-Find
function clusterEvents(items, threshold = 0.5) {
  const parent = items.map((_, i) => i);
  const find = i => parent[i] === i ? i : (parent[i] = find(parent[i]));
  const union = (a, b) => { parent[find(a)] = find(b); };

  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (titleSimilarity(items[i].title, items[j].title) > threshold) {
        union(i, j);
      }
    }
  }

  const clusters = {};
  for (let i = 0; i < items.length; i++) {
    const root = find(i);
    (clusters[root] = clusters[root] || []).push(items[i]);
  }
  return Object.values(clusters);
}
```

### 5.4 Digest 生成流程改造

当前流程：
```
用户订阅 Sources → listRawItemsForDigest(sourceIds) → 按时间截断 → LLM 生成
```

改造后：
```
用户订阅 Sources
  → listRawItemsForDigest(sourceIds)
  → 跨源去重聚类 (4.4)
  → 每簇选代表
  → 加权采样 (quality_score × user_weight × topic_boost)
  → 按加权分排序截取 Top N
  → LLM 生成 Digest（同时输出话题标签）
  → 存储话题标签到 raw_item_topics
```

---

## 6. 数据模型

### 6.1 新增表

```sql
-- Migration 011: Digest 质量提升

-- Source 全局质量分（每日重算）
CREATE TABLE IF NOT EXISTS source_weights (
  source_id INTEGER PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
  quality_score REAL NOT NULL DEFAULT 0.5,
  selection_rate REAL DEFAULT 0,
  feedback_score REAL DEFAULT 0,
  freshness_score REAL DEFAULT 0,
  calculated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 用户级 Source 权重覆盖
CREATE TABLE IF NOT EXISTS user_source_weights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  weight_level TEXT NOT NULL DEFAULT 'auto'
    CHECK(weight_level IN ('high', 'medium', 'low', 'muted', 'auto')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, source_id)
);
CREATE INDEX IF NOT EXISTS idx_usw_user ON user_source_weights(user_id);

-- Digest 内容反馈
CREATE TABLE IF NOT EXISTS digest_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  digest_id INTEGER NOT NULL REFERENCES digests(id) ON DELETE CASCADE,
  item_index INTEGER NOT NULL,
  raw_item_id INTEGER REFERENCES raw_items(id) ON DELETE SET NULL,
  source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL,
  signal TEXT NOT NULL CHECK(signal IN ('useful', 'not_useful')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, digest_id, item_index)
);
CREATE INDEX IF NOT EXISTS idx_df_user ON digest_feedback(user_id);
CREATE INDEX IF NOT EXISTS idx_df_digest ON digest_feedback(digest_id);
CREATE INDEX IF NOT EXISTS idx_df_source ON digest_feedback(source_id);

-- 用户偏好缓存（JSON blob，定期重算）
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  source_scores TEXT NOT NULL DEFAULT '{}',   -- JSON: { source_id: score }
  topic_scores TEXT NOT NULL DEFAULT '{}',    -- JSON: { topic: score }
  calculated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- raw_item 话题标签
CREATE TABLE IF NOT EXISTS raw_item_topics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  raw_item_id INTEGER NOT NULL REFERENCES raw_items(id) ON DELETE CASCADE,
  topic TEXT NOT NULL,
  confidence REAL DEFAULT 1.0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_rit_item ON raw_item_topics(raw_item_id);
CREATE INDEX IF NOT EXISTS idx_rit_topic ON raw_item_topics(topic);

-- 用户话题追踪
CREATE TABLE IF NOT EXISTS user_topic_tracking (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  topic TEXT NOT NULL,
  strength REAL NOT NULL DEFAULT 1.0,
  source TEXT NOT NULL DEFAULT 'auto'
    CHECK(source IN ('auto', 'manual', 'feedback', 'mark')),
  last_signal_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL DEFAULT (datetime('now', '+14 days')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, topic)
);
CREATE INDEX IF NOT EXISTS idx_utt_user ON user_topic_tracking(user_id);
CREATE INDEX IF NOT EXISTS idx_utt_expires ON user_topic_tracking(expires_at);

-- 跨源事件聚类
CREATE TABLE IF NOT EXISTS raw_item_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  raw_item_id INTEGER NOT NULL REFERENCES raw_items(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  is_representative INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(raw_item_id)
);
CREATE INDEX IF NOT EXISTS idx_rie_event ON raw_item_events(event_id);
CREATE INDEX IF NOT EXISTS idx_rie_item ON raw_item_events(raw_item_id);
```

### 6.2 现有表变更

```sql
-- digests 表新增字段：记录 Digest 内容条目与 raw_items 的关联
ALTER TABLE digests ADD COLUMN item_refs TEXT DEFAULT '[]';
-- item_refs 格式: [{ "index": 0, "raw_item_id": 123, "source_id": 5, "event_id": "evt_abc" }, ...]
```

### 6.3 ER 关系

```
users ─┬── user_source_weights ──── sources
       ├── digest_feedback ──┬──── digests
       │                     └──── raw_items
       ├── user_preferences
       ├── user_topic_tracking
       └── user_subscriptions ──── sources

sources ──── source_weights
raw_items ─┬── raw_item_topics
           └── raw_item_events
```

---

## 7. API 设计

### 7.1 Digest 反馈

```
POST /api/digests/:id/feedback
Auth: Cookie (登录用户)
Body: { "item_index": 2, "signal": "useful", "raw_item_id": 123 }
Response: { "ok": true }
```

```
GET /api/digests/:id/feedback
Auth: Cookie
Response: [{ "item_index": 2, "signal": "useful", "created_at": "..." }]
```

### 7.2 用户 Source 权重

```
GET /api/subscriptions/weights
Auth: Cookie
Response: [{ "source_id": 5, "quality_score": 0.82, "user_weight": "auto" }]
```

```
PUT /api/subscriptions/:sourceId/weight
Auth: Cookie
Body: { "weight": "high" }  // high | medium | low | muted | auto
Response: { "ok": true }
```

### 7.3 话题追踪

```
GET /api/topics/tracking
Auth: Cookie
Response: [{ "topic": "Rust async runtime", "strength": 1.5, "source": "auto", "expires_at": "..." }]
```

```
POST /api/topics/track
Auth: Cookie
Body: { "topic": "Rust async runtime" }
Response: { "ok": true }
```

```
DELETE /api/topics/tracking/:id
Auth: Cookie
Response: { "ok": true }
```

### 7.4 用户偏好概览

```
GET /api/preferences
Auth: Cookie
Response: {
  "feedback_count": 45,
  "top_sources": [{ "source_id": 5, "name": "Hacker News", "score": 0.85 }],
  "top_topics": [{ "topic": "AI", "score": 0.72 }],
  "tracked_topics": 3,
  "calculated_at": "..."
}
```

### 7.5 内部 API（API Key 认证）

```
POST /api/internal/quality-scores/recalculate
Auth: Bearer API_KEY
Response: { "ok": true, "sources_updated": 25 }
```

```
POST /api/internal/events/cluster
Auth: Bearer API_KEY
Body: { "since": "2026-02-24T00:00:00Z" }
Response: { "ok": true, "events_found": 8, "items_clustered": 23 }
```

---

## 8. 前端变更

### 8.1 Digest 反馈 UI

**位置：** 每条 Digest 条目右侧

```
┌─────────────────────────────────────────┐
│ 📰 OpenAI 发布 GPT-5，支持百万 token    │
│ 来自 Hacker News · 综合 3 个来源          │
│                              👍  👎      │
└─────────────────────────────────────────┘
```

- 未反馈时两个按钮灰色
- 点击后高亮对应按钮，另一个变暗
- 可以取消或切换
- 操作即时发送到后端，无需额外保存按钮

### 8.2 Source 权重 UI

**位置：** Sources 订阅列表页，每个 Source 卡片上

```
┌────────────────────────────────────────────────┐
│ ⭐ Hacker News          质量分: 0.85  ████████░░│
│    hackernews · 312 订阅者                      │
│    我的权重: [自动 ▾]  [高] [中] [低] [静音]     │
└────────────────────────────────────────────────┘
```

- "自动"为默认，跟随全局 quality_score
- 手动选择后显示实际生效的权重乘数
- "静音"= 不退订但该 Source 内容不进入 Digest

### 8.3 话题追踪 UI

**位置：** Digest 详情页 + 独立话题管理页

Digest 条目上：
```
┌─────────────────────────────────────────┐
│ 📰 Rust 异步运行时大战：Tokio vs ...     │
│ #rust #async-runtime                     │
│                    [📌 追踪此话题] 👍 👎 │
└─────────────────────────────────────────┘
```

话题管理页（Settings 下新增 tab）：
```
┌─────────────────────────────────────────────────┐
│ 📌 我追踪的话题                                   │
│                                                   │
│ Rust async runtime    强度: ██████░░  14天后过期   │
│ GPT-5                 强度: ████░░░░  手动追踪     │
│ SQLite vs PostgreSQL  强度: ██░░░░░░   3天后过期   │
│                                        [管理]     │
└─────────────────────────────────────────────────┘
```

### 8.4 去重展示 UI

合并条目在 Digest 中的显示：
```
┌─────────────────────────────────────────────────┐
│ 📰 OpenAI 发布 GPT-5                             │
│ 综合 3 个来源 ▾                                   │
│   ├── Hacker News (score: 284)                   │
│   ├── r/MachineLearning (↑ 1.2k)                 │
│   └── The Verge RSS                              │
│                                          👍  👎  │
└─────────────────────────────────────────────────┘
```

"综合 N 个来源"默认折叠，点击展开详细来源列表。

---

## 9. 验收标准

### 9.1 Source 权重系统
- [ ] `source_weights` 表存在且每日自动更新
- [ ] quality_score 基于采集成功率、被选中率、反馈率、订阅者数、鲜度五维加权计算
- [ ] 用户可手动设置 Source 权重为 高/中/低/静音/自动
- [ ] Digest 生成时实际使用加权采样（而非简单时间截断）
- [ ] "静音"的 Source 内容不出现在该用户的 Digest 中

### 9.2 用户反馈循环
- [ ] Digest 每条条目显示 thumbs-up / thumbs-down 按钮
- [ ] 反馈数据正确存入 `digest_feedback` 表
- [ ] 反馈后 30 天内 Digest 内容可观察到个性化差异
- [ ] 用户可在设置页查看反馈统计概览
- [ ] 反馈不影响页面加载性能（异步提交）

### 9.3 话题追踪
- [ ] Digest 条目显示话题标签
- [ ] 用户可手动追踪话题
- [ ] 连续 2 次正向反馈同话题内容 → 自动追踪
- [ ] 追踪话题的后续报道在 Digest 中权重提升 >= 1.5x
- [ ] 话题追踪 14 天无新信号自动过期
- [ ] 用户可查看和管理追踪话题列表

### 9.4 跨源去重
- [ ] 同一 24h 窗口内标题相似度 > 0.5 的条目被聚类为同一事件
- [ ] 每个事件簇仅一条代表进入 Digest 候选
- [ ] 代表选取优先：Source 权重高 + 内容丰富
- [ ] Digest 中合并条目显示"综合 N 个来源"
- [ ] 去重不误伤：相似但不同的事件保持独立（如"GPT-5 发布"和"GPT-5 定价争议"为不同事件）

---

## 10. 依赖关系

### 10.1 前置依赖

| 依赖 | 状态 | 影响 |
|------|------|------|
| **1.1 raw_items 采集管道** | 已完成 (PR #15) | 提供 raw_items 表和采集基础设施 |
| **1.2 个性化 Digest 生成** | **必须先完成** | 本 feature 的权重/反馈/话题全部作用于个性化 Digest 生成流程 |
| **1.3 Cron 采集集成** | 建议先完成 | 权重重算和事件聚类需要定时任务基础设施 |

### 10.2 后续解锁

| Feature | 关系 |
|---------|------|
| **2.1 多渠道推送** | 话题追踪更新可触发推送通知 |
| **2.2 AI 互动助理** | 偏好模型可用于个性化问答 |
| **2.3 Mark 增强** | 收藏行为接入话题追踪信号 |
| **3.2 Source Market** | quality_score 可用于 Source 排行 |
| **3.4 订阅组合缓存** | 权重个性化可能降低缓存命中率，需评估 |

### 10.3 技术依赖

- `digests` 表需新增 `item_refs` 字段，用于关联 Digest 条目与 raw_items（反馈需要此关联）
- Digest 生成器（当前为外部 LLM 调用）需要改造为输出结构化 JSON（含 raw_item_id 映射和话题标签）
- 定时任务框架（quality_score 重算、偏好重算、话题过期清理）

---

## 11. 风险与开放问题

### 11.1 风险

| 风险 | 严重度 | 缓解方案 |
|------|--------|---------|
| **冷启动问题** — 新用户无反馈数据，权重系统无法个性化 | 中 | 新用户默认使用全局 quality_score + 推荐包的权重；前 10 次反馈期间逐步过渡 |
| **反馈稀疏** — 用户懒得点 thumbs-up/down | 高 | UI 极简化（单击即可），考虑 swipe 手势；设置引导鼓励反馈；利用隐式信号（阅读时长、收藏）补充 |
| **去重误伤** — 标题相似度算法把不同事件合并 | 中 | 阈值保守（0.5），加入时间窗口约束（24h 内），可在 Digest 生成时由 LLM 二次确认 |
| **话题漂移** — 关键词级话题追踪不够精确 | 低 | 初期用 LLM 生成话题标签（语义级），而非纯关键词匹配 |
| **性能** — N² 标题比较在 raw_items 量大时变慢 | 低 | 限定时间窗口（24h）+ 预过滤（同时段有 >1 个 Source 才需要去重），预计候选集 < 500 |

### 11.2 开放问题

1. **Digest 条目与 raw_items 的关联方式**
   - 当前 Digest 是 LLM 生成的自由文本（`content` 字段），没有结构化条目概念
   - 需要先将 Digest 格式改为结构化 JSON（或在 `metadata` 中存储条目映射），才能实现逐条反馈
   - **建议：** 这部分改造作为 1.2 个性化 Digest 的一部分完成

2. **quality_score 的初始值和校准**
   - 新 Source 没有历史数据，初始 quality_score 设为 0.5 是否合理？
   - 不同类型 Source（RSS 博客 vs HN Top）的基准线不同，是否需要按类型设置不同的初始值？

3. **话题标签的粒度**
   - "AI" 太粗，"OpenAI GPT-5 发布时间 2026-03-01" 太细
   - 需要定义合适的粒度规范，建议 2-4 个词的短语（如 "GPT-5 release", "Rust async runtime"）

4. **权重系统与订阅组合缓存（3.4）的冲突**
   - 如果每个用户的权重不同，则相同订阅组合的 Digest 也不同，缓存命中率下降
   - 可能的方案：权重分桶（高/中/低三档），相同桶+相同订阅组合可共享缓存

5. **反馈信号是否回传给 Source 创建者**
   - Source 创建者是否应该看到"你的 Source 全局质量分为 0.3，被大量用户标记为没用"？
   - 正面：激励创建者改善 Source 质量。负面：可能引发争议

---

*Generated by Jessie — 2026-02-25*
