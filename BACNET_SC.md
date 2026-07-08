# BACnet/SC Development Notes

## Architecture

BACnet/SC is implemented as a transport beneath the existing BACnet application and service layers. Existing BACnet/IP remains the default transport.

Use BACnet/SC with:

```js
const bacnet = require('bacstack');

const client = new bacnet({
  transport: 'bacnet-sc',
  hubUrls: ['wss://primary.example:4443', 'wss://failover.example:4443'],
  vmac: '020000000101',
  uuid: '02000000-0101-4222-8333-020000000101',
  cert: 'docker/bacnet-sc/certs/node-bacstack.pem',
  key: 'docker/bacnet-sc/certs/node-bacstack.key',
  ca: 'docker/bacnet-sc/certs/ca.pem'
});
```

The transport opens a WebSocket/TLS connection using the BACnet/SC hub subprotocol, sends a Connect-Request, waits for Connect-Accept, then encapsulates bare BACnet NPDUs in BACnet/SC BVLL messages. The public service APIs (`whoIs`, `readProperty`, `readPropertyMultiple`, `writeProperty`, `readRange`) are unchanged.

For production edge-agent usage, the BACnet/SC transport accepts:

- `hubUrl` / `primaryHubUrl` plus `failoverHubUrl`, or an ordered `hubUrls` / `hubs` array.
- `cert`, `key`, `ca`, or `pfx` as file paths, PEM strings, Buffers, or CA arrays.
- `passphrase`, `servername`, `tlsOptions`, `tlsVersion`, `tlsMinVersion`, and `tlsMaxVersion` for site-specific TLS policy.
- `webSocketWaitTimeout`, `connectionWaitTimeout`, `heartbeatInterval`, `disconnectTimeout`, `reconnectMin`, and `reconnectMax`.

`requireClientCertificate` defaults to `true` for BACnet/SC. Transient connect failures are reported as `diagnostic` and `reconnect` events by default so an edge agent can fail over without crashing on an unhandled `error`; set `emitTransientErrors: true` to also emit those retryable failures as `error`.

Use `client.getTransportStatus()` to read a safe status snapshot for agent health reporting. It includes state, connected flag, current hub URL/index, configured hub list, VMAC/UUID, peer hub information, pending send count, reconnect delay/attempts, timestamps, and the latest diagnostic/error metadata.

## Java Reference Stack

The BACnet/SC Java Reference Stack is not vendored into this repository. Docker downloads or reuses a SourceForge snapshot at container startup, then compiles the local deterministic fixture in `docker/bacnet-sc/java-fixture` against the downloaded reference stack classes.

The upstream distribution is configured with text `.properties` files and runs examples with:

```sh
./Application config/TestHub.properties
./Application config/TestCombo.properties
```

During this implementation, raw SourceForge files were reachable, but `git clone --depth 1` was not always reliable. The Docker helper first uses a mounted local copy or cached Docker volume when present, otherwise it discovers the current SourceForge code snapshot URL and falls back to `git clone`.

## Commands

Generate local development certificates:

```sh
./scripts/generate-sc-certs.sh
```

Start the BACnet/SC Java reference bench:

```sh
npm run compose:sc:up
```

Stop it:

```sh
npm run compose:sc:down
```

Run the fast BACnet/SC transport interoperability suite:

```sh
npm run test:sc
```

Run the deterministic Java reference-stack service fixture:

```sh
npm run test:sc:java
```

This starts the Java reference stack hub plus a deterministic Java fixture node and asserts Who-Is/I-Am discovery, ReadProperty, ReadPropertyMultiple, WriteProperty/readback, and ReadRange from node-bacstack. The fixture uses the reference stack's plain WebSocket test mode for CI stability; the fast `npm run test:sc` suite covers TLS/mTLS behavior with the local mock hub.

Run the example against a hub:

```sh
npm run example:sc
```

## Certificates

`scripts/generate-sc-certs.sh` creates:

- `ca.pem` / `ca.key`
- `hub.pem` / `hub.key`
- `java-node.pem` / `java-node.key`
- `node-bacstack.pem` / `node-bacstack.key`

Generated Compose certificates are written under `docker/bacnet-sc/certs` by default and are not required in git. The checked-in certificates under `test/fixtures/sc-certs` are throwaway test fixtures used by the automated mock-hub integration tests.

The Java reference stack expects unencrypted PKCS#8 private keys (`BEGIN PRIVATE KEY`), which the generator produces with the installed OpenSSL defaults.

## Supported PoC Services

The implemented BACnet/SC transport supports:

- WebSocket/TLS hub connection with mTLS.
- Connect-Request / Connect-Accept.
- Encapsulated NPDU send/receive through a hub.
- Heartbeat request/ack.
- Clean Disconnect-Request / Disconnect-ACK.
- Reconnect with backoff after socket loss.
- Ordered primary/failover hub selection.
- Agent-facing transport status snapshots.
- Diagnostics for connect timeout, TLS/socket failure, WebSocket rejection, malformed SC messages, BVLC-Result NAKs, unsupported SC service messages, send queue overflow, and reconnect state.

The fast integration test verifies these BACnet services through BACnet/SC routing:

- Who-Is / I-Am.
- ReadProperty.
- ReadPropertyMultiple.
- WriteProperty with readback.
- ReadRange.
- mTLS certificate rejection.
- Reconnect after hub-side connection drop.
- Primary/failover hub selection after a transient connect failure.
- Transport status reporting for agent health.

The Java fixture test verifies the same client service path against the Java reference stack with deterministic Java-owned objects:

- Device `777001` at VMAC `777777777001`.
- Analog Value `2:1`, initial Present_Value `12.5`.
- WriteProperty readback value `42.25`.
- Trend Log `20:1` ReadRange values `1.25`, `2.5`, `3.75`.

## Known Limitations

- The automated `npm run test:sc` suite uses a local mock BACnet/SC hub. It verifies TLS/mTLS, node-bacstack SC transport behavior, and BACnet service flow without the Java reference stack.
- `npm run test:sc:java` asserts deterministic Java reference-stack ReadProperty, RPM, WriteProperty/readback, and ReadRange behavior, but it uses plain `ws://` because the reference stack's WSS server shows nondeterministic external WebSocket handshake delays from a separate Docker client. Use the WSS example path for manual TLS smoke testing.
- Direct Connect, address resolution, advertisement handling, and secure path header options are not implemented beyond graceful diagnostics.
- BACnet/SC VMACs are represented as 12-character lowercase hex strings in node-bacstack events and service address arguments.
- The transport currently connects as a BACnet/SC node to a hub. It does not implement a hub, node switch, or router.

## Next Interoperability Target

The next target should be a Niagara or JACE BACnet/SC hub. Validate with a vendor hub using the same node-bacstack API surface:

1. Import the local CA or issue an operational node certificate from the site CA.
2. Connect with `transport: 'bacnet-sc'` and the Niagara hub URL.
3. Verify Who-Is/I-Am discovery.
4. Verify ReadProperty and RPM against a stable Analog Value or Binary Value.
5. Verify safe WriteProperty/readback against a non-critical writable test point.
6. Verify Trend Log or Trend Log Multiple `ReadRange` where the device exposes historical data.
