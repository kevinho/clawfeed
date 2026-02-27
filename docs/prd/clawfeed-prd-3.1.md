# ClawFeed PRD 3.1: Agent Friendly API

> **版本**: v0.1 draft
> **日期**: 2026-02-25
> **作者**: Jessie
> **对应 Roadmap**: Phase 3.1 (v1.5 → v2.0)

---

## 1. 背景与动机

ClawFeed 当前 API 是为浏览器 SPA 设计的——Cookie 鉴权、无 schema 约束、无版本控制、错误格式不统一。这对人类用户没有问题，但对 AI Agent 来说是灾难：

**当前痛点：**

| 问题 | 影响 |
|------|------|
| 无 JSON Schema | Agent 不知道返回字段类型，每次调用都是"盲猜" |
| 无幂等设计 | Agent 重试可能创建重复 Source/Digest |
| Cookie 鉴权 | Agent 无法拿 session cookie，只能用 API Key 访问极少端点 |
| 无事件通知 | Agent 只能轮询，无法知道"采集完了"或"Digest 生成完了" |
| 无 MCP 支持 | Claude/GPT 等 Agent 无法通过标准协议直接操作 ClawFeed |
| 无 API 文档 | 集成方只能读源码 |

**行业趋势：**

2025-2026 年 AI Agent 生态爆发，MCP (Model Context Protocol) 成为 Agent-to-Tool 的事实标准。Anthropic Claude、OpenAI GPT、Google Gemini 均支持或兼容 MCP tool calling。ClawFeed 如果不提供 Agent Friendly 的接口，就无法被纳入任何 Agent 的工具链。

**核心主张：** ClawFeed 不仅是人看的产品，更是 Agent 的信息基础设施。Agent Friendly API 是平台化的前提。

---

## 2. 目标

### 必须达成

1. **任何 MCP 兼容 Agent 可在 5 分钟内接入 ClawFeed**——无需读源码，仅凭 tool description 即可完成"添加 Source → 等待采集 → 获取 Digest"全流程
2. **所有写操作幂等**——Agent 可安全重试任意请求而不产生副作用
3. **事件驱动通知**——Source 采集完成、Digest 生成完成时主动推送 Webhook
4. **完整 OpenAPI 3.1 spec**——自动生成，与代码同步

### 不做

- 不做 GraphQL（REST + MCP 已满足需求，GraphQL 增加复杂度无收益）
- 不做 Agent 认证体系变更（复用现有 API Key 机制，未来 Phase 4 再考虑 OAuth scope）
- 不做 Rate Limiting 精细化（Phase 4 付费层级再做）

---

## 3. 用户故事

> 以下所有"用户"指 AI Agent（Claude Agent / GPT Agent / 自建 Agent）

### US-1: Agent 发现并理解 API

> 作为一个 Claude Agent，当我的主人说"帮我用 ClawFeed 订阅 Hacker News"时，我能通过 MCP 服务发现 ClawFeed 提供的所有 tool 和 resource，阅读 description 就知道如何操作，而无需查阅外部文档。

### US-2: Agent 管理 Source

> 作为一个 GPT Agent，我需要为用户添加一个 RSS 源。我发送 `sources/create` 请求，附带 `idempotency_key`。即使网络超时导致我重试 3 次，也只会创建 1 个 Source。完成后我收到结构化响应，明确告知 `created` 或 `already_exists`。

### US-3: Agent 获取结构化 Digest

> 作为一个 Agent，我需要获取最新的 Daily Digest 内容并转发给用户。我调用 `digests/list`，得到的 JSON 包含严格的 schema（title, items[], summary, created_at），每个 item 有 source_name, url, relevance_score。我无需解析 markdown 字符串。

### US-4: Agent 响应事件

> 作为一个编排 Agent，我注册了 `digest.created` webhook。当 ClawFeed 生成新 Digest 时，我收到 POST 回调，里面包含 digest_id 和 summary。我据此触发下游动作（推送到 Telegram、写入 Notion），而不是每 5 分钟轮询一次。

