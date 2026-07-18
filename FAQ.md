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

Not necessarily. The `bacstack` name on npm refers to a separately published
package. Until this fork publishes and documents its own package identity,
install it from GitHub:

```sh
npm install github:antecursor/node-bacstack#bacnet-sc
```

For repeatable builds, pin a reviewed release tag or full commit SHA rather than
the moving branch, and commit the resolved npm lockfile.

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

## What does `ERR_TIMEOUT` mean?

The client did not match a response before its configured `apduTimeout` elapsed.
It does not identify a single root cause. Common causes include:

- wrong IP/VMAC, UDP port, device instance, object, or property;
- broadcast, firewall, VLAN, BBMD, router, or hub-path problems;
- a device that is offline, busy, communication-disabled, or rejecting the
  service;
- segmentation or routed-address behavior outside the currently validated path;
- an SC connection that was not accepted or that reconnected while the request
  was pending.

For BACnet/SC, log `diagnostic`, `reconnect`, and `error` events and inspect
`client.getTransportStatus()` alongside the operation name and target.

## What do `BacnetError` and `BacnetAbort` mean?

These errors originate from a remote BACnet peer rather than the local timeout
mechanism:

```text
BacnetError - Class: X - Code: Y
  X: look up ErrorClass in lib/enum.js
  Y: look up ErrorCode in lib/enum.js

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
