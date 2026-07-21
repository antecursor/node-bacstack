# node-bacstack (antecursor fork)

A JavaScript BACnet protocol stack for communicating with building-automation
devices. This repository is an independent fork of
[`fh1ch/node-bacstack`](https://github.com/fh1ch/node-bacstack), extended with an
experimental BACnet Secure Connect (BACnet/SC) node transport and maintained
tooling.

> [!CAUTION]
> This fork is pre-release software. It is not production-ready, has not
> completed a security review or vendor interoperability program, and makes no
> claim of BACnet certification or BTL listing. Use it only in controlled test
> environments until the remaining hardening work is complete. Do not use it
> for life-safety, access-control, or other safety-critical functions.

## Install this fork

Node.js 22.13.0 or newer is required.

This fork does not currently publish a fork-owned npm package name, and its
manifest is marked `private` to prevent an accidental publication under the
upstream `bacstack` identity. The bare command `npm install bacstack` resolves
the separately published upstream package, not this repository. Install the
fork from an immutable Git commit or published fork tag instead:

```sh
npm install github:antecursor/node-bacstack#<reviewed-tag-or-full-commit-sha>
```

Do not substitute a moving branch name in a repeatable build. Record the exact
tag or full SHA you reviewed and commit the resulting npm lockfile.

To work on the repository itself:

```sh
git clone https://github.com/antecursor/node-bacstack.git
cd node-bacstack
git checkout <reviewed-tag-or-full-commit-sha>
npm ci
npm run verify
```

The contributor toolchain uses the npm version declared by `packageManager` in
`package.json`.

## Maturity and validation

The repository contains a broad historical BACnet/IP service API, but an
implemented method is not the same as independently validated interoperability.
The current public-preview focus is deliberately narrower:

- BACnet/IP client behavior inherited from the original project.
- BACnet/SC node-to-hub connections over WebSocket Secure and mutual TLS.
- Primary/failover hub reconnect and transport diagnostics.
- Who-Is/I-Am, ReadProperty, ReadPropertyMultiple, WriteProperty, and ReadRange
  over BACnet/SC.

WriteProperty is included for interoperability testing, but all examples are
read-only unless writing is explicitly enabled and the complete target is
specified.

| Evidence | What it proves | What it does not prove |
| --- | --- | --- |
| Unit tests | Local codec and service behavior for the covered fixtures | Independent wire correctness or device interoperability |
| Integration tests | Client/service flow through mocked transports and a project-owned TLS BACnet/SC hub | Behavior with an independent product or vendor hub |
| BACnet/SC soak harness | Repeated WSS/mTLS transactions, reconnect faults, failover/failback, cancellation, segmentation, malformed-frame containment, and bounded resource measurements | A production-readiness result until a qualifying long-duration run has completed and its report has been reviewed |
| Java reference fixture | Who-Is/I-Am, ReadProperty, ReadPropertyMultiple, WriteProperty/readback, and ReadRange against a separate Java reference implementation | Vendor interoperability or WSS/mTLS interoperability; this fixture currently uses plain `ws://` inside its test network |
| Legacy compliance container | A historical Who-Is check against a third-party device-emulator image | A current release gate; it is not part of the default CI workflow |

The local BACnet/SC integration suite does exercise real TLS sockets, a
mutual-TLS connection, missing client-certificate enforcement, reconnect, and
failover, but its hub is test code from this repository. No operational vendor
hub is currently part of the automated release evidence. See
[BACNET_SC.md](BACNET_SC.md) for the exact matrix and limitations.

## Read-only BACnet/IP example

Run discovery and reads only on a BACnet network you are authorized to test.
BACnet/IP commonly uses UDP broadcasts, which may cross more devices than a
single unicast request.

```js
const Bacnet = require('bacstack');

const client = new Bacnet({apduTimeout: 6000});

client.on('error', (err) => {
  console.error('BACnet transport error:', err);
});

client.on('iAm', (device) => {
  console.log('device:', device);
});

const request = [{
  objectId: {type: Bacnet.enum.ObjectType.DEVICE, instance: 1234},
  properties: [{id: Bacnet.enum.PropertyIdentifier.OBJECT_NAME}]
}];

client.readPropertyMultiple('192.0.2.10', request, (err, value) => {
  if (err) console.error('ReadPropertyMultiple failed:', err);
  else console.log(value);
  client.close();
});

client.whoIs();
```

Replace the documentation-only address and object instance with values from
your test network. For BACnet/SC setup and the guarded read-only example, see
[BACNET_SC.md](BACNET_SC.md).

## Client addresses and request lifecycle

The built-in BACnet/IP transport interprets string addresses as IP addresses;
the BACnet/SC transport interprets them as six-byte VMACs. A custom transport
should implement `getAddressKind()` or set `addressKind: 'ip'` or
`addressKind: 'vmac'` on the client so string addresses are unambiguous. Direct
VMACs are normalized to 12 lowercase hexadecimal characters. A BACnet/IP
string implies the client's `destinationPort` (47808 by default). Use an
explicit `{ip, port}` object for a peer on another UDP port; the port is part of
the peer's transaction identity.

The built-in classic BACnet/IP transport uses an IPv4 UDP socket and BVLC type
`0x81`. Its `interface` and `broadcastAddress` options, plus direct and routed
destinations, must therefore be IPv4 literals. An IPv6 destination fails
synchronously with `ERR_UNSUPPORTED_ADDRESS_FAMILY`. Generic client address
normalization remains IPv6-capable for custom adapters: an IP adapter can opt
in by implementing `supportsAddress(linkAddress)` (recommended for dual-stack
adapters) or by returning `6` from `getIpVersion()`. Without either capability,
custom IP transports retain IPv4 compatibility but do not accept IPv6 peers.
The capability is only an address-routing contract; the custom adapter remains
responsible for any BACnet/IPv6 link framing or translation.

Routed destinations retain both the link peer and BACnet network/MAC identity:

```js
const routedIpDevice = {
  ip: '192.0.2.10', // BACnet/IP link peer or router
  port: 47809,      // optional; defaults to the client's destinationPort
  net: 2001,
  adr: [0x01, 0x23]
};

const routedScDevice = {
  vmac: '020000000101', // BACnet/SC link peer
  net: 2001,
  adr: [0x01, 0x23]
};
```

`port` must be in the range 1–65535, `net` must be in the range 1–65534, and
`adr` must contain 1–255 octets. The complete address participates in
confirmed-response correlation, so different UDP ports and devices behind the
same router do not share transaction identity. The compatibility option
`allowRoutedResponseFallback: true` permits a link-only response to match only
when that match is unambiguous; leave it disabled unless a known peer omits its
routed source address.

Every decoded service event includes a `sourceAddress` in one of the direct or
routed shapes above. Existing `address` fields retain their historical,
service-specific shape. A default-port direct BACnet/IP peer remains a string;
a non-default-port peer is `{ip, port}`. When transport metadata exists, the
event also includes `linkContext`.

Confirmed service methods accept two request-lifecycle options in their normal
`options` object:

- `timeout`: a positive whole number of milliseconds that overrides the
  client's `apduTimeout` while waiting for an unsegmented response or the first
  matching response segment. After the first segment, `segmentIdleTimeout` and
  the fixed `segmentAbsoluteTimeout` govern reassembly instead.
- `signal`: an `AbortSignal`. Aborting it completes the callback once with the
  signal's reason when available, releases the transaction, and prevents a late
  response from being attributed to another request. The signal remains active
  during segmented-response reassembly.

`acknowledgeAlarm` also accepts `acknowledgingProcessIdentifier` in its options.
It must be an integer from 0 through 4294967295 and should identify the
acknowledging application process. The historical value `57` remains the
default when this option is omitted.

`subscribeProperty` currently retains the historical public-helper behavior: a
non-cancellation request encodes lifetime `0` (indefinite) and does not include
a COV increment. Its options object controls only the shared confirmed-request
lifecycle fields above. Finite lifetimes and COV deadbands are a known API
limitation of this helper and are not silently inferred from extra options.

Their callback shape is `(err, value, linkContext)`. BACnet/IP normally has no
link metadata, so the third argument may be `undefined`. Forwarded BACnet/IP
traffic identifies its forwarding peer and original source. BACnet/SC metadata
is a detached snapshot containing `transport`, `messageId`, `originating`,
`destination`, and decoded `dataOptions`. Its containers are frozen and option
payload Buffers are copied from transport input, but Buffer contents remain
mutable JavaScript values. A reassembled segmented message also sets
`segmented`, `segmentCount`, and `messageIds`.

```js
const controller = new AbortController();

client.readProperty(
  '192.0.2.10',
  {type: Bacnet.enum.ObjectType.DEVICE, instance: 1234},
  Bacnet.enum.PropertyIdentifier.OBJECT_NAME,
  {timeout: 5000, signal: controller.signal},
  (err, value, linkContext) => {
    if (err) console.error(err);
    else console.log(value, linkContext);
  }
);

// controller.abort(new Error('application shutdown'));
```

`client.close()` also completes all active confirmed callbacks with
`ERR_CLIENT_CLOSED`, clears partial segmented messages, and then closes the
transport.

### Serving inbound confirmed requests

An inbound confirmed-service event carries a frozen, request-specific
`event.reply` capability. Use that capability instead of copying an address and
invoke ID into a later response. It is bound to the exact peer, UDP port,
service, invoke ID, and request generation; only its first terminal response is
accepted.

```js
client.on('readProperty', async (event) => {
  const {objectId, property} = event.request;

  // Perform application authorization and lookup before responding.
  const value = await readAuthorizedValue(objectId, property);
  event.reply.readProperty(objectId, property, [
    {type: Bacnet.enum.ApplicationTags.REAL, value}
  ]);
});
```

The capability exposes `simpleAck()`, `complexAck(payload)`,
`error(errorClass, errorCode)`, `reject(reason)`, `abort(reason)`, and typed
`readProperty(...)` and `readPropertyMultiple(...)` helpers. A Complex-ACK
payload may be a `Buffer`/`Uint8Array` or a function that writes into an
isolated `{buffer, offset}` encoder object. SimpleACK and ComplexACK helpers
reject service-incompatible response types.

Register exactly one listener for each confirmed-service event. No listener
produces a cached Unrecognized-Service Reject; an ambiguous listener set
produces a cached server Abort. A synchronous handler exception is aborted and
then rethrown. A rejected async handler is converted to a cached Abort and
surfaced through a `confirmed-handler-rejection` diagnostic (and `error` when
an error listener is present). If a handler never replies, the request deadline
produces an Application-Exceeded-Reply-Time Abort.

The first encoded terminal response is cached before transport delivery and is
replayed byte-for-byte for an exact duplicate request, even when the first send
was rejected or threw. This suppresses duplicate application work only within
`serverTransactionTimeout` and the current process; applications must still
make mutating operations idempotent across restarts and later retries. Legacy
address/invoke-ID response helpers are blocked by default. The
`allowUntrackedServerResponses: true` compatibility option re-enables them, but
loses generation binding and duplicate-safe reply ownership and should not be
used for new code.

### Resource bounds and segmentation

The client applies finite defaults to transaction and inbound segmentation
state. Tune them downward for small installations before raising them for a
measured workload:

| Constructor option | Default | Scope |
| --- | ---: | --- |
| `maxTransactions` | 1024 | Active confirmed requests across all peers |
| `maxTransactionPeers` | 1024 | Tracked peer invoke-ID states |
| `serverTransactionTimeout` | 30000 ms | Pending inbound reply deadline and completed-response replay retention |
| `maxServerTransactions` | 1024 | Pending and completed inbound confirmed requests |
| `maxServerTransactionsPerPeer` | 64 | Inbound confirmed requests per exact peer |
| `maxServerTransactionBytes` | 4 MiB | Reserved fingerprints and cached terminal frames |
| `maxSegmentedTransfers` | 32 | Partial inbound requests and responses |
| `maxSegmentedTransfersPerPeer` | 8 | Partial transfers per peer and direction |
| `maxSegmentedRequestTransfers` | 31 | Partial inbound requests; defaults to one fewer than the global transfer limit |
| `maxSegmentsPerTransfer` | 1024 | Segments accepted for one message |
| `maxSegmentedBytesPerTransfer` | 1 MiB | Reassembled bytes for one message |
| `maxSegmentedTotalBytes` | 4 MiB | Reassembled bytes across all partial messages |
| `maxSegmentedRequestBytes` | 3 MiB | Bytes held by inbound requests; defaults to the global byte limit minus one transfer allowance |
| `segmentIdleTimeout` | `apduTimeout` | Maximum pause between accepted segments |
| `segmentAbsoluteTimeout` | 30000 ms | Maximum lifetime of a partial message |

The request-direction limits may be zero and cannot exceed their corresponding
global limits; the other resource counts and all segment timeouts must be
positive whole numbers. Their defaults reserve enough global capacity for at
least one maximum-sized segmented response, so a flood of inbound requests
cannot consume every response slot and byte. The bounded completion cache also
reserves one response replay descriptor by default so completed request churn
cannot remove every final response SegmentACK replay opportunity.

Confirmed operations that expect a Complex-ACK advertise segmented-response
support unless their request option `maxSegments` is
`MaxSegmentsAccepted.SEGMENTS_0`. The client reassembles inbound segmented
Complex-ACK responses and inbound segmented Confirmed-Request messages, sends
SegmentACK/negative SegmentACK responses, and aborts a transfer that violates
its ordering, invariant, time, or resource limits. A failed segmented response
completes its callback with `BACNET_SEGMENTATION_ERROR`.

Outbound APDU fragmentation is not implemented. An outbound confirmed request
or application response must therefore fit the active transport and negotiated
payload limits even though the client can receive segmented messages. An
oversized local send fails before transport delivery with
`ERR_OUTBOUND_APDU_TOO_LARGE`; an oversized tracked ComplexACK becomes a cached
`APDU_TOO_LONG` Abort. The client also does not automatically retransmit a
confirmed request when its timeout expires. If an application adds retries, it
must account for the fact that a timed-out non-idempotent operation (for
example, a write, file operation, or device-control request) may already have
taken effect at the peer.

## Safe-use expectations

- Start with discovery and reads on an isolated or otherwise controlled network.
- Never point examples at a live building without the operator's authorization.
- Treat WriteProperty, file writes, object changes, device reinitialization, and
  communication-control services as potentially disruptive.
- Use a dedicated non-critical test object for writes, select the BACnet command
  priority deliberately, verify the target address, and arrange rollback first.
- Use unique operational certificates and protect private keys. The certificates
  under `test/fixtures` are public throwaway fixtures and must never be reused.
- Pin this dependency to a reviewed tag or commit, monitor diagnostics, apply
  timeouts, and always close clients during shutdown.

## Development commands

```sh
npm test                 # unit and mocked/in-process integration tests
npm run test:coverage    # combined coverage
npm run lint             # ESLint
npm run docs             # generate JSDoc under the ignored docs/ directory
npm run test:sc          # project-owned BACnet/SC TLS/mTLS test hub
npm run test:sc:java     # Docker-based Java reference fixture
npm run package:check    # inspect the package file set
npm run package:smoke    # pack, install, and load the real tarball
npm run test:state-churn # bounded synthetic transaction/segment churn
npm run verify           # standard local quality gates
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for runtime boundaries,
[RELEASE.md](RELEASE.md) for the evidence required before a release claim,
[CONTRIBUTING.md](CONTRIBUTING.md) for test categories and contribution
expectations, [FAQ.md](FAQ.md) for troubleshooting, and [SECURITY.md](SECURITY.md)
for private vulnerability reporting.

## License and trademarks

[MIT License](LICENSE.md)

Original copyright (c) 2017-2018 Fabio Huser. Subsequent fork contributions
remain covered by the repository license.

This is not an official product of ASHRAE or the BACnet Advocacy Group. BACnet®
is a registered trademark of the American Society of Heating, Refrigerating and
Air-Conditioning Engineers (ASHRAE).
