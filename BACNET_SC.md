# BACnet/SC experimental transport

BACnet Secure Connect (BACnet/SC) is implemented as an alternative transport
beneath the existing BACnet application and service layers. BACnet/IP remains
the default.

> [!WARNING]
> This transport is an experimental node-to-hub implementation. It has not been
> independently security-audited, certified, soak-tested for production, or
> validated against an operational vendor hub. The current evidence is suitable
> for controlled interoperability work, not a production-readiness claim.

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
  `tlsMaxVersion` for TLS policy.
- `connectionWaitTimeout`, `webSocketWaitTimeout`, `heartbeatInterval`,
  `heartbeatTimeout`, `disconnectTimeout`, `reconnectMin`, and `reconnectMax`.
- `sendQueueLimit`, `sendQueueTimeout`, `maxHandshakeBytes`, `maxFramePayload`,
  and `maxBufferedBytes` for resource bounds.

`requireClientCertificate` defaults to `true` and TLS certificate validation is
enabled unless `rejectUnauthorized: false` is explicitly supplied. Disabling
certificate verification is unsafe and should be confined to disposable test
setups. Plain `ws://` is rejected unless `allowPlain: true` is explicitly set;
it exists for isolated test fixtures and sends BACnet traffic without TLS.

Retryable connection failures are emitted as `diagnostic` and `reconnect`
events by default so failover does not create an unhandled `error` event. Set
`emitTransientErrors: true` if the application is prepared to handle those as
`error` events too. `client.getTransportStatus()` returns a snapshot containing
connection state, current/configured hubs, VMAC/UUID, peer information, queued
send count, reconnect state, timestamps, and latest diagnostic/error metadata.
Do not expose that snapshot outside a trusted operations boundary without
reviewing it for site information.

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
| Heartbeat and clean disconnect | Indirect only; mock peer supports both, but no direct assertion | Indirect connection cleanup only |
| Reconnect after dropped connection | Yes | No |
| Primary/failover selection | Yes | No |
| Missing client-certificate configuration rejected | Yes | No |
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
npm run compose:sc:down
```

Generated Compose certificates are stored under `docker/bacnet-sc/certs` and
ignored by git. Certificates and private keys under `test/fixtures/sc-certs`
are intentionally public throwaway fixtures for automated tests. Never install
or trust them outside a disposable test environment.

## Implemented BACnet/SC scope

- BACnet/SC node connection to a hub over WSS/mTLS.
- Connect-Request / Connect-Accept.
- Encapsulated NPDU send and receive through the hub.
- Heartbeat request/acknowledgment and disconnect request/acknowledgment.
- Reconnect with backoff and ordered primary/failover selection.
- Bounded pending-send queue and WebSocket handshake/frame buffers.
- Agent-facing status, diagnostic, reconnect, open, close, and error events.

## Known limitations

- Hub, node-switch, router, and Direct Connect roles are not implemented.
- Address resolution, advertisements, and secure-path header options are not
  implemented beyond diagnostics for unsupported messages.
- VMACs are represented as 12-character lowercase hexadecimal strings in events
  and service address arguments.
- WebSocket framing is implemented locally and has not received an independent
  protocol/security audit.
- The transport and application parser have not completed hostile-input fuzzing
  or long-running resource/reconnect soak testing.
- Queued requests, transaction cancellation, invoke-ID concurrency, segmentation,
  routed-address handling, and malformed-packet behavior require further
  production hardening across the shared client stack.
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
