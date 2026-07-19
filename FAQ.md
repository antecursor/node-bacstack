# Frequently asked questions

## Is this fork production-ready or BACnet-certified?

No. It is pre-release software intended for controlled development and
interoperability testing. It has not completed the vendor matrix, hostile-input
fuzzing, long-running soak tests, or independent security review needed for a
production-readiness claim. The project also makes no claim of BACnet
certification or BTL listing.

The exact BACnet/SC evidence and limitations are documented in
[BACNET_SC.md](BACNET_SC.md).

## Does `npm install bacstack` install this fork?

No. The `bacstack` name on npm refers to a separately published package, while
this fork's manifest is marked `private` to prevent an accidental publication
under that identity. Install an immutable revision from GitHub:

```sh
npm install github:antecursor/node-bacstack#<reviewed-tag-or-full-commit-sha>
```

Pin a reviewed fork tag or full commit SHA rather than a moving branch, and
commit the resolved npm lockfile.

## What Node.js version is required?

Node.js 22.13.0 or newer. Contributors should also use npm at the version in the
`packageManager` field of `package.json`.

## Which services are validated over BACnet/SC?

The current focused subset is Who-Is/I-Am, ReadProperty,
ReadPropertyMultiple, WriteProperty with readback, and ReadRange.

The fast integration suite routes these through a project-owned BACnet/SC test
hub and exercises WSS/mTLS. A second fixture runs the same service subset
against a separate Java reference implementation, but currently uses plain
`ws://` inside its isolated Docker network. Neither result proves operational
vendor-hub interoperability. See the matrix in [BACNET_SC.md](BACNET_SC.md).

## Does the BACnet/SC example write to a device?

Not by default. `npm run example:sc` discovers and reads only. WriteProperty is
enabled only when `BACNET_SC_ENABLE_WRITE=true` and the device instance, target
VMAC, object type/instance, property, REAL value, and command priority are all
explicitly supplied. The example also refuses the write when discovery returns
a different VMAC.

Only use the write path with authorization and a dedicated non-critical point.

## Why can't I connect to a simulator on the same host?

BACnet/IP commonly uses unicast and broadcast UDP traffic on port 47808. Two
stacks binding the same address and port can conflict, and broadcast routing can
differ between host, container, VPN, and virtual interfaces. Use a separate
interface/IP or a controlled container network, and explicitly configure the
client interface and broadcast address.

Also check host firewall rules, VPN route changes, Docker network mode, and
whether another BACnet process already owns the UDP port.

## How do I contact a BACnet/IP peer on a non-default UDP port?

An IP string uses the client's `destinationPort`, which defaults to 47808. Use
an explicit address when one peer differs:

```js
client.readProperty(
  {ip: '192.0.2.10', port: 47809},
  objectId,
  propertyId,
  callback
);
```

For a routed peer, use `{ip, port, net, adr}`. Incoming source ports are
preserved in `sourceAddress`, response correlation, duplicate detection, and
replies. A custom IP transport must use `context.destinationPort` on every send.

## How should I respond to an inbound confirmed request?

Use the frozen `event.reply` capability attached to the request event. It binds
the reply to that request's exact peer, service, invoke ID, generation, and
deadline. Call one terminal helper such as `simpleAck()`, `readProperty(...)`,
`readPropertyMultiple(...)`, `complexAck(...)`, `error(...)`, `reject(...)`, or
`abort(...)`.

Register exactly one listener for each confirmed-service event. Exact retries
within `serverTransactionTimeout` replay the cached terminal frame without
rerunning the handler. A missing reply eventually receives an automatic
reply-timeout Abort. Do not copy `address` and `invokeId` into the legacy
response helpers; those helpers are blocked by default because they cannot
prove request-generation ownership.

## What does `ERR_TIMEOUT` mean?

The client did not match an unsegmented response or first response segment
before its configured `apduTimeout` (or per-request `timeout`) elapsed. After a
first segment is accepted, the independent segment idle and absolute timers
apply; a failure in that phase is reported as `BACNET_SEGMENTATION_ERROR`.
`ERR_TIMEOUT` does not identify a single root cause. Common causes include:

