#!/usr/bin/env bash
# P0-10 全链路冒烟：隔离 config + data → 起服 → curl/CLI 断言 → 清理
# 见 docs/SPEC.md §7.1、docs/SPEC-FINAL-CHECK.md
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PASS=0
FAIL=0
SERVER_PID=""
TMP=""

log() { printf '[smoke] %s\n' "$*"; }
ok() { PASS=$((PASS + 1)); printf '  OK  %s\n' "$*"; }
fail() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$*" >&2; }

assert_eq() {
  local got="$1" want="$2" msg="$3"
  if [[ "$got" == "$want" ]]; then
    ok "$msg (got $want)"
  else
    fail "$msg (want=$want got=$got)"
  fi
}

assert_contains() {
  local hay="$1" needle="$2" msg="$3"
  if [[ "$hay" == *"$needle"* ]]; then
    ok "$msg"
  else
    fail "$msg (missing: $needle)"
  fi
}

cleanup() {
  if [[ -n "${SERVER_PID}" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  SERVER_PID=""
  if [[ -n "${TMP}" && -d "${TMP}" ]]; then
    rm -rf "$TMP"
  fi
}
trap cleanup EXIT

PORT="$(python3 - <<'PY'
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
)"
BASE="http://127.0.0.1:${PORT}"

TOKEN_A="smoke-token-a-$(openssl rand -hex 8)"
TOKEN_B="smoke-token-b-$(openssl rand -hex 8)"
TOKEN_Q="smoke-token-q-$(openssl rand -hex 8)"
TOKEN_S="smoke-token-s-$(openssl rand -hex 8)"
TOKEN_R0="smoke-token-r0-$(openssl rand -hex 8)"
TOKEN_R1="smoke-token-r1-$(openssl rand -hex 8)"
ADMIN_PASS="smoke-admin-$(openssl rand -hex 8)"
ADMIN_USER="admin"

TMP="$(mktemp -d /tmp/vibeview-smoke.XXXXXX)"
COOKIE_JAR="$TMP/cookies.txt"
DATA="$TMP/data"
mkdir -p "$DATA"/{html,images,videos,meta} "$TMP/fixtures"

MARKER="SMOKE_HTML_$(openssl rand -hex 4)"
printf '<!DOCTYPE html><html><body><h1>%s</h1></body></html>\n' "$MARKER" >"$TMP/fixtures/page.html"
printf 'not-allowed\n' >"$TMP/fixtures/note.txt"

python3 - "$TMP/fixtures/dot.png" <<'PY'
import struct, zlib, pathlib, sys
def chunk(t, d):
    return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
sig = b"\x89PNG\r\n\x1a\n"
ihdr = chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
idat = chunk(b"IDAT", zlib.compress(b"\x00\xff\x00\x00"))
iend = chunk(b"IEND", b"")
pathlib.Path(sys.argv[1]).write_bytes(sig + ihdr + idat + iend)
PY

printf 'fake-mp4-bytes' >"$TMP/fixtures/clip.mp4"
dd if=/dev/zero of="$TMP/fixtures/big.bin" bs=1024 count=1100 status=none 2>/dev/null
cp "$TMP/fixtures/big.bin" "$TMP/fixtures/big.html"
python3 - "$TMP/fixtures/heavy.html" <<'PY'
import sys
body = "<!DOCTYPE html><html><body>" + ("X" * 160) + "</body></html>"
open(sys.argv[1], "w").write(body)
PY

cat >"$TMP/config.yaml" <<YAML
server:
  port: ${PORT}
  base_url: "${BASE}"

storage:
  html_dir: "./data/html"
  image_dir: "./data/images"
  video_dir: "./data/videos"
  meta_dir: "./data/meta"
  retention_days: 7
  max_size_mb: 1

tokens:
  - name: "account-a"
    token: "${TOKEN_A}"
    max_files: 1
  - name: "account-b"
    token: "${TOKEN_B}"
  - name: "account-quota-files"
    token: "${TOKEN_Q}"
    max_files: 1
  - name: "account-quota-storage"
    token: "${TOKEN_S}"
    max_storage_mb: 0.0001
  - name: "account-retain0"
    token: "${TOKEN_R0}"
    retention_days: 0
  - name: "account-retain1"
    token: "${TOKEN_R1}"
    retention_days: 1

admin:
  user: "${ADMIN_USER}"
  password: "${ADMIN_PASS}"
  session_secret: "smoke-session-$(openssl rand -hex 16)"

preview:
  proxy_to_render: false
  render_url: "http://127.0.0.1:3001"
  proxy_timeout_ms: 30000
YAML

export DVIEW_CONFIG_PATH="$TMP/config.yaml"

log "TMP=$TMP PORT=$PORT"
log "starting server with DVIEW_CONFIG_PATH"

node server.js >"$TMP/server.log" 2>&1 &
SERVER_PID=$!

READY=0
for i in $(seq 1 50); do
  if curl -fsS "$BASE/healthz" >/dev/null 2>&1; then
    READY=1
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    fail "server exited early; log:"
    cat "$TMP/server.log" >&2 || true
    exit 1
  fi
  sleep 0.1
done
if [[ "$READY" != "1" ]]; then
  fail "server did not become healthy"
  cat "$TMP/server.log" >&2 || true
  exit 1
fi
ok "server up on $BASE"

json_get() {
  local file="$1" key="$2"
  python3 -c "import json;print(json.load(open('$file'))$key)"
}

log "== 1 health =="
CODE="$(curl -s -o "$TMP/out.json" -w '%{http_code}' "$BASE/healthz")"
assert_eq "$CODE" "200" "GET /healthz"
assert_contains "$(cat "$TMP/out.json")" '"role":"main"' "healthz role=main"
CODE="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/")"
assert_eq "$CODE" "200" "GET /"

