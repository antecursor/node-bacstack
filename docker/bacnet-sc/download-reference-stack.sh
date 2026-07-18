#!/usr/bin/env bash
set -euo pipefail

TARGET_DIR="${1:-/opt/bacnet-sc-reference}"
LOCAL_DIR="${BACNET_SC_REF_LOCAL_DIR:-/reference-stack}"
GIT_URL="${BACNET_SC_REF_GIT_URL:-https://git.code.sf.net/p/bacnet-sc-reference-stack/code}"
REF_COMMIT="${BACNET_SC_REF_COMMIT:-d40c80b8afa108a8806e997c99c6e9c94741b5bb}"
TMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

mkdir -p "$TARGET_DIR"

if [[ ! "$REF_COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
  echo "BACNET_SC_REF_COMMIT must be a full lowercase Git commit ID" >&2
  exit 1
fi

if [[ -f "$TARGET_DIR/Application" ]] \
  && [[ -f "$TARGET_DIR/.source-commit" ]] \
  && [[ "$(<"$TARGET_DIR/.source-commit")" == "$REF_COMMIT" ]]; then
  echo "Using cached BACnet/SC reference stack in $TARGET_DIR"
  exit 0
fi

if [[ -n "$(find "$TARGET_DIR" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
  echo "Reference cache in $TARGET_DIR is incomplete or does not match $REF_COMMIT" >&2
  echo "Remove the stale fixture volume or select an empty BACNET_SC_REF_TARGET_DIR" >&2
  exit 1
fi

if [[ -f "$LOCAL_DIR/Application" ]]; then
  LOCAL_COMMIT=""
  if [[ -d "$LOCAL_DIR/.git" ]]; then
    LOCAL_COMMIT="$(git -C "$LOCAL_DIR" rev-parse HEAD)"
  elif [[ -f "$LOCAL_DIR/.source-commit" ]]; then
    LOCAL_COMMIT="$(<"$LOCAL_DIR/.source-commit")"
  fi
  if [[ "$LOCAL_COMMIT" != "$REF_COMMIT" ]]; then
    echo "Local BACnet/SC reference stack does not match pinned commit $REF_COMMIT" >&2
    exit 1
  fi
  echo "Copying BACnet/SC reference stack from $LOCAL_DIR"
  if [[ -d "$LOCAL_DIR/.git" ]]; then
    git -C "$LOCAL_DIR" archive HEAD | tar -x -C "$TARGET_DIR"
  else
    cp -a "$LOCAL_DIR"/. "$TARGET_DIR"/
  fi
  printf '%s\n' "$REF_COMMIT" > "$TARGET_DIR/.source-commit"
  chmod +x "$TARGET_DIR/Application" "$TARGET_DIR/ApplicationWS" 2>/dev/null || true
  exit 0
fi

echo "Fetching BACnet/SC reference stack commit $REF_COMMIT"
git -C "$TMP_DIR" init --quiet reference
git -C "$TMP_DIR/reference" remote add origin "$GIT_URL"
git -C "$TMP_DIR/reference" \
  -c http.version=HTTP/1.1 \
  -c http.lowSpeedLimit=1024 \
  -c http.lowSpeedTime=30 \
  fetch --quiet --depth 1 origin "$REF_COMMIT"
ACTUAL_COMMIT="$(git -C "$TMP_DIR/reference" rev-parse FETCH_HEAD)"
if [[ "$ACTUAL_COMMIT" != "$REF_COMMIT" ]]; then
  echo "Fetched BACnet/SC reference commit $ACTUAL_COMMIT, expected $REF_COMMIT" >&2
  exit 1
fi
git -C "$TMP_DIR/reference" checkout --quiet --detach FETCH_HEAD
git -C "$TMP_DIR/reference" archive HEAD | tar -x -C "$TARGET_DIR"
printf '%s\n' "$REF_COMMIT" > "$TARGET_DIR/.source-commit"

if [[ ! -f "$TARGET_DIR/Application" ]]; then
  echo "Unable to find extracted BACnet/SC reference stack root" >&2
  exit 1
fi

chmod +x "$TARGET_DIR/Application" "$TARGET_DIR/ApplicationWS" 2>/dev/null || true
