# Feedback 系统 PRD（回顾性）

> 本 PRD 为已上线功能的回顾性文档，记录现有实现和后续规划。

## 背景

ClawFeed 需要一个让用户提交反馈的渠道。需求包括：用户可以在应用内提交反馈消息，管理员可以查看和回复，反馈提交后可通知到 Lark 群。

### 设计原则（参考 [Lisa 研究文档](https://lisa.kevinhe.io/research/clawfeed-feedback-prd.md)）

- **自建 CRM 优先**：数据存 SQLite，IM（Lark）只是通知渠道，不是数据源
- **HxA 模式**：Agent 自动分类 + 回复简单问题，复杂的标 `needs_human` 转人处理
- **派发流程**：用户提交 → 写入 CRM → 通知 IM → Agent 分类处理 → 复杂转 Human
- **状态流转**：`open` → `auto_draft`（Agent 处理中）→ `needs_human`（需人工）→ `replied` → `closed`

## 现有实现

### 前端

- 页面右下角浮动气泡按钮（绿色圆形 💬 图标）
- 点击弹出 Feedback 面板（320×420px）：消息输入框 + 发送按钮
- 已登录用户：直接提交，身份自动关联（不显示邮箱/姓名输入框）
- 未登录用户：可匿名提交，可选填邮箱/姓名
- 支持中英文 i18n
- 可通过 `/api/config` 的 `feedbackEnabled` 字段控制是否显示

### 后端

#### 数据模型

```sql
-- migration 008
CREATE TABLE feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,          -- 可为空（匿名）
  email TEXT,
  name TEXT,
  message TEXT NOT NULL,
  reply TEXT,               -- 管理员回复
  replied_by TEXT,
  replied_at TEXT,
  status TEXT DEFAULT 'open',  -- open | auto_draft | needs_human | replied | closed
  created_at TEXT DEFAULT (datetime('now'))
);

-- migration 009
ALTER TABLE feedback ADD COLUMN category TEXT;
ALTER TABLE feedback ADD COLUMN read_at TEXT;
```

#### API 端点

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| POST | `/api/feedback` | 无（匿名可提交） | 创建反馈，message 必填 |
| GET | `/api/feedback` | 需登录 | 查看当前用户的反馈 + 未读回复数 |
| POST | `/api/feedback/read` | 需登录 | 标记所有未读回复为已读 |
| GET | `/api/feedback/all` | API Key | 管理员查看全部反馈 |
| POST | `/api/feedback/:id/reply` | API Key | 管理员回复反馈 |
| PATCH | `/api/feedback/:id/status` | API Key | 管理员更新状态 |

#### Lark 通知

提交反馈时，如 `FEEDBACK_LARK_WEBHOOK` 已配置，自动发送通知到 Lark 群。通知包含：用户名、邮箱、反馈内容前 200 字、时间戳。Fire-and-forget，不阻塞响应。

### 配置

- `FEEDBACK_LARK_WEBHOOK` — Lark webhook URL（可选）
- `feedbackEnabled` — 前端开关（通过 /api/config 返回）

### 涉及文件

- `migrations/008_feedback.sql` — 建表
- `migrations/009_feedback_v2.sql` — 加 category + read_at
- `src/db.mjs` — createFeedback, getUserFeedback, getAllFeedback, replyToFeedback, updateFeedbackStatus, getUnreadFeedbackCount
- `src/server.mjs` — 6 个 API 端点
- `web/index.html` — 浮动按钮 + 面板 UI + i18n 文本
- `.env.example` — FEEDBACK_LARK_WEBHOOK

## 验收标准

### 基础功能（已上线 ✅）

1. [x] 页面右下角浮动反馈按钮可见
2. [x] 点击按钮弹出反馈面板
3. [x] 未登录用户可提交匿名反馈
4. [x] 已登录用户反馈关联 user_id（不显示邮箱/姓名输入框）
5. [x] 空消息提交被拒绝（400 错误）
6. [x] 提交成功后面板显示确认
7. [x] 管理员可通过 API Key 查看全部反馈
8. [x] 管理员可回复反馈
9. [x] 管理员可修改反馈状态
10. [x] 配置 FEEDBACK_LARK_WEBHOOK 后提交自动通知 Lark 群
11. [x] feedbackEnabled=false 时按钮不显示
12. [x] 中英文切换正常

### CRM 数据优先（待实现）

