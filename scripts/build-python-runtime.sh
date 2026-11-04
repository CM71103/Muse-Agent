#!/usr/bin/env bash
# build-python-runtime.sh — produce the self-contained Python runtime that the
# portable exe ships in resources/python/runtime. Windows x64 only; run it in
# WSL/Git-Bash/a Linux VM (downloads win_amd64 wheels, never executes them).
#
#   ./scripts/build-python-runtime.sh
#
# Output: python/runtime/{python.exe,Lib/site-packages/...}  (gitignored)
# Idempotent: wipes and rebuilds python/runtime each run.
#
# Builds in a scratch dir and copies the tree over once: ~30k small files
# written one at a time is minutes slower on a Windows mount than one `cp -a`.
set -euo pipefail
cd "$(dirname "$0")/.."

PYVER=3.12.8
OUT=python/runtime
BUILD=$(mktemp -d)
trap 'rm -rf "$BUILD"' EXIT
RT="$BUILD/runtime"

mkdir -p "$RT/Lib/site-packages"

echo "==> downloading Python $PYVER embeddable (amd64)"
curl -sL --max-time 300 -o "$BUILD/py.zip" \
  "https://www.python.org/ftp/python/$PYVER/python-$PYVER-embed-amd64.zip"
unzip -q "$BUILD/py.zip" -d "$RT"

# Embeddable Python ignores site-packages unless ._pth says so. Keep it
# explicit rather than shipping pip: nothing here needs to install at runtime.
cat > "$RT/python312._pth" <<'EOF'
python312.zip
.
Lib\site-packages
import site
EOF

echo "==> downloading win_amd64 wheels"
# OCR: rapidocr + onnxruntime + opencv are the bulk of the tree.
python3 -m pip download --only-binary=:all: --platform win_amd64 \
  --python-version 3.12 --no-deps -d "$BUILD/wheels" -q \
  rapidocr-onnxruntime onnxruntime opencv-python-headless numpy pillow \
  shapely pyclipper pyyaml protobuf packaging six tqdm flatbuffers
# Hands: pyautogui + mss. Two passes because pygetwindow/mouseinfo are gated on
# sys_platform=="win32" — pip only resolves them when a platform is given. No
# --only-binary here: pyautogui's helpers ship as pure-python sdists.
python3 -m pip download --no-deps --platform win_amd64 --python-version 3.12 \
  -d "$BUILD/wheels" -q \
  pyautogui pymsgbox pyrect pyperclip pyscreeze pygetwindow mouseinfo pytweening mss
# Deliberate omissions:
#   aiohttp — server.py has a stdlib http.server fallback; skipping it drops six
#     compiled wheels for a feature we don't use.
#   opencv-python — 44 MB with GUI libs; opencv-python-headless is the same OCR
#     engine without them.

echo "==> installing wheels + sdists"
python3 - "$RT/Lib/site-packages" "$BUILD/wheels" <<'PY'
import sys, os, glob, zipfile, tarfile, shutil, tempfile
dest, wheel_dir = sys.argv[1], sys.argv[2]

for whl in sorted(glob.glob(os.path.join(wheel_dir, "*.whl"))):
    with zipfile.ZipFile(whl) as z:
        z.extractall(dest)          # wheel == zip of site-packages layout

# Pure-python sdists (pyautogui, pyscreeze, pygetwindow, mouseinfo, ...) need no
# build step: copy the importable package dirs out of the archive. Some use the
# src/ layout, some don't — descend into src/ when it holds the packages.
# Metadata and packaging files stay behind: dead weight in the shipped tree.
JUNK = {"setup.py", "setup.cfg", "pyproject.toml", "MANIFEST.in", "PKG-INFO",
        "README.md", "README.rst", "LICENSE", "LICENSE.txt", "CHANGELOG.md",
        "AUTHORS.txt", "docs", "tests", "test", "CHANGELOG", "THANKS"}

def is_importable(name, path):
    if name in JUNK or name.endswith((".egg-info", ".dist-info", ".data")):
        return False
    return os.path.isdir(path) or name.endswith(".py")

scratch = tempfile.mkdtemp()
for sd in sorted(glob.glob(os.path.join(wheel_dir, "*.tar.gz"))):
    here = tempfile.mkdtemp(dir=scratch)
    with tarfile.open(sd) as t:
        t.extractall(here)
    roots = [d for d in os.listdir(here) if os.path.isdir(os.path.join(here, d))]
    if len(roots) != 1:
        raise SystemExit(f"unexpected sdist layout in {sd}: {roots}")
    src_root = os.path.join(here, roots[0])
    # src/ layout: the real packages live one level down
    src_dir = os.path.join(src_root, "src")
    if os.path.isdir(src_dir) and any(
        is_importable(n, os.path.join(src_dir, n)) for n in os.listdir(src_dir)
    ):
        src_root = src_dir
    copied = []
    for item in sorted(os.listdir(src_root)):
        path = os.path.join(src_root, item)
        if not is_importable(item, path):
            continue
        target = os.path.join(dest, item)
        if os.path.exists(target):
            continue                # a wheel already provided it
        shutil.copytree(path, target) if os.path.isdir(path) else shutil.copy2(path, target)
        copied.append(item)
    print(f"  sdist {os.path.basename(sd)}: {copied or 'nothing'}")
shutil.rmtree(scratch, ignore_errors=True)
PY

echo "==> installing muse_hands"
cp -r python/muse_hands "$RT/muse_hands"
find "$RT/muse_hands" -name __pycache__ -type d -exec rm -rf {} +

echo "==> copying tree to $OUT"
rm -rf "$OUT"
mkdir -p "$(dirname "$OUT")"
cp -a "$RT" "$OUT"
du -sh "$OUT"
echo "done. Ship it via electron-builder extraResources (see package.json)."
