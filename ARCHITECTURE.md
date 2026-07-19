# Architecture

This document describes the current runtime boundaries of the antecursor fork.
It is an orientation and audit aid, not a claim of BACnet certification or
complete interoperability. Public behavior is defined by the exported API and
the user documentation; implementation files may change without notice unless
they are deliberately exported.

## System map

The stack is intentionally layered around one coordinating client:

```text
application
  -> public Client service method
  -> service codec -> APDU -> NPDU -> BVLC-compatible client frame
  -> confirmed-transaction registration, when applicable
  -> BACnet/IP or BACnet/SC transport
  -> network peer

network peer
  -> transport framing and link validation
  -> BVLC -> NPDU -> APDU
  -> transaction settlement or inbound segment reassembly
  -> service decoder
  -> callback or event
```

| Layer | Primary responsibility | Must not own |
| --- | --- | --- |
| `index.js` | Stable package entry point and deliberate exports | Protocol state |
| `lib/client.js` | API orchestration, address routing, correlation, event delivery | TLS/WebSocket or UDP socket internals |
| `lib/services/` | Service-specific payload encoding and bounded decoding | Invoke-ID or connection lifecycle |
| `lib/apdu.js`, `lib/npdu.js`, `lib/bvlc.js`, `lib/asn1.js` | Wire-format primitives and length validation | Application policy |
| `lib/client/transaction-manager.js` | Confirmed-request identity, deadlines, cancellation, and completion | Wire encoding |
| `lib/client/server-transaction-manager.js` | Inbound confirmed-request generations, deadlines, duplicate suppression, and terminal-frame replay | Service handling or wire encoding |
| `lib/client/segment-receiver.js` | Bounded inbound APDU reassembly and replay handling | Outbound fragmentation |
| `lib/transport.js` | BACnet/IP UDP link | Service semantics |
| `lib/transport-bacnet-sc.js` | BACnet/SC node-to-hub WSS lifecycle and BVLL framing | APDU/service semantics |
| `lib/bacnet-sc/message.js` | BACnet/SC BVLL message codec | Socket lifecycle or trust policy |

The BACnet/SC transport adapts bare BACnet NPDUs to the same BVLC-framed client
interface used by BACnet/IP. This keeps service and APDU code transport-neutral.

## Address and transport contract

The built-in BACnet/IP transport reports address kind `ip`; BACnet/SC reports
`vmac`. A custom transport should implement `getAddressKind()`. Alternatively,
the client may be constructed with an explicit `addressKind`, but a conflicting
built-in transport declaration is rejected.

Classic BACnet/IP uses an IPv4 `udp4` socket and BVLC type `0x81`; the built-in
transport therefore rejects IPv6 link peers. Generic canonical addresses may
still contain IPv6 for custom IP adapters. Such an adapter must opt in by
implementing `supportsAddress(linkAddress)` and returning `true`, or by
returning `6` from `getIpVersion()`. `supportsAddress` is preferred for a
dual-stack adapter. An IP adapter without either capability is treated as
IPv4-only for backward compatibility. Declaring IPv6 capability does not alter
the client's BVLC-compatible frame; the custom adapter owns any BACnet/IPv6
link framing or translation.

Canonical application addresses are:

- direct BACnet/IP: an IP string implying `destinationPort`, or `{ip, port}`;
- direct BACnet/SC: a 12-character lowercase hexadecimal VMAC string;
- routed BACnet/IP: `{ip, port, net, adr}`, with `port` defaulting to
  `destinationPort` when omitted;
- routed BACnet/SC: `{vmac, net, adr}`.

For IP addresses, `port` is 1 through 65535. For routed addresses, `net` is 1
through 65534 and `adr` is 1 through 255 octets. The complete identity,
including the BACnet/IP UDP port and not only a router or hub-facing link
address, participates in response correlation.

A client transport is an `EventEmitter` with these operations:

| Member | Contract |
| --- | --- |
| `getAddressKind()` | Return `ip` or `vmac` |
| `supportsAddress(linkAddress)` | Optional IP capability check; return a boolean for the canonical link peer |
| `getIpVersion()` | Optional single-family IP capability; return `4` or `6` |
| `getBroadcastAddress()` | Return the broadcast address in that address kind |
| `getMaxPayload()` | Return the client frame capacity |
| `send(buffer, length, receiver, context)` | Send the first `length` bytes; for IP, use `context.destinationPort`; return `false` to reject, or throw on synchronous failure |
| `open()` / `close()` | Start and stop link resources idempotently |
| `message` | Emit `(buffer, remoteAddress, remotePort, linkContext)` |
| `error`, `open`, `close` | Emit link lifecycle information |
| `reconnect`, `diagnostic` | Optional operational events used by BACnet/SC |