log "== 2 upload HTML =="
CODE="$(curl -s -o "$TMP/up.json" -w '%{http_code}' \
  -H "Authorization: Bearer ${TOKEN_B}" \
  -F "file=@${TMP}/fixtures/page.html" \
  "$BASE/upload")"
assert_eq "$CODE" "200" "POST /upload HTML"
ID_B="$(json_get "$TMP/up.json" "['id']")"
SRC_B="$(json_get "$TMP/up.json" "['source']")"
URL_B="$(json_get "$TMP/up.json" "['url']")"
assert_eq "$SRC_B" "account-b" "upload source=account-b"
assert_contains "$URL_B" "/v/$ID_B" "upload url contains id"
BODY="$(curl -fsS "$BASE/v/$ID_B")"
assert_contains "$BODY" "$MARKER" "GET /v/:id body matches uploaded HTML"

log "== 3 image/video =="
CODE="$(curl -s -o "$TMP/img.json" -w '%{http_code}' \
  -H "Authorization: Bearer ${TOKEN_B}" \
  -F "file=@${TMP}/fixtures/dot.png" \
  "$BASE/upload")"
assert_eq "$CODE" "200" "POST /upload PNG"
ID_IMG="$(json_get "$TMP/img.json" "['id']")"
BODY="$(curl -fsS "$BASE/v/$ID_IMG")"
assert_contains "$BODY" "<img" "image preview has <img>"
assert_contains "$BODY" "/v/$ID_IMG/raw" "image preview raw path"
CODE="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v/$ID_IMG/raw")"
assert_eq "$CODE" "200" "GET /v/:id/raw image"

CODE="$(curl -s -o "$TMP/vid.json" -w '%{http_code}' \
  -H "Authorization: Bearer ${TOKEN_B}" \
  -F "file=@${TMP}/fixtures/clip.mp4;type=video/mp4" \
  "$BASE/upload")"
assert_eq "$CODE" "200" "POST /upload mp4"
ID_VID="$(json_get "$TMP/vid.json" "['id']")"
BODY="$(curl -fsS "$BASE/v/$ID_VID")"
assert_contains "$BODY" "<video" "video preview has <video>"

log "== 4 bad type =="
CODE="$(curl -s -o "$TMP/err.json" -w '%{http_code}' \
  -H "Authorization: Bearer ${TOKEN_B}" \
  -F "file=@${TMP}/fixtures/note.txt" \
  "$BASE/upload")"
assert_eq "$CODE" "400" "upload .txt → 400"

log "== 5 oversized =="
CODE="$(curl -s -o "$TMP/big.json" -w '%{http_code}' \
  -H "Authorization: Bearer ${TOKEN_B}" \
  -F "file=@${TMP}/fixtures/big.html;type=text/html" \
  "$BASE/upload")"
assert_eq "$CODE" "400" "upload > max_size_mb → 400"
assert_contains "$(cat "$TMP/big.json")" "file too large" "error mentions file too large"

