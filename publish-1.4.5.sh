#!/bin/sh
# Rilis VOID Client 1.4.5 (fix banner .upd-bar[hidden]).
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
  "vendor/void-client-1.4.4.jar#Mod jar 1.4.4" \
  --title "VOID Client 1.4.5" \
  --notes "Fix banner update idle: .upd-bar[hidden] tidak lagi ditimpa display:flex. Build config dipulihkan."

echo "--- verifikasi"
sleep 5
curl -sL -o /tmp/hot_check.tar.gz https://github.com/mitsuohiroshi927-png/void-client/releases/latest/download/VOID-Client-1.4.5-hot.tar.gz
echo "sha256 unduhan: $(sha256sum /tmp/hot_check.tar.gz | cut -d' ' -f1)"
echo "harus sama  : 8489d3ec10a026294435ff54cf91e0ee782767be67fb26d8f921e97a3a9abeea"
curl -sL https://mitsuohiroshi927-png.github.io/void-client/launcher.json | head -c 120; echo
