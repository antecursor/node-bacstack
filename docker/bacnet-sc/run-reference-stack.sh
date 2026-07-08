#!/usr/bin/env bash
set -euo pipefail

TARGET_DIR="${BACNET_SC_REF_TARGET_DIR:-/opt/bacnet-sc-reference}"
JAVA_BIN="${JAVA_BIN:-java}"
CLASSPATH="out/production/BACnetSC:lib/slf4j-api-1.7.28.jar:lib/logback-core-1.2.3.jar:lib/logback-classic-1.2.3.jar:lib/jython-standalone-2.7.2.jar"

/usr/local/bin/download-reference-stack "$TARGET_DIR"
cp /opt/node-bacstack-sc/TestCombo.properties "$TARGET_DIR/config/node-bacstack-TestCombo.properties"

cd "$TARGET_DIR"

set +e
while true; do
  "$JAVA_BIN" -cp "$CLASSPATH" dev.bscs.common.Application "$@"
  status=$?
  [[ "$status" == "2" ]] || exit "$status"
done
