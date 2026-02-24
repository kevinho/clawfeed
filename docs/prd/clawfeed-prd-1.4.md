# PRD 1.4: Sources 页面重构

> ClawFeed v1.0 · Phase 1 · 优先级 P0
> 作者: Lucy · 日期: 2026-02-25

---

## 背景

ClawFeed 的核心理念是"AI 编辑部"——Source 越多，筛选池越大，输出质量越高，但 Digest 篇幅不变（15-20 条/期）。用户不看原始内容，只看 AI 精选。

当前 Sources 页面（v0.8.1）存在以下问题：

1. **概念混淆**：页面混合了三个不同概念——"我的 Sources"（我创建的）、"公共 Sources"（所有公开的，与前者重叠）、"Source Packs"。用户进入页面后不知道该做什么。
2. **创建 ≠ 订阅 未清晰传达**：创建 Source 和订阅 Source 是两个独立操作，但当前 UI 没有明确区分。
3. **无探索入口**：用户只能看到已有的 Sources，缺少发现新 Source 的途径。
4. **空状态体验差**：新注册用户看到空白页面，不知从何开始。

PR #15（raw_items 采集管道）已 merge，Source 级采集与 Digest 生成解耦完成。

### 现有实现参考
- 前端：web/index.html 单文件 SPA（~1300 行），Sources 渲染在 renderSources() 函数中
- 后端 API：/api/sources、/api/subscriptions、/api/packs 已完整
- 数据库：sources、user_subscriptions、source_packs 表已就绪
- 已有功能：Smart Add（URL 自动检测）、订阅/退订、Pack 安装、软删除

---

## 目标

1. **信息架构清晰化**：让用户一眼看懂"我订阅了什么"、"我能发现什么"、"我创建了什么"
2. **订阅操作零摩擦**：订阅/退订一键完成，无需理解背后的数据模型
3. **建立探索基础**：为 Phase 3 Source Market 铺路，当前阶段提供基础的 Source 发现能力
4. **空状态引导**：新用户 3 步内完成首次订阅，进入个性化 Digest 体验

---

## 用户故事

### US-1: 新用户首次订阅
> 作为新注册用户，我希望看到推荐的 Source 包并一键安装，这样我能快速获得个性化 Digest。

验收场景：注册后进入 Sources 页面看到欢迎引导 + 推荐 Pack 列表；点击 Pack 查看包含的 Sources 预览；一键安装后"已订阅"分区立即显示这些 Sources；自动提示去查看 Digest。

### US-2: 管理已订阅 Sources
> 作为已有订阅的用户，我希望在页面顶部看到所有已订阅的 Sources 及其状态，能快速退订不想要的。

验收场景："已订阅"分区显示所有活跃订阅；每张卡片显示名称、类型图标、简要描述；一键退订（无需确认弹窗，支持撤销）；已删除的 Source 灰色显示。

### US-3: 发现并订阅新 Sources
> 作为现有用户，我希望能浏览其他人创建的公开 Sources 并订阅感兴趣的。

验收场景："探索"分区展示所有公开 Sources（排除已订阅的）；支持按类型筛选；每张卡片显示订阅人数；一键订阅后 Source 移入"已订阅"分区。

### US-4: 管理自己创建的 Sources
> 作为 Source 创建者，我希望在独立分区管理自己创建的 Sources。

验收场景："我创建的"分区默认折叠；可编辑名称/配置/公开状态；可软删除（有订阅者时提醒）；区分已订阅和未订阅自己的 Source。

### US-5: 添加新 Source
> 作为用户，我希望通过粘贴 URL 快速添加 Source，系统自动识别类型。

验收场景："添加 Source"入口始终可见；粘贴 URL 后自动检测并预览；确认后创建+自动订阅；URL 已存在时提示并提供直接订阅选项。

---

## 功能需求

### F-1: 页面信息架构重构

页面分区（从上到下）：已订阅 → 探索 Sources → 推荐 Packs → 我创建的（折叠）

空状态（新用户）：欢迎引导 + 推荐 Pack 选择 + 添加自定义 Source 入口

### F-2: Source 卡片升级

每张卡片包含：名称、类型图标、类型标签、订阅人数（新增: COUNT from user_subscriptions）、操作按钮（根据上下文显示订阅/退订/编辑/删除）。

不在此版本：Source 健康指标（采集成功率、最后更新时间）——留给后续迭代。

### F-3: 探索分区

- 展示所有 is_public=1 且 is_deleted=0 的 Sources，排除已订阅的
- 类型筛选 Tab：全部 | Twitter | RSS | Hacker News | Reddit | GitHub | 其他
- 按订阅人数降序排列
- 一键订阅，订阅后从探索列表移至已订阅列表（无需刷新）

### F-4: 订阅/退订操作优化

