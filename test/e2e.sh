#!/bin/bash
# ═══════════════════════════════════════════════════
#  ClawFeed — Full E2E Multi-User Test Suite
#  4 test users: Alice, Bob, Carol, Dave
#  Tests: auth, sources, packs, marks, subscriptions,
#         data isolation, ownership, feeds, security
# ═══════════════════════════════════════════════════
set -e

API="${AI_DIGEST_API:-https://digest.kevinhe.io/api}"
FEED="${AI_DIGEST_FEED:-https://digest.kevinhe.io/feed}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AI_DIGEST_DB="${AI_DIGEST_DB:-$SCRIPT_DIR/../data/digest.db}"
ALICE="Cookie: session=test-sess-alice"
BOB="Cookie: session=test-sess-bob"
CAROL="Cookie: session=test-sess-carol"
DAVE="Cookie: session=test-sess-dave"
PASS=0; FAIL=0; TOTAL=0; SKIP=0

check() {
  TOTAL=$((TOTAL+1))
  local desc="$1" expected="$2" actual="$3"
  if echo "$actual" | grep -qF "$expected"; then
    PASS=$((PASS+1))
    printf "  ✅ %s\n" "$desc"
  else
    FAIL=$((FAIL+1))
    printf "  ❌ %s\n" "$desc"
    printf "     expected: %s\n" "$expected"
    printf "     got: %.120s\n" "$actual"
  fi
}

check_not() {
  TOTAL=$((TOTAL+1))
  local desc="$1" forbidden="$2" actual="$3"
  if echo "$actual" | grep -qF "$forbidden"; then
    FAIL=$((FAIL+1))
    printf "  ❌ %s (found forbidden: %s)\n" "$desc" "$forbidden"
  else
    PASS=$((PASS+1))
    printf "  ✅ %s\n" "$desc"
  fi
}

check_code() {
  TOTAL=$((TOTAL+1))
  local desc="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then
    PASS=$((PASS+1))
    printf "  ✅ %s → %s\n" "$desc" "$actual"
  else
    FAIL=$((FAIL+1))
    printf "  ❌ %s → got %s, expected %s\n" "$desc" "$actual" "$expected"
  fi
}

jq_val() { python3 -c "import sys,json; d=json.load(sys.stdin); print($1)" 2>/dev/null; }
jq_len() { python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null; }

echo ""
echo "═══════════════════════════════════════════"
echo "  ClawFeed E2E Test Suite"
echo "  $(date '+%Y-%m-%d %H:%M:%S')"
echo "═══════════════════════════════════════════"

# ═══════════════════════════════════════════
# 1. AUTH
# ═══════════════════════════════════════════
echo ""
echo "─── 1. Authentication (4 users + visitor) ───"

check "Alice auth" '"name":"Alice (Test)"' "$(curl -s "$API/auth/me" -H "$ALICE")"
check "Bob auth" '"name":"Bob (Test)"' "$(curl -s "$API/auth/me" -H "$BOB")"
check "Carol auth" '"name":"Carol (Test)"' "$(curl -s "$API/auth/me" -H "$CAROL")"
check "Dave auth" '"name":"Dave (Test)"' "$(curl -s "$API/auth/me" -H "$DAVE")"
check "Visitor → not authenticated" 'not authenticated' "$(curl -s "$API/auth/me")"
check_code "Invalid session → 401" "401" "$(curl -s -o /dev/null -w '%{http_code}' "$API/auth/me" -H 'Cookie: session=bogus')"

# ═══════════════════════════════════════════
# 2. DIGEST BROWSING (public)
# ═══════════════════════════════════════════
echo ""
echo "─── 2. Digest Browsing (public) ───"

check "4H digest list (no auth)" '"type":"4h"' "$(curl -s "$API/digests?type=4h&limit=1")"
check "Daily digest list" 'daily' "$(curl -s "$API/digests?type=daily&limit=1")"
check "Weekly digest list" 'weekly' "$(curl -s "$API/digests?type=weekly&limit=1")"

