# AI Digest — Test Suite

## Quick Start

```bash
# 1. Setup test users (creates 4 fake users in DB)
bash test/setup.sh

# 2. Run E2E tests
bash test/e2e.sh

# 3. Teardown (removes all test data)
bash test/teardown.sh
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AI_DIGEST_API` | `https://digest.kevinhe.io/api` | API base URL |
| `AI_DIGEST_FEED` | `https://digest.kevinhe.io/feed` | Feed base URL |
| `AI_DIGEST_DB` | `../data/digest.db` (relative) | SQLite DB path |

### Local Testing

```bash
AI_DIGEST_API=http://localhost:8767/api \
AI_DIGEST_FEED=http://localhost:8767/feed \
bash test/e2e.sh
```

---

## Test Users

| User | ID | Session Cookie | Role |
|------|----|----------------|------|
| Alice | 100 | `test-sess-alice` | Creates sources & packs |
| Bob | 101 | `test-sess-bob` | Cross-user isolation tests |
| Carol | 102 | `test-sess-carol` | Fresh user (pack install) |
| Dave | 103 | `test-sess-dave` | Additional install tests |

ID range 100–199 reserved for test data; teardown cleans by range.

---

## Test Cases

### 1. Authentication (6 tests)
| # | Case | Method |
|---|------|--------|
| 1.1 | Alice auth returns correct name | `GET /auth/me` |
| 1.2 | Bob auth returns correct name | `GET /auth/me` |
| 1.3 | Carol auth returns correct name | `GET /auth/me` |
| 1.4 | Dave auth returns correct name | `GET /auth/me` |
| 1.5 | Visitor (no cookie) → "not authenticated" | `GET /auth/me` |
| 1.6 | Invalid session cookie → 401 | `GET /auth/me` |

### 2. Digest Browsing — Public (3 tests)
| # | Case | Method |
|---|------|--------|
| 2.1 | 4H digest list (no auth required) | `GET /digests?type=4h` |
| 2.2 | Daily digest list | `GET /digests?type=daily` |
| 2.3 | Weekly digest list | `GET /digests?type=weekly` |

### 3. Sources — CRUD + Visibility (6 tests)
| # | Case | Method |
|---|------|--------|
| 3.1 | Alice creates 3 sources (2 public, 1 private) | `POST /sources` ×3 |
| 3.2 | Alice auto-subscribed to all 3 | `GET /subscriptions` |
| 3.3 | Bob creates 1 public source | `POST /sources` |
| 3.4 | Visitor sees public sources | `GET /sources` |
| 3.5 | Visitor cannot see private sources | `GET /sources` (negative) |
| 3.6 | Visitor cannot create sources → 401 | `POST /sources` |

### 4. Source Ownership (3 tests)
| # | Case | Method |
|---|------|--------|
| 4.1 | Bob cannot delete Alice's source → 403 | `DELETE /sources/:id` |
| 4.2 | Alice deletes her private source | `DELETE /sources/:id` |
| 4.3 | Alice's subscription count decreases | `GET /subscriptions` |

### 5. Packs — Create + Share (4 tests)
| # | Case | Method |
|---|------|--------|
| 5.1 | Alice creates pack from her sources | `POST /packs` |
| 5.2 | Pack in public list | `GET /packs` |
| 5.3 | Pack detail accessible | `GET /packs/:slug` |
| 5.4 | Visitor cannot install pack → 401 | `POST /packs/:slug/install` |

### 6. Pack Install — Fresh User (4 tests)
| # | Case | Method |
|---|------|--------|
| 6.1 | Carol starts with 0 subscriptions | `GET /subscriptions` |
| 6.2 | Carol installs Alice's pack → added 2 | `POST /packs/:slug/install` |
| 6.3 | Carol subscribed to Alice's RSS | `GET /subscriptions` |
| 6.4 | Carol subscribed to Alice's HN | `GET /subscriptions` |

### 7. Pack Dedup (2 tests)
| # | Case | Method |
|---|------|--------|
| 7.1 | Re-install → 0 added | `POST /packs/:slug/install` |
| 7.2 | Dave installs same pack → 2 added | `POST /packs/:slug/install` |