Confirmed sends pass an internal `AbortSignal` and absolute deadline in
`context`. BACnet/SC uses them to remove stale queued sends; BACnet/IP may ignore
them. Every IP send passes the canonical peer port as
`context.destinationPort`; an IP transport must preserve it rather than
silently substituting a global port. A custom transport must never reinterpret
link metadata as application authorization.

## Confirmed transactions

`Client` encodes a confirmed request with an invoke-ID placeholder, registers a
transaction synchronously, patches the allocated invoke ID, and only then calls
the transport. This ordering prevents a synchronous response from arriving
before its correlation state exists.

Transaction identity is the exact canonical peer plus an 8-bit invoke ID.
Settlement also requires an expected terminal PDU class and, where the PDU
carries one, the requested service choice. A response from the wrong routed
device, peer, service, or PDU class is ignored rather than consuming a request.
Link-only matching for routed peers is disabled by default and, when explicitly
enabled, succeeds only for one unambiguous candidate.

Invoke IDs are allocated independently per peer. Active and recently completed
or cancelled IDs cannot be reused; terminal outcomes quarantine an ID for a
bounded interval so a late response cannot be attributed to a new request.
Global active-transaction and peer-state limits bound memory use. Each request
has a deadline and may also have an external `AbortSignal`. Timeout, abort,
transport rejection, send failure, or `Client.close()` completes at most one
callback and releases active state. On the first matching response segment, the
request timeout stops. Reassembly then uses a refreshable idle timer plus a
fixed absolute deadline, while the external signal remains active; segment
progress cannot extend the absolute deadline indefinitely. Correlation checks
compare the current clock with the applicable absolute deadline, so a delayed
JavaScript timer callback cannot make an already-late response successful.

The client does not implement automatic confirmed-request retransmission. An
application that retries after `ERR_TIMEOUT` must treat the outcome as unknown,
especially for writes, file operations, and device-control services: the first
request may have taken effect even when its response was lost.

## Inbound confirmed-request ownership

Before decoding or dispatching an inbound Confirmed-Request, `Client` asks the
server transaction manager to bind its exact peer and invoke ID to a SHA-256
fingerprint of the APDU identity and payload. This makes duplicate detection
independent of mutable application objects and avoids decoding or running a
handler twice for an exact retry.

A new request receives an opaque generation token and a frozen `event.reply`
capability. The capability closes over that token and the exact peer, service,
invoke ID, advertised response APDU limit, and absolute deadline. The token is
never serialized or exposed through a public address. Response helpers accept
only a live matching generation; the first terminal response wins, and later,
expired, mismatched, or stale capabilities fail locally.

Terminal frames are finalized, copied, and committed to the transaction before
the transport is called. An exact retry therefore receives the same bytes even
if initial delivery returned `false` or threw. Pending requests, completed
fingerprints, and cached frames share global, per-peer, byte, and time limits.
Completed entries are not evicted early to admit unrelated work; excess work is
aborted as out of resources. A same-key request with a different fingerprint
collides while the first request is pending, and starts a new generation only
after the prior generation has completed or expired. These guarantees are
process-local and bounded by `serverTransactionTimeout`; they do not replace
application-level idempotency or durable request journals.

Exactly one listener across a confirmed service's supported event aliases may
own the request. Missing, malformed, unsupported, ambiguous, timed-out, and
failed-handler paths are terminalized and cached. Async rejections are
contained and surfaced as diagnostics. Legacy address/invoke response helpers
are untracked and disabled unless the explicit compatibility option enables
them.

All outbound client frames pass through one finalization check. It verifies the
actual Buffer extent, transport maximum, 16-bit BVLC length, type, and declared
length before delivery. Oversize or inconsistent local output fails with
`ERR_OUTBOUND_APDU_TOO_LARGE`; a generation-bound ComplexACK that exceeds the
requester's advertised APDU limit is converted to a cached APDU-too-long Abort.

## Inbound segmentation invariants

Only inbound segmented Confirmed-Request and Complex-ACK APDUs are reassembled.
A transfer is keyed by direction, exact peer identity, and invoke ID. Responses
must first match an active transaction and its advertised segment/APDU policy;
unsolicited segmented responses do not allocate reassembly state.

The receiver enforces these invariants:

- the first accepted sequence number is zero;
- sequence numbers advance modulo 256 and the proposed window remains stable;
- PDU type, service, negotiated limits, and transport context remain consistent;
- BACnet/SC Data Options marked for every segment match across the transfer,
  while first-segment-only options cannot be introduced later;
- per-transfer segment count, per-segment size, per-transfer bytes, global
  bytes, global transfers, and per-peer transfers remain within configured
  bounds;
- independent request-direction transfer and byte ceilings reserve at least one
  response transfer and one maximum-transfer byte allowance under the defaults;
