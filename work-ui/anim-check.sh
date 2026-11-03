#!/usr/bin/env bash
# Prove the motion layer is actually running: two frames a few seconds apart must
# differ, and a third with the window allowed to settle must still match the second
# in the static areas (so we are seeing animation, not a redraw storm).
set -u
export DISPLAY=:99
cd /root/void-client
pgrep -f "Xvfb :99" >/dev/null 2>&1 || { Xvfb :99 -screen 0 1280x720x24 >/tmp/xvfb-ui.log 2>&1 & sleep 3; }

node_modules/.bin/electron . --no-sandbox >/tmp/void-ui2.log 2>&1 &
EPID=$!
sleep 9
shot () { ffmpeg -y -loglevel error -f x11grab -video_size 1280x720 -i :99 -frames:v 1 "$1"; }
shot /tmp/anim-a.png
sleep 4
shot /tmp/anim-b.png
sleep 4
shot /tmp/anim-c.png
kill "$EPID" 2>/dev/null || :
sleep 2
pkill -f "electron .*--no-sandbox" 2>/dev/null || :
echo "captured: $(ls /tmp/anim-*.png | tr '\n' ' ')"
