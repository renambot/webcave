#!/usr/bin/env bash
#
# Launch one kiosk-mode Chrome per WebCAVE render node, each on its own display.
#
# Browsers only enter fullscreen from a user gesture, so an unattended node
# must be started by the browser itself in kiosk mode. Each node gets its own
# Chrome profile directory so the instances are independent processes.
#
# Usage:
#   scripts/launch-nodes.sh [options]
#
# Options:
#   --nodes a,b,c        node ids to launch            (default: front,left,right,floor)
#                        "node:view" launches one window of a multi-screen node
#                        (e.g. pc:front,pc:left), matching node.html?node=pc&view=front
#   --server URL         page server (Vite or built)  (default: http://localhost:5173)
#   --manager URL        manager WebSocket            (default: ws://localhost:8765)
#   --width N --height N window size in pixels        (default: 1920 x 1080)
#   --positions "x,y ..."  one x,y per node; default lays them out left to right by --width
#   --stereo MODE        append &stereo=MODE to every node URL
#   --anaglyph SCHEME    append &anaglyph=SCHEME (dubois | bw) to every node URL
#   --chrome PATH        Chrome / Chromium executable
#   --profile-dir DIR    base dir for per-node profiles (default: ${TMPDIR:-/tmp}/webcave-nodes)
#   --kill               stop every node launched by this script and exit
#   --dry-run            print the commands without running them
#   -h, --help
#
# Examples:
#   scripts/launch-nodes.sh
#   scripts/launch-nodes.sh --nodes tile0,tile1,tile2 --positions "0,0 1920,0 3840,0"
#   scripts/launch-nodes.sh --nodes left --server http://192.168.1.10:5173 --manager ws://192.168.1.10:8765
#   scripts/launch-nodes.sh --kill

set -euo pipefail

NODES="front,left,right,floor"
SERVER="http://localhost:5173"
MANAGER="ws://localhost:8765"
WIDTH=1920
HEIGHT=1080
POSITIONS=""
STEREO=""
CHROME=""
PROFILE_BASE="${TMPDIR:-/tmp}"
PROFILE_BASE="${PROFILE_BASE%/}/webcave-nodes"
KILL=0
DRY=0

usage() { sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --nodes) NODES="$2"; shift 2 ;;
    --server) SERVER="$2"; shift 2 ;;
    --manager) MANAGER="$2"; shift 2 ;;
    --width) WIDTH="$2"; shift 2 ;;
    --height) HEIGHT="$2"; shift 2 ;;
    --positions) POSITIONS="$2"; shift 2 ;;
    --stereo) STEREO="$2"; shift 2 ;;
    --anaglyph) ANAGLYPH="$2"; shift 2 ;;
    --chrome) CHROME="$2"; shift 2 ;;
    --profile-dir) PROFILE_BASE="$2"; shift 2 ;;
    --kill) KILL=1; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage; exit 2 ;;
  esac
done

PROFILE_BASE="${PROFILE_BASE%/}"

if [[ $KILL -eq 1 ]]; then
  # Every instance we started carries its profile dir on the command line.
  if pgrep -f -- "--user-data-dir=${PROFILE_BASE}/" >/dev/null 2>&1; then
    pkill -f -- "--user-data-dir=${PROFILE_BASE}/" || true
    echo "stopped nodes using profiles under ${PROFILE_BASE}"
  else
    echo "no running nodes found under ${PROFILE_BASE}"
  fi
  exit 0
fi

# Find a browser.
if [[ -z "$CHROME" ]]; then
  candidates=(
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    "/Applications/Chromium.app/Contents/MacOS/Chromium"
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
    google-chrome google-chrome-stable chromium chromium-browser microsoft-edge
  )
  for c in "${candidates[@]}"; do
    if [[ -x "$c" ]] || command -v "$c" >/dev/null 2>&1; then CHROME="$c"; break; fi
  done
fi
if [[ -z "$CHROME" ]]; then
  echo "no Chrome/Chromium found; pass --chrome PATH" >&2
  exit 1
fi

IFS=',' read -r -a node_list <<< "$NODES"
read -r -a pos_list <<< "$POSITIONS"

mkdir -p "$PROFILE_BASE"

i=0
for node in "${node_list[@]}"; do
  node="${node// /}"
  [[ -z "$node" ]] && continue

  if [[ ${#pos_list[@]} -gt $i ]]; then
    pos="${pos_list[$i]}"
  else
    pos="$((i * WIDTH)),0"
  fi

  # "pc:front" -> node pc, view front
  view=""
  if [[ "$node" == *:* ]]; then
    view="${node#*:}"
    node="${node%%:*}"
  fi

  url="${SERVER%/}/node.html?node=${node}&manager=${MANAGER}"
  [[ -n "$view" ]] && url="${url}&view=${view}"
  [[ -n "$STEREO" ]] && url="${url}&stereo=${STEREO}"
  [[ -n "$ANAGLYPH" ]] && url="${url}&anaglyph=${ANAGLYPH}"

  profile="${PROFILE_BASE}/${node}${view:+-$view}"

  cmd=(
    "$CHROME"
    --kiosk
    --new-window
    --no-first-run
    --no-default-browser-check
    --noerrdialogs
    --disable-infobars
    --disable-session-crashed-bubble
    --disable-features=TranslateUI
    --autoplay-policy=no-user-gesture-required
    --user-data-dir="$profile"
    --window-position="$pos"
    --window-size="${WIDTH},${HEIGHT}"
    --app="$url"
  )

  echo "node ${node}${view:+ view $view}: position ${pos}  ->  ${url}"
  if [[ $DRY -eq 0 ]]; then
    "${cmd[@]}" >/dev/null 2>&1 &
    disown || true
    sleep 0.3
  else
    printf '  %q' "${cmd[@]}"; echo
  fi
  i=$((i + 1))
done

if [[ $DRY -eq 0 ]]; then
  echo "launched ${i} node(s). Stop them with: $0 --kill --profile-dir '${PROFILE_BASE}'"
fi
