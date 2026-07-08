#!/usr/bin/env bash
set -euo pipefail

COMPOSE_FILE="${BACNET_SC_COMPOSE_FILE:-docker-compose.bacnet-sc.yml}"
KEEP_COMPOSE="${BACNET_SC_KEEP_COMPOSE:-0}"

cleanup() {
  if [[ "$KEEP_COMPOSE" != "1" ]]; then
    docker compose -f "$COMPOSE_FILE" down --remove-orphans >/dev/null
  fi
}
trap cleanup EXIT

docker compose -f "$COMPOSE_FILE" up --build -d bacnet-sc-reference
docker compose -f "$COMPOSE_FILE" --profile test run --rm \
  -e BACNET_SC_HUB_URL=ws://bacnet-sc-reference:4443 \
  -e BACNET_SC_ALLOW_PLAIN=true \
  node-bacstack-sc-runner npm run test:sc:java:client
