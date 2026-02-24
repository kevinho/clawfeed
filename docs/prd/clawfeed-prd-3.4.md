# PRD 3.4: 订阅组合缓存 (Subscription Combination Cache)

> ClawFeed Phase 3.4 | 作者: Jessie | 2026-02-25

---

## 1. 背景与动机

ClawFeed 当前架构下，Digest 生成是 **per-user** 的流程：

1. 查询用户订阅 (`user_subscriptions`) 获取 `source_ids`
2. 从 `raw_items` 表拉取这些 Source 的最新内容
3. 调用 LLM（按 `digest-prompt.md` 模板）生成 Digest
4. 写入 `digests` 表，关联 `user_id`

假设系统有 1,000 个活跃用户，每人每天生成 1 次 Daily Digest，就需要 **1,000 次 LLM 调用**。但实际上，大量用户的订阅组合高度重叠——尤其是通过 Source Pack 一键安装的用户，他们的 `source_ids` 集合完全相同。

**核心洞察：** 如果两个用户订阅了完全相同的 Source 集合，他们的 raw_items 输入相同，Digest 输出也应该相同。没有必要重复调用 LLM。

**当前成本模型（以 1,000 用户为例）：**

| 项目 | 无缓存 | 有缓存（80% 命中率） |
|------|--------|---------------------|
| 每日 LLM 调用 | 1,000 次 | ~200 次 |
| 按 $0.03/次估算月成本 | $900 | $180 |
| 月节省 | — | **$720 (80%)** |

随用户规模增长，节省效果非线性放大——新用户大概率复用已有组合。

---

## 2. 目标

| 目标 | 指标 | 验收阈值 |
|------|------|---------|
| 降低 LLM 调用成本 | 相同组合不重复生成 | 成本降低 5-10x |
| 缓存命中率 | `cache_hits / total_requests` | > 80% |
| Digest 生成延迟 | 缓存命中时跳过 LLM | < 100ms（DB 查询） |
| 不影响个性化 | 不同订阅组合仍独立生成 | 100% 正确性 |
| 缓存一致性 | Source 变更后缓存失效 | 脏数据率 = 0 |

---

## 3. 功能需求

### 3.1 订阅组合 Hash 计算

每个用户的订阅组合可唯一表示为一个 hash：

```
subscription_hash = SHA256(sorted(source_ids).join(','))
```

**规则：**
- `source_ids` 取自 `user_subscriptions` 中 `is_active = 1` 且对应 Source 未被软删除（`sources.is_deleted = 0`）的记录
- 排序后拼接为逗号分隔字符串，再做 SHA-256
- 结果为 64 字符 hex 字符串
- 空订阅列表的 hash 为固定值 `SHA256("")`，对应跳过 Digest 生成

**示例：**
```
用户 A 订阅: [3, 1, 7]  → sorted: "1,3,7" → SHA256 → "a1b2c3..."
用户 B 订阅: [7, 3, 1]  → sorted: "1,3,7" → SHA256 → "a1b2c3..."  (相同)
用户 C 订阅: [1, 3, 7, 9] → sorted: "1,3,7,9" → SHA256 → "d4e5f6..."  (不同)
```

### 3.2 缓存查询流程

Digest 生成流程改造为：

```
生成 Digest(user_id, type, period):
  1. 查询用户有效订阅 → source_ids
  2. 计算 subscription_hash
  3. 查缓存: SELECT FROM digest_cache
       WHERE hash = ? AND type = ? AND period_start = ? AND period_end = ?
  4. 若命中 → 直接写入 digests 表（复用 content），关联 user_id
  5. 若未命中 → 调用 LLM 生成 → 写入 digests 表 + 写入 digest_cache
```

### 3.3 缓存写入

LLM 生成完成后，同时写入：
- `digests` 表（现有逻辑，关联 `user_id`）
- `digest_cache` 表（新增，关联 `subscription_hash`）

### 3.4 缓存失效

