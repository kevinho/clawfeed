# ClawFeed — 测试文档

## 快速开始

```bash
# 创建测试用户 → 跑测试 → 清理
bash test/setup.sh && bash test/e2e.sh; bash test/teardown.sh
```

## 测试架构

```
test/
├── setup.sh       # 创建 4 个测试用户 + session
├── e2e.sh         # 57 个 E2E 用例
└── teardown.sh    # 清理所有测试数据
```

### 设计原则

- **不依赖外部服务**：用 SQLite 直接注入测试用户和 session，绕过 Google OAuth
- **不污染生产数据**：测试用户 id 100-199，真实用户 id 1-99
- **可重复执行**：setup → test → teardown 循环，任意时刻可跑
- **纯 curl + bash**：无额外依赖（python3 仅做 JSON 解析）

## 测试用户

| 用户 | ID | Email | Session Cookie | 角色 |
|------|-----|-------|----------------|------|
| Alice | 100 | alice@test.local | `session=test-sess-alice` | 内容创建者（创建 source + pack） |
| Bob | 101 | bob@test.local | `session=test-sess-bob` | 有部分重叠的用户 |
| Carol | 102 | carol@test.local | `session=test-sess-carol` | 纯消费者（空状态 → 装 pack） |
| Dave | 103 | dave@test.local | `session=test-sess-dave` | 第二个消费者（验证去重） |

### 用户关系图

```
Alice (创建者)
├── 创建 Source A (public RSS)
├── 创建 Source B (public HN)
├── 创建 Source C (private Reddit) → 删除
├── 创建 Pack "Alice AI Pack" (含 A + B)
│
├── Carol 安装 Pack → 订阅 A, B
├── Dave  安装 Pack → 订阅 A, B
├── Bob   手动订阅 A → 再装 Pack → 增量订阅 B
│
└── Alice 删除 Source B → Carol/Dave 丢失 1 个订阅

Bob (独立创建者)
└── 创建 Source D (public RSS)
```

## 测试矩阵

### 1. 认证 (6 cases)

| # | 场景 | 预期 |
|---|------|------|
| 1.1 | Alice/Bob/Carol/Dave 认证 | 返回正确用户信息 |
| 1.2 | 无 cookie | `not authenticated` |
| 1.3 | 无效 session | 401 |

### 2. Digest 浏览 (3 cases)

| # | 场景 | 预期 |
|---|------|------|
| 2.1 | 4H 列表（无需登录） | 返回 4h 类型数据 |
| 2.2 | Daily 列表 | 返回 daily 类型 |
| 2.3 | Weekly 列表 | 返回 weekly 类型 |

### 3. Sources CRUD + 可见性 (7 cases)

| # | 场景 | 预期 |
|---|------|------|
| 3.1 | Alice 创建 3 个 source（2 public + 1 private） | 成功，返回 id |
| 3.2 | Alice 自动订阅自己创建的 | subscriptions = 3 |
| 3.3 | Bob 创建 1 个 public source | 成功 |
| 3.4 | Visitor 看到 public sources | 包含 Alice 和 Bob 的 public |
| 3.5 | Visitor 看不到 private source | 不包含 "Alice Private Reddit" |
| 3.6 | Visitor 看到 Bob 的 source | 包含 "Bob Tech Blog" |
| 3.7 | Visitor 不能创建 source | 401 |

### 4. Source 所有权 (3 cases)

| # | 场景 | 预期 |
|---|------|------|
| 4.1 | Bob 删 Alice 的 source | 403 |
| 4.2 | Alice 删自己的 private source | 成功 |
| 4.3 | Alice 订阅数减 1 | 2 |

### 5. Pack 创建 + 分享 (4 cases)

| # | 场景 | 预期 |
|---|------|------|
| 5.1 | Alice 创建 pack | 返回 slug |
| 5.2 | 公开 packs 列表 | 包含 Alice 的 pack |
| 5.3 | Pack 详情页 | 包含 pack 名称 |
| 5.4 | Visitor 不能安装 | 401 |

### 6. Pack 安装 — 新用户 (5 cases)

| # | 场景 | 预期 |
|---|------|------|
| 6.1 | Carol 初始 0 订阅 | subscriptions = 0 |
| 6.2 | Carol 安装 Alice 的 pack | ok, added=2 |
| 6.3 | Carol 订阅了 RSS | 包含 "Alice Public RSS" |
| 6.4 | Carol 订阅了 HN | 包含 "Alice Public HN" |

### 7. Pack 去重 (2 cases)

