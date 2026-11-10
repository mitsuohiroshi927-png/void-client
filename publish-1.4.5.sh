#!/bin/sh
# Rilis VOID Client 1.4.5 (perf: zero-alloc HUD hot path mod + Windows argfile fallback).
# Butuh: gh sudah login (gh auth login) atau GH_TOKEN di environment.
set -eu
cd /root/void-client

if ! gh auth status >/dev/null 2>&1; then
  if [ -z "${GH_TOKEN:-}" ]; then
    echo "gh belum login. Jalankan: gh auth login   (atau export GH_TOKEN=...)" >&2
    exit 1
  fi
fi

# gh reads GH_TOKEN but git does not; supply it as a one-shot askpass (same trick as release.sh step 7).
printf '#!/bin/sh\ncase "$1" in *[Uu]sername*) echo x-access-token;; *) echo "%s";; esac\n' "$GH_TOKEN" > /tmp/ap-145.sh
chmod 700 /tmp/ap-145.sh
GIT_ASKPASS=/tmp/ap-145.sh git -c core.askPass=/tmp/ap-145.sh push origin main
rm -f /tmp/ap-145.sh
gh release create v1.4.5 \
  "dist/VOID-Client-1.4.5-Setup.exe#Windows installer" \
  "dist/VOID-Client-1.4.5-x86_64.AppImage#Linux AppImage" \
  "dist/VOID-Client-1.4.5-hot.tar.gz#Hot-swap payload (app.asar + vendor)" \
  "site/launcher.json#Manifest launcher" \
  "site/launcher-site.json#Manifest situs" \
  "vendor/void-client-1.4.5.jar#Mod jar 1.4.5" \
  --title "VOID Client 1.4.5" \
  --notes "Perf lintas spek device: HUD hot path mod zero-allocation (EQUIPMENT_SLOTS hoisted, hudStr tanpa lambda/boxing per frame), launcher Windows argfile fallback (classpath modpack besar >32k char), GC adaptif 3 jalur, RAM-aware presets. Feed mod: void-client-1.4.5.jar sha256 193305b586aa3cc89a716f3545390f893faa14bf6a2d34b54eac847805ba8663."

echo "--- verifikasi"
sleep 5
curl -sL -o /tmp/hot_check.tar.gz https://github.com/mitsuohiroshi927-png/void-client/releases/latest/download/VOID-Client-1.4.5-hot.tar.gz
echo "sha256 unduhan: $(sha256sum /tmp/hot_check.tar.gz | cut -d' ' -f1)"
curl -sL https://github.com/mitsuohiroshi927-png/void-client/releases/download/v1.4.5/void-client-1.4.5.jar -o /tmp/jar_check.jar
echo "sha256 mod jar: $(sha256sum /tmp/jar_check.jar | cut -c1-16)..."
echo "harus sama  : 193305b586aa3cc8..."
curl -sL https://mitsuohiroshi927-png.github.io/void-client/launcher.json | head -c 120; echo
