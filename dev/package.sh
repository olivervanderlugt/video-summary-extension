#!/usr/bin/env bash
# Build the zip for the Chrome Web Store.
#
# Ships only what the manifest references. dev/, test/, docs/ and .github/ are
# development material and have no business inside a user's browser.
set -euo pipefail

cd "$(dirname "$0")/.."
version=$(node -p "require('./manifest.json').version")
out="video-summary-$version.zip"

rm -f "$out"
zip -rq "$out" \
  manifest.json \
  src/background src/content src/lib src/options src/providers \
  assets/icon16.png assets/icon32.png assets/icon48.png assets/icon128.png \
  LICENSE PRIVACY.md \
  -x '*.DS_Store'

echo "$out"
unzip -l "$out" | tail -1
