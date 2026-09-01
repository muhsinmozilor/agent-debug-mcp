#!/usr/bin/env bash
# Publish the `agent-debug-mcp` npm package (packages/relay). Reads NPM_TOKEN from .env at the repo root, so
# rotating the token is a one-line edit; the token never touches ~/.npmrc (a temporary --userconfig is used).
#
#   pnpm release:relay                 # typecheck + tests + build + publish
#   pnpm release:relay -- --dry-run    # everything except the publish (prints the tarball contents)
#   pnpm release:relay -- --tag next   # publish under a dist-tag
#   pnpm release:relay -- --skip-tests # when CI already ran them
#   pnpm release:relay -- --otp 123456 # 2FA code from your authenticator (needed unless the token has "bypass 2FA")
#
# .env (git-ignored):   NPM_TOKEN=npm_xxx   (granular token with read+write on packages, or an automation token)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG="$ROOT/packages/relay"
DRY=0; TAG=""; SKIP_TESTS=0; OTP=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --tag) TAG="$2"; shift ;;
    --skip-tests) SKIP_TESTS=1 ;;
    --otp) OTP="$2"; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

# 1. Environment
if [ -f "$ROOT/.env" ]; then
  set -a; . "$ROOT/.env"; set +a
fi
if [ -z "${NPM_TOKEN:-}" ]; then
  echo "NPM_TOKEN is not set. Put it in $ROOT/.env (see .env.example) or export it." >&2
  exit 1
fi

# 2. Version sanity: package.json and the RELAY_VERSION constant must agree.
PKG_VERSION="$(node -p "require('$PKG/package.json').version")"
NAME="$(node -p "require('$PKG/package.json').name")"
CONST_VERSION="$(sed -nE "s/^export const RELAY_VERSION = '([^']+)';/\1/p" "$PKG/src/index.ts")"
if [ "$PKG_VERSION" != "$CONST_VERSION" ]; then
  echo "version mismatch: package.json=$PKG_VERSION but RELAY_VERSION=$CONST_VERSION in packages/relay/src/index.ts" >&2
  exit 1
fi
if npm view "$NAME@$PKG_VERSION" version >/dev/null 2>&1; then
  echo "$NAME@$PKG_VERSION is already on npm — bump the version first." >&2
  exit 1
fi
echo "▶ $NAME@$PKG_VERSION${TAG:+ (tag: $TAG)}"

# 3. Quality gates + build
cd "$ROOT"
if [ "$SKIP_TESTS" = 0 ]; then
  pnpm typecheck
  pnpm test
fi
pnpm --filter "$NAME" build

# 4. Auth via a temporary userconfig (never written to ~/.npmrc)
NPMRC="$(mktemp)"
trap 'rm -f "$NPMRC"' EXIT
printf '//registry.npmjs.org/:_authToken=%s\n' "$NPM_TOKEN" > "$NPMRC"
cd "$PKG"
echo "▶ authenticated as: $(npm whoami --userconfig "$NPMRC")"

# 5. Publish (or show what would go out)
ARGS=(--access public --userconfig "$NPMRC")
[ -n "$TAG" ] && ARGS+=(--tag "$TAG")
[ -n "$OTP" ] && ARGS+=(--otp "$OTP")
if [ "$DRY" = 1 ]; then
  npm publish --dry-run "${ARGS[@]}"
  echo "▶ dry run only — nothing published."
  exit 0
fi
if ! npm publish "${ARGS[@]}"; then
  cat >&2 <<'MSG'

publish failed. If npm answered "Two-factor authentication or granular access token with bypass 2fa enabled is
required": either rerun with --otp <code from your authenticator>, or create a granular access token on npmjs.com
(Access Tokens → Generate New Token → Granular → Read and write on packages → tick "Bypass two-factor
authentication") and put it in .env as NPM_TOKEN.
MSG
  exit 1
fi
# The registry can take a few seconds to serve a brand-new version; poll instead of failing the run.
for i in 1 2 3 4 5 6; do
  if SEEN="$(npm view "$NAME@$PKG_VERSION" version 2>/dev/null)" && [ -n "$SEEN" ]; then break; fi
  sleep 5
done
echo "▶ published: $NAME@${SEEN:-$PKG_VERSION (not yet visible in the registry index — it will be shortly)} — https://www.npmjs.com/package/$NAME"
echo "  next: git tag v$PKG_VERSION && git push --tags"