以下事件触发缓存失效：
- 用户订阅/退订 Source → 该用户的 `subscription_hash` 变化（自动失效，无需主动清除）
- Source 被删除（软删除）→ 涉及该 Source 的所有 hash 失效
- Source 内容更新（新 raw_items 入库）→ 下一个 period 自动使用新数据
- 手动清除（管理接口）

详见第 6 节。

---

## 4. 技术方案

### 4.1 Hash 计算实现

在 `db.mjs` 中新增：

```javascript
import { createHash } from 'crypto';

export function computeSubscriptionHash(db, userId) {
  const rows = db.prepare(`
    SELECT us.source_id FROM user_subscriptions us
    JOIN sources s ON us.source_id = s.id
    WHERE us.user_id = ? AND us.is_active = 1 AND s.is_deleted = 0
    ORDER BY us.source_id ASC
  `).all(userId);

  const key = rows.map(r => r.source_id).join(',');
  return createHash('sha256').update(key).digest('hex');
}
```

**注意：** `server.mjs` 已经 import 了 `crypto` 模块（用于 `createHmac`），这里复用 Node.js 内置能力，零新增依赖。

### 4.2 缓存存储

使用 SQLite 表（与现有架构一致，无需引入 Redis）：

- 当前数据规模（~400 用户）下 SQLite 完全够用
- `digest_cache` 表预计行数 = 独立组合数 x 类型数 x 保留天数，量级在千级
- WAL 模式已启用（`db.mjs` 第 27 行），读写并发无问题

未来如用户量突破 10K+，可考虑迁移至 Redis（参见 roadmap 4.3 架构演进）。

### 4.3 Digest 生成集成点

当前 Digest 生成流程在 `server.mjs` 的 `POST /api/digests` 端点（第 530-537 行），由外部采集脚本调用。改造方案：

**方案 A（推荐）：内部生成函数**

新增 `generateDigestForUser(db, userId, type)` 函数，封装完整的缓存查询 + LLM 调用 + 缓存写入逻辑。Cron 脚本调用此函数而非直接调 API。

**方案 B：API 层缓存**

在 `POST /api/digests` 端点增加缓存层。但该端点目前是通用的内容写入接口，加缓存会增加耦合。

选择方案 A，原因：
1. 缓存逻辑内聚在生成模块，不污染通用 API
2. 便于未来 Cron 集成（Phase 1.3）直接调用
3. `listRawItemsForDigest`（`db.mjs` 第 494 行）已有按 sourceIds 查询的能力，可直接复用

### 4.4 Period 窗口定义

缓存按 **时间窗口** 区分，避免不同时段的 raw_items 混用：

| Digest 类型 | Period 粒度 | 示例 |
|-------------|------------|------|
| `4h` | 4 小时窗口 | `2026-02-25T08:00+08:00 ~ 2026-02-25T12:00+08:00` |
| `daily` | 自然日 (SGT) | `2026-02-25T00:00+08:00 ~ 2026-02-26T00:00+08:00` |
| `weekly` | 自然周 (周一开始) | `2026-02-24 ~ 2026-03-02` |
| `monthly` | 自然月 | `2026-02-01 ~ 2026-03-01` |

Period 由 `period_start` 和 `period_end` 共同定义，确保同一组合在同一窗口内只生成一次。

---

## 5. 数据模型

### 5.1 新增表：`digest_cache`

