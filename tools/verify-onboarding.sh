#!/bin/bash
# Headless proof for 1.2.11: fresh profile must show the onboarding wizard.
set -uo pipefail
RL=v1.2.11
cd /root/void-client || exit 1

# scratch user + fresh app data
userdel -r voidtest 2>/dev/null || true
useradd -m voidtest
pkill -f '[X]vfb :98' 2>/dev/null; sleep 1
Xvfb :98 -screen 0 1280x720x24 -ac -nolisten tcp &
XVFB_PID=$!
sleep 2
rm -rf /home/voidtest/lu
cp -r dist-linux/linux-unpacked /home/voidtest/lu
chmod -R a+rX /home/voidtest/lu
chmod 4755 /home/voidtest/lu/chrome-sandbox 2>/dev/null

# launch on the virtual display, fresh userData (no launcher.json → onboarded=false)
su - voidtest -c "DISPLAY=:98 HOME=/home/voidtest /home/voidtest/lu/void-client --no-sandbox --disable-gpu >/dev/null 2>&1 &"
sleep 12
ffmpeg -y -loglevel error -f x11grab -video_size 1180x720 -i :98+50,0 -frames:v 1 /tmp/onb-1-language.png
xdotool mousemove 160 200 click 1   # play rail top — not needed, keep for parity
# click "Bahasa Indonesia" row (grid 2x2, second cell) then Continue → account step
xdotool mousemove 830 470 click 1
sleep 2
ffmpeg -y -loglevel error -f x11grab -video_size 1180x720 -i :98+50,0 -frames:v 1 /tmp/onb-2-picked.png
xdotool mousemove 900 655 click 1   # Continue
sleep 2
ffmpeg -y -loglevel error -f x11grab -video_size 1180x720 -i :98+50,0 -frames:v 1 /tmp/onb-3-account.png
# config must now carry the language choice once we finished (check after clicking Skip: bottom ghost button)
xdotool mousemove 1010 655 click 1   # Skip for now
sleep 4
CFG=$(find /home/voidtest/.config -name launcher.json -path '*void*' 2>/dev/null | head -1)
echo "CFG=$CFG"
[ -n "$CFG" ] && python3 -c "import json;d=json.load(open('$CFG'));print('lang=',d.get('lang'),'onboarded=',d.get('onboarded'))"
kill $XVFB_PID 2>/dev/null
pkill -u voidtest -f 'lu/void-client' 2>/dev/null
echo SCREENSHOTS: /tmp/onb-1-language.png /tmp/onb-2-picked.png /tmp/onb-3-account.png