- 订阅：点击后立即生效，卡片移动到已订阅分区，显示 toast
- 退订：点击后立即移除，显示 toast + 5秒内可撤销（Undo）
- 无确认弹窗（低成本操作）
- 乐观更新：UI 立即响应，API 后台完成，失败时回滚

### F-5: 添加 Source 入口优化

- 页面顶部右侧常驻 [+] 添加按钮
- 增加重复检测：同类型+同 config 已存在时，提示并提供直接订阅选项
- Manual Add 保留为 Smart Add 面板内的手动添加链接

### F-6: 匿名用户体验

- 匿名用户看到所有公开 Sources 列表（只读）
- 操作按钮替换为"登录以订阅" CTA
- 作为转化入口展示 Source 丰富度

---

## 技术方案

### 后端变更

**API-1: GET /api/sources 增强**
- 新增查询参数：?type=twitter_feed（按类型筛选）、?explore=true（探索模式：公开 Sources 排除已订阅）
- 响应增加 subscriber_count 和 is_subscribed 字段
- 实现：LEFT JOIN user_subscriptions 做 COUNT + EXISTS 子查询

**API-2: POST /api/sources 重复检测**
- 创建前检查同 type+config 是否已存在（getSourceByTypeConfig() 已有）
- 已存在返回 409 Conflict，body 含已存在 Source 信息
- 前端展示"此 Source 已存在，是否直接订阅？"

**API-3: DELETE /api/subscriptions/source/:sourceId**
- 新增按 source_id 退订接口（当前用 subscription ID，不够直觉）
- 保留原接口向后兼容

### 前端变更

**FE-1: renderSources() 重构**
拆分为：renderSubscribedSection() / renderExploreSection() / renderPacksSection() / renderCreatedByMeSection() / renderEmptyState()

**FE-2: 类型筛选 Tab**
新增 exploreFilter 状态变量，前端过滤（一次 API 请求获取所有公开 Sources）

**FE-3: 乐观更新 + Toast**
订阅/退订立即更新本地状态+重新渲染；toast 3秒消失；退订 toast 含撤销链接（5秒）；API 失败回滚+错误提示

**FE-4: Source 卡片组件**
增强 renderSourceCard()，根据分区显示不同内容

### 数据库变更
无 schema 变更。subscriber_count 通过查询时计算。

---

## 验收标准

### 页面结构
- AC-1: 已登录用户看到四个分区：已订阅 → 探索 → 推荐 Packs → 我创建的
- AC-2: "我创建的" 默认折叠，点击可展开
- AC-3: 每个分区标题显示数量（如 "已订阅 (12)"）
- AC-4: 页面顶部有常驻 [+] 添加按钮

### 订阅操作
- AC-5: 点击订阅后 Source 立即出现在已订阅分区（无需刷新）
- AC-6: 点击退订后 Source 立即从已订阅分区移除
- AC-7: 退订后显示 toast，5秒内可撤销
- AC-8: API 请求失败时 UI 回滚并显示错误提示

### 探索功能
- AC-9: 探索分区显示所有公开 Sources，排除已订阅的
- AC-10: 类型筛选 Tab 正常工作（全部/Twitter/RSS/HN 等）
- AC-11: Sources 按订阅人数降序排列
- AC-12: 每张卡片显示订阅人数

### 空状态
- AC-13: 新用户（无订阅）看到推荐 Pack 引导页
- AC-14: 安装 Pack 后自动切换到正常页面布局
- AC-15: 引导页有"添加自定义 Source"的次要入口

### 添加 Source
- AC-16: Smart Add 检测到已存在的 Source 时，提示"已存在"并提供订阅选项
- AC-17: 创建 Source 后自动订阅并显示在已订阅分区

### 匿名用户
- AC-18: 未登录用户看到公开 Sources 列表（只读）
- AC-19: 操作按钮替换为"登录以订阅"提示

### 兼容性
- AC-20: 移动端响应式布局正常（卡片单列）
- AC-21: Dark/Light 主题切换正常
- AC-22: 中英文 i18n 切换正常

---

## 依赖关系

### 前置依赖
- PR #15 raw_items 采集管道: ✅ 已 merge
- PR #32 Phase 1 release: ✅ 已部署 v0.8.1
- 用户认证系统: ✅ 已完成 (Google OAuth)
- Sources/Subscriptions API: ✅ 已完成 (CRUD + 订阅管理)

### 被依赖（下游）
- 1.2 个性化 Digest 生成: 依赖用户有清晰的订阅管理入口
- 3.2 Source Market: 本 PRD 的探索分区是 Market 的基础版本
- 2.1 多渠道推送: 推送内容基于用户订阅的 Sources

### 外部依赖
无。不引入新的第三方库或外部服务。

---

*PRD by Lucy · ClawFeed Phase 1*