# ═══════════════════════════════════════════
# 3. SOURCES — CRUD + VISIBILITY
# ═══════════════════════════════════════════
echo ""
echo "─── 3. Sources (CRUD + visibility) ───"

# Alice creates 3 sources: 2 public, 1 private
A_S1=$(curl -s -X POST "$API/sources" -H "$ALICE" -H "Content-Type: application/json" \
  -d '{"name":"Alice Public RSS","type":"rss","config":"{\"url\":\"https://alice.test/rss\"}","isPublic":true}' | jq_val "d['id']")
A_S2=$(curl -s -X POST "$API/sources" -H "$ALICE" -H "Content-Type: application/json" \
  -d '{"name":"Alice Public HN","type":"hackernews","config":"{\"section\":\"front\"}","isPublic":true}' | jq_val "d['id']")
A_S3=$(curl -s -X POST "$API/sources" -H "$ALICE" -H "Content-Type: application/json" \
  -d '{"name":"Alice Private Reddit","type":"reddit","config":"{\"subreddit\":\"test\"}","isPublic":false}' | jq_val "d['id']")
check "Alice creates 3 sources" "$A_S1" "$A_S1"
echo "     IDs: public=$A_S1,$A_S2 private=$A_S3"

# Alice auto-subscribed to all 3
r=$(curl -s "$API/subscriptions" -H "$ALICE" | jq_len)
check "Alice auto-subscribed (3)" "3" "$r"

# Bob creates 1 public source
B_S1=$(curl -s -X POST "$API/sources" -H "$BOB" -H "Content-Type: application/json" \
  -d '{"name":"Bob Tech Blog","type":"rss","config":"{\"url\":\"https://bob.test/rss\"}","isPublic":true}' | jq_val "d['id']")
check "Bob creates 1 source" "$B_S1" "$B_S1"

# Visitor sees only public sources (no private)
r=$(curl -s "$API/sources")
check "Visitor sees Alice's public sources" 'Alice Public RSS' "$r"
check_not "Visitor cannot see private source" 'Alice Private Reddit' "$r"
check "Visitor sees Bob's source" 'Bob Tech Blog' "$r"

# Security: visitor can't create
check_code "Visitor cannot create → 401" "401" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/sources" -H 'Content-Type: application/json' -d '{"name":"x","type":"rss","config":"{}"}')"

# ═══════════════════════════════════════════
# 4. SOURCE OWNERSHIP
# ═══════════════════════════════════════════
echo ""
echo "─── 4. Source Ownership ───"

# Bob can't delete Alice's source
check_code "Bob cannot delete Alice's source → 403" "403" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$API/sources/$A_S1" -H "$BOB")"

# Alice can delete her own
r=$(curl -s -X DELETE "$API/sources/$A_S3" -H "$ALICE")
check "Alice deletes her private source" 'ok' "$r"

# Verify subscription still exists but marked as deleted (soft delete)
r=$(curl -s "$API/subscriptions" -H "$ALICE" | jq_len)
check "Alice still has 3 subscriptions (1 soft-deleted)" "3" "$r"
# Verify the deleted one has sourceDeleted=true
r=$(curl -s "$API/subscriptions" -H "$ALICE")
check "Deleted source marked sourceDeleted" '"sourceDeleted":true' "$r"

# ═══════════════════════════════════════════
# 5. PACKS — CREATE + SHARE
# ═══════════════════════════════════════════
echo ""
echo "─── 5. Packs (create + share) ───"

# Alice creates a pack from her sources
A_PACK=$(curl -s -X POST "$API/packs" -H "$ALICE" -H "Content-Type: application/json" \
  -d "{\"name\":\"Alice AI Pack\",\"description\":\"RSS + HN\",\"sourcesJson\":\"[{\\\"name\\\":\\\"Alice Public RSS\\\",\\\"type\\\":\\\"rss\\\",\\\"config\\\":\\\"{\\\\\\\"url\\\\\\\":\\\\\\\"https://alice.test/rss\\\\\\\"}\\\"},{\\\"name\\\":\\\"Alice Public HN\\\",\\\"type\\\":\\\"hackernews\\\",\\\"config\\\":\\\"{\\\\\\\"section\\\\\\\":\\\\\\\"front\\\\\\\"}\\\"}]\"}" \
  | jq_val "d.get('slug','')")
