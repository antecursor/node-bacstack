#!/usr/bin/env bash
set -euo pipefail

OUT_DIR="${1:-docker/bacnet-sc/certs}"
DAYS="${BACNET_SC_CERT_DAYS:-3650}"

mkdir -p "$OUT_DIR"

if [[ "${BACNET_SC_CERT_FORCE:-0}" != "1" ]] \
  && [[ -f "$OUT_DIR/ca.pem" ]] \
  && [[ -f "$OUT_DIR/hub.pem" ]] \
  && [[ -f "$OUT_DIR/hub.key" ]] \
  && [[ -f "$OUT_DIR/java-node.pem" ]] \
  && [[ -f "$OUT_DIR/java-node.key" ]] \
  && [[ -f "$OUT_DIR/node-bacstack.pem" ]] \
  && [[ -f "$OUT_DIR/node-bacstack.key" ]]; then
  echo "Using existing BACnet/SC development certificates in $OUT_DIR"
  exit 0
fi

rm -f "$OUT_DIR"/*.csr "$OUT_DIR"/*.srl

openssl genrsa -out "$OUT_DIR/ca.key" 2048
openssl req -x509 -new -nodes -key "$OUT_DIR/ca.key" -sha256 -days "$DAYS" \
  -subj "/CN=node-bacstack BACnet SC dev CA" \
  -out "$OUT_DIR/ca.pem"

make_cert() {
  local name="$1"
  local cn="$2"
  local san="$3"

  openssl genrsa -out "$OUT_DIR/$name.key" 2048
  if [[ -n "$san" ]]; then
    openssl req -new -key "$OUT_DIR/$name.key" -subj "/CN=$cn" -addext "subjectAltName=$san" -out "$OUT_DIR/$name.csr"
    openssl x509 -req -in "$OUT_DIR/$name.csr" -CA "$OUT_DIR/ca.pem" -CAkey "$OUT_DIR/ca.key" \
      -CAcreateserial -out "$OUT_DIR/$name.pem" -days "$DAYS" -sha256 -copy_extensions copy
  else
    openssl req -new -key "$OUT_DIR/$name.key" -subj "/CN=$cn" -out "$OUT_DIR/$name.csr"
    openssl x509 -req -in "$OUT_DIR/$name.csr" -CA "$OUT_DIR/ca.pem" -CAkey "$OUT_DIR/ca.key" \
      -CAcreateserial -out "$OUT_DIR/$name.pem" -days "$DAYS" -sha256
  fi
  rm -f "$OUT_DIR/$name.csr"
}

make_cert "hub" "bacnet-sc-reference" "DNS:bacnet-sc-reference,DNS:localhost,IP:127.0.0.1"
make_cert "java-node" "bacnet-sc-java-node" ""
make_cert "node-bacstack" "node-bacstack" ""

rm -f "$OUT_DIR"/*.srl

cat <<EOF
Generated BACnet/SC development certificates in $OUT_DIR
  CA:              $OUT_DIR/ca.pem
  Hub cert/key:    $OUT_DIR/hub.pem / $OUT_DIR/hub.key
  Java node cert:  $OUT_DIR/java-node.pem / $OUT_DIR/java-node.key
  node-bacstack:   $OUT_DIR/node-bacstack.pem / $OUT_DIR/node-bacstack.key
EOF
