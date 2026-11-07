#!/usr/bin/env bash
# dsh-plugin-yapi installer.
#
# Usage:
#   ./install.sh [profile]        # profile defaults to "desktop"
#
# Environment:
#   DSH_HOME                     default: ~/.dsh
#   YAPI_EMAIL / YAPI_PASSWORD   optional: seed the account file during install
#   YAPI_BASE_URL                required together with YAPI_EMAIL/YAPI_PASSWORD to seed the account
#
# The installer copies this folder into <DSH_HOME>/local-plugins, links it into
# the profile's node_modules, and registers it as a profile dependency + bundle.
# It never edits the plugin's cordis.patch.yml, so the bundle stays hot-mountable.
set -euo pipefail

PROFILE="${1:-desktop}"
HERE="$(cd "$(dirname "$0")" && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
PLUGIN_DIR="$DSH_HOME/local-plugins/dsh-plugin-yapi"
LINK="$PROFILE_DIR/node_modules/dsh-plugin-yapi"

say() { printf '%s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[ -f "$HERE/index.js" ] || die "index.js not found — run this script from inside the dsh-plugin-yapi folder"
[ -f "$HERE/package.json" ] || die "package.json not found — the folder is incomplete"
[ -f "$PROFILE_DIR/package.json" ] || die "DSH profile '$PROFILE' not found at $PROFILE_DIR — open DSH once, then rerun (or pass 'web')"

case "$PLUGIN_DIR" in
  "$DSH_HOME"/local-plugins/*) ;;
  *) die "refusing to install outside $DSH_HOME/local-plugins" ;;
esac

mkdir -p "$DSH_HOME/local-plugins" "$PROFILE_DIR/node_modules"

if [ "$HERE" != "$PLUGIN_DIR" ]; then
  rm -rf "$PLUGIN_DIR"
  mkdir -p "$PLUGIN_DIR"
  cp "$HERE/index.js" "$HERE/client.js" "$HERE/package.json" "$HERE/cordis.patch.yml" "$PLUGIN_DIR/"
  for file in README.md LICENSE install.sh uninstall.sh; do
    [ -f "$HERE/$file" ] && cp "$HERE/$file" "$PLUGIN_DIR/"
  done
  cp -R "$HERE/lib" "$HERE/bin" "$HERE/skills" "$PLUGIN_DIR/"
  chmod -R u+rwX,go+rX "$PLUGIN_DIR"
  say "Copied plugin -> $PLUGIN_DIR"
else
  say "Plugin already at $PLUGIN_DIR"
fi

if [ -e "$LINK" ] && [ ! -L "$LINK" ]; then
  die "$LINK exists and is not a symlink; move it aside and rerun"
fi
rm -f "$LINK"
ln -s "$PLUGIN_DIR" "$LINK"
say "Linked $LINK -> $PLUGIN_DIR"

BACKUP="$PROFILE_DIR/package.json.bak-yapi-$(date +%Y%m%d%H%M%S)"
cp "$PROFILE_DIR/package.json" "$BACKUP"

if command -v node >/dev/null 2>&1; then
  node - "$PROFILE_DIR/package.json" "$PLUGIN_DIR" <<'NODE'
const fs = require('node:fs')
const [file, pluginDir] = process.argv.slice(2)
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
manifest.dependencies = manifest.dependencies || {}
manifest.dependencies['dsh-plugin-yapi'] = 'file:' + pluginDir
manifest.dsh = manifest.dsh || {}
manifest.dsh.profile = manifest.dsh.profile || {}
const bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : []
if (!bundles.includes('dsh-plugin-yapi')) bundles.push('dsh-plugin-yapi')
manifest.dsh.profile.bundles = bundles
fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n')
NODE
elif command -v python3 >/dev/null 2>&1; then
  python3 - "$PROFILE_DIR/package.json" "$PLUGIN_DIR" <<'PY'
import json
import sys

file, plugin_dir = sys.argv[1], sys.argv[2]
with open(file, encoding='utf-8') as handle:
    manifest = json.load(handle)
manifest.setdefault('dependencies', {})['dsh-plugin-yapi'] = 'file:' + plugin_dir
profile = manifest.setdefault('dsh', {}).setdefault('profile', {})
bundles = profile.setdefault('bundles', [])
if 'dsh-plugin-yapi' not in bundles:
    bundles.append('dsh-plugin-yapi')
with open(file, 'w', encoding='utf-8') as handle:
    json.dump(manifest, handle, ensure_ascii=False, indent=2)
    handle.write('\n')
PY
else
  die "Node.js or python3 is required to edit $PROFILE_DIR/package.json; see README for the two manual entries"
fi
chmod 600 "$PROFILE_DIR/package.json" 2>/dev/null || true
say "Updated $PROFILE_DIR/package.json (backup: $BACKUP)"

if [ -n "${YAPI_EMAIL:-}" ] && [ -n "${YAPI_PASSWORD:-}" ] && [ -n "${YAPI_BASE_URL:-}" ]; then
  umask 077
  cat > "$DSH_HOME/dsh-plugin-yapi.json" <<JSON
{
  "baseUrl": "${YAPI_BASE_URL}",
  "email": "${YAPI_EMAIL}",
  "password": "${YAPI_PASSWORD}",
  "timeoutMs": 20000
}
JSON
  chmod 600 "$DSH_HOME/dsh-plugin-yapi.json"
  say "Wrote $DSH_HOME/dsh-plugin-yapi.json"
else
  if [ -n "${YAPI_EMAIL:-}" ] || [ -n "${YAPI_PASSWORD:-}" ]; then
    say "YAPI_BASE_URL is required to seed YAPI_EMAIL/YAPI_PASSWORD — nothing seeded."
  else
    say "No account seeded — fill YAPI 地址 / 账号 / 密码 in the panel's 账号设置 after DSH starts."
  fi
fi

# Install the companion skill + standalone CLI under the user skill root.
SKILL_DIR="$DSH_HOME/skills/yapi-doc"
case "$SKILL_DIR" in
  "$DSH_HOME"/skills/*) ;;
  *) die "refusing to install the skill outside $DSH_HOME/skills" ;;
esac
if [ -f "$PLUGIN_DIR/skills/yapi-doc/SKILL.md" ] && [ -f "$PLUGIN_DIR/skills/yapi-doc/yapi-doc.mjs" ]; then
  mkdir -p "$DSH_HOME/skills"
  rm -rf "$SKILL_DIR"
  mkdir -p "$SKILL_DIR"
  cp "$PLUGIN_DIR/skills/yapi-doc/SKILL.md" "$SKILL_DIR/SKILL.md"
  cp "$PLUGIN_DIR/skills/yapi-doc/yapi-doc.mjs" "$SKILL_DIR/yapi-doc.mjs"
  chmod 755 "$SKILL_DIR/yapi-doc.mjs"
  say "Skill + CLI installed -> $SKILL_DIR"
else
  say "Skill files not found in the package; skipped the skill install."
fi

say ""
say "Done. Restart the DSH process for profile '$PROFILE' (desktop app: quit and reopen)."
say "Then click YAPI in the left sidebar. The first install needs a restart; later client-only updates only need a page refresh."
say "AI can read YAPI docs with: node \"$SKILL_DIR/yapi-doc.mjs\" <id> (or --search <keyword>)."
