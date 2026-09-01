#!/usr/bin/env bash
set -euo pipefail

REPOSITORY="kudasaixc/mar"
INSTALL_ROOT="${MAR_INSTALL_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/mar}"
BIN_DIR="${MAR_BIN_DIR:-$HOME/.local/bin}"
VERSION="${MAR_VERSION:-main}"

fail() {
  echo "MAR installer: $*" >&2
  exit 1
}

if [[ "${1:-}" == "--uninstall" ]]; then
  [[ "$INSTALL_ROOT" == */mar ]] || fail "refusing unexpected install path: $INSTALL_ROOT"
  rm -f "$BIN_DIR/mar"
  rm -rf "$INSTALL_ROOT"
  echo "Removed MAR from $INSTALL_ROOT and $BIN_DIR/mar"
  exit 0
fi

command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v tar >/dev/null 2>&1 || fail "tar is required"
command -v node >/dev/null 2>&1 || fail "Node.js 20 or newer is required"
command -v npm >/dev/null 2>&1 || fail "npm is required"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" =~ ^[0-9]+$ ]] || fail "could not determine the Node.js version"
(( NODE_MAJOR >= 20 )) || fail "Node.js 20 or newer is required (found $(node --version))"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

if [[ "$VERSION" == "main" ]]; then
  ARCHIVE_URL="https://github.com/$REPOSITORY/archive/refs/heads/main.tar.gz"
else
  VERSION="${VERSION#v}"
  ARCHIVE_URL="https://github.com/$REPOSITORY/archive/refs/tags/v$VERSION.tar.gz"
fi

echo "Downloading MAR ${VERSION}..."
curl --proto '=https' --tlsv1.2 -fsSL "$ARCHIVE_URL" -o "$TMP_DIR/mar.tar.gz"
mkdir -p "$TMP_DIR/source"
tar -xzf "$TMP_DIR/mar.tar.gz" -C "$TMP_DIR/source" --strip-components=1

(
  cd "$TMP_DIR/source"
  npm install --ignore-scripts
  npm run build
  npm prune --omit=dev --ignore-scripts
)

PACKAGE_VERSION="$(node -p "require('$TMP_DIR/source/package.json').version")"
TARGET="$INSTALL_ROOT/versions/$PACKAGE_VERSION"
mkdir -p "$INSTALL_ROOT/versions" "$BIN_DIR"
rm -rf "$TARGET"
mv "$TMP_DIR/source" "$TARGET"
ln -sfn "$TARGET" "$INSTALL_ROOT/current.new"
mv -Tf "$INSTALL_ROOT/current.new" "$INSTALL_ROOT/current" 2>/dev/null || {
  rm -f "$INSTALL_ROOT/current"
  mv "$INSTALL_ROOT/current.new" "$INSTALL_ROOT/current"
}
ln -sfn "$INSTALL_ROOT/current/dist/cli.js" "$BIN_DIR/mar"
chmod +x "$TARGET/dist/cli.js"

echo "Installed MAR $PACKAGE_VERSION to $TARGET"
echo "Executable: $BIN_DIR/mar"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "Add this to your shell profile: export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac
echo "Next: mar init"