- an idle timer may be refreshed by activity, but the absolute deadline never
  moves.

Out-of-order input receives a negative SegmentACK. Invalid state, resource
exhaustion, or expiry produces a mapped Abort when possible; a segmented
response failure also settles its waiting callback once. Payload chunks are
copied into owned buffers and accounting is released when a transfer completes,
fails, expires, or the client closes.

Descriptors for the final unacknowledged window are retained for a bounded time
and count after completion. They contain segment attributes and payload hashes,
not a second assembled payload. An exact final-window retransmission can
therefore receive the same ACK behavior without dispatching the service or
callback twice. Retaining only that window also keeps sequence-number wrap
unambiguous. A different sequence-zero transfer may begin after the retained
entry is removed. Completion-cache pressure evicts request descriptors before
response descriptors and reserves one response replay slot by default.

## BACnet/SC trust boundary

BACnet/SC is an initiating node-to-hub transport. By default it requires WSS,
TLS 1.3, a client certificate, an explicitly configured site CA, and a peer
operational certificate directly signed by a configured CA. BACnet/SC does not
apply DNS Common Name or Subject Alternative Name matching by default; an
installation can opt into Node.js hostname checking or supply a custom identity
check. `allowSystemTrust`, `rejectUnauthorized: false`,
`requireClientCertificate: false`, a wider TLS policy, and plain `ws://` are
explicit compatibility/test escape hatches, not production defaults.

TLS authentication protects the link but does not make protocol bytes trusted.
The transport still validates BVLC function, source/destination VMACs, Data
Options, peer-advertised sizes, frame sizes, queue limits, handshake state, and
message generation before delivering an NPDU. Late events from a replaced
WebSocket generation cannot mutate the active connection. Reconnect, failover,
primary probes, heartbeat, and disconnect state remain inside the transport.

`linkContext` is detached diagnostic/correlation metadata. Its containers are
frozen and BACnet/SC Data Option payload Buffers are copied from transport input,
although Buffer contents remain mutable JavaScript values. BACnet/SC supplies
the message ID, originating/destination VMACs, and decoded Data Options;
reassembly adds the segment count and message-ID list. Forwarded BACnet/IP adds
the original source and forwarding peer. This metadata is useful for logs and
audits but is not an authorization decision or proof of end-device identity.

## Public and internal modules

The supported package entry point exports:

- the `Client` constructor;
- `enum` protocol constants;
- `transport.BacnetSc` for explicit transport construction;
- `bacnetSc` message helpers.

Documented client methods, events, options, callbacks, and errors form the
application-facing API. Files under `lib/client/` are deliberately excluded
from generated JSDoc and are internal state machinery. Other `lib/` files are
packaged so the entry point can load them, but filesystem availability alone
does not make a deep import a compatibility guarantee. A new supported surface
should be exported from `index.js`, documented, and covered through the public
entry point.

## Extension and test guidance

- Add a service codec under `lib/services/`; decode only inside the supplied
  offset/length window and reject truncation or impossible lengths safely.
- Route confirmed public methods through the central confirmed-send path so
  allocation, deadlines, cancellation, PDU/service matching, and cleanup remain
  uniform. Do not add a parallel invoke-ID store.
- Reply to inbound confirmed requests only through `event.reply`; new terminal
  response types must preserve generation binding, finalize before sending,
  and enter the duplicate-response cache before transport delivery.
- Route all client sends through the address-aware send helper. New transports
  must state their address kind and test direct, routed, broadcast, failure, and
  close behavior.
- Add independent expected wire bytes where possible. Encoder/decoder
  round-trips alone can preserve the same defect on both sides.
- For parser or state changes, test empty/truncated windows, malformed lengths,
  limits, duplicate/out-of-order input, timeout, cancellation, close, and wrong
  peer/service/PDU cases.
- Use unit tests for codec/state invariants, public-client integration tests for
  cross-layer flow, the project TLS hub for BACnet/SC lifecycle, and the pinned
  Java fixture or named vendor equipment for independent interoperability
  evidence. Record which evidence level produced each result.

## Deliberately unsupported scope

- Outbound APDU fragmentation and outbound segment-window state.
- Automatic confirmed-request retransmission and retry counting.
- BACnet/SC hub, node-switch, router, and Direct Connect roles.
- Accepting BACnet/SC direct connections; address resolution reports that
  Direct Connect is unavailable.
- A guarantee that every historically implemented BACnet service interoperates
  with every vendor device.
- Life-safety, access-control, or other safety-critical deployment claims.
- BACnet certification, BTL listing, or affiliation with ASHRAE.

See [BACNET_SC.md](BACNET_SC.md) for the implemented BACnet/SC feature matrix and
[RELEASE.md](RELEASE.md) for the evidence required before publication.