```sql
CREATE TABLE IF NOT EXISTS digest_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_hash TEXT NOT NULL,        -- SHA-256 of sorted source_ids
  digest_type TEXT NOT NULL,              -- '4h', 'daily', 'weekly', 'monthly'
  period_start TEXT NOT NULL,             -- ISO 8601 时间窗口开始
  period_end TEXT NOT NULL,               -- ISO 8601 时间窗口结束
  content TEXT NOT NULL,                  -- LLM 生成的 Digest 内容
  metadata TEXT DEFAULT '{}',             -- 生成参数、raw_items 统计等
  source_ids TEXT NOT NULL,               -- 原始 source_id 列表 (JSON array)，用于失效判断
  raw_item_count INTEGER DEFAULT 0,       -- 参与生成的 raw_items 数量
  llm_model TEXT,                         -- 使用的模型标识
  llm_tokens INTEGER,                     -- token 消耗量
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,                        -- 过期时间（可选，用于自动清理）
  UNIQUE(subscription_hash, digest_type, period_start)
);

CREATE INDEX IF NOT EXISTS idx_dc_hash_type ON digest_cache(subscription_hash, digest_type);
CREATE INDEX IF NOT EXISTS idx_dc_period ON digest_cache(period_start, period_end);
CREATE INDEX IF NOT EXISTS idx_dc_expires ON digest_cache(expires_at);
```

### 5.2 新增表：`user_subscription_hashes`（物化视图）

为避免每次生成 Digest 时重新计算 hash，维护一个物化缓存：

```sql
CREATE TABLE IF NOT EXISTS user_subscription_hashes (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  subscription_hash TEXT NOT NULL,
  source_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ush_hash ON user_subscription_hashes(subscription_hash);
```

**更新时机：**
- `subscribe()` / `unsubscribe()` / `bulkSubscribe()` 调用后
- Source 软删除时（影响所有订阅该 Source 的用户）

### 5.3 现有表不做改动

`digests` 表保持不变。缓存命中时，仍正常写入 `digests` 表（复用 content），保证前端查询逻辑不受影响。

### 5.4 Migration 文件

新建 `migrations/011_digest_cache.sql`，包含上述两个表的 CREATE 语句。遵循现有 migration 模式（幂等，`CREATE IF NOT EXISTS`）。

---

## 6. 缓存失效策略

### 6.1 基于时间窗口的自然失效

每个 `digest_cache` 条目绑定了 `period_start` 和 `period_end`。下一个时间窗口开始时，新的 Digest 请求会使用新的 period 参数，自然不会命中旧缓存。

**这是主要的失效机制——大多数场景不需要主动清除。**

### 6.2 订阅变更

| 事件 | 影响 | 处理方式 |
|------|------|---------|
| 用户订阅新 Source | 该用户 hash 变化 | 更新 `user_subscription_hashes`，新 hash 无缓存则重新生成 |
| 用户退订 Source | 该用户 hash 变化 | 同上 |
| 批量订阅（Pack 安装） | 该用户 hash 变化 | 同上 |

**不需要删除旧缓存。** 旧 hash 对应的缓存仍可被其他用户命中。

### 6.3 Source 级变更

| 事件 | 影响 | 处理方式 |
|------|------|---------|
| Source 被软删除 | 涉及该 Source 的所有组合 hash 变化 | 批量更新 `user_subscription_hashes`（查询 `user_subscriptions` 中订阅该 Source 的用户） |
| Source 恢复激活 | 同上 | 同上 |

```sql
-- 查找受影响的用户
SELECT DISTINCT user_id FROM user_subscriptions WHERE source_id = ?;
-- 对每个用户重新计算 hash
```

### 6.4 主动清除（管理操作）

提供管理接口用于紧急清除：

```
DELETE /api/admin/digest-cache?hash=xxx     -- 清除指定组合
DELETE /api/admin/digest-cache?before=date  -- 清除指定日期前的缓存
DELETE /api/admin/digest-cache              -- 清除所有缓存
```

### 6.5 自动过期清理

定期任务清理过期缓存，防止 SQLite 文件膨胀：

```sql
DELETE FROM digest_cache WHERE expires_at < datetime('now');
```

建议过期策略：
- `4h` 类型：保留 3 天
- `daily` 类型：保留 14 天
- `weekly` 类型：保留 60 天
- `monthly` 类型：保留 180 天

---

## 7. 性能预估

### 7.1 命中率模型