log "== 6 max_files =="
CODE="$(curl -s -o "$TMP/q1.json" -w '%{http_code}' \
  -H "Authorization: Bearer ${TOKEN_Q}" \
  -F "file=@${TMP}/fixtures/page.html" \
  "$BASE/upload")"
assert_eq "$CODE" "200" "quota account first upload"
CODE="$(curl -s -o "$TMP/q2.json" -w '%{http_code}' \
  -H "Authorization: Bearer ${TOKEN_Q}" \
  -F "file=@${TMP}/fixtures/page.html" \
  "$BASE/upload")"
assert_eq "$CODE" "429" "max_files second upload → 429"
assert_contains "$(cat "$TMP/q2.json")" "max_files" "429 mentions max_files"

log "== 7 max_storage =="
HTML_BEFORE="$(find "$DATA/html" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')"
CODE="$(curl -s -o "$TMP/st.json" -w '%{http_code}' \
  -H "Authorization: Bearer ${TOKEN_S}" \
  -F "file=@${TMP}/fixtures/heavy.html;type=text/html" \
  "$BASE/upload")"
assert_eq "$CODE" "429" "max_storage_mb → 429"
HTML_AFTER="$(find "$DATA/html" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')"
assert_eq "$HTML_AFTER" "$HTML_BEFORE" "no orphan html dirs after storage 429"
curl -fsS -H "Authorization: Bearer ${TOKEN_S}" "$BASE/api/me" >"$TMP/me_s.json"
COUNT_S="$(json_get "$TMP/me_s.json" "['account']['usage']['count']")"
assert_eq "$COUNT_S" "0" "storage-quota account usage count=0"

log "== 8 isolation =="
curl -fsS -H "Authorization: Bearer ${TOKEN_B}" "$BASE/api/me/items" >"$TMP/items_b.json"
python3 - "$TMP/items_b.json" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
assert all(i.get("source") == "account-b" for i in data["items"]), data
assert len(data["items"]) >= 1
print("ok", len(data["items"]))
PY
ok "GET /api/me/items only own (account-b)"

CODE="$(curl -s -o "$TMP/forbid.json" -w '%{http_code}' \
  -X DELETE \
  -H "Authorization: Bearer ${TOKEN_A}" \
  "$BASE/api/me/items/$ID_B")"
assert_eq "$CODE" "403" "account-a DELETE account-b id → 403"

curl -fsS -H "Authorization: Bearer ${TOKEN_A}" "$BASE/api/me/items" >"$TMP/items_a.json"
HAS_B="$(python3 -c "import json;d=json.load(open('$TMP/items_a.json'));print(any(i.get('id')=='$ID_B' for i in d['items']))")"
assert_eq "$HAS_B" "False" "account-a list does not include B id"

log "== 9 disable/enable + admin 401 =="
CODE="$(curl -s -o "$TMP/admin401.json" -w '%{http_code}' "$BASE/admin/api/list")"
assert_eq "$CODE" "401" "GET /admin/api/list no cookie → 401"
BODY401="$(cat "$TMP/admin401.json")"
assert_contains "$BODY401" "unauthorized" "401 body is JSON unauthorized"
if [[ "$BODY401" == *"<!DOCTYPE"* ]] || [[ "$BODY401" == *"<html"* ]]; then
  fail "401 returned HTML login page"
else
  ok "401 is not HTML login page"
fi

# 登录：express-session 需要跟随 Set-Cookie；-L 会把 POST 变成 GET 对 redirect，分两步更稳
curl -s -c "$COOKIE_JAR" -b "$COOKIE_JAR" \
  -X POST \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode "user=${ADMIN_USER}" \
  --data-urlencode "password=${ADMIN_PASS}" \
  -D "$TMP/login.hdr" \
  -o /dev/null \
  "$BASE/admin/login"

CODE="$(curl -s -b "$COOKIE_JAR" -o "$TMP/alist.json" -w '%{http_code}' "$BASE/admin/api/list")"
assert_eq "$CODE" "200" "admin list with session"

CODE="$(curl -s -b "$COOKIE_JAR" -o "$TMP/dis.json" -w '%{http_code}' \
  -X POST "$BASE/admin/api/accounts/account-b/disable")"
assert_eq "$CODE" "200" "disable account-b"

