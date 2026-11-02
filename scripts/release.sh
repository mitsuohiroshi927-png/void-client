#!/usr/bin/env bash
#
# Cut a VOID Client release: build, publish, deploy.
#
# Usage:
#   VOIDFPS_FEEDBACK_URL='https://discord.com/api/webhooks/<id>/<token>' \
#     scripts/release.sh 1.2.3 "Short headline for the release notes"
#
# Why the env var: launch.js ships inside the installer's asar, so a webhook
# literal in the source is readable by anyone who runs `asar extract` on the
# downloaded exe. Passing it in at build time keeps it out of the repo.
#
# Prereqs: `gh auth login` (repo scope), `npx wrangler login` OR CLOUDFLARE_API_TOKEN.
set -euo pipefail

VER="${1:?usage: release.sh <version> [notes]}"
NOTES="${2:-VOID Client ${VER}}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

EXE="VOID-Client-${VER}-Setup.exe"
TAG="v${VER}"

echo "==> 1/6 bump version to ${VER}"
node -e "
const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));
p.version='${VER}';fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n');
console.log('   package.json ->',p.version);
"

echo "==> 2/6 build installer"
# electron-builder downloads its toolchain from GitHub on first run; this host
# needs the local proxy or the fetch dies as a bare network error.
HTTPS_PROXY="${HTTPS_PROXY:-http://127.0.0.1:28118}" \
HTTP_PROXY="${HTTP_PROXY:-http://127.0.0.1:28118}" \
WINEPREFIX="${WINEPREFIX:-/root/.wine-void}" WINEDEBUG=-all \
  npx electron-builder --win --x64

echo "==> 3/6 verify the build actually produced a real installer"
SIZE=$(stat -c%s "dist/${EXE}")
# A truncated NSIS stub is ~296 KB; a real installer is ~120 MB. Anything small
# means the packaging step died quietly and the feed would ship a dead file.
if [ "$SIZE" -lt 50000000 ]; then
  echo "FATAL: dist/${EXE} is only ${SIZE} bytes - packaging failed, refusing to publish" >&2
  exit 1
fi
SHA=$(sha256sum "dist/${EXE}" | cut -d' ' -f1)
echo "   ${EXE}: ${SIZE} bytes, sha256 ${SHA}"

echo "==> 4/7 refresh update feeds"
# The feed is regenerated from the artifact that was just built, so it can never
# disagree with the file users download. Templates are used when a feed is
# missing (fresh clone: dist/ is gitignored and may not exist yet).
node -e "
const fs=require('fs'), path=require('path');
const v='${VER}', sha='${SHA}', size=${SIZE};
const url='https://github.com/mitsuohiroshi927-png/void-client/releases/latest/download/${EXE}';
const notes=process.env.REL_NOTES || '';
const win={url,primary:url,mirror:url,urls:[url],sha256:sha,size};
// All three aliases (url / primary / mirror) are written to both feeds: the
// launcher's updater reads `url`, the site reads `primary`+`mirror`, and a
// single shape means the two files can be diffed against each other safely.
const tpl={version:v,notes,platforms:{win32:win}};
fs.mkdirSync('dist',{recursive:true});
for (const f of ['dist/launcher.json','dist/launcher-site.json']) {
  let j=tpl;
  if (fs.existsSync(f)) {
    try { j=JSON.parse(fs.readFileSync(f,'utf8')); } catch (e) { j=tpl; }
  }
  j.version=v; j.notes=notes;
  j.platforms=j.platforms||{win32:{}};
  j.platforms.win32=Object.assign({}, j.platforms.win32, win);
  fs.writeFileSync(f,JSON.stringify(j,null,2)+'\n');
}
console.log('   launcher.json + launcher-site.json ->',v);
" REL_NOTES="$NOTES"

echo "==> 5/7 refresh site pages and _redirects"
node scripts/update-site.js "$VER" "$SHA" "$SIZE"
cp site/index.html site/download.html site/_redirects dist/

echo "==> 6/7 publish the GitHub release"
gh release create "$TAG" "dist/${EXE}" \
  --title "VOID Client ${VER}" --notes "$NOTES" || \
  gh release upload "$TAG" "dist/${EXE}" --clobber

echo "==> 7/7 deploy the site"
cp dist/launcher.json dist/launcher-site.json site/
npx wrangler@latest pages deploy site \
  --project-name=void-client --branch=main

cat <<EOF

Done. Verify before announcing:
  curl -s https://mitsuohiroshi927-png.github.io/void-client/launcher.json | head -5
  curl -sI https://mitsuohiroshi927-png.github.io/void-client/${EXE} | head -3   # expect 200
EOF