基于以下假设建模：
- 80% 新用户通过 Source Pack 注册，订阅组合相同
- 10% 用户在默认 Pack 基础上增减 1-2 个 Source
- 10% 用户完全自定义

| 用户规模 | 预估独立组合数 | 缓存命中率 | LLM 调用减少比 |
|---------|--------------|-----------|---------------|
| 100 | ~15 | 85% | 6.7x |
| 1,000 | ~80 | 92% | 12.5x |
| 10,000 | ~300 | 97% | 33x |

**长尾效应：** Pack 机制天然促进订阅趋同。`install_count` 最高的 Pack（见 `source_packs` 表）的用户群体最大，缓存收益最高。

### 7.2 存储开销

每条 `digest_cache` 记录约 5-10 KB（主要是 content 字段）。

| Digest 类型 | 每日新增缓存条目 | 月增量 |
|-------------|----------------|--------|
| `4h` | 独立组合数 x 6 | ~2,880 条 (80 组合) |
| `daily` | 独立组合数 x 1 | ~2,400 条 |
| `weekly` | 独立组合数 x 0.14 | ~48 条 |

按 80 个独立组合、保留 14 天计算，`digest_cache` 表约 **10K 行，50-100 MB**，SQLite 轻松承载。

### 7.3 延迟影响

| 场景 | 延迟 |
|------|------|
| 缓存命中（DB 查询） | < 5ms |
| 缓存未命中（LLM 调用） | 10-30s（取决于模型） |
| Hash 计算 | < 1ms |
| Hash 物化表更新 | < 5ms |

**总结：** 缓存命中时 Digest "生成" 从数十秒降至毫秒级。

---

## 8. API 变更

### 8.1 新增内部函数（`db.mjs`）

```javascript
// Hash 计算
computeSubscriptionHash(db, userId) → string

// Hash 物化表
updateUserSubscriptionHash(db, userId) → void
getUserSubscriptionHash(db, userId) → { hash, source_count }
getUsersBySubscriptionHash(db, hash) → [{ user_id }]

// Digest 缓存
getDigestCache(db, { hash, type, periodStart }) → cache_entry | null
setDigestCache(db, { hash, type, periodStart, periodEnd, content, metadata, sourceIds, rawItemCount, llmModel, llmTokens }) → id
deleteDigestCache(db, { hash?, before?, all? }) → changes
cleanExpiredDigestCache(db) → changes

// 缓存统计
getDigestCacheStats(db) → { total, hit_rate, unique_hashes, by_type }
```

### 8.2 现有函数修改

以下函数需要在操作后触发 hash 更新：

| 函数 | 文件 | 修改内容 |
|------|------|---------|
| `subscribe()` | `db.mjs:393` | 操作后调用 `updateUserSubscriptionHash(db, userId)` |
| `unsubscribe()` | `db.mjs:398` | 同上 |
| `bulkSubscribe()` | `db.mjs:401` | 同上 |
| `deleteSource()` | `db.mjs:326` | 操作后批量更新受影响用户的 hash |
| `upsertUser()` | `db.mjs:201` | 新用户自动订阅后计算初始 hash |

### 8.3 新增 API 端点

| 方法 | 路径 | 认证 | 说明 |
|------|------|------|------|
| `GET` | `/api/digest-cache/stats` | API Key | 缓存统计信息 |
| `DELETE` | `/api/admin/digest-cache` | API Key | 手动清除缓存 |
| `GET` | `/api/subscription-hash` | Session | 当前用户的订阅 hash |

### 8.4 不变更的端点

| 端点 | 说明 |
|------|------|
| `GET /api/digests` | 仍从 `digests` 表读取，不感知缓存 |
| `GET /feed/:slug` | 同上 |
| `POST /api/digests` | 保留原有功能，但未来 Digest 生成建议走内部函数 |

---

## 9. 验收标准

### 9.1 功能验收

