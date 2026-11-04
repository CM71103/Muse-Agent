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
# the unpacked native tree is content-addressed by build; refresh it only when
# better-sqlite3 actually changed (Windows may hold a lock on the .node files)
rm -rf "$RES/app.asar.unpacked" 2>/dev/null || \
  echo "    (unpacked dir partially locked — prebuilds are unchanged, safe to ignore)"
cp -r "$STAGE/app-new.asar.unpacked" "$RES/" 2>/dev/null || true

echo "==> verifying shipped asar"
# full extract, not extract-file: piping single-file extraction to stdout has
# been observed to emit nothing even when the member is present and correct.
rm -rf "$STAGE/verify"
./node_modules/.bin/asar extract "$RES/app.asar" "$STAGE/verify" >/dev/null 2>&1 || true
echo "session.js jsonl markers:     $(grep -c jsonlFile "$STAGE/verify/app/harness/session.js" 2>/dev/null || echo 0)"
echo "hands_client bundledPython:   $(grep -c bundledPython "$STAGE/verify/app/harness/hands_client.js" 2>/dev/null || echo 0)"
echo "agent.js saveSummary:         $(grep -c saveSummary "$STAGE/verify/app/harness/agent.js" 2>/dev/null || echo 0)"
echo "test dirs excluded:           $(ls "$STAGE/verify/app/harness/" 2>/dev/null | grep -c '^test$')"
ls -la "$RES/app.asar" | awk '{print "app.asar bytes:", $5}'
echo "done."
