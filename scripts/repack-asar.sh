#!/usr/bin/env bash
# Rebuild executable and ASAR together so embedded integrity stays valid.
set -euo pipefail
cd "$(dirname "$0")/.."
exec npm run dist:dir