### US-5: Agent 批量操作

> 作为一个 Agent，用户让我"把这个 Source Pack 里的所有源都订阅了"。我调用 `packs/install`，单次请求完成全部订阅。响应告诉我 `added: 8, skipped: 2`（2 个已存在），我据此向用户汇报。

### US-6: 开发者集成

> 作为一个第三方开发者，我要在自己的应用中集成 ClawFeed 的 Digest 功能。我下载 OpenAPI spec，用 codegen 工具自动生成 TypeScript client，直接调用。

---

## 4. 功能需求

### 4.1 结构化 JSON Schema 输出

**现状**: 返回格式由代码隐式决定，无 schema 定义，字段可能随迭代变化。

**需求**:

| 编号 | 需求 | 优先级 |
|------|------|--------|
| F-4.1.1 | 所有 API 端点的请求和响应均有 JSON Schema 定义 | P0 |
| F-4.1.2 | 错误响应统一格式：`{ error: { code, message, details? } }` | P0 |
| F-4.1.3 | 列表响应统一分页格式：`{ data: [], pagination: { total, limit, offset, has_more } }` | P0 |
| F-4.1.4 | 日期统一 ISO 8601 格式（UTC），附 `+00:00` 后缀 | P1 |
| F-4.1.5 | 枚举值均在 schema 中显式声明（如 source.type、digest.type） | P0 |
| F-4.1.6 | Digest content 除 markdown string 外增加 `items[]` 结构化字段 | P1 |

**错误码体系**:

```
error.code 命名规则: <domain>.<action>.<reason>
```

| code | HTTP | 含义 |
|------|------|------|
| `auth.required` | 401 | 未提供认证凭证 |
| `auth.invalid` | 401 | API Key 无效 |
| `source.not_found` | 404 | Source 不存在 |
| `source.duplicate` | 409 | 相同 type+config 的 Source 已存在 |
| `source.limit_exceeded` | 429 | Source 数量超限 |
| `digest.not_found` | 404 | Digest 不存在 |
| `webhook.invalid_url` | 422 | Webhook URL 不可达 |
| `request.invalid` | 400 | 请求体不合法 |
| `request.idempotent_conflict` | 409 | Idempotency key 冲突（不同请求体） |
| `server.internal` | 500 | 服务端错误 |

### 4.2 MCP Server 支持

**需求**:

| 编号 | 需求 | 优先级 |
|------|------|--------|
| F-4.2.1 | 实现独立 MCP Server 进程，通过 stdio 或 SSE 传输 | P0 |
| F-4.2.2 | 暴露 Tools：source 管理、digest 查询、subscription 操作、webhook 管理 | P0 |
| F-4.2.3 | 暴露 Resources：digest 内容、source 列表、raw items | P1 |
| F-4.2.4 | 暴露 Prompts：digest 摘要模板、source 推荐模板 | P2 |
| F-4.2.5 | MCP Server 可通过 npx 一键安装：`npx @clawfeed/mcp-server` | P1 |
| F-4.2.6 | 支持 Claude Desktop、Cursor、Windsurf 等主流 MCP Client 配置 | P0 |

### 4.3 Webhook 回调

**需求**:

| 编号 | 需求 | 优先级 |
|------|------|--------|
| F-4.3.1 | 支持注册 Webhook URL，接收事件推送 | P0 |
| F-4.3.2 | 事件类型：`source.created`, `source.updated`, `source.fetched`, `digest.created` | P0 |
| F-4.3.3 | Webhook payload 签名验证（HMAC-SHA256） | P0 |
| F-4.3.4 | 失败自动重试：指数退避，最多 5 次，跨 24 小时 | P1 |
| F-4.3.5 | Webhook 管理 API：CRUD + 最近投递记录查询 | P1 |
| F-4.3.6 | 支持事件过滤（注册时指定只关注某些事件类型） | P1 |

