#!/usr/bin/env bash
set -euo pipefail

TARGET_DIR="${1:-/opt/bacnet-sc-reference}"
LOCAL_DIR="${BACNET_SC_REF_LOCAL_DIR:-/reference-stack}"
ZIP_URL="${BACNET_SC_REF_ZIP_URL:-}"
TARBALL_PAGE="${BACNET_SC_REF_TARBALL_PAGE:-https://sourceforge.net/p/bacnet-sc-reference-stack/code/ci/master/tarball}"
GIT_URL="${BACNET_SC_REF_GIT_URL:-https://git.code.sf.net/p/bacnet-sc-reference-stack/code}"
TMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

mkdir -p "$TARGET_DIR"

if [[ -f "$TARGET_DIR/Application" ]]; then
  echo "Using cached BACnet/SC reference stack in $TARGET_DIR"
  exit 0
fi

if [[ -f "$LOCAL_DIR/Application" ]]; then
  echo "Copying BACnet/SC reference stack from $LOCAL_DIR"
  cp -a "$LOCAL_DIR"/. "$TARGET_DIR"/
  chmod +x "$TARGET_DIR/Application" "$TARGET_DIR/ApplicationWS" 2>/dev/null || true
  exit 0
fi

download_zip() {
  local url="$1"
  echo "Downloading BACnet/SC reference stack snapshot: $url"
  curl -fL "$url" -o "$TMP_DIR/reference.zip"
  unzip -q "$TMP_DIR/reference.zip" -d "$TMP_DIR/unpacked"
  ROOT_DIR="$(find "$TMP_DIR/unpacked" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
  if [[ -z "$ROOT_DIR" ]]; then
    echo "Unable to find extracted BACnet/SC reference stack root" >&2
    return 1
  fi
  cp -a "$ROOT_DIR"/. "$TARGET_DIR"/
}

if [[ -n "$ZIP_URL" ]]; then
  download_zip "$ZIP_URL"
elif SNAPSHOT_URL="$(curl -fsL "$TARBALL_PAGE" | perl -0777 -ne 'print $1 if m#(https://sourceforge.net/code-snapshots/git/[^"<> ]+?\.zip)#')" && [[ -n "$SNAPSHOT_URL" ]]; then
  if ! download_zip "$SNAPSHOT_URL"; then
    echo "SourceForge advertised snapshot failed; falling back to git clone." >&2
    git -c http.version=HTTP/1.1 clone --depth 1 --single-branch "$GIT_URL" "$TMP_DIR/git"
    cp -a "$TMP_DIR/git"/. "$TARGET_DIR"/
    rm -rf "$TARGET_DIR/.git"
  fi
else
  echo "No SourceForge snapshot URL discovered; falling back to git clone." >&2
  git -c http.version=HTTP/1.1 clone --depth 1 --single-branch "$GIT_URL" "$TMP_DIR/git"
  cp -a "$TMP_DIR/git"/. "$TARGET_DIR"/
  rm -rf "$TARGET_DIR/.git"
fi

if [[ ! -f "$TARGET_DIR/Application" ]]; then
  echo "Unable to find extracted BACnet/SC reference stack root" >&2
  exit 1
fi

chmod +x "$TARGET_DIR/Application" "$TARGET_DIR/ApplicationWS" 2>/dev/null || true