CODE="$(curl -s -o "$TMP/dis_up.json" -w '%{http_code}' \
  -H "Authorization: Bearer ${TOKEN_B}" \
  -F "file=@${TMP}/fixtures/page.html" \
  "$BASE/upload")"
assert_eq "$CODE" "401" "disabled token upload → 401"

CODE="$(curl -s -o "$TMP/dis_me.json" -w '%{http_code}' \
  -H "Authorization: Bearer ${TOKEN_B}" \
  "$BASE/api/me")"
assert_eq "$CODE" "401" "disabled token /api/me → 401"

CODE="$(curl -s -b "$COOKIE_JAR" -o "$TMP/en.json" -w '%{http_code}' \
  -X POST "$BASE/admin/api/accounts/account-b/enable")"
assert_eq "$CODE" "200" "enable account-b"

CODE="$(curl -s -o "$TMP/en_me.json" -w '%{http_code}' \
  -H "Authorization: Bearer ${TOKEN_B}" \
  "$BASE/api/me")"
assert_eq "$CODE" "200" "enabled token /api/me → 200"

log "== 10 cleanup =="
CODE="$(curl -s -o "$TMP/r0.json" -w '%{http_code}' \
  -H "Authorization: Bearer ${TOKEN_R0}" \
  -F "file=@${TMP}/fixtures/page.html" \
  "$BASE/upload")"
assert_eq "$CODE" "200" "upload retain0"
ID_R0="$(json_get "$TMP/r0.json" "['id']")"

CODE="$(curl -s -o "$TMP/r1.json" -w '%{http_code}' \
  -H "Authorization: Bearer ${TOKEN_R1}" \
  -F "file=@${TMP}/fixtures/page.html" \
  "$BASE/upload")"
assert_eq "$CODE" "200" "upload retain1"
ID_R1="$(json_get "$TMP/r1.json" "['id']")"

python3 - "$DATA/meta" "$ID_R0" "$ID_R1" <<'PY'
import json, pathlib, sys
from datetime import datetime, timedelta, timezone
meta_dir = pathlib.Path(sys.argv[1])
old = (datetime.now(timezone.utc) - timedelta(days=3)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
for iid in sys.argv[2:]:
    p = meta_dir / f"{iid}.json"
    m = json.loads(p.read_text())
    m["createdAt"] = old
    p.write_text(json.dumps(m, indent=2))
print("aged", old)
PY

REMOVED="$(DVIEW_CONFIG_PATH="$TMP/config.yaml" node -e "const c=require('./lib/cleanup'); console.log=()=>{}; process.stdout.write(String(c.cleanupExpired()))")"
assert_eq "$REMOVED" "1" "cleanupExpired removes 1 (retain1 only)"

if [[ -f "$DATA/meta/$ID_R0.json" ]]; then ok "retain0 meta kept"; else fail "retain0 meta missing"; fi
if [[ ! -f "$DATA/meta/$ID_R1.json" ]]; then ok "retain1 meta removed"; else fail "retain1 meta still present"; fi

log "== 12 CLI =="
export DVIEW_URL="$BASE"
export DVIEW_TOKEN="$TOKEN_B"
CLI_URL="$("$ROOT/bin/dview" upload "$TMP/fixtures/page.html")"
assert_contains "$CLI_URL" "/v/" "dview upload prints URL"
CLI_ID="$(basename "$CLI_URL")"
if "$ROOT/bin/dview" me | grep -q 'account-b'; then ok "dview me"; else fail "dview me"; fi
if "$ROOT/bin/dview" list | grep -q "$CLI_ID"; then ok "dview list contains upload"; else fail "dview list"; fi
if "$ROOT/bin/dview" delete "$CLI_ID" | grep -q "deleted"; then ok "dview delete"; else fail "dview delete"; fi

log "== summary =="

if [[ "${SMOKE_SKIP_RENDER:-}" != "1" ]]; then
  log "running smoke:render (sidecar unit checks)"
  if bash "$ROOT/scripts/smoke-render.sh"; then
    ok "smoke:render passed"
  else
    fail "smoke:render failed"
  fi
fi

log "passed=$PASS failed=$FAIL"
if [[ "$FAIL" -gt 0 ]]; then
  log "server.log (tail):"
  tail -n 80 "$TMP/server.log" >&2 || true
  exit 1
fi
log "ALL smoke checks passed"
exit 0
