# Release-candidate checklist

Use this checklist on one immutable candidate commit. Attach command output,
dates, environment versions, and manual-test notes to the release record. A box
is evidence only for the exact commit named below.

```text
Candidate commit:
Candidate version/tag:
Distribution identity:
Previous known-good version/tag:
Release owner:
Evidence location:
```

An item marked **external/manual** cannot be satisfied by this repository's CI.
An item marked **claim gate** may remain open only when the associated claim is
removed and the limitation remains prominent. A production-readiness claim is
blocked until every required and claim-gate item is complete.

## 1. Freeze the candidate

- [ ] Work from a fresh clone or clean worktree at the candidate commit; record
  `git rev-parse HEAD` and confirm `git status --short` is empty.
- [ ] Review the complete fork diff and commit series, including generated or
  vendored-looking files, executable bits, and binary additions.
- [ ] Run `git diff --check <previous-known-good>...HEAD`.
- [ ] Run `npm run lint:commits`. The current script compares `master` to
  `HEAD`; update that script before release if the maintained base branch
  changes.
- [ ] Confirm `CHANGELOG.md`, migration notes, README maturity language,
  `SECURITY.md`, JSDoc, examples, and [ARCHITECTURE.md](ARCHITECTURE.md) describe
  the candidate rather than planned behavior.
- [ ] Confirm examples are read-only by default and test credentials remain
  visibly disposable.

## 2. Reproduce CI and local quality gates

Use Node.js 22.13.0 or newer and npm 11.18.0, as declared in `package.json`.
Start with the committed lockfile and do not repair it during the evidence run.

The release-evidence utility refuses a dirty worktree, an abbreviated or
unexpected commit ID, a changed lockfile, or the wrong npm version. It records
each command's output and digest, retains and smoke-tests the exact package
tarball, and writes a checksummed manifest below
`reports/release-evidence/<candidate-sha>/`:

```sh
CANDIDATE_SHA=$(git rev-parse HEAD)
npm run release:evidence -- --expected-sha "$CANDIDATE_SHA" --plan full
```

Use `--plan quick` only to rehearse the capture path. It omits commit lint,
coverage and state-churn verification, dependency audits, hostile-input focus
tests, and the Java reference fixture, so it is not complete release evidence.

```sh
node --version
npm --version
npm ci --ignore-scripts
npm run verify
npm run test:sc
```

- [ ] `npm ci --ignore-scripts` completes without changing
  `package-lock.json`.
- [ ] `npm run lint` passes with no unreviewed suppressions.
- [ ] `npm test` passes; record the test count and duration.
- [ ] Inbound confirmed-request tests cover exact duplicate replay before
  decoding, invoke-ID collisions, stale reply generations, first-terminal-wins,
  async rejection, deadline Abort, transport `false`/throw, resource ceilings,
  requester APDU limits, and exact UDP-port separation.
- [ ] `npm run docs` completes and the generated API pages are spot-checked for
  the constructor, confirmed callbacks, lifecycle options, events, and errors.
- [ ] `npm run package:check` lists only intended runtime and documentation
  files. It must exclude test keys, generated certificates, test fixtures,
  captures, reports, local configuration, and secrets.
- [ ] Confirm the package intentionally includes `ARCHITECTURE.md` and
  `RELEASE.md` for consumer and auditor context, as declared by the
  `package.json` `files` allowlist.
- [ ] GitHub Actions passes on the exact commit for Node.js 22.x, 24.x, and 26.x
  plus the separate quality-gate job. A local pass is not a substitute for this
  clean-run evidence.
- [ ] Archive the completed release-evidence directory, verify
  `manifest.sha256`, and record its path and manifest digest at the top of this
  checklist. A `-FAILED` directory is diagnostic evidence, not a passing run.

## 3. Dependency and supply-chain checks

```sh
npm audit --audit-level=high
npm audit --omit=dev --audit-level=high
npm ls --all
```

- [ ] Both audits have no unresolved high or critical advisory. Record and
  assess lower-severity findings rather than hiding them.
- [ ] `npm ls --all` reports a coherent tree with no unexpected extraneous or
  invalid packages.
- [ ] Review changes to `package-lock.json`, direct dependency ranges,
  overrides, GitHub Actions, Docker base images, and downloaded build inputs.
- [ ] GitHub Actions remain pinned to full commit SHAs and use least-privilege
  permissions.
- [ ] The Java reference source remains pinned and verified by full Git object
  ID; the current fixture expects
  `d40c80b8afa108a8806e997c99c6e9c94741b5bb`.

## 4. Coverage and hostile-input checks

```sh
npm run test:coverage
./node_modules/.bin/mocha \
  test/unit/decoder-fuzz.spec.js \
  test/unit/service-decoder-safety.spec.js \
  test/unit/client-malformed-packets.spec.js
```