### 8. Cross-Install with Overlap (1 test)
| # | Case | Method |
|---|------|--------|
| 8.1 | Bob (already subscribed to 1) installs pack → partial add | `POST /packs/:slug/install` |

### 9. Subscription Management (2 tests)
| # | Case | Method |
|---|------|--------|
| 9.1 | Carol unsubscribes → count decreases | `DELETE /subscriptions/:sourceId` |
| 9.2 | Carol re-subscribes → count restores | `POST /subscriptions` |

### 10. Marks — CRUD + Isolation (7 tests)
| # | Case | Method |
|---|------|--------|
| 10.1 | Alice creates mark | `POST /marks` |
| 10.2 | Bob creates mark on same digest | `POST /marks` |
| 10.3 | Alice sees only her marks | `GET /marks` |
| 10.4 | Alice cannot see Bob's marks | `GET /marks` (negative) |
| 10.5 | Bob cannot see Alice's marks | `GET /marks` (negative) |
| 10.6 | Carol has 0 marks | `GET /marks` |
| 10.7 | Visitor → 401 | `GET /marks` |

### 11. Data Isolation (2 tests)
| # | Case | Method |
|---|------|--------|
| 11.1 | Alice's subscriptions are hers only | `GET /subscriptions` |
| 11.2 | Bob's subscriptions include his source | `GET /subscriptions` |

### 12. Feed Output (4 tests)
| # | Case | Method |
|---|------|--------|
| 12.1 | JSON Feed → 200 | `GET /feed/kevin.json` |
| 12.2 | JSON Feed valid format | `GET /feed/kevin.json` |
| 12.3 | RSS Feed → 200 | `GET /feed/kevin.rss` |
| 12.4 | Invalid slug → 404 | `GET /feed/xxx.json` |

### 13. API Security (5 tests)
| # | Case | Method |
|---|------|--------|
| 13.1 | POST digests without API key → 401 | `POST /digests` |
| 13.2 | Create source without login → 401 | `POST /sources` |
| 13.3 | Install pack without login → 401 | `POST /packs/:slug/install` |
| 13.4 | Delete source without login → 401 | `DELETE /sources/:id` |
| 13.5 | Access marks without login → 401 | `GET /marks` |

### 14. Edge Cases (3+ tests)
| # | Case | Method |
|---|------|--------|
| 14.1 | Triple-install is idempotent | `POST /packs/:slug/install` |
| 14.2 | Double-subscribe handled | `POST /subscriptions` |
| 14.3 | Subscribe to nonexistent source | `POST /subscriptions` |
| 14.4 | Create source with empty name | `POST /sources` (TODO: validate) |

### 15. Source Deletion + Subscriber Impact (2 tests)
| # | Case | Method |
|---|------|--------|
| 15.1 | Alice deletes source → Carol loses subscription | `DELETE /sources/:id` |
| 15.2 | Pack still exists after source deleted (stale) | `GET /packs/:slug` |

**Total: ~52 test assertions**

---

## Known Issues / TODOs

- [ ] Empty source name accepted (no server-side validation) — test 14.4
- [ ] Pack stores JSON snapshot; source deletion creates zombie data — test 15.2 (see ARCHITECTURE.md)
- [ ] Subscribe to nonexistent source doesn't return 404
- [ ] Mark deletion of nonexistent ID behavior undefined

---

## Iteration Log

### v1 — 2026-02-22
- Initial E2E suite: 44 tests across 14 categories
- 3 test users (Elon, Kevin, Coco) with hardcoded sessions
- Manual browser testing for UI flows

### v2 — 2026-02-22
- Refactored to 4 test users (Alice, Bob, Carol, Dave) with ID range 100-199
- Added setup.sh / teardown.sh for clean isolation
- Expanded to 15 categories, ~52 assertions
- Added source deletion cascade tests (Section 15)
- Added edge case tests (Section 14)
- Helper functions: `check`, `check_not`, `check_code`, `jq_val`, `jq_len`