13. [ ] 所有反馈数据以 SQLite 为主数据源，Lark 仅作通知渠道
14. [ ] 反馈查询和统计从数据库获取，不依赖 IM 历史记录

### HxA 模式 — Agent 自动处理（待实现）

15. [ ] 新反馈提交后 Agent 自动分类（赋值 `category` 字段）
16. [ ] Agent 可对简单问题（如 FAQ）自动起草回复（状态流转到 `auto_draft`）
17. [ ] Agent 无法处理的反馈标记为 `needs_human`，通知人工接管
18. [ ] Agent 回复和人工回复使用同一 `reply` 字段，用户无感知差异

### 状态流转（待实现）

19. [ ] 反馈提交后初始状态为 `open`
20. [ ] Agent 处理中状态为 `auto_draft`
21. [ ] 需人工处理状态为 `needs_human`
22. [ ] 回复后状态为 `replied`
23. [ ] 关闭后状态为 `closed`
24. [ ] 状态正向流转：`open → auto_draft → needs_human → replied → closed`
25. [ ] 允许 reopen：`closed → open`（用户追加反馈或问题未解决）
26. [ ] 其他逆向跳转禁止（如 `replied → open`）
27. [ ] 管理员可通过 API 更新状态

## 测试用例

### 基础功能（已验证 ✅）

| # | 场景 | 步骤 | 预期结果 |
|---|------|------|----------|
| 1 | 匿名提交 | 未登录 → 输入消息 → 发送 | 提交成功，返回 id |
| 2 | 登录提交 | 已登录 → 输入消息 → 发送 | 反馈关联 user_id，无邮箱/姓名输入框 |
| 3 | 空消息拒绝 | 不输入 → 发送 | 400 错误 |
| 4 | 查看历史 | 已登录 → 打开面板 | 显示历史反馈和回复 |
| 5 | 管理员查看 | GET /api/feedback/all + API Key | 返回全部反馈 |
| 6 | 管理员回复 | POST /api/feedback/:id/reply | 回复写入，用户可见 |
| 7 | 标记已读 | 有未读回复 → POST /api/feedback/read | read_at 更新 |
| 8 | Lark 通知 | 配置 webhook → 提交反馈 | Lark 群收到通知 |
| 9 | 开关关闭 | feedbackEnabled=false | 按钮不显示 |
| 10 | i18n | 切换语言 → 打开面板 | 文本正确切换 |

### Agent 自动分类（待实现）

| # | 场景 | 步骤 | 预期结果 |
|---|------|------|----------|
| 11 | 自动分类 | 提交反馈 | category 字段被自动赋值（如 bug / feature_request / question / other） |
| 12 | 分类为空 fallback | Agent 分类失败 | category 为 null，状态直接到 needs_human |
| 13 | 按分类筛选 | GET /api/feedback/all?category=bug | 只返回对应分类的反馈 |

### Agent 自动回复（待实现）

| # | 场景 | 步骤 | 预期结果 |
|---|------|------|----------|
| 14 | 简单问题自动回复 | 提交 FAQ 类反馈（如「怎么订阅」） | 状态 open → auto_draft，Agent 起草回复 |
| 15 | 复杂问题转人工 | 提交 bug 报告 | 状态 open → needs_human，通知管理员 |
| 16 | 人工接管 auto_draft | 管理员修改 Agent 草稿并回复 | 状态 auto_draft → replied |
| 17 | 用户无感知 | 用户查看 Agent 回复和人工回复 | 两种回复在前端显示一致 |

### 状态流转（待实现）

| # | 场景 | 步骤 | 预期结果 |
|---|------|------|----------|
| 18 | 完整流转 | open → auto_draft → replied → closed | 每步状态变更成功 |
| 19 | needs_human 流转 | open → needs_human → replied → closed | 每步状态变更成功 |
| 20 | reopen | closed → open | 状态重置为 open，允许重新处理 |
| 20b | 非法流转 | 尝试 replied → open | 400 错误，禁止非法逆向跳转 |
| 21 | 状态查询 | GET /api/feedback/all?status=needs_human | 只返回对应状态的反馈 |

## 后续规划

现有 feedback 系统是纯文本反馈。后续 ClawMark 嵌入（PR #8 PRD 已 merge）将作为增强方案，支持：
- 截图标注
- 自动采集页面 URL、浏览器信息
- 结构化 bug 报告

ClawMark 上线后可考虑替代或与现有 feedback 共存。

## 负责人

- 开发：Jessie
- 测试：Lisa
- 审批：Kevin
