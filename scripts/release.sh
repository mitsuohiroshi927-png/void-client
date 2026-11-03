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

echo "==> 1/7 bump version to ${VER}"
node -e "
const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));
p.version='${VER}';fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n');
console.log('   package.json ->',p.version);
"

echo "==> 2/7 build installer"
# electron-builder downloads its toolchain from GitHub on first run; this host
# needs the local proxy or the fetch dies as a bare network error.
HTTPS_PROXY="${HTTPS_PROXY:-http://127.0.0.1:28118}" \
HTTP_PROXY="${HTTP_PROXY:-http://127.0.0.1:28118}" \
WINEPREFIX="${WINEPREFIX:-/root/.wine-void}" WINEDEBUG=-all \
  npx electron-builder --win --x64

echo "==> 3/7 verify the build actually produced a real installer"
SIZE=$(stat -c%s "dist/${EXE}")
# A truncated NSIS stub is ~296 KB; a real installer is ~120 MB. Anything small
# means the packaging step died quietly and the feed would ship a dead file.
if [ "$SIZE" -lt 50000000 ]; then
  echo "FATAL: dist/${EXE} is only ${SIZE} bytes - packaging failed, refusing to publish" >&2
  exit 1
fi
SHA=$(sha256sum "dist/${EXE}" | cut -d' ' -f1)
echo "   ${EXE}: ${SIZE} bytes, sha256 ${SHA}"

echo "==> 4/7 refresh every feed from the artifact that was just built"
# ONE writer on purpose. This used to be two: a node one-liner wrote dist/launcher.json
# with all-latest URLs, then update-site.js wrote site/launcher.json with a pinned url,
# and step 7 copied the dist shape over the site one. The two disagreed, and the docs/
# copies - which are the launcher's PRIMARY feed on GitHub Pages - were never written
# at all. That is how the live feed ended up announcing 1.2.5 while its own mirror list
# still named the 1.2.4 installer, turning the fallback into a guaranteed sha256 failure.
node scripts/update-site.js "$VER" "$SHA" "$SIZE" "$NOTES"
# The MOD's own feed is derived from vendor/*.jar, not from this installer's version:
# the two move independently, and a feed that announced the launcher's version would
# tell every installed mod to "update" to a jar that does not exist.
node scripts/update-mod-feed.js
mkdir -p dist
cp site/index.html site/download.html site/_redirects \
   site/launcher.json site/launcher-site.json site/voidfps.json dist/

echo "==> 5/7 publish the GitHub release (installer + manifests)"
# launcher.json must be a RELEASE ASSET: updater.js falls back to
# releases/latest/download/launcher.json when the Pages feed is unreachable, and that
# fallback 404s for as long as the manifest is not attached. Same for the mod's
# voidfps.json, whose fallback URL points at this release's asset list.
gh release create "$TAG" "dist/${EXE}" dist/launcher.json dist/launcher-site.json dist/voidfps.json \
  --title "VOID Client ${VER}" --notes "$NOTES" || \
  gh release upload "$TAG" "dist/${EXE}" dist/launcher.json dist/launcher-site.json dist/voidfps.json --clobber

echo "==> 6/7 deploy the site (Cloudflare Pages)"
# Project name is `void-client`; "-c8q" is only the subdomain Cloudflare assigned to it
# because void-client.pages.dev was already taken:
#   GET /accounts/<id>/pages/projects -> name: void-client, subdomain: void-client-c8q.pages.dev
# The site had been stuck on an old build because this step never ran to completion, not
# because it targeted the wrong project.
npx wrangler@latest pages deploy site \
  --project-name="${PAGES_PROJECT:-void-client}" --branch=main

echo "==> 7/7 publish the GitHub Pages copy (the launcher's PRIMARY feed)"
# docs/ is served at mitsuohiroshi927-png.github.io/void-client/ and is what
# settings.js updateUrl points at. Nothing regenerated or committed it before, so it
# was always one hand-edit behind. update-site.js has already rewritten it in place.
if [ -n "$(git status --porcelain docs)" ]; then
  git add docs/launcher.json docs/launcher-site.json docs/voidfps.json docs/index.html docs/download.html
  git commit -m "docs: site and launcher manifest ${VER}"
  git push
  echo "   docs/ pushed -> GitHub Pages feed is live"
else
  echo "   docs/ already current, nothing to push"
fi

cat <<EOF

Done. Verify before announcing:
  curl -s https://mitsuohiroshi927-png.github.io/void-client/launcher.json | head -12
  curl -s https://github.com/mitsuohiroshi927-png/void-client/releases/latest/download/launcher.json | head -6
  curl -sI https://void-client-c8q.pages.dev/${EXE} | head -3   # expect 302 -> 200
  curl -s  https://void-client-c8q.pages.dev/ | grep -o "Version [0-9.]*" | head -1
EOF