- [ ] 两个订阅组合完全相同的用户，第二个用户生成 Digest 时不触发 LLM 调用
- [ ] 用户订阅/退订 Source 后，hash 自动更新
- [ ] Source 被软删除后，涉及该 Source 的 hash 自动重新计算
- [ ] 缓存命中时，写入 `digests` 表的 content 与缓存内容一致
- [ ] 空订阅的用户不触发 LLM 调用也不写入缓存
- [ ] `digest_cache` 过期数据能被自动清理
- [ ] 管理员可通过 API 手动清除缓存

### 9.2 性能验收

- [ ] 缓存命中率在 100 用户规模下 >= 80%
- [ ] 缓存命中时端到端延迟 < 100ms
- [ ] Hash 计算对订阅/退订操作的额外延迟 < 10ms
- [ ] `digest_cache` 表在万行级别时查询延迟 < 5ms

### 9.3 数据完整性

- [ ] `digest_cache` 与 `digests` 内容一致性：写入 `digests` 的 content 必须 == 缓存 content
- [ ] `user_subscription_hashes` 与实际订阅始终一致：任何修改订阅的操作后 hash 都被更新
- [ ] 无脏读：period 窗口内 raw_items 有增量时，同 period 的缓存不应被污染（period 内新增 raw_items 归入下一 period）

### 9.4 测试用例

1. **基础命中：** 创建 2 个用户，订阅相同 Source，生成 Digest，验证只有 1 次 LLM 调用
2. **Hash 正确性：** 验证不同顺序的 source_ids 产生相同 hash
3. **退订后失效：** 用户退订 1 个 Source 后，hash 变化，下次生成不命中缓存
4. **Source 删除：** 软删除 Source 后，涉及的 hash 全部重算
5. **Period 隔离：** 同 hash + 同 type，不同 period 不互相命中
6. **过期清理：** 设置 `expires_at` 为过去时间，运行清理，验证被删除
7. **并发安全：** 两个相同 hash 的用户同时请求生成，只有一个触发 LLM（需加锁机制或 UNIQUE 约束兜底）

---

## 10. 依赖关系

### 10.1 前置依赖