### 4.4 幂等操作设计

**需求**:

| 编号 | 需求 | 优先级 |
|------|------|--------|
| F-4.4.1 | 所有 POST/PUT 端点接受 `Idempotency-Key` header | P0 |
| F-4.4.2 | 相同 key + 相同请求体 = 返回首次结果（不重复执行） | P0 |
| F-4.4.3 | 相同 key + 不同请求体 = 返回 409 冲突 | P0 |
| F-4.4.4 | Idempotency key 有效期 24 小时 | P1 |
| F-4.4.5 | Source 创建自带逻辑幂等：相同 type+config 自动检测 | P0 |
| F-4.4.6 | 响应 header 包含 `Idempotent-Replayed: true` 标记重放 | P1 |

### 4.5 OpenAPI 文档自动生成

**需求**:

| 编号 | 需求 | 优先级 |
|------|------|--------|
| F-4.5.1 | 维护 OpenAPI 3.1 spec 文件（YAML），作为 single source of truth | P0 |
| F-4.5.2 | `/api/openapi.json` 端点提供 spec | P0 |
| F-4.5.3 | `/api/docs` 提供交互式文档（Swagger UI 或 Scalar） | P1 |
| F-4.5.4 | CI 中校验 spec 与实际 API 行为一致性 | P2 |

---

## 5. 技术方案

### 5.1 API 版本策略

```
/api/v1/sources       ← 新版 agent-friendly
/api/sources           ← 现有端点保持不变（兼容 SPA）
```

- 新增 `/api/v1/` 前缀的端点，包含完整 schema 验证、分页、幂等支持
- 现有 `/api/` 端点保持不变，SPA 零改动
- 当 SPA 迁移完成后，`/api/` 重定向到 `/api/v1/`

### 5.2 认证方案

当前认证方式不变，扩展支持：

| 场景 | 机制 | header |
|------|------|--------|
| SPA 用户 | Cookie session | `Cookie: session=xxx` |
| Agent / 开发者 | API Key (Bearer) | `Authorization: Bearer <key>` |
| MCP Server | 本地 API Key（配置文件传入） | 内部调用 |

API Key 当前是全局单个 key（admin 权限）。本阶段不变，Phase 4 再引入 per-user API Key + scope。

### 5.3 Idempotency 实现

```
新增表: idempotency_keys
┌──────────────────────────────┐
│ key        TEXT PRIMARY KEY  │
│ request_hash  TEXT NOT NULL  │  ← SHA256(method + path + body)
│ response_status INTEGER     │
│ response_body TEXT          │
│ created_at  TEXT            │
│ expires_at  TEXT            │
└──────────────────────────────┘
```

处理流程:

```
1. 检查 Idempotency-Key header
2. 若 key 已存在：
   a. request_hash 匹配 → 返回缓存 response，header 加 Idempotent-Replayed: true
   b. request_hash 不匹配 → 返回 409
3. 若 key 不存在：
   a. 执行请求
   b. 存储 key + request_hash + response
   c. 返回 response
4. 定时清理过期 key（>24h）
```

### 5.4 Webhook 实现

```
新增表: webhooks
┌──────────────────────────────┐
│ id          INTEGER PK      │
│ user_id     INTEGER FK      │
│ url         TEXT NOT NULL    │
│ secret      TEXT NOT NULL    │  ← 自动生成，用于 HMAC 签名
│ events      TEXT NOT NULL    │  ← JSON array: ["digest.created", "source.fetched"]
│ is_active   INTEGER DEFAULT 1│
│ created_at  TEXT            │
│ updated_at  TEXT            │
└──────────────────────────────┘

新增表: webhook_deliveries
┌──────────────────────────────┐
│ id          INTEGER PK      │
│ webhook_id  INTEGER FK      │
│ event_type  TEXT NOT NULL    │
│ payload     TEXT NOT NULL    │
│ status      TEXT            │  ← pending/success/failed
│ attempts    INTEGER DEFAULT 0│
│ last_attempt_at TEXT        │
│ next_retry_at   TEXT        │
│ response_status INTEGER     │
│ response_body   TEXT        │
│ created_at  TEXT            │
└──────────────────────────────┘
```

