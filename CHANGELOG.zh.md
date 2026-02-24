# 更新日志

## v0.8.1 — 2026-02-24
### ✨ 新增
- **Telegram 群组链接** — Info banner 增加可点击 TG 图标 + 群邀请链接，支持中英文 (#16)
- **DEVOPLOG.md** — 研发全生命周期追踪（开发/staging/production）(#20)

### 🔧 修复
- **TG 图标渲染** — emoji 替换为 SVG 图标，群链接可点击 (#17)
- **副标题 Twitter 链接** — @提及 现在链接到 Twitter 个人页 (#18)
- **ClawHub 元数据对齐** — SKILL.md 凭证声明、TESTING.md HttpOnly 说明、README/SKILL.md 一致性 (#25)

### 🏗️ 基础设施
- **CI 流水线** — GitHub Actions lint + 安全审计 (#2, #9)
- **PR 模板 & 贡献指南** — 标准化贡献流程 (#3)
- **健康检查** — `GET /api/health` 端点 (#4)
- **反馈 Webhook 配置** — .env.example 增加 `FEEDBACK_LARK_WEBHOOK` (#5)
- **开发流程文档** — 完整 PROCESS.md 工作流 (#7)
- **安全加固** — SSRF 防护、OAuth state 校验、API key 处理 (#1)

## v0.7.0 — 2026-02-22
### ✨ 新增
- **深色/浅色模式切换** — Header 日/月图标，localStorage 持久化
- **README 视频演示** — demo.mp4 作为 GitHub Release 资源嵌入

### 🔧 修复
- README 视频在 GitHub 上自动播放（Release 资源 URL 替代相对路径）

## v0.6.0 — 2026-02-22
### ✨ 新增
- **Source 软删除** — 删除 Source 标记 `is_deleted` 而非硬删，避免 Pack 僵尸复活
- **产品路线图** — ⋯ 菜单新增 Roadmap 页面
- **测试文档** — 完整测试用例索引 + 迭代记录

### 🔧 修复
- Pack 安装时跳过已删除 Source（不再创建僵尸副本）
- 订阅列表显示已停用 Source（灰色 + ⚠️ 标签）

## v0.5.0 — 2026-02-21
### ✨ 新增
- **Digest Feed** — 每个用户有自己的订阅源（`/feed/:slug.json`、`/feed/:slug.rss`）
- **智能 Source 识别** — 粘贴 URL 自动检测类型（RSS、Twitter、HN、Reddit 等）
- **Source 管理** — 添加/编辑/删除数据源的 UI
- **Source Packs** — 可分享的源包，一键安装
- **Auth 配置 API** — 未配置 OAuth 时自动隐藏登录 UI
- **API Key 认证** — `POST /api/digests` 改用 Bearer token

### 🔧 修复
- Tab 切换状态重置
- 时区分组 bug（UTC vs 本地时间）
- 标题点击返回首页

### 🗑️ 移除
- Admin 角色系统（每个用户管理自己的数据）

## v0.4.0 — 2026-02-21
### ✨ 新增
- **国际化** — 中英文切换，localStorage 持久化
- **Google OAuth** — 登录、Session Cookie、用户级 Mark
- **私有板块** — 🧹建议取关和🔖Bookmarks 对未登录用户隐藏
- **开源** — MIT 协议发布到 GitHub

### 🔧 修复
- Header 布局 flex 化（不再 position:absolute 重叠）
- Auth 时序竞态（checkAuth 先于 renderList）
- 移动端标题响应式

## v0.3.0 — 2026-02-21
### ✨ 新增
- **SQLite 存储** — 从 Markdown 文件迁移到 better-sqlite3
- **Mark 收藏** — 文章收藏、去重、用户隔离
- **分页** — 每页 10 条 + "加载更多"
- **摘要预览** — 卡片显示 1-2 行摘要
- **时间分组** — 4H→天，日报→周，周报→月，月报→年

## v0.2.0 — 2026-02-21
### ✨ 新增
- **独立服务** — Node HTTP server，端口 8767
- **REST API** — Digest 和 Mark 的增删查
- **Dashboard** — 暗色主题，4H/日报/周报/月报/收藏 Tab
- **域名** — digest.kevinhe.io + Cloudflare Access

## v0.1.0 — 2026-02-21
### ✨ 新增
- **初始版本** — ClawFeed Web Dashboard
- **4 小时定时** — 每 4 小时从 Twitter For You 生成摘要
- **递归摘要** — 日报/周报/月报层级汇总
