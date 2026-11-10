#!/bin/sh
# Publish VOID Client 1.4.5 perf round — idempotent: release v1.4.5 & installer
# assets SUDAH ada di GitHub (dibuat dari state lama). Yang di-idup-in di sini:
#   1. push 6 commit optimasi (argfile fallback, jar 1.4.5 vendored, feed sync)
#   2. upload void-client-1.4.5.jar (zero-alloc hot path) ke release v1.4.5
#   3. deploy site/ ke Cloudflare Pages (voidclient.my.id — feed UTAMA VoidUpdater)
#   4. verifikasi: kedua feed harus serve sha 193305b5..., asset release = 807433 bytes
# Butuh: gh auth login  DAN  npx wrangler login (sekali, interaktif)
set -eu
cd /root/void-client

[ -n "${GH_TOKEN:-}" ] || gh auth status >/dev/null 2>&1 || {
  echo "gh belum login: jalankan 'gh auth login'" >&2; exit 1; }

echo "==> 1/4 push main (termasuk docs/voidfps.json 1.4.5 -> GitHub Pages fallback feed)"
GIT_ASKPASS="${GIT_ASKPASS:-}" git push origin main

echo "==> 2/4 upload mod jar 1.4.5 ke release v1.4.5 (clobber)"
gh release upload v1.4.5 vendor/void-client-1.4.5.jar --clobber
gh release view v1.4.5 --json assets -q \
  '.assets[] | select(.name=="void-client-1.4.5.jar") | "asset: " + .name + " " + (.size|tostring) + " bytes"'

echo "==> 3/4 deploy site/ ke Cloudflare Pages"
npx wrangler@latest pages deploy site --project-name=void-client --branch=main --commit-dirty=true

echo "==> 4/4 verifikasi feed & asset"
sleep 5
fail=0
for u in https://voidclient.my.id/voidfps.json https://mitsuohiroshi927-png.github.io/void-client/voidfps.json; do
  sha=$(curl -sL "$u" | python3 -c "import json,sys;print(json.load(sys.stdin)['sha256'][:16])")
  echo "  $u -> $sha"
  [ "$sha" = "193305b586aa3cc8" ] || { echo "  SALAH, harus 193305b586aa3cc8" >&2; fail=1; }
done
code=$(curl -sL -o /dev/null -w "%{http_code}" https://github.com/mitsuohiroshi927-png/void-client/releases/download/v1.4.5/void-client-1.4.5.jar)
[ "$code" = "200" ] || { echo "jar asset HTTP $code" >&2; fail=1; }
curl -sL -o /tmp/jar145check.jar https://github.com/mitsuohiroshi927-png/void-client/releases/download/v1.4.5/void-client-1.4.5.jar
jarsha=$(sha256sum /tmp/jar145check.jar | cut -d' ' -f1)
[ "$jarsha" = "193305b586aa3cc89a716f3545390f893faa14bf6a2d34b54eac847805ba8663" ] || { echo "jar sha $jarsha != feed sha" >&2; fail=1; }
[ "$fail" = "0" ] && echo "ALL GREEN: feed utama + fallback + release asset = jar 1.4.5 193305b5..." \
  || { echo "VERIFIKASI GAGAL — cek output di atas" >&2; exit 1; }
