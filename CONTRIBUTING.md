# Contributing

Thank you for improving the antecursor fork of node-bacstack. Protocol-stack
changes can affect real building equipment, so correctness claims and safe test
methods matter as much as code style.

This fork is currently pre-release and is not represented as production-ready
or certified. Contributions should make the implemented, tested, and externally
validated scopes easier to distinguish.

## Before opening an issue

- Search this fork's GitHub issues and read [FAQ.md](FAQ.md).
- Do not post suspected vulnerabilities, credentials, certificates, packet
  captures containing site information, or private topology details in an issue.
  Follow [SECURITY.md](SECURITY.md) for private reporting.
- State whether a result came from a mocked transport, the project-owned
  BACnet/SC test hub, the Java reference fixture, an emulator, or a named vendor
  product. These are different levels of evidence.
- Redact building addresses, device names, network ranges, certificate subjects,
  and other customer/site identifiers before attaching diagnostics.

## Development setup

Node.js 22.13.0 or newer is required. Use npm and the npm version declared by
the `packageManager` field in `package.json`.

```sh
git clone https://github.com/antecursor/node-bacstack.git
cd node-bacstack
git checkout <reviewed-tag-or-full-commit-sha>
npm ci
npm run verify
```

`npm ci` intentionally treats `package-lock.json` as authoritative. Do not add a
second package-manager lockfile.

## Commit history

Keep changes small enough to understand and bisect even when they are developed
on one long-lived branch. Separate mechanical formatting, behavioral fixes,
tests, and public API changes when practical.

Use [Conventional Commits](https://www.conventionalcommits.org/) with an
imperative summary, for example:

```text
fix(sc): expire queued requests before reconnect
test(asn1): add truncated date vectors
docs: document fork validation levels
```

Use `!` and a `BREAKING CHANGE:` footer for intentional compatibility breaks.
Before finalizing an organized commit series, run:

```sh
npm run lint:commits
```

## Code and documentation style

The project uses ESLint with the repository configuration:

```sh
npm run lint
```

Add or update JSDoc when public options, events, callbacks, return values, or
errors change. Generate it locally with:

```sh
npm run docs
```

Generated JSDoc is written to the ignored `docs/` directory. Do not commit the
generated output.

## Test categories

Run the smallest relevant command while iterating, then the complete verification
command before handing off a change:

```sh
npm run test:unit
npm run test:integration
npm test
npm run test:coverage
npm run test:state-churn
npm run test:sc:soak -- --help
npm run verify
```

The evidence levels are intentionally named precisely:

- **Unit tests** cover codecs and helpers with repository-owned fixtures. A
  local encoder/decoder round trip alone can preserve the same defect on both
  sides, so protocol fixes should include independent expected bytes where
  possible.
- **Integration tests** exercise the public client through mocked transports or
  in-process peers. They prove internal flow, not hardware interoperability.
- **`npm run test:sc`** uses real TLS sockets and a project-owned mock BACnet/SC
  hub. It covers WSS/mTLS behavior, service routing, reconnect, and failover,
  but remains same-project evidence.
- **`npm run test:sc:soak`** runs a 24-hour project-owned WSS/mTLS fault and
  resource campaign by default. Its generated report supports operational
  review, but short test invocations are only harness smoke tests and do not
  establish long-duration stability.
- **`npm run test:sc:java`** uses Docker and a separate Java reference stack. It
  currently verifies Who-Is/I-Am, ReadProperty, ReadPropertyMultiple,
  WriteProperty/readback, and ReadRange over plain WebSocket inside the test
  network. It does not prove vendor WSS/mTLS interoperability.
- **`npm run compliance`** is the test command used by the legacy Docker
  compliance setup. That container path is not part of the current default CI
  release gate and should not be cited as current production evidence.

Every bug fix should include a regression test that fails for the original
reason. Network decoders should also receive boundary, truncation, malformed
length, and resource-limit cases. Mutating service tests must use disposable
fixtures rather than live operational points.

## BACnet/SC fixture

The fast suite is:

```sh
npm run test:sc
```

The independent-codebase Java fixture requires Docker Compose and may require
network access to obtain the reference implementation:

```sh
npm run test:sc:java
```

Generate disposable certificates for manual testing with:

```sh
./scripts/generate-sc-certs.sh
```

Never commit operational certificates, private keys, passphrases, site
configuration, or captures. The checked-in keys under `test/fixtures/sc-certs`
are intentionally public and only safe for disposable automated tests.

## Pull-request checklist

Even if a branch is maintained by one person, the checklist is useful as a
release record:

- Explain the user-visible behavior and risk.
- Identify compatibility changes and migration steps.
- Add regression and negative-path tests.
- State each test command actually run and whether it used mocks, Java, an
  emulator, or vendor equipment.
- Update README/JSDoc/security guidance when public behavior changes.
- Run `npm run verify` and inspect `npm run package:check` for unintended files.
- Confirm examples remain read-only unless an explicit, fully specified write
  opt-in is present.
- Before a public release/announcement, confirm this fork's GitHub **Report a
  vulnerability** button is enabled and opens a private advisory form.

## Reporting conduct concerns

This repository follows [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). For behavior
that occurs on GitHub, use GitHub's built-in content/report-abuse controls. If a
matter is safe to discuss publicly, open an issue in this fork and label it as a
conduct concern. Do not misuse private vulnerability reporting for conduct
matters.