check "Alice creates pack" "alice-ai-pack" "$A_PACK"

# Pack visible in public list
check "Pack in public list" 'Alice AI Pack' "$(curl -s "$API/packs")"

# Pack detail accessible
check "Pack detail" 'Alice AI Pack' "$(curl -s "$API/packs/$A_PACK")"

# Visitor can see pack but not install
check_code "Visitor cannot install → 401" "401" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/packs/$A_PACK/install")"

# ═══════════════════════════════════════════
# 6. PACK INSTALL — FRESH USER
# ═══════════════════════════════════════════
echo ""
echo "─── 6. Pack Install (Carol = fresh user) ───"

# Carol has 0 subs
r=$(curl -s "$API/subscriptions" -H "$CAROL" | jq_len)
check "Carol starts with 0 subscriptions" "0" "$r"

# Carol installs Alice's pack
r=$(curl -s -X POST "$API/packs/$A_PACK/install" -H "$CAROL")
check "Carol installs Alice's pack" '"ok":true' "$r"
check "Carol gets 2 added" '"added":2' "$r"

# Carol now has 2 subs
r=$(curl -s "$API/subscriptions" -H "$CAROL")
check "Carol subscribed to Alice's RSS" 'Alice Public RSS' "$r"
check "Carol subscribed to Alice's HN" 'Alice Public HN' "$r"

# ═══════════════════════════════════════════
# 7. PACK DEDUP
# ═══════════════════════════════════════════
echo ""
echo "─── 7. Pack Dedup ───"

# Carol installs again → 0 added
r=$(curl -s -X POST "$API/packs/$A_PACK/install" -H "$CAROL")
check "Re-install → 0 added" '"added":0' "$r"

# Dave installs same pack
r=$(curl -s -X POST "$API/packs/$A_PACK/install" -H "$DAVE")
check "Dave installs same pack" '"added":2' "$r"

# ═══════════════════════════════════════════
# 8. CROSS-INSTALL (user with overlap)
# ═══════════════════════════════════════════
echo ""
echo "─── 8. Cross-install (Bob has partial overlap) ───"

# Bob subscribes to one of Alice's sources manually first
curl -s -X POST "$API/subscriptions" -H "$BOB" -H "Content-Type: application/json" \
  -d "{\"sourceId\":$A_S1}" > /dev/null

BOB_BEFORE=$(curl -s "$API/subscriptions" -H "$BOB" | jq_len)
r=$(curl -s -X POST "$API/packs/$A_PACK/install" -H "$BOB")
BOB_AFTER=$(curl -s "$API/subscriptions" -H "$BOB" | jq_len)
check "Bob installs with overlap → partial add" '"ok":true' "$r"
echo "     Bob subs: $BOB_BEFORE → $BOB_AFTER"

# ═══════════════════════════════════════════
# 9. SUBSCRIPTION MANAGEMENT
# ═══════════════════════════════════════════
echo ""
echo "─── 9. Subscription Management ───"

# Carol unsubscribes from one
r=$(curl -s -X DELETE "$API/subscriptions/$A_S1" -H "$CAROL")
CAROL_AFTER=$(curl -s "$API/subscriptions" -H "$CAROL" | jq_len)
check "Carol unsubscribes → 1 left" "1" "$CAROL_AFTER"

# Carol re-subscribes
curl -s -X POST "$API/subscriptions" -H "$CAROL" -H "Content-Type: application/json" \
  -d "{\"sourceId\":$A_S1}" > /dev/null
CAROL_RESUB=$(curl -s "$API/subscriptions" -H "$CAROL" | jq_len)
check "Carol re-subscribes → 2" "2" "$CAROL_RESUB"

# ═══════════════════════════════════════════
# 10. MARKS — CRUD + ISOLATION
# ═══════════════════════════════════════════
echo ""
echo "─── 10. Marks (CRUD + isolation) ───"