- [ ] Coverage satisfies `.c8rc.json`: at least 78% branches, 93% functions,
  90% lines, and 90% statements. Archive
  `reports/coverage/coverage-summary.json` with the evidence.
- [ ] The deterministic 1,024-input decoder corpus, service truncation suite,
  and malformed client-ingress suite pass within their normal resource bounds.
- [ ] New or changed decoders have explicit empty, every-truncation, malformed
  length, displaced-offset, oversized-input, and resource-limit cases where
  applicable.
- [ ] CharacterString golden vectors and PrivateTransfer ownership/migration
  tests pass; record any deliberately unsupported character-set IDs.
- [ ] **External/manual, claim gate:** complete a coverage-guided or equivalent
  hostile-input campaign against BVLC, NPDU, APDU, ASN.1, service, and
  BACnet/SC entry points; record tool/version, corpus, duration, sanitizer or
  runtime settings, crashes, hangs, and fixes. The deterministic suite alone is
  not evidence of exhaustive fuzzing.
- [ ] Run `npm run test:state-churn` as a fast deterministic
  transaction/segment churn
  regression and record its iteration count. Do not describe this synthetic
  check as long-duration or operational soak evidence.
- [ ] **External/manual, claim gate:** run a long-duration reconnect,
  heartbeat-loss, failover/failback, cancellation, transaction, segmentation,
  and malformed-input soak with bounded memory, listeners, timers, queues, and
  CPU using `npm run test:sc:soak`. Its default campaign is 24 hours and writes
  a machine-readable summary plus resource samples below
  `reports/soak-bacnet-sc/`. A short smoke invocation or the synthetic state
  churn check does not satisfy this gate; archive the command, report, samples,
  environment, and reviewed acceptance limits before checking it.

## 5. BACnet/SC evidence

### Project-owned TLS hub

```sh
npm run test:sc
```

- [ ] Record the exact tests for WSS/mTLS, missing or invalid credentials,
  TLS/site-CA policy, Connect/Accept, message routing, heartbeat, reconnect,
  primary/failover recovery, queue bounds, and clean close.
- [ ] Label this as same-project integration evidence, not independent
  interoperability.

### Project-owned operational soak

```sh
npm run test:sc:soak
```

- [ ] Run from an otherwise idle, monitored host with `global.gc` exposed by
  the package command; record the exact commit, Node/npm versions, duration,
  environment overrides, and output directory.
- [ ] Review every check in `summary.json`, the complete `samples.jsonl`
  timeline, fault counters, memory trend applicability, CPU ratio, event-loop
  delay, high-water resource bounds, and clean-shutdown state.
- [ ] Preserve the generated report with the release evidence. A passing short
  integration smoke test proves harness operation, not long-duration stability.

### Pinned Java reference

Docker and, when the source is not already cached, network access are required.

```sh
npm run test:sc:java
```

- [ ] Record candidate SHA, date, Docker versions, pinned Java source commit,
  fixture image IDs, and complete pass/fail output.
- [ ] Confirm Who-Is/I-Am, ReadProperty, ReadPropertyMultiple,
  WriteProperty/readback, and ReadRange against the deterministic Java-owned
  objects.
- [ ] Label the result accurately: this is independent-codebase application
  evidence over plain `ws://` inside the test network. It does not prove vendor
  interoperability, WSS, mutual TLS, reconnect, or failover.

### Operational vendor hub

- [ ] **External/manual, required for production readiness:** use an authorized,
  non-production Niagara/JACE or comparable named vendor hub. Record exact
  product/firmware versions and sanitized configuration.
- [ ] Verify WSS/mTLS with unique test credentials, correct site-CA trust,
  expected identity policy, invalid-certificate rejection, and certificate
  rotation. Do not reuse repository fixture keys.
- [ ] Verify Who-Is/I-Am and read-only services first, including at least one
  routed device when routed-address support is in release scope and one
  non-default UDP port when BACnet/IP port-aware behavior is claimed.
- [ ] Verify heartbeat loss, reconnect, hub restart, primary/failover/failback,
  bounded queued-send expiry, cancellation, and clean shutdown.
- [ ] Only after the read-only path passes, exercise WriteProperty on a
  dedicated non-critical point with an approved priority and verify the planned
  rollback. If this is not run, remove vendor WriteProperty claims.
- [ ] Save sanitized packet evidence and repeatable steps without credentials,
  private topology, customer names, or site identifiers.

## 6. Security and repository controls

- [ ] **External/manual:** GitHub's **Report a vulnerability** button is enabled
  for this fork and opens the private advisory form linked from `SECURITY.md`
  while signed in.
