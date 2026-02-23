# ClawFeed 研发规范

> 目标：保证线上稳定，同时保持小团队的迭代速度。

## 核心原则

1. **PRD 是项目基准** — 所有功能以 PRD 为准，开发、测试、验收都对照 PRD
2. **Production 是红线** — 任何改动先过 staging，线上不能挂
3. **测试先行** — PRD 附带测试用例，Kevin + Agent 评审后再开发
4. **改动可回滚** — 每次部署前确认能快速回退

## 角色

| 角色 | 人 | 职责 |
|------|-----|------|
| PO (Product Owner) | Kevin | 提需求、审批 PRD + 测试用例、staging 验收、上线审批 |
| Lead Dev + 协调 | Jessie | 写 PRD、分配任务、开发、协调团队 |
| Dev | Lucy | 开发、补充 PRD 技术细节 |
| QA + Code Review | Lisa | 写测试用例、code review（Codex + 手动）、staging 自测、production smoke test |

## 完整工作流程

```
需求 → PRD + 测试用例 → Kevin Review → 开发 → Code Review → Staging 自测 → Kevin 验收 → Production 部署 → Smoke Test
```

### 1. 需求 → PRD

- Kevin 提需求（飞书群里说即可）
- Jessie 写 PRD（`docs/prd/xxx.md`），包含：
  - 问题描述
  - 方案设计
  - 影响范围
  - 验收标准（acceptance criteria）
  - 测试用例
  - 负责人
- Lucy 可补充技术实现细节
- PRD 以 PR 形式提交到 `develop` 分支

**例外：** Bug 修复/紧急 hotfix 可跳过 PRD，但事后需补充说明。

### 2. 测试用例

- Lisa 基于 PRD 的验收标准编写测试用例
- 测试用例包含在 PRD 文档中
- 测试用例覆盖：功能测试、边界情况、回归测试
- **Kevin + Lisa 共同评审测试用例**（和 PRD 一起审）

### 3. Kevin Review PRD

- Kevin 在 PR 里 review PRD + 测试用例
- 可以评论修改意见，Jessie 修改后重新提交
- **Kevin approve 后才能开始开发**
- Lisa 可以从技术可行性角度补充意见

### 4. 开发

- Jessie 或 Lucy 写代码，从 `develop` 拉 `feat/xxx` 分支
- **不直接改 production 数据库**（config 等通过 API）
- 涉及 DB schema 变更必须写 migration 文件
- 开发完成后提 PR（目标分支：`develop`）

### 5. Code Review

- **Lisa review**（Codex 自动审查 + 手动检查）
- 检查项：代码质量、安全性、是否符合 PRD 设计
- Kevin 有兴趣也可以看
- Review 通过后 merge 到 `develop`

### 6. Staging 自测

- `develop` 分支自动部署到 staging 环境
- **Lisa 按 PRD 测试用例在 staging 上逐项自测**
- 自测清单：
  - [ ] PRD 验收标准逐项通过
  - [ ] 页面正常加载（无白屏/JS 报错）
  - [ ] 已有功能未受影响（登录、digest 列表、marks、sources）
  - [ ] 移动端正常
  - [ ] 未登录用户视角正常
- 自测通过 → 通知 Kevin 验收
- 自测不通过 → 打回给开发修复

### 7. Kevin 验收

- Kevin 在 staging 上验收，对照 PRD 确认功能
- 通过 → 批准上线
- 不通过 → 反馈问题，回到开发环节

### 8. Production 部署

- Kevin 确认后，将 `develop` merge 到 `main`
- 打 release tag（如 `v0.8.0`）
- 部署 production
- 更新 `CHANGELOG.md`

### 9. Production Smoke Test

- 部署后 Lisa 立即跑 smoke test：
  - API 健康检查：`/api/health` 返回 200
  - 核心功能点检：digest 列表、登录、sources 页面
  - 对照 PRD 关键验收项快速过一遍
- Smoke test 通过 → 通知 Kevin 已上线
- Smoke test 失败 → 立即回滚

## 分支策略

```
feat/xxx  ──PR──→  develop  ──auto deploy──→  staging
                      │
                      │  (验收通过后)
                      ▼
                    main  ──release tag──→  production
```

| 分支 | 用途 | 部署目标 | 谁合并 |
|------|------|----------|--------|
| `feat/xxx` | 功能开发 | — | 开发者创建 |
| `develop` | 集成分支 | staging | Lisa review 后 merge |
| `main` | 生产分支 | production | Kevin 验收后 merge |

**规则：**
- `main` 永远是干净的、可部署的状态
- **不在 `main` 或 `develop` 上直接提交**（所有改动走 PR）
- staging 上发现问题，不影响 production

### Branch Protection

- `develop`：CI 通过（Lint + Security Audit）+ 1 review
- `main`：需要 Kevin approve

## 环境

| 环境 | 分支 | URL | 用途 |
|------|------|-----|------|
| CI | feat/* | GitHub Actions | 自动化测试（Lint + Security Audit + Test） |
| Staging | develop | lisa.kevinhe.io/staging/clawfeed | 集成测试 + Kevin 验收（预发级别，和线上同配置） |
| Production | main | clawfeed.kevinhe.io | 线上服务 |

**Staging 要求：** 和 production 使用相同配置结构，独立数据库，确保验证通过的代码到 production 无惊喜。

## 回滚

- `main` 用 git tag 标记每个 release（`v0.7.0`, `v0.8.0`...）
- 回滚 = checkout 上一个 tag → 重新部署
- 数据库 migration 设计为只增不删（向前兼容），代码回滚不破坏数据
- 如有破坏性 migration，PRD 里必须说明回滚方案

## PRD 模板

文件位置：`docs/prd/xxx-feature-name.md`

```markdown
# [功能名称] PRD

## 背景
为什么要做这个功能？解决什么问题？

## 方案
### 设计
具体怎么做？包括数据模型、API、UI 变更等。

### 影响范围
哪些现有功能会受影响？

## 验收标准
1. [ ] 标准 1
2. [ ] 标准 2

## 测试用例
| # | 场景 | 步骤 | 预期结果 |
|---|------|------|----------|
| 1 | ... | ... | ... |

## 回滚方案
如有破坏性变更，说明回滚步骤。

## 负责人
- 开发：Jessie / Lucy
- 测试：Lisa
- 审批：Kevin
```

## 事故响应

1. **发现线上异常** → 立即排查（不等指令）
2. **能快速修复** → 修复并通知 Kevin
3. **不确定原因** → 回滚到上一个 tag，再慢慢排查
4. **事后** → 记录到 `docs/INCIDENTS.md`

## 代码质量检查（上线前）

- [ ] CI 全部通过（Lint + Security Audit + Test）
- [ ] `async/await` 匹配
- [ ] 新加的 fetch 有 error handling
- [ ] 前端改动在 Chrome DevTools Console 无报错
- [ ] 数据库 migration 幂等（可重复执行）
- [ ] 环境变量改动同步到 `.env.example`