签名算法:

```
signature = HMAC-SHA256(webhook.secret, timestamp + "." + payload_json)
headers:
  X-ClawFeed-Signature: sha256=<hex>
  X-ClawFeed-Timestamp: <unix_seconds>
  X-ClawFeed-Event: digest.created
  X-ClawFeed-Delivery-Id: <uuid>
```

重试策略:

| 尝试 | 延迟 |
|------|------|
| 1 | 立即 |
| 2 | 1 分钟 |
| 3 | 15 分钟 |
| 4 | 1 小时 |
| 5 | 6 小时 |

5 次全部失败后标记 webhook 为 `failing`，不自动禁用（保留 Agent 自行修复的机会），但在 API 响应中提示。

### 5.5 结构化 Digest 输出

当前 Digest 的 `content` 是纯 markdown 字符串。为 Agent 增加结构化输出：

```json
{
  "id": 42,
  "type": "daily",
  "content": "# AI 日报 ...",
  "structured": {
    "title": "AI 日报 | 2026-02-25 08:00 SGT",
    "summary": "今日要点：...",
    "items": [
      {
        "title": "OpenAI 发布 GPT-5",
        "url": "https://...",
        "source_name": "Hacker News",
        "source_type": "hackernews",
        "summary": "...",
        "relevance_score": 0.95,
        "topics": ["AI", "LLM"]
      }
    ],
    "metadata": {
      "source_count": 12,
      "raw_item_count": 347,
      "generated_at": "2026-02-25T00:00:00+00:00"
    }
  },
  "created_at": "2026-02-25T00:00:00+00:00"
}
```

`structured` 字段在 Digest 生成时由 LLM 同步产出，与 `content` (markdown) 并存。旧 Digest 该字段为 `null`。

---

## 6. API 设计

### 6.1 基础约定

| 项 | 约定 |
|----|------|
| Base URL | `https://clawfeed.kevinhe.io/api/v1` |
| Content-Type | `application/json` |
| 认证 | `Authorization: Bearer <api_key>` |
| 幂等 | `Idempotency-Key: <client_generated_uuid>` (写操作) |
| 分页 | `?limit=20&offset=0`，响应含 `pagination` 对象 |
| 排序 | `?sort=-created_at`（`-` 前缀表降序） |

### 6.2 端点列表

#### Sources

| 方法 | 路径 | 说明 | 幂等 |
|------|------|------|------|
| GET | `/sources` | 列出 Sources | N/A (读操作) |
| GET | `/sources/:id` | 获取单个 Source 详情 | N/A |
| POST | `/sources` | 创建 Source | Idempotency-Key + type+config 逻辑幂等 |
| PUT | `/sources/:id` | 更新 Source | Idempotency-Key |
| DELETE | `/sources/:id` | 删除 Source（软删除） | 天然幂等 |
| POST | `/sources/resolve` | 从 URL 推断 Source 类型和配置 | N/A (无副作用) |

**POST /sources 请求体**:

```json
{
  "name": "Hacker News",
  "type": "hackernews",
  "config": {
    "filter": "top",
    "min_score": 100
  },
  "is_public": false
}
```

**POST /sources 响应** (201 Created):

```json
{
  "data": {
    "id": 15,
    "name": "Hacker News",
    "type": "hackernews",
    "config": { "filter": "top", "min_score": 100 },
    "is_active": true,
    "is_public": false,
    "created_by": 1,
    "created_at": "2026-02-25T08:00:00+00:00"
  },
  "meta": {
    "created": true,
    "auto_subscribed": true
  }
}
```

**POST /sources 响应** (200 OK，幂等命中):