| 依赖项 | Roadmap 编号 | 状态 | 原因 |
|--------|-------------|------|------|
| raw_items 采集管道 | 1.1 | 已完成 (PR #15) | 缓存的输入数据来自 raw_items |
| 个性化 Digest 生成 | 1.2 | 待开发 | 缓存机制建立在 per-user Digest 之上；如果所有用户看同一个 Digest（当前状态），就不需要缓存 |
| Cron 采集集成 | 1.3 | 待开发 | Digest 生成时机由 Cron 触发，缓存查询嵌入此流程 |

**Phase 1.2 是硬依赖。** 没有个性化 Digest，就没有"相同组合共享"的需求。

### 10.2 后续依赖（被本特性 unblock）

| 特性 | 说明 |
|------|------|
| 分析仪表板 (3.5) | 缓存统计数据（命中率、LLM 调用量）是仪表板数据源之一 |
| 付费层级 (4.1) | 成本结构改善后，Free 层可以提供更高频率的 Digest |
| 团队功能 (4.2) | 团队成员共享订阅组合，缓存命中率极高 |

### 10.3 技术依赖

- Node.js `crypto` 模块（已在使用，`server.mjs` 第 7 行）
- `better-sqlite3`（已有，唯一外部依赖）
- 无需引入 Redis 或其他新依赖

---

## 11. 风险与开放问题

### 11.1 已识别风险

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| **Hash 物化表不一致** | 用户看到错误的缓存 Digest | 所有订阅修改函数统一触发 hash 更新；定期全量校验任务 |
| **并发写入冲突** | 同 hash 同时生成，重复 LLM 调用 | `UNIQUE(subscription_hash, digest_type, period_start)` 约束 + INSERT OR IGNORE 兜底；接受小概率重复（浪费 1 次调用好过引入分布式锁复杂度） |
| **Period 边界 raw_items 归属** | 采集和生成时间差导致部分 raw_items 被遗漏或重复 | 以 `raw_items.fetched_at` 为准划分 period，生成时加 buffer（如 period_end 往后延 5 分钟） |
| **SQLite 写入瓶颈** | 高并发下 WAL 模式也有写串行化 | 当前规模无风险；10K+ 用户时评估迁移 PostgreSQL |

### 11.2 开放问题

1. **部分重叠组合的缓存** — 如果用户 A 订阅了 [1,3,7]，用户 B 订阅了 [1,3,7,9]，B 的 Digest 是否可以基于 A 的结果增量生成（只对 Source 9 的增量内容调 LLM）？这会进一步降低成本，但显著增加实现复杂度。**建议 v1 不做，先观察完全匹配的命中率是否已足够。**

2. **Digest 个性化参数** — 如果未来支持用户自定义 Digest 偏好（语言、风格、长度），则 hash 需要包含这些参数。当前设计的 `subscription_hash` 仅基于 `source_ids`，需要预留扩展能力。**建议 hash 计算函数接受可选的 `options` 参数：**
   ```
   hash = SHA256(sorted(source_ids).join(',') + '|' + JSON.stringify(sorted_options))
   ```

3. **缓存预热** — 是否在 Digest 生成窗口开始时，主动为 Top N 个高频组合预生成缓存？可以减少用户等待时间，但增加 Cron 复杂度。**建议 v1 不做，按需生成即可。**

4. **多语言 Digest (Phase 3.3) 的交互** — 同组合 + 不同语言应视为不同缓存条目。hash 需包含语言参数。**待 3.3 设计时确认。**

5. **缓存穿透保护** — 如果存在大量独特组合（极端情况），缓存无法发挥作用。是否需要限制用户最大 Source 订阅数（如 Free 10 / Pro 50）来间接控制组合发散？**已在 roadmap 4.1 付费层级中规划，可在此之前不做。**

---

## 附录 A: 现有数据模型参考

**关键表关系（当前）：**

```
users (id, google_id, email, name, slug)
  └── user_subscriptions (user_id, source_id)
        └── sources (id, name, type, config, is_active, is_deleted)
              └── raw_items (source_id, title, url, content, fetched_at)
  └── digests (id, type, content, user_id, created_at)
```

**缓存层插入点：**

```
users
  └── user_subscription_hashes (user_id → subscription_hash)  [新增]
  └── user_subscriptions → sources → raw_items
                                          ↓ (LLM 生成)
  └── digests ← digest_cache (subscription_hash → content)    [新增]
```

## 附录 B: db.mjs 修改清单

| 行号 | 函数 | 修改类型 | 说明 |
|------|------|---------|------|
| 7 | (文件头) | 新增 import | `import { createHash } from 'crypto'` |
| ~115 | (migration 加载) | 新增 | 加载 `011_digest_cache.sql` |
| ~226 | `upsertUser()` | 追加逻辑 | 自动订阅后计算初始 hash |
| ~393 | `subscribe()` | 追加逻辑 | 更新 hash |
| ~398 | `unsubscribe()` | 追加逻辑 | 更新 hash |
| ~401 | `bulkSubscribe()` | 追加逻辑 | 更新 hash |
| ~326 | `deleteSource()` | 追加逻辑 | 批量更新受影响用户 hash |
| 新增 | `computeSubscriptionHash()` | 新函数 | 核心 hash 计算 |
| 新增 | `updateUserSubscriptionHash()` | 新函数 | hash 物化表更新 |
| 新增 | `getDigestCache()` | 新函数 | 缓存查询 |
| 新增 | `setDigestCache()` | 新函数 | 缓存写入 |
| 新增 | `deleteDigestCache()` | 新函数 | 缓存清除 |
| 新增 | `cleanExpiredDigestCache()` | 新函数 | 过期清理 |
| 新增 | `getDigestCacheStats()` | 新函数 | 统计接口 |

---

*Generated by Jessie -- 2026-02-25*
