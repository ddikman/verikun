#!/usr/bin/env bash
# Capture the fixture's Device state screen under each `vk device set` value, as
# evidence that a device setting actually reached the app.
#
# Usage:  scripts/capture-device-screens.sh <out-dir> <label> [vk global flags...]
#   scripts/capture-device-screens.sh .context/shots pixel6 --device emulator-5554
#   scripts/capture-device-screens.sh .context/shots ios    --ios
#
# <out-dir> must be inside the repo: `vk screenshot --out` refuses to write outside
# the working directory. Shots use vk's default downscale (700px longest edge), which
# is what the committed fixture screenshots already use.
#
# Every setting it applies is snapshotted by `vk device set` and undone by the
# `device reset` in the trap, so an interrupted run still leaves the device as found.
set -euo pipefail

OUT=$1; LABEL=$2; shift 2
VK=(node dist/bin/verikun.js "$@")
APP=dev.verikun.testapp

mkdir -p "$OUT"
cleanup() { "${VK[@]}" device reset >/dev/null 2>&1 || true; }
trap cleanup EXIT

# The value one Device state line currently shows. A Flutter label lands in `desc` on
# Android and `text` on iOS, so read whichever is populated.
line_value() {
  "${VK[@]}" find "@$1" --json 2>/dev/null | python3 -c '
import sys, json
els = json.load(sys.stdin) or [{}]
print(els[0].get("desc") or els[0].get("text") or "")'
}

# Block until a line stops showing `$2`. `vk device set` returns as soon as the
# SETTING is verified, but the app still has to receive the configuration change and
# rebuild — screenshotting straight after catches the old frame and produces evidence
# that shows the opposite of what it claims. (That is exactly what happened first try.)
wait_change() {
  local id=$1 previous=$2 current
  for _ in $(seq 1 40); do
    current=$(line_value "$id")
    if [ "$current" != "$previous" ]; then
      echo "    @$id: '$previous' -> '$current'"
      return 0
    fi
    sleep 0.25
  done
  echo "  TIMED OUT waiting for @$id to change from '$previous'" >&2
  return 1
}

# Let the theme crossfade finish before capturing. wait_change already proves the app
# received the change, but Flutter animates the theme transition (and iOS adds its own
# appearance crossfade), so a shot taken the instant the value flips catches a
# half-faded grey frame — technically correct, useless as evidence.
SETTLE_S=${VK_SHOT_SETTLE_S:-2}
shot() {
  sleep "$SETTLE_S"
  "${VK[@]}" screenshot --out "$OUT/$LABEL-$1.png" >/dev/null
  echo "  captured $LABEL-$1.png"
}

echo "[$LABEL] opening the Device state screen"
"${VK[@]}" launch "$APP" >/dev/null
"${VK[@]}" assert @vk_home --wait 20s >/dev/null
"${VK[@]}" tap @vk_nav_device --wait 10s >/dev/null
"${VK[@]}" assert @vk_device --wait 10s >/dev/null

shot baseline
brightness0=$(line_value vk_dev_brightness)
scale0=$(line_value vk_dev_textscale)

echo "[$LABEL] dark=on"
"${VK[@]}" device set dark=on >/dev/null
wait_change vk_dev_brightness "$brightness0"
shot dark

echo "[$LABEL] font-scale=1.3"
"${VK[@]}" device set font-scale=1.3 >/dev/null
wait_change vk_dev_textscale "$scale0"
shot fontscale

# Ask the capability table whether rotation works here, rather than hard-coding a
# platform check — iOS refuses it with exit 3 and would abort the capture.
supports_rotation() {
  "${VK[@]}" device caps --json | python3 -c '
import sys, json
caps = json.load(sys.stdin)["settings"]
rotation = next(c for c in caps if c["key"] == "rotation")
sys.exit(0 if rotation["support"] == "supported" else 1)'
}

if supports_rotation; then
  echo "[$LABEL] rotation=landscape"
  orientation0=$(line_value vk_dev_orientation)
  "${VK[@]}" device set rotation=landscape >/dev/null
  wait_change vk_dev_orientation "$orientation0"
  shot landscape
fi

echo "[$LABEL] device reset"
"${VK[@]}" device reset >/dev/null
# Wait for the app to be back at the value it started on — that is both the restore
# check and the guard against screenshotting a stale frame.
"${VK[@]}" assert "@vk_dev_brightness" --text "$brightness0" --wait 15s >/dev/null
echo "    @vk_dev_brightness restored to '$brightness0'"
shot restored
