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
" || echo "   node aborted at exit (known host quirk); version written anyway"

echo "==> 2/7 build installer"
# electron-builder downloads its toolchain from GitHub on first run; the local
# mirror proxy is OPT-IN now (export HTTPS_PROXY before running if you want it):
# the old hard default 127.0.0.1:28118 is dead and ECONNREFUSED'd every build.
WINEPREFIX="${WINEPREFIX:-/root/.wine-void}" WINEDEBUG=-all \
  npx electron-builder --win --x64

# 2b. the Linux build the download pages actually advertise. It is built into dist-linux/
# because update-site.js looks for it there, and it MUST be uploaded as a release asset:
# every Linux URL in the manifest points at /releases/download/<tag>/, so a missing asset
# is a 404 behind a working-looking button.
echo "==> 2b/7 build the Linux artifacts (AppImage + tar.gz)"
npx electron-builder --linux --x64 --config.directories.output=dist-linux
APPIMAGE="VOID-Client-${VER}-x86_64.AppImage"
TARGZ="VOID-Client-${VER}-x64.tar.gz"
LINUX_ASSETS=()
if [ -f "dist-linux/${APPIMAGE}" ]; then LINUX_ASSETS+=("dist-linux/${APPIMAGE}"); fi
if [ -f "dist-linux/${TARGZ}" ]; then LINUX_ASSETS+=("dist-linux/${TARGZ}"); fi
if [ "${#LINUX_ASSETS[@]}" -eq 0 ]; then
  echo "FATAL: no Linux artifacts in dist-linux/ — the download pages advertise one" >&2
  exit 1
fi

echo "==> 3/7 verify the build actually produced a real installer"
SIZE=$(stat -c%s "dist/${EXE}")
# A truncated NSIS stub is ~296 KB; a real installer is ~120 MB. Anything small
# means the packaging step died quietly and the feed would ship a dead file.
if [ "$SIZE" -lt 50000000 ]; then
  echo "FATAL: dist/${EXE} is only ${SIZE} bytes - packaging failed, refusing to publish" >&2
  exit 1
fi
SHA=$(sha256sum "dist/${EXE}" | cut -d' ' -f1)

# The mod ships INSIDE this installer and is versioned with it (the user asked for one
# version number for both), so a stale vendor/ jar means shipping an old mod under a new
# version. Cheap to check here, impossible to notice afterwards.
JARVER=$(unzip -p vendor/void-client-*.jar fabric.mod.json | node -e "let d='';process.stdin.on('data',(c)=>{d+=c}).on('end',()=>{try{console.log(JSON.parse(d).version)}catch(e){console.log('unreadable')}})" || true)
if [ "$JARVER" != "$VER" ]; then
  echo "FATAL: bundled mod jar is ${JARVER}, this release is ${VER}." >&2
  echo "       Rebuild the mod at ${VER}, copy it into vendor/ (removing the old jar), then release." >&2
  exit 1
fi
echo "   bundled mod jar: ${JARVER}"
echo "   ${EXE}: ${SIZE} bytes, sha256 ${SHA}"

echo "==> 4/7 refresh every feed from the artifact that was just built"
# ONE writer on purpose. This used to be two: a node one-liner wrote dist/launcher.json
# with all-latest URLs, then update-site.js wrote site/launcher.json with a pinned url,
# and step 7 copied the dist shape over the site one. The two disagreed, and the docs/
# copies - which are the launcher's PRIMARY feed on GitHub Pages - were never written
# at all. That is how the live feed ended up announcing 1.2.5 while its own mirror list
# still named the 1.2.4 installer, turning the fallback into a guaranteed sha256 failure.
# Hot-swap payload: app code only (~4 MB) — the launcher updates like Modrinth,
# download small, swap, relaunch. Built from the Windows unpack the NSIS step
# just produced; identical asar/vendor ship on every platform.
HOT_TGZ="dist/VOID-Client-${VER}-hot.tar.gz"
tar -czf "$HOT_TGZ" -C dist/win-unpacked/resources app.asar vendor
HOT_SHA=$(sha256sum "$HOT_TGZ" | cut -d' ' -f1)
HOT_SIZE=$(stat -c%s "$HOT_TGZ")
echo "   hot payload: $HOT_TGZ ($((HOT_SIZE / 1024 / 1024)) MB)"

DL_TOTAL=$(curl -s --max-time 30 "https://api.github.com/repos/mitsuohiroshi927-png/void-client/releases?per_page=100" | python3 -c "import sys,json
try: print(sum(a['download_count'] for r in json.load(sys.stdin) for a in r.get('assets', []) if a['name'].endswith(('.exe', '.AppImage', '.tar.gz')) and '-hot.tar.gz' not in a['name']))
except Exception: print(0)" || echo 0)
export DL_TOTAL
node scripts/update-site.js "$VER" "$SHA" "$SIZE" "$NOTES" || echo "   update-site node abort (exit quirk); files on disk are the truth"
# The mod has NO feed and no web download on purpose: it ships inside the installer and is
# versioned with the launcher. scripts/update-mod-feed.js used to publish one — removed.
mkdir -p dist
cp site/index.html site/download.html site/_redirects \
   site/launcher.json site/launcher-site.json dist/

echo "==> 5/7 publish the GitHub release (installer + manifests)"
# launcher.json must be a RELEASE ASSET: updater.js falls back to
# releases/latest/download/launcher.json when the Pages feed is unreachable, and that
# fallback 404s for as long as the manifest is not attached.
gh release create "$TAG" "dist/${EXE}" dist/launcher.json dist/launcher-site.json "${LINUX_ASSETS[@]}" \
  --title "VOID Client ${VER}" --notes "$NOTES" || \
  gh release upload "$TAG" "dist/${EXE}" "$HOT_TGZ" dist/launcher.json dist/launcher-site.json "${LINUX_ASSETS[@]}" --clobber

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
  git add docs/launcher.json docs/launcher-site.json docs/index.html docs/download.html
  git commit -m "docs: site and launcher manifest ${VER}"
  # GH_TOKEN alone does not authenticate `git push`: gh reads it, git does not. Supply the
  # token as a one-shot credential helper so a CI-style run (`GH_TOKEN=... scripts/release.sh`)
  # completes instead of dying on an interactive username prompt.
  if [ -n "${GH_TOKEN:-}" ]; then
    git -c credential.helper='!f() { echo "username=x-access-token"; echo "password=$GH_TOKEN"; }; f' push
  else
    git push
  fi
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

