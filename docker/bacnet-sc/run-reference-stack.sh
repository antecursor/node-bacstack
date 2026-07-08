#!/usr/bin/env bash
set -euo pipefail

TARGET_DIR="${BACNET_SC_REF_TARGET_DIR:-/opt/bacnet-sc-reference}"
JAVA_BIN="${JAVA_BIN:-java}"
FIXTURE_SRC="${BACNET_SC_FIXTURE_SRC:-/opt/node-bacstack-sc/java-fixture}"
FIXTURE_OUT="out/node-bacstack-fixture"
CLASSPATH="$FIXTURE_OUT:out/production/BACnetSC:lib/slf4j-api-1.7.28.jar:lib/logback-core-1.2.3.jar:lib/logback-classic-1.2.3.jar:lib/jython-standalone-2.7.2.jar"

compile_fixture() {
  if [[ ! -d "$FIXTURE_SRC" ]]; then
    return
  fi
  mkdir -p "$TARGET_DIR/$FIXTURE_OUT"
  find "$FIXTURE_SRC" -name '*.java' -print0 \
    | xargs -0 javac \
        -cp "$TARGET_DIR/out/production/BACnetSC:$TARGET_DIR/lib/slf4j-api-1.7.28.jar:$TARGET_DIR/lib/logback-core-1.2.3.jar:$TARGET_DIR/lib/logback-classic-1.2.3.jar:$TARGET_DIR/lib/jython-standalone-2.7.2.jar" \
        -d "$TARGET_DIR/$FIXTURE_OUT"
}

/usr/local/bin/download-reference-stack "$TARGET_DIR"
cp /opt/node-bacstack-sc/TestCombo.properties "$TARGET_DIR/config/node-bacstack-TestCombo.properties"
cp /opt/node-bacstack-sc/JavaFixture.properties "$TARGET_DIR/config/node-bacstack-JavaFixture.properties"
compile_fixture

cd "$TARGET_DIR"

set +e
while true; do
  "$JAVA_BIN" -cp "$CLASSPATH" dev.bscs.common.Application "$@"
  status=$?
  [[ "$status" == "2" ]] || exit "$status"
done