```json
{
  "data": { "id": 15, "..." : "..." },
  "meta": {
    "created": false,
    "already_exists": true
  }
}
```

#### Digests

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/digests` | 列出 Digests，支持 `?type=daily&structured=true` |
| GET | `/digests/:id` | 获取单个 Digest |
| GET | `/digests/latest` | 获取最新一期 Digest（快捷方式） |
| POST | `/digests` | 创建 Digest（仅限 admin API Key） |

**GET /digests 响应**:

```json
{
  "data": [
    {
      "id": 42,
      "type": "daily",
      "content": "# AI 日报 ...",
      "structured": { "...": "..." },
      "created_at": "2026-02-25T00:00:00+00:00"
    }
  ],
  "pagination": {
    "total": 156,
    "limit": 20,
    "offset": 0,
    "has_more": true
  }
}
```

#### Subscriptions

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/subscriptions` | 列出当前用户的订阅 |
| POST | `/subscriptions` | 订阅一个 Source（幂等：重复订阅不报错） |
| DELETE | `/subscriptions/:source_id` | 退订 |
| POST | `/subscriptions/bulk` | 批量订阅 |

#### Packs

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/packs` | 列出 Source Packs |
| GET | `/packs/:slug` | 获取 Pack 详情 |
| POST | `/packs` | 创建 Pack（幂等） |
| POST | `/packs/:slug/install` | 安装 Pack（幂等） |
| DELETE | `/packs/:id` | 删除 Pack |

#### Raw Items

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/raw-items` | 列出原始采集条目 |
| GET | `/raw-items/stats` | 采集统计 |
| GET | `/raw-items/for-digest` | 获取当前用户订阅源的待处理条目 |

#### Webhooks

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/webhooks` | 列出已注册 Webhooks |
| POST | `/webhooks` | 注册 Webhook |
| PUT | `/webhooks/:id` | 更新 Webhook |
| DELETE | `/webhooks/:id` | 删除 Webhook |
| GET | `/webhooks/:id/deliveries` | 查看最近投递记录 |
| POST | `/webhooks/:id/test` | 发送测试事件 |

**POST /webhooks 请求体**:

```json
{
  "url": "https://my-agent.example.com/callback",
  "events": ["digest.created", "source.fetched"],
  "description": "My agent's callback"
}
```

**POST /webhooks 响应** (201):

```json
{
  "data": {
    "id": 1,
    "url": "https://my-agent.example.com/callback",
    "events": ["digest.created", "source.fetched"],
    "secret": "whsec_abc123...",
    "is_active": true,
    "created_at": "2026-02-25T08:00:00+00:00"
  },
  "meta": {
    "note": "请保存 secret，后续不可再次查看完整值"
  }
}
```

#### 文档

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/openapi.json` | OpenAPI 3.1 spec |
| GET | `/docs` | 交互式 API 文档（Scalar UI） |

---

## 7. MCP Server 设计

### 7.1 概述

MCP (Model Context Protocol) 是 Anthropic 提出的 Agent-to-Tool 标准协议。ClawFeed MCP Server 让 Claude、GPT 等 Agent 通过标准接口操作 ClawFeed。

**传输方式**: 优先 Streamable HTTP（远程部署），同时支持 stdio（本地开发）。

**架构**:

```
┌─────────────────┐     MCP Protocol      ┌──────────────────┐
│  Claude Agent   │ ◄──────────────────► │  ClawFeed MCP    │
│  GPT Agent      │    stdio / SSE        │  Server          │
│  Custom Agent   │                       │                  │
└─────────────────┘                       └────────┬─────────┘
                                                   │ HTTP
                                                   ▼
                                          ┌──────────────────┐
                                          │  ClawFeed API    │
                                          │  /api/v1/*       │
                                          └──────────────────┘
```

MCP Server 是 ClawFeed API 的 thin wrapper，不直接操作数据库。

### 7.2 Tools

Tools 是 Agent 可调用的"函数"——有参数、有返回值、有副作用。