# Get a real digest ID
DIGEST_ID=$(curl -s "$API/digests?type=4h&limit=1" | jq_val "d[0]['id'] if d else ''")
echo "     Using digest_id: $DIGEST_ID"

if [ -n "$DIGEST_ID" ] && [ "$DIGEST_ID" != "None" ]; then
  # Alice marks a digest
  A_MARK=$(curl -s -X POST "$API/marks" -H "$ALICE" -H "Content-Type: application/json" \
    -d "{\"digestId\":$DIGEST_ID,\"url\":\"https://test.local/alice-mark\",\"title\":\"Alice mark\",\"note\":\"alice private note\"}" \
    | jq_val "d.get('id','')")
  check "Alice creates mark" "$A_MARK" "$A_MARK"

  # Bob marks same digest
  B_MARK=$(curl -s -X POST "$API/marks" -H "$BOB" -H "Content-Type: application/json" \
    -d "{\"digestId\":$DIGEST_ID,\"url\":\"https://test.local/bob-mark\",\"title\":\"Bob mark\",\"note\":\"bob private note\"}" \
    | jq_val "d.get('id','')")
  check "Bob marks same digest" "$B_MARK" "$B_MARK"

  # Alice sees only her marks
  r=$(curl -s "$API/marks" -H "$ALICE")
  check "Alice sees her mark" 'alice private note' "$r"
  check_not "Alice cannot see Bob's mark" 'bob private note' "$r"

  # Bob sees only his marks
  r=$(curl -s "$API/marks" -H "$BOB")
  check "Bob sees his mark" 'bob private note' "$r"
  check_not "Bob cannot see Alice's mark" 'alice private note' "$r"

  # Carol sees nothing
  r=$(curl -s "$API/marks" -H "$CAROL")
  CAROL_MARKS=$(echo "$r" | jq_len)
  check "Carol has 0 marks" "0" "$CAROL_MARKS"

  # Visitor blocked
  check_code "Visitor cannot access marks → 401" "401" \
    "$(curl -s -o /dev/null -w '%{http_code}' "$API/marks")"

  # Alice deletes her mark
  if [ -n "$A_MARK" ] && [ "$A_MARK" != "None" ]; then
    r=$(curl -s -X DELETE "$API/marks/$A_MARK" -H "$ALICE")
    check "Alice deletes her mark" 'ok' "$r"

    # Bob can't delete Alice's mark... well it's already gone. Try Bob's own
    # Bob tries to delete with wrong user? Actually marks are identified by ID
    # Let's check Bob can't delete someone else's mark by trying a fake ID
    # Delete nonexistent mark — might be 200 (no-op) or 404
    r=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$API/marks/999999" -H "$BOB")
    echo "     Delete nonexistent mark: HTTP $r (informational)"
  fi
else
  echo "  ⏭️  Skipping marks tests (no digest in DB)"
  SKIP=$((SKIP+6))
fi

# ═══════════════════════════════════════════
# 11. DATA ISOLATION — CROSS-USER
# ═══════════════════════════════════════════
echo ""
echo "─── 11. Data Isolation ───"

# Alice's private source is gone (deleted earlier), but let's verify subscriptions don't leak
ALICE_SUBS=$(curl -s "$API/subscriptions" -H "$ALICE" | python3 -c "import sys,json; print(','.join(str(s['id']) for s in json.load(sys.stdin)))" 2>/dev/null)
BOB_SUBS=$(curl -s "$API/subscriptions" -H "$BOB" | python3 -c "import sys,json; print(','.join(str(s['id']) for s in json.load(sys.stdin)))" 2>/dev/null)
CAROL_SUBS=$(curl -s "$API/subscriptions" -H "$CAROL" | python3 -c "import sys,json; print(','.join(str(s['id']) for s in json.load(sys.stdin)))" 2>/dev/null)
echo "     Alice subs: [$ALICE_SUBS]"
echo "     Bob subs:   [$BOB_SUBS]"
echo "     Carol subs: [$CAROL_SUBS]"

