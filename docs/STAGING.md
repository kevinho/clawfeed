# ClawFeed Staging Environment

## URLs
- **Staging**: https://lisa.kevinhe.io/staging/
- **API**: https://lisa.kevinhe.io/staging/api/digests
- **Local**: http://localhost:8768

## Config
- **Port**: 8768 (production is 8767)
- **DB**: `data/digest-staging.db`
- **Auth**: Disabled (no Google OAuth configured)
- **API Key**: `staging-api-key-1234`

## Start / Stop

```bash
# Start
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.openclaw.clawfeed-staging.plist

# Stop
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.openclaw.clawfeed-staging.plist

# Manual run
cd /Users/kevinhe/clawd/clawfeed
./scripts/start-staging.sh
```

## Logs
```bash
tail -f /tmp/clawfeed-staging-out.log
tail -f /tmp/clawfeed-staging-err.log
```

## Seed Data
```bash
cd /Users/kevinhe/clawd/clawfeed
sqlite3 data/digest-staging.db "INSERT INTO digests (type, content, created_at) VALUES ('4h', '## Test\n• Item 1\n• Item 2', datetime('now'));"
```

## Post a digest via API
```bash
curl -X POST http://localhost:8768/api/digests \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer staging-api-key-1234' \
  -d '{"type":"4h","content":"## Test digest"}'
```

## Notes
- Staging runs alongside production with a separate DB
- No auth required — for testing only
- Env vars use `DIGEST_PORT` and `DIGEST_DB` (same as production server expects)