| Tool 名称 | 描述 | 参数 |
|-----------|------|------|
| `list_sources` | 列出可用信息源 | `type?`, `limit?`, `offset?` |
| `get_source` | 获取单个信息源详情 | `source_id` |
| `create_source` | 创建新信息源 | `name`, `type`, `config`, `is_public?` |
| `resolve_url` | 从 URL 自动识别信息源类型 | `url` |
| `delete_source` | 删除信息源 | `source_id` |
| `subscribe` | 订阅信息源 | `source_id` |
| `unsubscribe` | 退订信息源 | `source_id` |
| `bulk_subscribe` | 批量订阅 | `source_ids: number[]` |
| `list_digests` | 列出 Digest 列表 | `type?`, `limit?`, `structured?` |
| `get_digest` | 获取单个 Digest 内容 | `digest_id` |
| `get_latest_digest` | 获取最新 Digest | `type?` |
| `list_packs` | 列出 Source Pack | 无 |
| `install_pack` | 安装 Source Pack | `slug` |
| `list_raw_items` | 列出原始采集条目 | `source_id?`, `since?`, `limit?` |
| `register_webhook` | 注册 Webhook | `url`, `events[]` |
| `delete_webhook` | 删除 Webhook | `webhook_id` |

**Tool 定义示例** (MCP JSON-RPC):

```json
{
  "name": "create_source",
  "description": "在 ClawFeed 中创建一个新的信息源。支持 RSS、Hacker News、Reddit、GitHub Trending、Twitter 等类型。创建后自动订阅。相同 type+config 的源不会重复创建。",
  "inputSchema": {
    "type": "object",
    "properties": {
      "name": {
        "type": "string",
        "description": "信息源显示名称，如 'Hacker News' 或 'TechCrunch RSS'"
      },
      "type": {
        "type": "string",
        "enum": ["rss", "hackernews", "reddit", "github_trending", "twitter_feed", "twitter_list", "website", "digest_feed"],
        "description": "信息源类型"
      },
      "config": {
        "type": "object",
        "description": "类型相关配置。RSS: {url}; Reddit: {subreddit, sort?, limit?}; HN: {filter?, min_score?}; GitHub: {language?, since?}; Twitter: {handle} 或 {list_url}"
      },
      "is_public": {
        "type": "boolean",
        "default": false,
        "description": "是否设为公开源（其他用户可见）"
      }
    },
    "required": ["name", "type", "config"]
  }
}
```

### 7.3 Resources

Resources 是 Agent 可读取的数据——类似 GET 端点，只读，无副作用。

| URI 模板 | 描述 | MIME |
|----------|------|------|
| `clawfeed://sources` | 当前所有信息源列表 | application/json |
| `clawfeed://sources/{id}` | 单个信息源详情 | application/json |
| `clawfeed://digests/latest?type={type}` | 最新 Digest | application/json |
| `clawfeed://digests/{id}` | 单个 Digest 内容 | application/json |
| `clawfeed://subscriptions` | 当前订阅列表 | application/json |
| `clawfeed://raw-items/stats` | 采集统计概览 | application/json |

### 7.4 Prompts

Prompts 是预置的提示词模板，Agent 可调用来获取格式化的上下文。

| Prompt 名称 | 描述 | 参数 |
|-------------|------|------|
| `summarize_digest` | 将 Digest 内容浓缩为 3-5 句话 | `digest_id`, `language?` |
| `recommend_sources` | 根据用户当前订阅推荐新 Source | `interest_keywords?` |
| `explain_item` | 深度解读某条 raw item 的背景 | `item_id` |

### 7.5 安装与配置

**Claude Desktop / claude_desktop_config.json**:

```json
{
  "mcpServers": {
    "clawfeed": {
      "command": "npx",
      "args": ["@clawfeed/mcp-server"],
      "env": {
        "CLAWFEED_API_URL": "https://clawfeed.kevinhe.io/api/v1",
        "CLAWFEED_API_KEY": "your-api-key"
      }
    }
  }
}
```

