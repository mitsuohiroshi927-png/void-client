#!/usr/bin/env bash
# Boot the launcher headlessly, capture each view, and report console errors.
set -u
export DISPLAY=:99
cd /root/void-client

pgrep -f "Xvfb :99" >/dev/null 2>&1 || { Xvfb :99 -screen 0 1280x720x24 >/tmp/xvfb-ui.log 2>&1 & sleep 3; }

LOG=/tmp/void-ui.log
: > "$LOG"
node_modules/.bin/electron . --no-sandbox > "$LOG" 2>&1 &
EPID=$!

# Wait for the first paint of the rail (Play view).
for _ in $(seq 1 40); do
  grep -qE "ready|Content-Security|listening" "$LOG" && break
  sleep 1
done
sleep 6

shot () { ffmpeg -y -loglevel error -f x11grab -video_size 1280x720 -i :99 -frames:v 1 "$1"; }

shot /tmp/ui-1-home.png
for v in mods profiles settings; do
  case $v in mods) y=200 ;; profiles) y=245 ;; settings) y=290 ;; esac
  xdotool mousemove 110 "$y" click 1 2>/dev/null || :
  sleep 2
  shot "/tmp/ui-$v.png"
done

kill "$EPID" 2>/dev/null || :
sleep 2
pkill -f "electron .*--no-sandbox" 2>/dev/null || :

echo "===== SCREENSHOTS ====="
ls -la /tmp/ui-*.png 2>/dev/null
echo "===== CONSOLE (error/warn saja) ====="
grep -iE "error|warn|fail|uncaught|refused" "$LOG" | grep -viE "GPU|dbus|libva|Fontconfig|gbm|Vulkan|sandbox|DevTools|Autofill|deprecat" | head -15
echo "===== ADA CRASH? ====="
grep -icE "uncaught|fatal|SIGTRAP|sigsegv" "$LOG"
