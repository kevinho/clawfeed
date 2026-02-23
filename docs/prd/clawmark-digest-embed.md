# ClawMark Digest 嵌入组件 PRD

## 背景

用户在阅读 Digest 时，想对感兴趣的条目做标注（mark）并写笔记。当前 marks 功能只有 API，没有前端交互。ClawMark 是已开源的标注/评论组件（kevinho/clawmark），需要嵌入到 ClawFeed 的 Digest 页面，让用户可以直接在页面上操作 marks。

**方案选择：** 嵌入 Digest 页面（Option B），不做浏览器插件。

## 方案

### 设计

在 Digest 详情页的每个条目旁边增加一个标注按钮（bookmark icon）。用户点击后可以：
1. 标记/取消标记该条目
2. 添加/编辑笔记（note）
3. 查看自己的所有 marks

#### 前端交互

- 每个 digest item 右侧显示一个 bookmark icon（未标记=空心，已标记=实心）
- 点击 icon → 如果未标记，创建 mark；如果已标记，弹出操作面板（编辑笔记 / 删除 mark）
- 页面顶部或侧边增加 "My Marks" 入口，展示当前用户所有 marks 列表
- 未登录用户看到 icon 但点击后提示登录

#### API 变更

现有 marks API 已基本满足需求，需补充：

1. **GET /api/marks?digestId=X** — 按 digest 筛选 marks（现有 listMarks 需加 digestId filter）
2. **PATCH /api/marks/:id** — 更新 mark 的 note（现有只有 create/delete，缺 update note）

不需要新建表。现有 `marks` 表的字段（url, title, note, user_id, status）够用。`url` 存 digest item 的原始链接，`title` 存条目标题。

#### 前端实现

- Digest 详情页（服务端渲染 HTML）中嵌入一段 JS：
  - 页面加载时 fetch `/api/marks?digestId=X` 获取当前用户已标记的条目
  - 渲染 bookmark icon 状态
  - 点击事件调用 marks API
- 使用 ClawMark 的 headless core 做标注逻辑，不依赖 ClawMark 的 UI 插件（Fab/Comment），因为 Digest 的 UI 是自定义的

### 影响范围

- `src/server.mjs` — 新增 PATCH /api/marks/:id，listMarks 增加 digestId 过滤
- `src/db.mjs` — updateMarkNote 函数，listMarks 加 digestId 参数
- Digest 详情页 HTML — 嵌入前端 JS + bookmark icon
- `test/e2e.sh` — 补充 mark update + digestId filter 测试

不影响：digest 列表页、sources、packs、subscriptions、feed 输出。

## 验收标准

1. [ ] Digest 详情页每个条目旁有 bookmark icon
2. [ ] 登录用户点击 icon 可创建 mark
3. [ ] 已标记条目显示实心 icon
4. [ ] 点击已标记 icon 可编辑笔记或删除 mark
5. [ ] "My Marks" 页面展示用户所有 marks
6. [ ] 未登录用户点击 icon 提示登录
7. [ ] marks 按 digestId 过滤正常工作
8. [ ] PATCH /api/marks/:id 可更新 note
9. [ ] 其他用户看不到别人的 marks（数据隔离）
10. [ ] 移动端 bookmark icon 可点击、操作面板正常

## 测试用例

| # | 场景 | 步骤 | 预期结果 |
|---|------|------|----------|
| 1 | 创建 mark | Alice 登录 → 打开 digest 详情 → 点击条目 bookmark icon | mark 创建成功，icon 变实心 |
| 2 | 添加笔记 | Alice 点击已标记 icon → 输入笔记 → 保存 | note 保存成功，再次打开可见 |
| 3 | 编辑笔记 | Alice 点击已标记 icon → 修改笔记 → 保存 | PATCH /api/marks/:id 返回成功，note 更新 |
| 4 | 删除 mark | Alice 点击已标记 icon → 点删除 | mark 删除，icon 恢复空心 |
| 5 | 数据隔离 | Alice 标记条目 A → Bob 打开同一 digest | Bob 看不到 Alice 的 mark |
| 6 | digestId 过滤 | Alice 在 digest 1 标记 3 条，digest 2 标记 1 条 → GET /api/marks?digestId=1 | 返回 3 条 |
| 7 | 未登录操作 | 未登录用户点击 bookmark icon | 提示登录，不创建 mark |
| 8 | 重复标记 | Alice 对同一 URL 点两次 bookmark | 不创建重复 mark（现有去重逻辑） |
| 9 | My Marks 页 | Alice 标记 5 个条目 → 打开 My Marks | 展示 5 条 mark，点击可跳转原文 |
| 10 | 移动端 | 手机浏览器打开 digest → 点击 bookmark | icon 可点击，操作面板不溢出屏幕 |

## 回滚方案

无破坏性 migration（只新增 API 逻辑 + 前端 JS）。回滚 = 回退代码版本，marks 数据不受影响。

## 负责人

- 开发：Jessie
- 测试：Lisa
- 审批：Kevin
