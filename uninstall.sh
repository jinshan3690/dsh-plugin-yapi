#!/usr/bin/env bash
# dsh-plugin-yapi uninstaller.
#
# Usage:
#   ./uninstall.sh [profile]      # profile defaults to "desktop"
#
# Removes the profile dependency, the bundle entry, and the node_modules link.
# Keeps the plugin folder and the YAPI account file so you can reinstall later.
# Restart DSH afterwards.
set -euo pipefail

PROFILE="${1:-desktop}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
PLUGIN_DIR="$DSH_HOME/local-plugins/dsh-plugin-yapi"
LINK="$PROFILE_DIR/node_modules/dsh-plugin-yapi"

say() { printf '%s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[ -f "$PROFILE_DIR/package.json" ] || die "DSH profile '$PROFILE' not found at $PROFILE_DIR"

if [ -L "$LINK" ]; then
  rm -f "$LINK"
  say "Removed link $LINK"
elif [ -e "$LINK" ]; then
  say "Kept $LINK (not a symlink; remove it manually if it is the plugin)"
fi

BACKUP="$PROFILE_DIR/package.json.bak-yapi-uninstall-$(date +%Y%m%d%H%M%S)"
cp "$PROFILE_DIR/package.json" "$BACKUP"

if command -v node >/dev/null 2>&1; then
  node - "$PROFILE_DIR/package.json" <<'NODE'
const fs = require('node:fs')
const file = process.argv[2]
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
if (manifest.dependencies) delete manifest.dependencies['dsh-plugin-yapi']
const bundles = manifest.dsh && manifest.dsh.profile && manifest.dsh.profile.bundles
if (Array.isArray(bundles)) manifest.dsh.profile.bundles = bundles.filter((name) => name !== 'dsh-plugin-yapi')
fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n')
NODE
elif command -v python3 >/dev/null 2>&1; then
  python3 - "$PROFILE_DIR/package.json" <<'PY'
import json
import sys

file = sys.argv[1]
with open(file, encoding='utf-8') as handle:
    manifest = json.load(handle)
manifest.get('dependencies', {}).pop('dsh-plugin-yapi', None)
profile = manifest.get('dsh', {}).get('profile', {})
bundles = profile.get('bundles')
if isinstance(bundles, list):
    profile['bundles'] = [name for name in bundles if name != 'dsh-plugin-yapi']
with open(file, 'w', encoding='utf-8') as handle:
    json.dump(manifest, handle, ensure_ascii=False, indent=2)
    handle.write('\n')
PY
else
  die "Node.js or python3 is required to edit $PROFILE_DIR/package.json"
fi
chmod 600 "$PROFILE_DIR/package.json" 2>/dev/null || true
say "Updated $PROFILE_DIR/package.json (backup: $BACKUP)"

# Remove the companion skill installed by install.sh.
SKILL_DIR="$DSH_HOME/skills/yapi-doc"
case "$SKILL_DIR" in
  "$DSH_HOME"/skills/*)
    if [ -e "$SKILL_DIR" ]; then
      rm -rf "$SKILL_DIR"
      say "Removed skill $SKILL_DIR"
    fi
    ;;
esac

say ""
say "Kept the plugin folder: $PLUGIN_DIR"
say "Kept the account file: $DSH_HOME/dsh-plugin-yapi.json"
say "Delete them manually if you want a clean removal."
say "Restart the DSH process for profile '$PROFILE' to finish."
