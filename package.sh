#!/usr/bin/env bash
# Build a shareable tarball of this plugin.
#
#   ./package.sh
#
# Output: dist/dsh-plugin-yapi-<version>.tar.gz
# The archive's top-level folder is dsh-plugin-yapi/; install it with:
#   dsh plugin --profile desktop add file:/path/to/dsh-plugin-yapi
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$HERE/package.json" | head -1)"
[ -n "$VERSION" ] || { echo "cannot read version from package.json" >&2; exit 1; }

OUT_DIR="$HERE/dist"
OUT="$OUT_DIR/dsh-plugin-yapi-$VERSION.tar.gz"
mkdir -p "$OUT_DIR"
rm -f "$OUT"

tar -czf "$OUT" \
  --exclude='dist' \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='.DS_Store' \
  --exclude='dsh-plugin-yapi.json' \
  --exclude='.env' \
  --exclude='test/vendor' \
  --exclude='test/harness.html' \
  -C "$(dirname "$HERE")" "$(basename "$HERE")"

echo "wrote $OUT"
echo "size: $(ls -lh "$OUT" | awk '{print $5}')"
echo "contents:"
tar -tzf "$OUT" | sed 's/^/  /'
