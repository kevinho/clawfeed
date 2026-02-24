# ClawFeed PRD 2.1 — 多渠道推送

作者: Lucy · 日期: 2026-02-25

## 背景

用户必须主动打开网页看 Digest，没有推送。Phase 2 交付标准：用户通过 Telegram 收到个性化 Digest，能即时追问。

## 目标

G1: Telegram Bot 推送 — ≥10 用户绑定
G2: Email 推送 — ≥5 用户配置邮件
G3: 用户自主配置渠道偏好
G4: 新增渠道 < 200 行改动
G5: 推送失败率 < 1%

## 用户故事（6 个）

US-1 Telegram 绑定: 网页端点击"连接 Telegram" → t.me/ClawFeedBot?start=<token> → Bot 回复"绑定成功" → 网页显示已连接
US-2 定时推送: Digest 生成 5 分钟内推送，含标题+前 3-5 条+查看完整链接
US-3 按需查询: /digest 获取最新，/digest daily 获取 daily，/settings 查看配置
US-4 Email 推送: 启用 Email → 选频率(per-digest/daily/weekly) → HTML 邮件+退订链接
US-5 推送频率配置: 三种频率，不同渠道可设不同频率
US-6 飞书推送(P1): 群机器人 Webhook 或 Bot DM

## 功能需求

### 渠道优先级
Telegram Bot (P0，双向) → Email (P1，单向HTML) → 飞书 (P1，Webhook) → Slack (P2) → Discord (P2)

### Telegram Bot 设计
7 个命令: /start, /start <token>(绑定), /digest, /digest daily|weekly, /settings(inline keyboard), /unlink, /help
Webhook 模式（非 Long Polling）: POST /api/telegram/webhook + secret_token 验证
MarkdownV2 消息格式，4096 字符限制截断+链接
绑定流程: 网页生成 link_token(32字符hex, 10分钟有效, 一次性) → 用户 Telegram /start <token> → 验证+关联 user_id+chat_id

### Email 设计
Nodemailer + SMTP，.env 配置 SMTP_HOST/PORT/USER/PASS/FROM
HTML 模板: templates/email-digest.html，内联 CSS，移动端自适应(600px)
退订: HMAC(user_id+"email", SESSION_SECRET) token，无需数据库验证
频率: per-digest(每次) / daily summary(每日 20:00 UTC+8) / weekly only(每周日 20:00)

### 飞书 P1: 群 Webhook（最简，单向），Bot DM 延后
### Slack/Discord P2: Incoming Webhook

### 推送引擎
事件驱动+队列: createDigest() → push_queue 表(pending) → Worker 30秒轮询 → 发送 → sent/failed
失败重试: 3 次，指数退避(2min/4min/8min)
频率聚合 Cron: daily summary 每日 20:00 UTC+8 合并当日 Digest，weekly 每周日
渠道适配器接口: PushChannel.send(config, digest, user) → { success, error }

## 技术方案

### Migration 010 (4 张表)
1. push_channels: user_id, channel, is_enabled, config(JSON), frequency, UNIQUE(user_id,channel)
2. push_queue: user_id, digest_id, channel, status(pending/sent/failed), retry_count, scheduled_at, error
3. push_log: user_id, digest_id, channel, status, error (审计+统计)
4. push_link_tokens: user_id, token(UNIQUE), channel, expires_at (绑定令牌，临时)

config JSON per channel:
- telegram: {chat_id, username}
- email: {address}
- lark/slack/discord: {webhook_url}

### API 8 个新接口
GET/POST /api/push/channels — 列表/添加更新渠道
DELETE/PATCH /api/push/channels/:channel — 删除/更新渠道
POST /api/push/link-token — 生成绑定令牌
GET /api/push/unsubscribe — 邮件一键退订(token验证)
POST /api/telegram/webhook — Telegram 回调(secret验证)
GET /api/push/stats — 推送统计(管理员)

### 文件结构
src/push/engine.mjs (队列+worker), formatter.mjs (格式化)
src/push/channels/{telegram,email,lark,slack,discord}.mjs
src/telegram-bot.mjs (webhook handler+命令路由)
templates/email-digest.html

### db.mjs 新增 ~15 个导出函数
Push Channels: list/get/upsert/delete/update/listByFrequency
Push Queue: enqueue/getPending/updateStatus/incrementRetry
Link Tokens: create/consume/cleanExpired
Push Log: log/getStats

### Telegram Bot 注册
.env: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET
服务启动时自动 setWebhook + setMyCommands

### Worker
setInterval 30秒，每次取 50 pending jobs，串行处理
仅新增 nodemailer 1 个 npm 依赖，其余用原生 https

## 验收标准（29 条）

Telegram Bot (P0): AC-1~10
- Bot 创建+Webhook 自动注册、绑定流程、5 分钟内推送、/digest /settings /unlink 命令、未绑定引导、4096 截断、secret 验证

Email (P1): AC-11~17
- 启用用 OAuth 邮箱、per-digest 10 分钟内、daily 20:00、weekly 周日 20:00、HTML 移动端可读、退订链接可用、SMTP 缺失时自动禁用

推送引擎: AC-18~21
- Worker 30 秒轮询、失败 3 次重试(指数退避)、push_log 完整、频率正确

用户设置: AC-22~25
- 设置页显示所有渠道、不同渠道不同频率、开关即时生效、断开连接删除记录

数据完整性: AC-26~29
- Migration 幂等、CASCADE 清理、token 过期失效、UNIQUE 约束

## 依赖

上游: Digest 生成管线(已有，需加 hook)、Google OAuth(已有)、HTTPS(已有)、BotFather 注册(需操作)、SMTP 配置(需配置)
下游: 新增 Cron(daily/weekly 聚合、token 清理)、.env 新增 4 配置项、push_queue 定期清理(7天sent/failed)

### 实施顺序
2.1a 基础设施(1周): Migration + db.mjs + engine + telegram channel + bot handler
2.1b Telegram 集成(1周): BotFather + server 路由 + 前端设置页 + 绑定流程 + E2E
2.1c Email+飞书(1周): email channel + HTML 模板 + lark channel + SMTP + 频率 Cron
2.1d P2 渠道(按需): slack + discord + 监控告警

---

*PRD by Lucy · ClawFeed Phase 2*
