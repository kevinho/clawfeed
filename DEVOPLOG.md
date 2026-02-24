# DevOp Log

Development and operations log for ClawFeed. Records the full R&D lifecycle — feature development, staging validation, production release, and infrastructure changes.

## 2026-02-24 — v0.8.1 (TG hotfix + subtitle links)

**Status:** Staging verified ✅ | Production: pending merge

**Changes:**
- #16 — TG group link button + info banner (i18n)
- #17 — Replace airplane emoji with Telegram SVG icon + clickable TG group link
- #18 — Subtitle @mentions link to Twitter profiles (Jessie@ZylosAI, Lisa@OpenClaw)

**Docs/PRD (no runtime impact):**
- #8 — ClawMark Digest embed PRD
- #9 — CI trigger fix for develop branch
- #10 — Source personalization PRD
- #11 — Feedback system PRD (retroactive)

**Staging validation:**
- Validated by: Kevin
- Date: 2026-02-24
- Result: OK

**Infrastructure:**
- Staging/production environment isolation implemented (independent directories + databases)
- Staging auto-deploy configured (develop branch, 60s polling)