**远程 SSE 模式**（免安装）:

```json
{
  "mcpServers": {
    "clawfeed": {
      "url": "https://clawfeed.kevinhe.io/mcp",
      "headers": {
        "Authorization": "Bearer your-api-key"
      }
    }
  }
}
```

---

## 8. Webhook 设计

### 8.1 事件类型

| 事件 | 触发时机 | Payload 核心字段 |
|------|---------|-----------------|
| `source.created` | 新 Source 被创建 | `source: { id, name, type }` |
| `source.updated` | Source 配置或状态变更 | `source: { id, name, changes[] }` |
| `source.fetched` | Source 采集完成（有新内容） | `source: { id, name }, items_added: number, items_total: number` |
| `source.error` | Source 采集失败 | `source: { id, name }, error: string, consecutive_failures: number` |
| `digest.created` | 新 Digest 生成完毕 | `digest: { id, type, summary, item_count }, user_id?` |
| `webhook.test` | 手动触发的测试事件 | `message: "Webhook is working"` |

### 8.2 Payload 结构

所有 Webhook payload 遵循统一格式：

```json
{
  "id": "evt_abc123",
  "type": "digest.created",
  "created_at": "2026-02-25T08:00:00+00:00",
  "data": {
    "digest": {
      "id": 42,
      "type": "daily",
      "summary": "今日要点：OpenAI 发布 GPT-5...",
      "item_count": 18
    }
  }
}
```

### 8.3 签名验证

接收方验证示例 (Node.js):

