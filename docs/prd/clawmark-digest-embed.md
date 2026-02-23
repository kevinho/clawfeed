# ClawMark 嵌入 ClawFeed PRD

## 背景

ClawFeed 在 staging 环境测试时，测试人员发现 bug 需要手动截图、描述问题、发到群里。流程低效且容易丢失上下文（当前页面 URL、截图、操作路径等）。

ClawMark（kevinho/clawmark）是已开源的反馈/标注组件，提供 Fab 插件（浮动操作按钮）。将 ClawMark 嵌入 ClawFeed 应用，让测试人员可以直接在页面上提交 bug 报告，附带自动采集的上下文信息。

## 方案

### 设计

在 ClawFeed 所有页面嵌入 ClawMark Fab 插件（浮动按钮），点击后弹出反馈表单。

#### 用户交互流程

1. 用户在 ClawFeed 任意页面看到右下角浮动按钮
2. 点击按钮 → 弹出反馈表单
3. 填写：bug 描述 + 可选截图/标注
4. 提交 → 反馈数据存入 ClawMark 后端
5. 可选：提交后通知到 Lark 群（复用已有的 FEEDBACK_LARK_WEBHOOK）

#### 技术实现

1. **ClawMark server 部署**：独立进程部署（Kevin 确认），域名由 Lisa 配置（如 clawmark.kevinhe.io）。使用 kevinho/clawmark 仓库自带的 Express + SQLite 后端。
2. **前端嵌入**：在 ClawFeed 的 HTML 模板中引入 ClawMark SDK（`<script>` 标签），初始化 Fab 插件，指向 ClawMark server
3. **自动采集**：当前页面 URL、浏览器 UA、用户登录状态（如有）自动附带在反馈中
4. **线上服务化**：ClawMark server 作为通用服务运行，不仅服务 ClawFeed，其他项目也可接入（开源集成 vs 在线集成）

#### 环境策略

- **Staging**：默认启用 Fab 按钮（测试环境，鼓励提 bug）
- **Production**：可通过环境变量 `CLAWMARK_ENABLED=true/false` 控制是否显示

#### 配置

新增环境变量：
- `CLAWMARK_ENABLED` — 是否启用 ClawMark（default: true for staging, false for production）
- `CLAWMARK_SERVER_URL` — ClawMark 后端地址

### 影响范围

- ClawFeed HTML 模板 — 新增 `<script>` 引用 + 初始化代码
- `.env.example` — 新增 CLAWMARK_ENABLED、CLAWMARK_SERVER_URL
- `src/server.mjs` — 渲染 HTML 时注入 ClawMark 配置（环境变量传到前端）

不影响：digest API、marks API、sources、packs、subscriptions、feed 输出、认证逻辑。

## 验收标准

1. [ ] ClawFeed 页面右下角显示 ClawMark 浮动按钮
2. [ ] 点击按钮弹出反馈表单
3. [ ] 填写描述并提交成功
4. [ ] 提交的反馈包含当前页面 URL
5. [ ] 提交后可选通知到 Lark 群
6. [ ] `CLAWMARK_ENABLED=false` 时按钮不显示
7. [ ] 不影响 ClawFeed 已有功能（digest 列表、登录、sources）
8. [ ] 移动端浮动按钮正常显示且不遮挡主要内容

## 测试用例

| # | 场景 | 步骤 | 预期结果 |
|---|------|------|----------|
| 1 | Fab 按钮可见 | 打开 ClawFeed 任意页面 | 右下角可见浮动按钮 |
| 2 | 提交反馈 | 点击按钮 → 填写描述 → 提交 | 提交成功，表单关闭 |
| 3 | 自动采集 URL | 在 /digests 页面提交反馈 | 反馈数据中包含当前页面 URL |
| 4 | Lark 通知 | 提交反馈（配置了 FEEDBACK_LARK_WEBHOOK） | Lark 群收到通知 |
| 5 | 环境开关 - 关 | 设置 CLAWMARK_ENABLED=false → 打开页面 | 按钮不显示 |
| 6 | 环境开关 - 开 | 设置 CLAWMARK_ENABLED=true → 打开页面 | 按钮显示 |
| 7 | 不影响已有功能 | 嵌入 ClawMark 后访问 digest 列表、登录、sources | 所有功能正常 |
| 8 | 移动端 | 手机浏览器打开 ClawFeed | 浮动按钮可见、可点击、不遮挡内容 |
| 9 | ClawMark 服务不可用 | ClawMark server 关闭 → 打开 ClawFeed | ClawFeed 正常加载，Fab 按钮可能不可用但不影响主功能 |
| 10 | 空描述提交 | 点击按钮 → 不填内容 → 点提交 | 提示必须填写描述 |

## 回滚方案

设置 `CLAWMARK_ENABLED=false` 即可关闭，无需回滚代码。无数据库变更。

## 负责人

- 开发：Jessie
- 测试：Lisa
- 审批：Kevin
