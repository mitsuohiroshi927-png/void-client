#!/usr/bin/env bash
# Publish fix mod-jar 1.4.4→1.4.5 di artifacts 1.4.5 (clobber upload + deploy feeds).
# Prereqs (dikerjakan KING sekali): gh auth login && npx wrangler login (di /root/void-client/site)
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> verify auth"
gh auth status >/dev/null 2>&1 || { echo "FATAL: gh belum login — jalankan: gh auth login" >&2; exit 1; }

echo "==> push feed fix ke GitHub"
git push origin main

echo "==> upload artifacts baru ke release v1.4.5 (clobber)"
gh release upload v1.4.5 \
  dist/VOID-Client-1.4.5-Setup.exe \
  dist/VOIDClient-Setup.exe \
  dist/VOID-Client-1.4.5-hot.tar.gz \
  dist/VOID-Client-1.4.5-Setup.exe.blockmap \
  dist/VOID-Client-1.4.5-x86_64.AppImage \
  --clobber

echo "==> deploy feed ke Cloudflare Pages (site/)"
(cd site && npx wrangler@latest pages deploy . \
  --project-name void-client \
  --branch main \
  --commit-dirty=true)

echo "==> verify"
sleep 5
curl -s https://mitsuohiroshi927-png.github.io/void-client/launcher.json | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log('GH Pages hot sha:',j.hot.sha256.slice(0,12),'win:',j.platforms.win32.sha256.slice(0,12))})"
curl -s https://void-client-c8q.pages.dev/launcher.json | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log('CF Pages  hot sha:',j.hot.sha256.slice(0,12),'win:',j.platforms.win32.sha256.slice(0,12))})"
curl -sIL https://github.com/mitsuohiroshi927-png/void-client/releases/download/v1.4.5/VOID-Client-1.4.5-hot.tar.gz | grep -iE "^(HTTP|content-length)" | head -4
sha256sum dist/VOID-Client-1.4.5-hot.tar.gz
echo "DONE — cek hot sha di kedua feed == sha lokal 4a7b34df…"