```javascript
const crypto = require('crypto');

function verifyWebhook(payload, signature, timestamp, secret) {
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${payload}`)
    .digest('hex');
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(`sha256=${expected}`)
  );
}
```

### 8.4 安全约束

- Webhook URL 必须是 HTTPS（开发环境可豁免 localhost）
- 注册时发送 verification 请求：POST 到 URL，包含 `challenge` 字段，接收方原样返回
- 投递超时 10 秒
- Payload 最大 64KB（超出时截断 items，保留 summary）
- 每个用户最多 10 个 Webhook
- SSRF 防护复用现有 `assertSafeFetchUrl` 逻辑

---

## 9. 验收标准

### AC-1: Agent 全流程可用

用一个 Claude Agent（通过 MCP）完成以下流程，全程不看文档、不看源码：

1. 列出当前 Sources
2. 通过 URL resolve 识别一个 RSS 源
3. 创建该 Source
4. 确认自动订阅
5. 获取最新 Digest
6. 注册 Webhook 接收 `digest.created` 事件

**判定标准**: 6 个步骤均一次成功，无需人类干预。

### AC-2: 幂等验证

1. 发送 `POST /api/v1/sources` 带 `Idempotency-Key: test-1`，创建成功
2. 再次发送相同请求（相同 key + 相同 body），返回 200 + 相同 data + `Idempotent-Replayed: true` header
3. 发送相同 key + 不同 body，返回 409
4. 不带 Idempotency-Key 的 `POST /sources` 也正常工作（逻辑幂等：type+config 去重）

### AC-3: Webhook 投递

1. 注册 Webhook 订阅 `digest.created`
2. 触发 Digest 生成
3. 15 秒内收到 Webhook 回调，payload 结构正确，签名验证通过
4. 模拟 Webhook 接收端宕机，验证重试发生（检查 deliveries 记录）

### AC-4: OpenAPI spec 完整性

1. 访问 `/api/v1/openapi.json`，返回合法 OpenAPI 3.1 文档
2. 所有 v1 端点均有定义
3. 所有请求/响应 schema 均存在
4. 用 `openapi-generator` 生成 TypeScript client，编译通过

### AC-5: MCP Server 基础功能

1. `npx @clawfeed/mcp-server` 启动无报错
2. Claude Desktop 或 MCP Inspector 成功连接
3. `tools/list` 返回全部 tool 定义
4. 调用 `list_sources` tool 返回正确结果
5. 调用 `create_source` tool 创建 Source 成功

### AC-6: 向后兼容

1. 现有 SPA（`/api/sources`、`/api/digests` 等）全部正常工作
2. 现有 RSS/JSON Feed 输出不变
3. 现有 API Key 认证方式不变

---

## 10. 依赖关系

### 前置依赖

| 依赖 | 状态 | 说明 |
|------|------|------|
| raw_items 采集管道 (1.1) | 已完成 | Webhook `source.fetched` 事件依赖采集管道 |
| 个性化 Digest (1.2) | 进行中 | 结构化 Digest 输出依赖 Digest 生成逻辑 |
| Cron 采集 (1.3) | 进行中 | Webhook 事件触发点在采集 cron 中 |

### 新增依赖（NPM 包）

| 包 | 用途 | 大小 |
|----|------|------|
| `@modelcontextprotocol/sdk` | MCP Server 官方 SDK | ~50KB |
| `zod` | Schema 定义 & 运行时校验（MCP SDK 依赖） | ~60KB |
| `yaml` | OpenAPI spec YAML 解析 | ~30KB |

**保持不变**: 不引入 Express/Fastify（本阶段继续使用原生 HTTP，在 v1 路由中加 middleware 层即可）。

### 后续被依赖

| 功能 | 依赖本 PRD |
|------|-----------|
| Telegram Bot (2.1) | 通过 Webhook `digest.created` 触发推送 |
| AI Chat Widget (2.2) | 通过结构化 Digest 获取 items 数据 |
| Source Market (3.2) | 复用 v1 API Schema |
| 付费层级 (4.1) | 基于 v1 API 加 rate limit 和 scope |

---

## 11. 风险与开放问题

### 风险

| 风险 | 影响 | 缓解 |
|------|------|------|
| MCP 协议尚在快速迭代 | SDK 升级可能有 breaking change | 封装 adapter 层，SDK 升级只改 adapter |
| OpenAPI spec 与代码不同步 | 文档误导开发者 | CI 检查 + 请求/响应自动校验 middleware |
| Webhook 投递导致外部请求激增 | 被滥用为 DDoS 工具 | SSRF 防护 + per-user webhook 数量限制 + payload 大小限制 |
| 幂等 key 存储占用 | SQLite 表膨胀 | 24h TTL + 定时清理 cron |
| 单一 API Key 权限过大 | Key 泄露 = 全权限暴露 | 本阶段接受此风险，Phase 4 引入 scoped API Key |

### 开放问题

| # | 问题 | 影响范围 | 建议 |
|---|------|---------|------|
| Q1 | MCP Server 部署方式——独立进程还是和 API server 同进程？ | 架构 | 建议独立进程（`mcp-server.mjs`），通过 HTTP 调用 API server。避免 MCP stdio 阻塞主 server 事件循环 |
| Q2 | 结构化 Digest 的 `items[]` 生成时机——Digest 创建时实时解析，还是单独写一个 migration 补全历史数据？ | Digest 输出 | 建议新 Digest 实时生成 structured 字段，旧数据不补全（`structured: null`） |
| Q3 | OpenAPI spec 维护方式——手写 YAML 还是从 Zod schema 自动导出？ | 工程效率 | 建议 Zod schema 作为 single source of truth，自动导出 OpenAPI。避免手写 YAML 与代码脱节 |
| Q4 | Webhook 是否支持 SSE 作为替代？有些 Agent 更适合长连接 | Webhook 设计 | 建议 v1 只做 POST 回调。SSE/WebSocket 在 Phase 3 后期或 Phase 4 再考虑 |
| Q5 | API Key 是否在本阶段就支持 per-user 生成？ | 认证 | 建议本阶段先保持全局 API Key，Phase 4 再做。降低本阶段复杂度 |

---

*Generated by Jessie -- 2026-02-25*