| # | 场景 | 预期 |
|---|------|------|
| 7.1 | Carol 重复安装 | added=0 |
| 7.2 | Dave 安装同一个 pack | added=2（独立用户） |

### 8. 有重叠的安装 (1 case)

| # | 场景 | 预期 |
|---|------|------|
| 8.1 | Bob 先手动订阅 1 个 → 再装 pack | 增量添加，subs 增长 |

### 9. 订阅管理 (2 cases)

| # | 场景 | 预期 |
|---|------|------|
| 9.1 | Carol 取消订阅 | subs - 1 |
| 9.2 | Carol 重新订阅 | subs 恢复 |

### 10. Marks 隔离 (9 cases)

| # | 场景 | 预期 |
|---|------|------|
| 10.1 | Alice 标记一篇 | 成功 |
| 10.2 | Bob 标记同一篇 | 成功 |
| 10.3 | Alice 只看到自己的 | 包含 alice，不包含 bob |
| 10.4 | Bob 只看到自己的 | 包含 bob，不包含 alice |
| 10.5 | Carol 没有 marks | 0 |
| 10.6 | Visitor 不能看 marks | 401 |
| 10.7 | Alice 删除 mark | 成功 |

### 11. 数据隔离 (2 cases)

| # | 场景 | 预期 |
|---|------|------|
| 11.1 | Alice 的订阅列表独立 | 只含自己的 source_id |
| 11.2 | Bob 的订阅包含自己创建的 | 含 Bob 的 source |

### 12. Feed 输出 (4 cases)

| # | 场景 | 预期 |
|---|------|------|
| 12.1 | JSON Feed | 200, 含 "version" |
| 12.2 | RSS Feed | 200 |
| 12.3 | 无效 slug | 404 |

### 13. API 安全 (5 cases)

| # | 场景 | 预期 |
|---|------|------|
| 13.1 | POST /digests 无 API key | 401 |
| 13.2 | POST /sources 未登录 | 401 |
| 13.3 | POST /packs/install 未登录 | 401 |
| 13.4 | DELETE /sources 未登录 | 401 |
| 13.5 | GET /marks 未登录 | 401 |

### 14. 边界情况 (2+ cases)

| # | 场景 | 预期 |
|---|------|------|
| 14.1 | 三次安装同一 pack | idempotent, added=0 |
| 14.2 | 重复订阅同一 source | 不报错 |

### 15. Source 删除级联 (2 cases)

| # | 场景 | 预期 |
|---|------|------|
| 15.1 | Alice 删 source → Carol 丢订阅 | Carol subs - 1 |
| 15.2 | Pack 仍然存在（JSON 快照） | pack 可查询 |

## 已知问题 (TODO)

| 问题 | 现状 | 优先级 |
|------|------|--------|
| 空 source name 无校验 | 直接创建成功 | 低 |
| 删除不存在的 mark 返回 200 | 应返回 404 | 低 |
| 删 source 后 pack 快照不更新 | 僵尸源可无限复活 | **高** |
| 订阅者的 source 被删时无通知 | 静默消失 | 中 |

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `AI_DIGEST_DB` | `../data/digest.db` (相对 test/) | SQLite 数据库路径 |
| `AI_DIGEST_API` | `https://digest.kevinhe.io/api` | API base URL |
| `AI_DIGEST_FEED` | `https://digest.kevinhe.io/feed` | Feed base URL |

### 本地开发测试

```bash
AI_DIGEST_API=http://localhost:8767/api \
AI_DIGEST_FEED=http://localhost:8767/feed \
bash test/setup.sh && bash test/e2e.sh; bash test/teardown.sh
```

## 手动浏览器测试

对于需要视觉验证的场景（UI 渲染、响应式布局、交互动画），用浏览器手动测试：

### 切换用户

> **仅限本地开发环境。** 以下方法用于在 localhost 上快速切换测试用户，不适用于 staging 或 production。

先运行 `bash test/setup.sh`，然后用浏览器开发者工具设置 cookie：

```javascript
// DevTools Console — 仅限 localhost 开发环境
// 测试用户的 session cookie 由 setup.sh 直接写入 SQLite，
// 需要通过 DevTools Application 面板手动设置 cookie 值
document.cookie = 'session=test-sess-alice; path=/; max-age=86400';
location.reload();
```

### 重点视觉验证

- [ ] 空状态页面（"选择你的信息源"）
- [ ] Pack 安装后页面刷新到订阅列表
- [ ] Source 被删后订阅者页面变化
- [ ] 语言切换（中/英）
- [ ] 移动端响应式布局
- [ ] TOC 折叠/展开
- [ ] Mark 按钮未登录状态（灰色+tooltip）
