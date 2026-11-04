#!/usr/bin/env bash
# repack-asar.sh — fast iteration path for the packaged app: repack app.asar
# from current source and drop it into dist/win-unpacked, without running the
# whole electron-builder pipeline (which needs NSIS from GitHub).
#
#   ./scripts/repack-asar.sh
#
# For a real release, use `npm run dist:portable` instead — that also handles
# extraResources (python/runtime), the installer, and signing.
set -euo pipefail
cd "$(dirname "$0")/.."

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
RES=dist/win-unpacked/resources

echo "==> staging app source (tests excluded)"
mkdir -p "$STAGE/app"
for d in main harness renderer memory; do cp -r "app/$d" "$STAGE/app/"; done
rm -rf "$STAGE/app/harness/test" "$STAGE/app/renderer/test"
find "$STAGE" -name __pycache__ -type d -exec rm -rf {} + 2>/dev/null || true
cp package.json config.example.toml "$STAGE/"

# native module: kept unpacked at runtime (asarUnpack in package.json), and its
# prebuilds are byte-identical between builds, so only the asar itself changes.
mkdir -p "$STAGE/node_modules"
cp -r node_modules/better-sqlite3 "$STAGE/node_modules/"

echo "==> packing asar"
./node_modules/.bin/asar pack --unpack-dir node_modules/better-sqlite3 \
  "$STAGE" "$STAGE/app-new.asar"

if [ ! -d "$RES" ]; then
  echo "no $RES — run 'npm run dist:dir' once to produce it" >&2
  exit 1
fi

echo "==> swapping into $RES"
cp "$STAGE/app-new.asar" "$RES/app.asar"
# template.toml is an extraResource, not part of the asar — it seeds
# ~/.muse-agent/config.toml on first run, so it must be refreshed too or new
# installs keep the defaults from whenever the dir was last built.
cp config.example.toml "$RES/template.toml"
# The unpacked tree MUST be refreshed with the asar: members flagged unpacked
# in the header are read from here, so a missing or stale dir means
# better-sqlite3's native binary can't load and the app dies at startup.
# Never swallow this copy — a Windows file lock leaves the tree half-swapped.
rm -rf "$RES/app.asar.unpacked"
cp -r "$STAGE/app-new.asar.unpacked" "$RES/app.asar.unpacked"

echo "==> verifying shipped asar"
# full extract, not extract-file: piping single-file extraction to stdout has
# been observed to emit nothing even when the member is present and correct.
rm -rf "$STAGE/verify"
./node_modules/.bin/asar extract "$RES/app.asar" "$STAGE/verify" >/dev/null 2>&1 || true
echo "session.js jsonl markers:     $(grep -c jsonlFile "$STAGE/verify/app/harness/session.js" 2>/dev/null || echo 0)"
echo "hands_client bundledPython:   $(grep -c bundledPython "$STAGE/verify/app/harness/hands_client.js" 2>/dev/null || echo 0)"
echo "agent.js saveSummary:         $(grep -c saveSummary "$STAGE/verify/app/harness/agent.js" 2>/dev/null || echo 0)"
echo "test dirs excluded:           $(ls "$STAGE/verify/app/harness/" 2>/dev/null | grep -c '^test$')"
# template.toml seeds first-run config; report the memory default it will install
awk -v q='[memory]' '/^\[/{s=$0} /^enabled/{if(s==q)print "template memory default:     " $3}' \
  "$RES/template.toml" 2>/dev/null || echo "template.toml missing"

# The native binary must survive the swap: better-sqlite3 is flagged unpacked in
# the asar header, so it loads from app.asar.unpacked/, NOT from inside the
# archive. A missing/locked dir here means the app dies at startup.
NATIVE="$RES/app.asar.unpacked/node_modules/better-sqlite3/prebuilds/win32-x64.node"
if [ -f "$NATIVE" ]; then
  printf "native better_sqlite3:        %s bytes\n" "$(stat -c%s "$NATIVE" 2>/dev/null || stat -f%z "$NATIVE")"
else
  echo "FATAL: native binary missing at $NATIVE" >&2
  echo "       the asar marks better-sqlite3 unpacked; the app cannot start without it." >&2
  exit 1
fi

# The packaged version must match package.json. If it drifts, the app self-reports
# a different version than the release it is tagged under, so the updater offers
# the same build as an update forever. Same-length version strings also defeat any
# size-only copy downstream, so check by content.
PKG_VER=$(node -e "process.stdout.write(require('./package.json').version)")
ASAR_VER=$(node -e "process.stdout.write(require('$STAGE/verify/package.json').version)")
if [ "$PKG_VER" = "$ASAR_VER" ]; then
  echo "packaged version:             $ASAR_VER"
else
  echo "FATAL: asar version $ASAR_VER != package.json $PKG_VER" >&2
  echo "       bump the version BEFORE packing, or the updater will loop." >&2
  exit 1
fi
ls -la "$RES/app.asar" | awk '{print "app.asar bytes:", $5}'
echo "done."
