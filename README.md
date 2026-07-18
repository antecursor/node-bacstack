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

This fork does not currently document a fork-owned npm package name. The bare
command `npm install bacstack` resolves the separately published upstream
package, not necessarily the code in this repository. Install the fork directly
from GitHub instead:

```sh
npm install github:antecursor/node-bacstack#bacnet-sc
```

The branch name is convenient for evaluation but can move. For repeatable
builds, replace `bacnet-sc` with a reviewed fork release tag or full commit SHA
and commit the resulting npm lockfile.

To work on the repository itself:

```sh
git clone --branch bacnet-sc https://github.com/antecursor/node-bacstack.git
cd node-bacstack
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
npm run verify           # standard local quality gates
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for test categories and contribution
expectations, [FAQ.md](FAQ.md) for troubleshooting, and [SECURITY.md](SECURITY.md)
for private vulnerability reporting.

## License and trademarks

[MIT License](LICENSE.md)

Original copyright (c) 2017-2018 Fabio Huser. Subsequent fork contributions
remain covered by the repository license.

This is not an official product of ASHRAE or the BACnet Advocacy Group. BACnet®
is a registered trademark of the American Society of Heating, Refrigerating and
Air-Conditioning Engineers (ASHRAE).
