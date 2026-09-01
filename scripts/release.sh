#!/usr/bin/env bash
# Release: bump the extension and the npm package (agent-debug-mcp) in lockstep, build the Chrome
# extension zip, store it in releases/ (committed to git), point the npm README's download link at it,
# publish to npm (via scripts/publish-relay.sh), then commit and tag.
#
#   pnpm release                       # patch bump: x.y.z -> x.y.(z+1)
#   pnpm release minor                 # or: major | <exact version like 0.2.0>
#   pnpm release -- --dry-run          # bump + zip + README edit, but no publish / commit / tag
#   pnpm release -- --otp 123456       # forwarded to npm publish (2FA)
#   pnpm release -- --dist-tag next    # forwarded to npm publish --tag
#   pnpm release -- --skip-tests       # skip typecheck + unit tests (CI already ran them)
#
# Version is bumped in: packages/relay/package.json, RELAY_VERSION in packages/relay/src/index.ts,
# and packages/extension/package.json (WXT stamps it into the manifest).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RELAY="$ROOT/packages/relay"
EXT="$ROOT/packages/extension"
RELEASES="$ROOT/releases"
README="$RELAY/README.md"

BUMP="patch"; DRY=0; PUBLISH_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    patch|minor|major) BUMP="$1" ;;
    [0-9]*.[0-9]*.[0-9]*) BUMP="$1" ;;
    --dry-run) DRY=1 ;;
    --skip-tests) PUBLISH_ARGS+=(--skip-tests) ;;
    --otp) PUBLISH_ARGS+=(--otp "$2"); shift ;;
    --dist-tag) PUBLISH_ARGS+=(--tag "$2"); shift ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

# 1. Compute the new version from the relay package.json (source of truth).
CUR="$(node -p "require('$RELAY/package.json').version")"
case "$BUMP" in
  patch|minor|major)
    NEW="$(node -e "
      const [ma,mi,pa] = '$CUR'.split('.').map(Number);
      const b = '$BUMP';
      console.log(b==='major' ? [ma+1,0,0].join('.') : b==='minor' ? [ma,mi+1,0].join('.') : [ma,mi,pa+1].join('.'));
    ")" ;;
  *) NEW="$BUMP" ;;
esac
echo "▶ release: $CUR -> $NEW"

# 2. Bump versions everywhere (extension manifest version comes from its package.json via WXT).
setver() { node -e "
  const fs = require('fs'), p = process.argv[1];
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  j.version = '$NEW';
  fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
" "$1"; }
setver "$RELAY/package.json"
setver "$EXT/package.json"
sed -i '' -E "s/^export const RELAY_VERSION = '[^']+';/export const RELAY_VERSION = '$NEW';/" "$RELAY/src/index.ts"
grep -q "RELAY_VERSION = '$NEW'" "$RELAY/src/index.ts" || { echo "failed to update RELAY_VERSION" >&2; exit 1; }

# 3. Build + zip the extension (wxt zip builds first).
echo "▶ building extension zip"
pnpm --filter @devtools-mcp/extension zip >/dev/null
ZIP="$EXT/.output/agent-debug-mcp-$NEW-chrome.zip"
[ -f "$ZIP" ] || { echo "expected zip not found: $ZIP" >&2; exit 1; }
mkdir -p "$RELEASES"
cp "$ZIP" "$RELEASES/"
echo "▶ stored $(du -h "$RELEASES/agent-debug-mcp-$NEW-chrome.zip" | cut -f1 | tr -d ' ') releases/agent-debug-mcp-$NEW-chrome.zip"

# 4. Point the npm README's extension download link at the new zip.
sed -i '' -E "s/agent-debug-mcp-[0-9]+\.[0-9]+\.[0-9]+-chrome\.zip/agent-debug-mcp-$NEW-chrome.zip/g" "$README"
grep -q "agent-debug-mcp-$NEW-chrome.zip" "$README" || { echo "README has no extension zip link to update" >&2; exit 1; }

# 5. Publish to npm (typecheck + tests + build + version checks live in publish-relay.sh).
if [ "$DRY" = 1 ]; then
  bash "$ROOT/scripts/publish-relay.sh" --dry-run ${PUBLISH_ARGS[@]+"${PUBLISH_ARGS[@]}"}
  echo "▶ dry run: nothing published, nothing committed. Working tree now holds the $NEW bump —"
  echo "  inspect with 'git diff', or discard with:"
  echo "  git checkout -- packages/relay/package.json packages/extension/package.json packages/relay/src/index.ts packages/relay/README.md && rm -f releases/agent-debug-mcp-$NEW-chrome.zip"
  exit 0
fi
bash "$ROOT/scripts/publish-relay.sh" ${PUBLISH_ARGS[@]+"${PUBLISH_ARGS[@]}"}

# 6. Keep only the newest zip in releases/ (old npm READMEs pin their own version, so their links go
#    stale by design), then commit exactly the release files (never the rest of the working tree) and tag.
cd "$ROOT"
find "$RELEASES" -name "agent-debug-mcp-*-chrome.zip" ! -name "agent-debug-mcp-$NEW-chrome.zip" -delete
git add -A "releases" \
        "packages/relay/package.json" "packages/extension/package.json" \
        "packages/relay/src/index.ts" "packages/relay/README.md"
git commit -m "release: v$NEW"
git tag "v$NEW"
echo "▶ committed and tagged v$NEW — publish the zip link with: git push --follow-tags"