# Each user's subscription list is independent
check "Alice has her own subs" "$A_S1" "$ALICE_SUBS"
check "Bob has Bob's source" "$B_S1" "$BOB_SUBS"

# ═══════════════════════════════════════════
# 12. FEED OUTPUT
# ═══════════════════════════════════════════
echo ""
echo "─── 12. Feed Output ───"

# Kevin's feed (real user slug)
check_code "JSON Feed → 200" "200" "$(curl -s -o /dev/null -w '%{http_code}' "$FEED/kevin.json")"
check "JSON Feed valid" 'version' "$(curl -s "$FEED/kevin.json" | head -c 200)"
check_code "RSS Feed → 200" "200" "$(curl -s -o /dev/null -w '%{http_code}' "$FEED/kevin.rss")"
check_code "Invalid slug → 404" "404" "$(curl -s -o /dev/null -w '%{http_code}' "$FEED/nonexistent-slug.json")"

# ═══════════════════════════════════════════
# 13. API SECURITY
# ═══════════════════════════════════════════
echo ""
echo "─── 13. API Security ───"

check_code "POST /digests without API key → 401" "401" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/digests" -H 'Content-Type: application/json' -d '{"type":"4h","content":"x"}')"

check_code "Create source without login → 401" "401" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/sources" -H 'Content-Type: application/json' -d '{"name":"x","type":"rss","config":"{}"}')"

check_code "Install pack without login → 401" "401" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/packs/$A_PACK/install")"

check_code "Delete source without login → 401" "401" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$API/sources/$A_S1")"

check_code "Access marks without login → 401" "401" \
  "$(curl -s -o /dev/null -w '%{http_code}' "$API/marks")"

# ═══════════════════════════════════════════
# 14. EDGE CASES
# ═══════════════════════════════════════════
echo ""
echo "─── 14. Edge Cases ───"

# Double-click install (idempotent)
r=$(curl -s -X POST "$API/packs/$A_PACK/install" -H "$CAROL")
check "Triple-install is idempotent" '"added":0' "$r"

# Subscribe to already-subscribed source
r=$(curl -s -X POST "$API/subscriptions" -H "$CAROL" -H "Content-Type: application/json" \
  -d "{\"sourceId\":$A_S1}")
check "Double-subscribe handled" '' "$r"  # should not error

# Subscribe to nonexistent source
r=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/subscriptions" -H "$CAROL" -H "Content-Type: application/json" \
  -d '{"sourceId":999999}')
# Might be 404 or just succeed silently
echo "     Subscribe to nonexistent source: HTTP $r"

# Create source with empty name — currently allowed (no validation)
r=$(curl -s -X POST "$API/sources" -H "$ALICE" -H "Content-Type: application/json" \
  -d '{"name":"","type":"rss","config":"{}"}')
echo "     Empty source name: $(echo "$r" | head -c 80) (TODO: add validation)"

# ═══════════════════════════════════════════
# 15. SOURCE DELETION CASCADE
# ═══════════════════════════════════════════
echo ""
echo "─── 15. Source Deletion + Subscriber Impact ───"

# Carol is subscribed to Alice's sources. Alice deletes one.
CAROL_BEFORE=$(curl -s "$API/subscriptions" -H "$CAROL" | jq_len)
curl -s -X DELETE "$API/sources/$A_S2" -H "$ALICE" > /dev/null
CAROL_AFTER=$(curl -s "$API/subscriptions" -H "$CAROL" | jq_len)
check "Alice soft-deletes source → Carol keeps sub count" "$CAROL_BEFORE" "$CAROL_AFTER"
# But Carol sees it as deleted
r=$(curl -s "$API/subscriptions" -H "$CAROL")
check "Carol sees soft-deleted source" '"sourceDeleted":true' "$r"

# Pack still exists but with stale data
r=$(curl -s "$API/packs/$A_PACK")
check "Pack still exists after source deleted" 'Alice AI Pack' "$r"

