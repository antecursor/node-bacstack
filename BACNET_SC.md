# BACnet/SC hub transport

BACnet Secure Connect (BACnet/SC) is implemented as an alternative transport
beneath the existing BACnet application and service layers. BACnet/IP remains
the default.

> [!WARNING]
> This is a pre-release node-to-hub implementation. Its protocol and resource
> handling have automated adversarial coverage, but it has not been independently
> security-audited, certified, subjected to long-duration operational soak
> testing, or validated against an operational vendor hub. Do not describe it
> as a certified BACnet/SC implementation.

## Connection example

Install this fork as described in [README.md](README.md), then configure a node:

```js
const Bacnet = require('bacstack');

const client = new Bacnet({
  transport: 'bacnet-sc',
  hubUrls: ['wss://primary.example:4443', 'wss://failover.example:4443'],
  vmac: '020000000101',
  uuid: '02000000-0101-4222-8333-020000000101',
  cert: '/run/secrets/bacnet-sc-node.pem',
  key: '/run/secrets/bacnet-sc-node.key',
  ca: '/run/secrets/site-ca.pem'
});

client.on('diagnostic', (event) => console.log('BACnet/SC diagnostic:', event));
client.on('error', (err) => console.error('BACnet/SC transport error:', err));
```

The transport opens a WebSocket/TLS connection using the BACnet/SC hub
subprotocol, sends Connect-Request, waits for Connect-Accept, and carries bare
BACnet NPDUs in BACnet/SC BVLL messages. Existing callback service methods such
as `whoIs`, `readProperty`, `readPropertyMultiple`, `writeProperty`, and
`readRange` retain their historical shape.

Accepted configuration includes:

- `hubUrl` or `primaryHubUrl` plus `failoverHubUrl`, or an ordered `hubUrls` or
  `hubs` array.
- `cert`, `key`, `ca`, or `pfx` as file paths, PEM text, Buffers, or (for `ca`)
  an array.
- `passphrase`, `servername`, `tlsOptions`, `tlsVersion`, `tlsMinVersion`, and
  `tlsMaxVersion` for TLS policy. TLS 1.3 is the default and required unless
  `allowInsecureTls: true` explicitly enables a wider version range.
- `verifyServerIdentity` or `checkServerIdentity` for installation-directed
  certificate name/identity policy. Supplying an explicit `servername` also
  enables the standard Node.js hostname check unless
  `verifyServerIdentity: false` is supplied.
- `connectionWaitTimeout`, `webSocketWaitTimeout`, `heartbeatInterval`,
  `heartbeatTimeout`, `disconnectTimeout`, `reconnectMin`, and `reconnectMax`.
- `maxBvlc`/`maxBVLC` and `maxNpdu`/`maxNPDU` for advertised and enforced
  protocol limits. Their defaults are 5705 and 1497 bytes respectively, which
  leave room for the BACnet/SC minimum supported Data Options size.
- `sendQueueLimit`, `sendQueueTimeout`, `maxHandshakeBytes`, and
  `maxBufferedAmount`/`maxBufferedBytes` for resource bounds.

