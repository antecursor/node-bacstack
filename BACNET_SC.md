# BACnet/SC Development Notes

## Architecture

BACnet/SC is implemented as a transport beneath the existing BACnet application and service layers. Existing BACnet/IP remains the default transport.

Use BACnet/SC with:

```js
const bacnet = require('bacstack');

const client = new bacnet({
  transport: 'bacnet-sc',
  hubUrl: 'wss://localhost:4443',
  vmac: '020000000101',
  uuid: '02000000-0101-4222-8333-020000000101',
  cert: 'docker/bacnet-sc/certs/node-bacstack.pem',
  key: 'docker/bacnet-sc/certs/node-bacstack.key',
  ca: 'docker/bacnet-sc/certs/ca.pem'
});
```

The transport opens a WebSocket/TLS connection using the BACnet/SC hub subprotocol, sends a Connect-Request, waits for Connect-Accept, then encapsulates bare BACnet NPDUs in BACnet/SC BVLL messages. The public service APIs (`whoIs`, `readProperty`, `readPropertyMultiple`, `writeProperty`, `readRange`) are unchanged.

## Java Reference Stack

The BACnet/SC Java Reference Stack is not vendored into this repository. Docker downloads the SourceForge snapshot during image build.

The upstream distribution is configured with text `.properties` files and runs examples with:

```sh
./Application config/TestHub.properties
./Application config/TestCombo.properties
```

During this implementation, raw SourceForge files were reachable, but `git clone --depth 1` disconnected and the advertised `tarball?path=` endpoint returned an HTML snapshot page. The Dockerfile therefore uses the direct SourceForge code snapshot URL for the current `d40c80` master snapshot.

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
- Diagnostics for connect timeout, TLS/socket failure, WebSocket rejection, malformed SC messages, BVLC-Result NAKs, unsupported SC service messages, send queue overflow, and reconnect state.

The fast integration test verifies these BACnet services through BACnet/SC routing:

- Who-Is / I-Am.
- ReadProperty.
- ReadPropertyMultiple.
- WriteProperty with readback.
- ReadRange.
- mTLS certificate rejection.
- Reconnect after hub-side connection drop.

## Known Limitations

- The automated `npm run test:sc` suite uses a local mock BACnet/SC hub. It verifies the node-bacstack SC transport and BACnet service flow, but it does not yet assert the full Java reference stack end to end.
- The Java reference stack Compose service is scaffolded for manual interoperability testing. A deterministic Java object fixture still needs to be selected or scripted before the full acceptance suite can assert Java ReadProperty, RPM, WriteProperty, and ReadRange values automatically.
- Direct Connect, address resolution, advertisement handling, hub failover selection, and secure path header options are not implemented beyond graceful diagnostics.
- BACnet/SC VMACs are represented as 12-character lowercase hex strings in node-bacstack events and service address arguments.
- The transport currently connects as a BACnet/SC node to a hub. It does not implement a hub, node switch, or router.

## Next Interoperability Target

After the Java reference stack test fixture is fully scripted, the next target should be a Niagara or JACE BACnet/SC hub. Validate with a vendor hub using the same node-bacstack API surface:

1. Import the local CA or issue an operational node certificate from the site CA.
2. Connect with `transport: 'bacnet-sc'` and the Niagara hub URL.
3. Verify Who-Is/I-Am discovery.
4. Verify ReadProperty and RPM against a stable Analog Value or Binary Value.
5. Verify safe WriteProperty/readback against a non-critical writable test point.
6. Verify Trend Log or Trend Log Multiple `ReadRange` where the device exposes historical data.