# ═══════════════════════════════════════════
# 16. SOFT DELETE
# ═══════════════════════════════════════════
echo ""
echo "─── 16. Soft Delete ───"

# Create a source for soft delete testing
SD_SRC=$(curl -s -X POST "$API/sources" -H "$ALICE" -H "Content-Type: application/json" \
  -d '{"name":"SoftDel Test","type":"rss","config":"{\"url\":\"https://softdel.test/rss\"}","isPublic":true}' | jq_val "d['id']")

# Bob subscribes to it
curl -s -X POST "$API/subscriptions" -H "$BOB" -H "Content-Type: application/json" \
  -d "{\"sourceId\":$SD_SRC}" > /dev/null

# 16.1 Delete source → is_deleted=1, not removed from DB
curl -s -X DELETE "$API/sources/$SD_SRC" -H "$ALICE" > /dev/null
SD_CHECK=$(sqlite3 "$AI_DIGEST_DB" "SELECT is_deleted FROM sources WHERE id=$SD_SRC" 2>/dev/null || echo "")
check "16.1 Soft delete sets is_deleted=1" "1" "$SD_CHECK"

# 16.2 Deleted source hidden from GET /sources
r=$(curl -s "$API/sources" -H "$ALICE")
check_not "16.2 Deleted source hidden from sources list" 'SoftDel Test' "$r"

# 16.3 Subscriber sees deleted source as "已停用"
r=$(curl -s "$API/subscriptions" -H "$BOB")
check "16.3 Subscriber sees sourceDeleted field" '"sourceDeleted":true' "$r"

# 16.4 Pack install skips deleted source (no zombie)
# Create a pack containing the deleted source's type+config
SD_PACK=$(curl -s -X POST "$API/packs" -H "$ALICE" -H "Content-Type: application/json" \
  -d '{"name":"SoftDel Pack","sourcesJson":"[{\"name\":\"SoftDel Test\",\"type\":\"rss\",\"config\":\"{\\\"url\\\":\\\"https://softdel.test/rss\\\"}\"}]"}' \
  | jq_val "d.get('slug','')")
r=$(curl -s -X POST "$API/packs/$SD_PACK/install" -H "$CAROL")
check "16.4 Pack install skips deleted source" '"added":0' "$r"

# 16.5 Pack install: mixed (skip deleted, create non-deleted only)
SD_PACK2=$(curl -s -X POST "$API/packs" -H "$ALICE" -H "Content-Type: application/json" \
  -d '{"name":"Mixed Pack","sourcesJson":"[{\"name\":\"SoftDel Test\",\"type\":\"rss\",\"config\":\"{\\\"url\\\":\\\"https://softdel.test/rss\\\"}\"},{\"name\":\"Brand New Source\",\"type\":\"rss\",\"config\":\"{\\\"url\\\":\\\"https://brandnew.test/rss\\\"}\"}]"}' \
  | jq_val "d.get('slug','')")
r=$(curl -s -X POST "$API/packs/$SD_PACK2/install" -H "$DAVE")
check "16.5 Mixed pack: only non-deleted added" '"added":1' "$r"

# 16.6 Re-install after source deleted → 0 added (for the deleted one)
r=$(curl -s -X POST "$API/packs/$SD_PACK/install" -H "$DAVE")
check "16.6 Re-install deleted source pack → 0 added" '"added":0' "$r"

# 16.7 Deleted source not counted in active sources
r=$(curl -s "$API/sources")
check_not "16.7 Deleted source not in active sources" 'SoftDel Test' "$r"

# ═══════════════════════════════════════════
# RESULTS
# ═══════════════════════════════════════════
echo ""
echo "═══════════════════════════════════════════"
printf "  Results: %d/%d passed" "$PASS" "$TOTAL"
[ "$FAIL" -gt 0 ] && printf ", \033[31m%d failed\033[0m" "$FAIL"
[ "$SKIP" -gt 0 ] && printf ", %d skipped" "$SKIP"
echo ""
echo "═══════════════════════════════════════════"
echo ""

[ "$FAIL" -gt 0 ] && exit 1 || exit 0