The shared client layer also bounds confirmed transactions and partial
segmented messages. Its `maxTransactions`, `maxTransactionPeers`,
`serverTransactionTimeout`, `maxServerTransactions`,
`maxServerTransactionsPerPeer`, `maxServerTransactionBytes`,
`maxSegmentedTransfers`, `maxSegmentedTransfersPerPeer`,
`maxSegmentedRequestTransfers`, `maxSegmentsPerTransfer`,
`maxSegmentedBytesPerTransfer`, `maxSegmentedTotalBytes`,
`maxSegmentedRequestBytes`, `segmentIdleTimeout`, and
`segmentAbsoluteTimeout` options are documented in
[README.md](README.md#resource-bounds-and-segmentation).

`requireClientCertificate` defaults to `true`. A WSS connection also requires
an explicitly configured site `ca` store. The peer certificate must pass TLS
validation and be signed directly by one of those CA certificates. In keeping
with the BACnet/SC interoperability rules, Common Name and Subject Alternative
Name matching are not performed by default. Enable that additional policy with
`verifyServerIdentity: true`, an explicit `servername`, or a custom
`checkServerIdentity` function when the installation requires it.

`allowSystemTrust: true` replaces the BACnet/SC direct-site-CA signer rule with
standard Node.js TLS validation. It uses the default roots only when no custom
`ca` is supplied; as usual in Node.js, a custom `ca` replaces those roots.
`rejectUnauthorized: false` disables peer certificate verification entirely.
Those settings, `requireClientCertificate: false`, `allowInsecureTls: true`, and
`allowPlain: true` are explicit nonconformant compatibility/test escape hatches
and should be confined to controlled work or disposable fixtures. Plain
`ws://` sends BACnet traffic without TLS.

Retryable connection failures are emitted as `diagnostic` and `reconnect`
events by default so reconnect attempts do not create an unhandled `error`
event. Set
`emitTransientErrors: true` if the application is prepared to handle those as
`error` events too. `client.getTransportStatus()` returns a snapshot containing
connection state, current/configured hubs, VMAC/UUID, peer information, queued
send count, reconnect state, primary-probe state, timestamps, and latest
diagnostic/error metadata.
The `close` event includes the received WebSocket status code, UTF-8 reason,
and whether the shutdown was locally requested. Returned status objects are
snapshots; changing one does not alter live transport limits or peer state.
Do not expose that snapshot outside a trusted operations boundary without
reviewing it for site information.

BACnet/SC service addresses use 12-character lowercase hexadecimal VMACs. A
direct peer is passed as a string such as `020000000101`; a routed peer is
passed as `{vmac: '020000000101', net: 2001, adr: [0x01, 0x23]}`. Decoded
service events include this canonical value as `sourceAddress`.

Inbound confirmed-service events use the same generation-bound `event.reply`
capability as BACnet/IP. The capability is tied to the exact VMAC or routed
identity and caches its first terminal frame before WebSocket delivery, so an
exact retry does not rerun application work during the configured retention
window. Register one listener per confirmed service; see
[README.md](README.md#serving-inbound-confirmed-requests) for the handler and
resource contract.

Confirmed-service callbacks accept `(err, value, linkContext)`. For BACnet/SC,
`linkContext` exposes a detached snapshot of the BVLL message ID,
originating/destination VMACs, and Data Options. Its containers are frozen and
option payload Buffers are copied from transport input, although Buffer contents
remain mutable JavaScript values. Segmented messages add their segment count and
complete message-ID list. The same metadata is available as `event.linkContext`
on decoded service events. Treat it as diagnostic and correlation information,
not as authorization data.

## Safe example

From a repository checkout, `npm run example:sc` is read-only by default. (The
example source is not included in the runtime package allowlist.) It performs
discovery, ReadProperty, and ReadRange. Configure the hub, certificate paths,
node identity, and read targets with environment variables as needed:

```sh
BACNET_SC_HUB_URL=wss://hub.example:4443 \
BACNET_SC_DEVICE_INSTANCE=777001 \
BACNET_SC_OBJECT_TYPE=2 \
BACNET_SC_OBJECT_INSTANCE=1 \
BACNET_SC_TREND_OBJECT_TYPE=20 \
BACNET_SC_TREND_OBJECT_INSTANCE=1 \
npm run example:sc
```

The default object and property are an Analog Value instance `1` and
Present_Value; the default trend object is Trend Log instance `1`. Prefer
setting these explicitly for any shared test environment. Certificate settings
are `BACNET_SC_NODE_BACSTACK_PEM`, `BACNET_SC_NODE_BACSTACK_KEY`, and
`BACNET_SC_CA_PEM`.

`BACNET_SC_ALLOW_PLAIN` defaults to `false` and accepts only the exact strings
`true` or `false`. Set it to `true` only with a `ws://` URL for the disposable
Java fixture described below. The example rejects both a plain URL without that
opt-in and an unnecessary plain-transport opt-in paired with `wss://`.

Writing requires every guard below. The example refuses to write when any value
is absent, when the discovered VMAC does not match the configured target, or
when priority is outside 1–16:

```sh
BACNET_SC_ENABLE_WRITE=true \
BACNET_SC_DEVICE_INSTANCE=777001 \
BACNET_SC_TARGET_ADDRESS=777777777001 \
BACNET_SC_OBJECT_TYPE=2 \
BACNET_SC_OBJECT_INSTANCE=1 \
BACNET_SC_PROPERTY_ID=85 \
BACNET_SC_WRITE_VALUE=42.25 \
BACNET_SC_WRITE_PRIORITY=16 \
npm run example:sc
```

The guarded example encodes the write value as a BACnet REAL. Use only a
dedicated, non-critical point whose type and command-priority behavior you have
verified, and arrange a rollback before enabling the write.

## Current validation matrix

| Capability | Project-owned TLS mock hub (`test:sc`) | Java reference fixture (`test:sc:java`) |
| --- | :---: | :---: |
| WSS and mutual TLS | Yes | No; plain `ws://` only |
| Connect/Accept and NPDU routing | Yes | Yes |
| Heartbeat and BACnet/WebSocket close handshakes | Yes | Indirect connection cleanup only |
| Reconnect after dropped connection | Yes | No |
| Primary/failover selection | Yes | No |
| TLS 1.3, direct-site-CA, and opt-in hostname cases | Yes | No |
| Who-Is / I-Am | Yes | Yes |
| ReadProperty | Yes | Yes |
| ReadPropertyMultiple | Yes | Yes |
| WriteProperty with readback | Yes | Yes |
| ReadRange | Yes | Yes |
| Operational vendor hub | No | No |

The mock suite uses a hub and peer implementation from this repository. It is
valuable for transport behavior and regressions but is not independent protocol
evidence. The Java fixture uses a separate BACnet/SC reference implementation
and deterministic Java-owned objects, but its current plain-WebSocket setup does
not validate WSS or mutual TLS interoperability.

The deterministic Java objects are:

- Device `777001` at VMAC `777777777001`.
- Analog Value `2:1`, initial Present_Value `12.5`.
- WriteProperty readback value `42.25`.
- Trend Log `20:1`, with ReadRange values `1.25`, `2.5`, and `3.75`.

## Test-bench commands

Generate disposable local certificates:

```sh
./scripts/generate-sc-certs.sh
```

Run the project-owned TLS/mTLS integration suite:

```sh
npm run test:sc
```

Run the Docker-based Java reference fixture:

```sh
npm run test:sc:java
```

The Java reference implementation is not vendored. Unless a verified local or
cached copy is available, the Docker setup fetches the full SourceForge Git
commit pinned by `BACNET_SC_REF_COMMIT` and verifies the fetched object ID before
using it. The Compose fixture currently pins
`d40c80b8afa108a8806e997c99c6e9c94741b5bb`; changing the fixture requires an
explicit full commit ID and a review of the resulting interoperability evidence.

For interactive work, start and stop the reference bench with:

```sh
npm run compose:sc:up
BACNET_SC_HUB_URL=ws://127.0.0.1:4443 \
BACNET_SC_ALLOW_PLAIN=true \
npm run example:sc
npm run compose:sc:down
```

The Java fixture deliberately uses unencrypted `ws://` and is reachable from
the host only through ports bound to `127.0.0.1`; never expose those ports or
reuse this opt-in for an operational connection. Compose stores generated
certificates in its managed `sc-certs` named volume rather than the working
tree. `npm run compose:sc:down` removes that volume. Running
`./scripts/generate-sc-certs.sh` directly instead writes its disposable output
under the ignored `docker/bacnet-sc/certs` directory by default.

Certificates and private keys under `test/fixtures/sc-certs` are intentionally
public throwaway fixtures for automated tests. Never install or trust them
outside a disposable test environment.

## Implemented BACnet/SC scope

- BACnet/SC node connection to a hub over WSS/mTLS.
- Connect-Request / Connect-Accept.
- Encapsulated NPDU send and receive through the hub.
- Heartbeat request/acknowledgment and disconnect request/acknowledgment.
- Reconnect with bounded backoff, primary-first recovery, failover selection,
  background primary probes, and clean return from failover to primary.
- Common-error BVLC-Result NAK behavior, Must-Understand option handling, and
  hub-destination validation.
- Standards-defined negative Address-Resolution responses when Direct Connect
  is unavailable, Advertisement exchange, and explicit rejection of unsupported
  proprietary messages.
- Standards-tested WebSocket framing through the maintained `ws` package.
- Bounded pending-send queue, WebSocket handshake, frame, and outbound buffers.
- Bounded, cancellable confirmed transactions correlated by complete peer
  identity, invoke ID, service, and expected PDU.
- Bounded reassembly of inbound segmented Confirmed-Request and Complex-ACK
  messages.
- Application-facing status, diagnostic, reconnect, open, close, and error events.

## Known limitations

- Hub, node-switch, router, and Direct Connect roles are not implemented.
- Address resolution reports that Direct Connect is unsupported, and
  advertisements report that direct connections are not accepted.
- VMACs are represented as 12-character lowercase hexadecimal strings in events
  and service address arguments.
- The transport and application parser have deterministic hostile-input and
  malformed-window tests, but have not completed long-running
  coverage-guided fuzzing or resource/reconnect soak testing.
- Shared-client transaction, segmentation, and routed-address paths have
  automated coverage but still need operational routed-device and vendor-hub
  interoperability evidence.
- Outbound APDU fragmentation is not implemented; requests and application
  responses must fit the active transport and negotiated payload limits.
- No Niagara/JACE or other operational vendor WSS/mTLS result is currently part
  of the repository evidence.

## Next interoperability target

Use an authorized non-production Niagara/JACE or comparable vendor hub, with a
dedicated test certificate and objects:

1. Verify WSS/mTLS trust, hostname handling, rejection paths, and certificate
   rotation.
2. Verify Who-Is/I-Am and read-only service flow.
3. Exercise reconnect, failover, heartbeat loss, hub restart, and clean shutdown.
4. Only then enable guarded WriteProperty against a non-critical test point and
   verify rollback.
5. Capture versions, configuration, exact packets, and repeatable results without
   committing credentials or site-identifying data.
