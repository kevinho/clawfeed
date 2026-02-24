# Development & Release Process

ClawFeed uses a two-branch model: `develop` (staging) and `main` (production).

## Roles

| Role | Who | Responsibility |
|------|-----|---------------|
| Dev | Jessie | Feature development, PR creation, release coordination |
| Review/QA/DevOps | Lisa | Code review, staging/production deployment, smoke tests |
| PO | Kevin | Feature verification, release approval, merge |

## Feature Flow

```
feature branch → PR to develop → Lisa review → Kevin merge → staging auto-deploy → Lisa verify staging → notify Kevin to verify → Kevin验收 → accumulate for release
```

### Steps

1. **Dev creates feature branch** from `develop`
   - Branch naming: `feat/<name>`, `fix/<name>`, `docs/<name>`

2. **Dev opens PR** to `develop`
   - CI must pass (Lint + Security Audit)

3. **Dev notifies Lisa** to review (via BotsHub)
   - Lisa reviews code quality + functionality
   - Lisa approves on GitHub

4. **Dev notifies Kevin** to merge
   - Only after Lisa has approved
   - Kevin reviews and merges

5. **Staging auto-deploys** (launchd cron, 60s interval)
   - Lisa verifies staging deployment + smoke test
   - Lisa reports staging status

6. **Dev notifies Kevin to verify on staging**
   - Kevin tests the feature on staging
   - Kevin confirms acceptance or requests changes

## Release Flow

When features are verified and ready for production:

```
develop → release PR to main → Lisa review → Kevin merge → Lisa deploy production → smoke test → done
```

### Steps

1. **Dev creates Release PR** (`develop` → `main`)
   - All merge conflicts resolved before review
   - Version bump included if needed

2. **Dev notifies Lisa** to review (via BotsHub)
   - Lisa reviews and approves

3. **Dev notifies Kevin** to merge
   - Only after Lisa has approved

4. **Kevin merges** the Release PR

5. **Lisa deploys production**
   - Pull main, restart service, run smoke test
   - Report deployment status

6. **Dev notifies Kevin** that production is live
   - Kevin verifies production

7. **Lisa publishes to ClawHub** (if version bump)
   - `clawhub publish . --slug clawfeed --version X.Y.Z --tags latest`

## Rules

- **No half-done handoffs.** Resolve all conflicts and get Lisa's review before pinging Kevin.
- **PR flow is automatic.** Dev notifies Lisa immediately after creating any PR. No waiting for Kevin to remind.
- **Every step is driven.** Dev proactively moves the process forward and notifies the right person at each step.
- **Follow the process regardless of change size.** Even small changes go through the full flow.

## Environments

| Environment | Branch | Port | Deploy |
|-------------|--------|------|--------|
| Staging | develop | 8768 | Auto (launchd cron 60s) |
| Production | main | 8767 | Manual (Lisa) |
