# PRD: 3.3 多语言 Digest

作者: Lucy · 日期: 2026-02-25

---

## 背景

ClawFeed 当前 Digest 生成只输出单语言。前端已有 i18n（中/英），但 Digest 正文始终单语言。393 用户中已有中/英/日语用户，单语言成为增长瓶颈。

核心区分：多语言 Digest 不是简单翻译。AI 需要根据目标文化语境对信息进行重组——标题重写、背景补充、术语本地化。如同一条 YC 新闻，中文版需解释 YC，英文版直接用行话，日文版补充日本市场关联。

## 目标

1. 同源多语：同一 Source Pool 生成不同语言 Digest
2. 用户级偏好：每用户独立设置 Digest 语言
3. 成本可控：N 种语言不产生 N 倍线性增长
4. 质量优先：信息重组而非机械翻译

## 用户故事

US-1: 设置 Digest 语言 — Settings 中选择中文/English/日本語，服务端持久化，下次生成自动使用。老用户默认 en。
US-2: 查看本地化 Digest — 不只是翻译：专有名词保留原文+标注，信息排序考虑受众兴趣，文化语境补充。
US-3: 切换语言查看 — 双语用户切换语言看同一期不同版本。已缓存立即展示，未生成显示"生成中"。
US-4: 管理员查看多语言覆盖 — 各语言版本生成状态、用户分布、用户数为 0 时自动停止。

## 功能需求

### FR-1: 用户语言偏好存储
- users 表新增 digest_language TEXT 默认 'en'
- 支持 zh/en/ja
- API: PATCH /api/user/preferences { digestLanguage: "zh" }
- 老用户迁移默认 en

### FR-2: 多语言 Prompt 工程
单模板+语言指令注入方案。新增 templates/languages.json 配置：
- zh: 简洁专业，中国科技媒体行文，货币换算人民币
- en: Professional concise，assume tech-savvy audience
- ja: 丁寧語，カタカナ英語注釈，円換算

Localization Rules: 专有名词保留原文+目标语言标注，信息优先级按目标受众文化语境重组。

### FR-3: Digest 生成流程改造 — 两阶段生成（成本优化核心）

阶段 1（语言无关策展，只执行一次）: raw_items 100-500 条 → 精选 15-20 条结构化 JSON（item_id/category/摘要/评分）
阶段 2（语言特定渲染，每语言一次）: 阶段 1 JSON + 语言指令 → 目标语言完整 Digest

成本分析：3 语言 = 1.0x(阶段1) + 3×0.2x(阶段2) = 1.6x，对比朴素方案 3.0x 节省 47%。

按需生成：只为有活跃用户的语言生成。阶段 2 可 Promise.all 并行。

### FR-4: 数据模型变更 (Migration 010)

digests 表：+language TEXT DEFAULT 'en', +digest_group_id TEXT（同期不同语言版本共享）
users 表：+digest_language TEXT DEFAULT 'en'
索引：idx_digests_language, idx_digests_group, idx_users_digest_lang

缓存键预埋（为 3.4）: subscription_hash + "_" + language

### FR-5: API 变更

GET /api/digests — 新增 ?language=zh 过滤，默认返回用户偏好语言
PATCH /api/user/preferences — 设置 digestLanguage
GET /api/user/preferences — 返回当前偏好
GET /feed/:slug — 输出用户偏好语言 Digest
GET /feed/:slug?language=ja — 允许覆盖语言

### FR-6: 前端变更

1. Settings 页：Digest 语言选择器（下拉：中文/English/日本語）→ PATCH API → 同步 localStorage
2. Digest 列表页：默认显示偏好语言版本 + 语言版本指示器 + 点击切换
3. 未登录用户：沿用 localStorage 逻辑

---

## 技术方案

架构：Cron 触发 → 阶段 1 内容策展(language-agnostic, 只执行一次) → 阶段 2 多语言渲染(每语言并行 Promise.all)

Prompt 模板改造：
- templates/digest-curation-prompt.md（阶段 1：策展，输出 JSON，固定英文，token 成本高但只一次）
- templates/digest-render-prompt.md（阶段 2：渲染，输入精选 JSON + languages.json 配置，token 成本低，每语言一次）
- templates/languages.json（zh/en/ja 配置：name, nativeName, promptSuffix, dateFormat, greeting）

语言检测：新注册用户取 Accept-Language header 首选语言匹配，无法匹配默认 en。

并发：阶段 2 多语言 Promise.all 并行。LLM 速率限制时回退串行+sleep。

向后兼容：现有无 language 字段的 Digest 视为 en。API 不传 language 返回用户偏好。Feed 默认用户语言。

db.mjs 变更：新增 getUserPreferences(), updateUserPreferences(), getActiveDigestLanguages()；修改 listDigests() 支持 language 过滤；修改 createDigest() 支持 language + digestGroupId。

---

## 验收标准（19 条）

1. users 表含 digest_language 字段，默认 'en'
2. digests 表含 language 和 digest_group_id 字段
3. Settings 页可选 zh/en/ja，持久化到服务端
4. 新用户注册根据 Accept-Language 自动设默认语言
5. 定时任务只为有活跃用户的语言生成 Digest
6. 两阶段策略：阶段 1 只执行一次，阶段 2 按语言并行
7. 中文 Digest 符合中国科技媒体行文，专有名词标注原文
8. 日文 Digest 使用丁寧語，术语标注片假名英文
9. 英文 Digest 保持当前质量不下降
10. 同期不同语言版本共享 digest_group_id
11. GET /api/digests?language=zh 正确返回中文版
12. 不传 language 时返回用户偏好语言版本
13. Feed 输出用户偏好语言，支持 ?language= 覆盖
14. 3 种语言总 LLM 成本不超过单语言 2 倍（目标 1.6x）
15. 老 Digest 无 language 字段时视为 en，不受影响
16. Migration 编号 010
17. templates/languages.json 含 zh/en/ja 配置
18. 阶段 1 策展结果为结构化 JSON，可被任意语言阶段 2 消费
19. 某语言活跃用户数为 0 时自动停止生成

## 依赖

前置：raw_items 表(已完成)、user_subscriptions(已完成)、digests.user_id(已存在)、前端 i18n(已有)、LLM API(运行时)
预埋：3.4 订阅组合缓存 — subscription_hash + language 缓存键已设计，3.4 实现时直接用。阶段 1 按 hash 缓存 + 阶段 2 按 hash+language 缓存 → N用户×M语言成本从 O(N×M) 降至 O(unique_hashes×M)。

---

*PRD by Lucy · ClawFeed Phase 3*
