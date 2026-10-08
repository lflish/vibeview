#!/usr/bin/env bash
# 渲染 sidecar 冒烟：无 Docker 时本地起 render-server；有 Docker 时可选探测
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "== bash -n =="
bash -n scripts/smoke-render.sh
bash -n install-skill.sh 2>/dev/null || true

echo "== syntax: node --check =="
node --check render-server.js
node --check lib/preview-store.js
node --check lib/preview-routes.js
node --check lib/preview-proxy.js
node --check server.js

echo "== unit: preview-store path + id =="
TMP="$(mktemp -d)"
RENDER_PID=""
PROXY_PID=""
cleanup() {
  if [[ -n "${RENDER_PID}" ]] && kill -0 "$RENDER_PID" 2>/dev/null; then
    kill "$RENDER_PID" 2>/dev/null || true
    wait "$RENDER_PID" 2>/dev/null || true
  fi
  if [[ -n "${PROXY_PID}" ]] && kill -0 "$PROXY_PID" 2>/dev/null; then
    kill "$PROXY_PID" 2>/dev/null || true
    wait "$PROXY_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

TMP_DATA="$TMP" node << 'NODE'
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createPreviewStore, isValidId } = require('./lib/preview-store');

assert.strictEqual(isValidId('abcdefghijklmnop'), true);
assert.strictEqual(isValidId('../etc/passwdxxxx'), false);
assert.strictEqual(isValidId('short'), false);

const root = process.env.TMP_DATA;
assert.ok(root);
const store = createPreviewStore(root);
const id = 'abcdefghijklmnop';
fs.mkdirSync(path.join(root, 'meta'), { recursive: true });
fs.mkdirSync(path.join(root, 'html', id), { recursive: true });
fs.writeFileSync(path.join(root, 'html', id, 'index.html'), '<h1>ok</h1>');
fs.writeFileSync(
  path.join(root, 'meta', id + '.json'),
  JSON.stringify({
    id,
    type: 'html',
    filename: 'index.html',
    mime: 'text/html',
    size: 10,
    source: 'smoke',
    createdAt: new Date().toISOString(),
  })
);
const meta = store.readMeta(id);
assert.ok(meta);
assert.strictEqual(meta.type, 'html');
assert.ok(store.filePath(meta).includes(id));
console.log('preview-store ok, dataRoot=', store.dataRoot);
NODE

echo "== local render-server (no docker) =="
export RENDER_DATA_ROOT="$TMP"
export RENDER_PORT=13091
node render-server.js &
RENDER_PID=$!
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS "http://127.0.0.1:${RENDER_PORT}/healthz" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

curl -fsS "http://127.0.0.1:${RENDER_PORT}/healthz" | grep -q '"role":"render"'
BODY="$(curl -fsS "http://127.0.0.1:${RENDER_PORT}/v/abcdefghijklmnop")"
echo "$BODY" | grep -q '<h1>ok</h1>'
CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${RENDER_PORT}/v/not-a-valid-idXX" || true)"
[[ "$CODE" == "404" ]]
echo "local render-server ok"

echo "== proxy 502 when render down =="
node << 'NODE' &
const express = require('express');
const { createPreviewProxy } = require('./lib/preview-proxy');
const app = express();
app.use('/v', createPreviewProxy({ renderUrl: 'http://127.0.0.1:13091', proxyTimeoutMs: 2000 }));
app.listen(13092, '127.0.0.1');
NODE
PROXY_PID=$!
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS "http://127.0.0.1:13092/v/abcdefghijklmnop" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done
curl -fsS "http://127.0.0.1:13092/v/abcdefghijklmnop" | grep -q '<h1>ok</h1>'

kill "$RENDER_PID"
wait "$RENDER_PID" 2>/dev/null || true
RENDER_PID=""
sleep 0.2
CODE502="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:13092/v/abcdefghijklmnop" || true)"
[[ "$CODE502" == "502" ]]
echo "proxy 502 ok (no silent fallback)"
kill "$PROXY_PID" 2>/dev/null || true
wait "$PROXY_PID" 2>/dev/null || true
PROXY_PID=""

echo "== docker (optional) =="
if command -v docker >/dev/null 2>&1; then
  IMAGE="vibeview-render-smoke-$$"
  docker build -f Dockerfile.render -t "$IMAGE" .
  CID="$(docker run -d --read-only --tmpfs /tmp \
    -p 127.0.0.1:13093:3001 \
    -v "${TMP}:/data:ro" \
    -e RENDER_DATA_ROOT=/data \
    -e RENDER_PORT=3001 \
    "$IMAGE")"
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if curl -fsS "http://127.0.0.1:13093/healthz" >/dev/null 2>&1; then
      break
    fi
    sleep 0.3
  done
  curl -fsS "http://127.0.0.1:13093/healthz" | grep -q '"role":"render"'
  curl -fsS "http://127.0.0.1:13093/v/abcdefghijklmnop" | grep -q '<h1>ok</h1>'
  docker stop "$CID" >/dev/null
  docker rm "$CID" >/dev/null
  docker rmi "$IMAGE" >/dev/null || true
  echo "docker render ok"
else
  echo "docker not installed; skipped container build (local checks passed)"
fi

echo "ALL smoke-render checks passed"