- [ ] A report containing no sensitive details has been used to verify the
  private intake workflow, ownership, notifications, and response access.
- [ ] Open security findings are triaged; no known critical or high issue is
  deferred. Lower-severity deferrals have an owner, rationale, and disclosure
  decision.
- [ ] **External/manual, claim gate:** an independent security review covers
  parser boundaries, TLS policy, certificate handling, address confusion,
  transaction misattribution, segmentation/replay state, reconnect generations,
  queues/timers/listeners, and package provenance. Archive scope and disposition
  without publishing exploitable details.
- [ ] The support window and private-reporting expectations in `SECURITY.md`
  match the version being released.
- [ ] Operational documentation requires network authorization, least privilege,
  unique certificates, egress/peer restrictions, monitoring, timeouts, and a
  tested shutdown path.

## 7. Distribution identity and package smoke test

The current package name is `bacstack`, which is also associated with the
separately published upstream package. Do not publish or advertise an npm
install command until ownership and identity are unambiguous.

- [ ] **External/manual:** choose a fork-owned package name, or explicitly
  choose Git-tag/SHA-only distribution. Verify registry ownership and access
  with the intended maintainer account and organization.
- [ ] `name`, `version`, `repository`, `bugs`, `homepage`, README install
  commands, lockfile root metadata, release title, and security scope all name
  the same artifact.
- [ ] The version does not collide with inherited upstream tags and accurately
  communicates prerelease/stable status.
- [ ] Run `npm pack --dry-run --json`, inspect every entry, and archive the JSON.
- [ ] Build the actual tarball from the clean candidate, record its SHA-256,
  install it in an empty temporary project, and smoke-test `require()` plus one
  read-only mocked client flow using only documented imports.
- [ ] If publishing to a registry, require strong account authentication,
  least-privilege automation, provenance where supported, and a dry run from
  the same environment. Do not put a long-lived registry token in the repo or
  release logs.

## 8. Default branch, tag, and announcement

- [ ] **External/manual:** set the intended maintained branch as the GitHub
  default. Confirm the repository landing page, clone instructions, issue/PR
  targets, branch protection, and required CI checks all use it.
- [ ] Remove moving development-branch install instructions from stable release
  guidance; use the reviewed tag or immutable commit SHA.
- [ ] Create an annotated, preferably signed, tag only after all required gates
  pass. Confirm `git rev-parse <tag>^{commit}` equals the recorded candidate SHA
  before pushing it.
- [ ] Publish release notes that separate implemented scope, automated evidence,
  independent Java evidence, vendor evidence, known limitations, security
  reporting, upgrade notes, and rollback.
- [ ] Verify all release links and install commands from a signed-out browser
  and a clean machine or container before the public post.
- [ ] Retain the evidence bundle and immutable artifact checksum with the release
  record.

## 9. Rollback readiness

- [ ] Name the rollback decision-maker and triggers: security finding, response
  misattribution, unbounded resource growth, interoperability regression,
  certificate/trust failure, or packaging/identity error.
- [ ] Keep the previous known-good tag/SHA and artifact checksum available;
  confirm a clean consumer can pin and install it.
- [ ] For operational testing, record how to stop the client, revoke or rotate
  candidate credentials, restore the prior dependency, and reverse any guarded
  write made to the disposable vendor point.
- [ ] Never move or silently replace a published tag. Publish a corrected
  version. If a registry artifact is unsafe, deprecate it with a clear reason
  and link to the advisory or replacement; use unpublish only under the
  registry's exceptional-removal policy.
- [ ] Prepare a short notice naming affected versions, impact, immediate
  mitigation, fixed version when available, and the private reporting channel.

## Claims that must not be made

Unless future evidence and project status explicitly support them, do not say:

- “BACnet certified,” “BTL listed,” “ASHRAE approved,” or equivalent;
- “production-ready,” “security-audited,” “fully fuzzed,” or “safe for untrusted
  networks” while the corresponding claim gates above are open;
- “vendor interoperable” based only on the project hub or Java fixture;
- “WSS/mTLS interoperable” based on the Java fixture's plain-WebSocket run;
- “complete BACnet/SC” while Direct Connect, hub, node-switch, and router roles
  are unsupported;
- “supports outbound segmentation” while outbound APDU fragmentation is absent;
- “all BACnet services are interoperable” from unit or same-project integration
  tests;
- “safe for life-safety, access-control, or other safety-critical control”;
- “install this fork with `npm install bacstack`” until the fork owns and
  publishes that exact identity; or
- “legacy compliance passed” as current release evidence unless the historical
  container is independently refreshed, pinned, run, and documented.

When a gate is intentionally deferred, state the exact limitation in the
release notes and public post. Silence is not a substitute for evidence.
