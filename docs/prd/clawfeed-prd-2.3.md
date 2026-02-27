# ClawFeed 2.3 — Mark（收藏）增强

**作者: Lucy · 日期: 2026-02-25**

---

## 背景

ClawFeed 目前已有基础的收藏（Mark）功能：用户可以对 Digest 中的条目进行收藏，系统会生成简要的 AI 分析。但现有功能存在以下不足：

1. **AI 分析深度不够**——当前分析仅为摘要级别，缺少深度解读、关联分析和行动建议。
2. **数据无法导出**——收藏内容锁死在系统内，用户无法将其带入自己的知识管理工作流。
3. **无法分享**——用户发现有价值的内容后，没有便捷途径分享给他人。
4. **收藏信号未被利用**——收藏行为是用户最强的兴趣信号，但目前未反哺到推荐算法中。

现有 393 位用户，marks 表已在 001_init.sql 中建立。

---

## 目标

G1: 提升收藏内容的知识价值 — AI 深度分析生成率 > 95%
G2: 打通知识管理工作流 — 至少支持 Markdown 导出
G3: 实现社交传播 — 收藏集合可通过公开链接分享
G4: 利用收藏信号优化推荐 — 收藏偏好纳入 Digest 排序

---

## 用户故事

### US-1：AI 深度分析
> 作为信息消费者，收藏文章时希望系统自动生成深度分析（要点提炼、背景关联、趋势判断、行动建议）。
场景：收藏 → 显示"分析生成中" → 后台异步生成 → 轮询更新。失败自动重试最多 3 次。

### US-2：导出收藏
> 作为知识工作者，希望导出为 Markdown 文件归入 Obsidian/Notion。
场景：选择日期/标签筛选 → 导出单 .md 文件或批量 ZIP（每条收藏独立 .md + YAML frontmatter）。

### US-3：分享收藏
> 作为信息筛选者，希望通过链接分享精选收藏集合给同事。
场景：生成公开链接 → 支持公开/密码保护/关闭三种模式 → 可选分享全部或按标签/日期范围 → 页面含 Open Graph 元标签 + 品牌水印。

### US-4：偏好调优
> 作为长期用户，希望系统根据收藏偏好自动调整 Digest 排序。
场景：积累 ≥5 条收藏 → 系统提取兴趣标签 → Digest 中匹配条目排序上升（权重 30%）→ 设置页面可管理标签。

---

## 功能需求

### FR-1：AI 深度分析

**触发：** 用户收藏 → marks 表插入 → analysis_jobs 表插入任务（pending）→ 后台 5 秒轮询消费。

**模型：** Claude Sonnet，max_tokens=1500。Prompt 输出四个板块：核心要点（3-5 个）、背景关联、深度解读、行动建议。

**异步流程：** 取 pending 任务 → 调用 API → 成功写入 marks.deep_analysis → 失败 retry_count+1（≥3 次标记 abandoned）。前端 3 秒轮询，最多 60 秒。

**前端：** 收藏详情页新增 AI 分析区域 + 骨架屏动画 + 折叠/展开。

### FR-2：导出收藏

**Markdown P0：** 单文件或批量 ZIP（每条收藏独立 .md，YAML frontmatter：title/source/url/bookmarked_at/tags）。

**API：** GET /api/marks/export?format=md|zip&from=&to=&tags= → Content-Disposition: attachment

**Notion P1（Nice-to-have）：** OAuth 授权 → 同步到指定 Database。
**Obsidian P1：** ZIP 结构兼容 vault，可选 _index.md 汇总页。

### FR-3：分享收藏

**机制：** UUID v4 share_token → /share/{token} 服务端渲染只读 HTML → Open Graph 元标签。

**隐私：** 公开 / 密码保护（4-8 位）/ 关闭（404）。默认不过期，可选 7天/30天/永久。

**范围：** 全部收藏 / 按标签 / 按日期。动态快照（新增收藏自动出现）。

**API：** POST/GET/PATCH/DELETE /api/shares + GET /share/:token + POST /share/:token/verify

### FR-4：偏好调优

**信号提取：** 近 30 天收藏（≥5 条）→ Claude Sonnet 提取 5-15 个兴趣标签（tag/weight/reason JSON）→ 存 user_preferences 表。增量更新，1 小时防抖。

**排序调整：** Digest 生成时，候选条目 vs 用户偏好标签做相似度匹配 → 加权因子 0.3（30%），不删除条目只调排序。

**控制面板：** 设置页面"我的兴趣"区域 → 标签列表 + 禁用/添加/权重滑块/一键重置。

---

## 技术方案

### 数据库变更（Migration 010）

4 项变更：
1. marks 表新增字段：deep_analysis TEXT, analysis_status TEXT ('pending'/'completed'/'failed'/'abandoned'), tags TEXT (JSON 数组)
2. analysis_jobs 表：mark_id, status, retry_count, error_message, created_at, updated_at
3. shares 表：user_id, token(UUID UNIQUE), scope('all'/'tags'/'date_range'), filter_tags, filter_from, filter_to, privacy('public'/'password'/'disabled'), password_hash, expires_at
4. user_preferences 表：user_id, tag, weight(0.0-1.0), source('auto'/'manual'), enabled, reason, UNIQUE(user_id,tag)

### 后端模块
- src/analysis.mjs — AI 分析生成、任务队列消费、重试逻辑
- src/export.mjs — Markdown 渲染、ZIP 打包
- src/share.mjs — 分享 CRUD、密码验证、公开页面渲染
- src/preference.mjs — 兴趣提取、偏好 CRUD、排序加权
- src/db.mjs 扩展新增表 CRUD

### API 路由新增
POST/GET /api/marks（扩展）、GET /api/marks/export、POST/GET/PATCH/DELETE /api/shares、GET/PUT/DELETE /api/preferences、POST /api/preferences/reset、GET /share/:token、POST /share/:token/verify

### 后台任务
分析消费者 setInterval 5秒；偏好更新 1小时防抖。

---

## 验收标准（22 条）

AI 深度分析：AC-1~5（30秒内完成、四板块结构、骨架屏、3次重试、折叠展开）
导出收藏：AC-6~10（单文件MD、ZIP、YAML frontmatter、日期/标签筛选、Obsidian 兼容）
分享收藏：AC-11~16（公开链接、只读页面、密码保护、关闭404、OG标签、品牌水印）
偏好调优：AC-17~22（≥5条触发、标签管理UI、影响排序、不删条目、一键重置、1小时防抖）

---

## 依赖

内部：marks 表(已有)、Anthropic API(已集成)、db.mjs/server.mjs(扩展)
外部：archiver npm(ZIP)、crypto.scrypt(密码哈希，内置)、Notion API(P1 Nice-to-have)

风险：API 成本（用 Sonnet+1500 token 控制）、队列积压（前端容忍异步）、分享滥用（rate limit+过期）、偏好过拟合（30% 权重上限）

---

*PRD by Lucy · ClawFeed Phase 2*