- wrong IP/VMAC, UDP port, device instance, object, or property;
- broadcast, firewall, VLAN, BBMD, router, or hub-path problems;
- a device that is offline, busy, communication-disabled, or rejecting the
  service;
- no first response segment, or a routed response whose network/MAC source does
  not match the requested peer;
- an SC connection that was not accepted or that reconnected while the request
  was pending.

For BACnet/SC, log `diagnostic`, `reconnect`, and `error` events and inspect
`client.getTransportStatus()` alongside the operation name and target.

## How do I cancel or shorten one confirmed request?

Pass `timeout` and/or `signal` in that service method's options object. The
timeout overrides `apduTimeout` until a complete unsegmented response or first
response segment arrives. Segmented reassembly then uses the client's segment
idle and absolute timers. Aborting the signal completes the callback once and
removes transaction and reassembly state in either phase.

```js
const controller = new AbortController();

client.readProperty(address, objectId, propertyId, {
  timeout: 5000,
  signal: controller.signal
}, (err, value, linkContext) => {
  // linkContext contains transport metadata when one was supplied.
});

controller.abort(new Error('request no longer needed'));
```

Calling `client.close()` cancels every active confirmed request with
`ERR_CLIENT_CLOSED`.

The client does not automatically resend a confirmed request. Treat a timeout as
an unknown outcome, not proof that the peer did nothing. Retrying a write, file
operation, reinitialization, or communication-control request can repeat a side
effect; use an application-specific reconciliation step before retrying one of
those operations.

## Why is PrivateTransfer `data` now a Buffer?

The decoder returns an owned `Buffer` so wire bytes have bounded storage and do
not alias the receive packet. Existing code that needs the old numeric-array
shape can use `Array.from(result.data)`. Encoders accept a `Buffer`,
`Uint8Array`, or an array of integer octets from 0 through 255.

## Which BACnet CharacterString encodings are supported?

The strict decoder supports UTF-8 (`0`), JIS X 0208 row/cell octet pairs (`2`),
network-byte-order UCS-4 (`3`) and UCS-2 (`4`), and ISO-8859-1 (`5`). Encoding
`1` is installation-specific Microsoft DBCS and is rejected because this fork
does not guess a code page. Shift-JIS bytes labeled as JIS X 0208 and
little-endian UCS-2 are also rejected.

General service fields fail decoding when their CharacterString is invalid or
unsupported. The standard treats AcknowledgeAlarm Ack Source and
EventNotification Message Text specially: those fields are still consumed and
reported as an empty string so the surrounding valid service is not rejected.

## What do `BacnetError`, `BacnetReject`, and `BacnetAbort` mean?

These errors originate from a remote BACnet peer rather than the local timeout
mechanism:

```text
BacnetError - Class: X - Code: Y
  X: look up ErrorClass in lib/enum.js
  Y: look up ErrorCode in lib/enum.js

BacnetReject - Reason: Z
  Z: look up RejectReason in lib/enum.js

BacnetAbort - Reason: Z
  Z: look up AbortReason in lib/enum.js
```

For example, error class `2` and code `32` represent a property error and an
unknown property. Preserve the numeric values, service name, target, invoke ID
when available, and sanitized diagnostics in a bug report.

## How should I debug a failed operation?

1. Reproduce with a read-only operation against a known test object.
2. Confirm connectivity and the same operation with an independent BACnet tool.
3. Enable internal diagnostics with `DEBUG=bacstack`.
4. For SC, record `diagnostic`, `reconnect`, and `error` events plus a transport
   status snapshot.
5. Capture packets with [Wireshark](https://www.wireshark.org/) only when
   authorized, and redact site/device/certificate details before sharing.
6. Record whether the peer was a project mock, Java reference fixture, emulator,
   or vendor product, including exact versions.

Do not attach private keys, passphrases, operational certificates, or unredacted
building-network captures to a public issue. Suspected vulnerabilities belong
in the private process described by [SECURITY.md](SECURITY.md).

## Where are API examples?

- [README.md](README.md) contains a minimal read-only BACnet/IP example.
- [BACNET_SC.md](BACNET_SC.md) documents SC configuration and the guarded
  example.
- Public method JSDoc can be generated with `npm run docs`.
- `test/integration` contains service-flow examples, but most use mocked
  transports and should not be interpreted as vendor interoperability evidence.
